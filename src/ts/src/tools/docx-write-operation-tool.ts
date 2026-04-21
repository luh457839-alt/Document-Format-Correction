import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, copyFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AgentError, asAppError } from "../core/errors.js";
import { getWriterScriptPath } from "../core/project-paths.js";
import type { DocumentIR, Tool, ToolExecutionInput, ToolExecutionOutput } from "../core/types.js";
import { normalizeWriteOperationPayload } from "./style-operation.js";

const execFileAsync = promisify(execFile);

interface DocxWriteOperationToolDeps {
  pythonBin?: string;
  scriptPath?: string;
  timeoutMs?: number;
}

export class DocxWriteOperationTool implements Tool {
  name = "write_operation";
  readOnly = false;
  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;

  constructor(deps: DocxWriteOperationToolDeps = {}) {
    this.pythonBin = deps.pythonBin ?? process.env.TS_AGENT_PYTHON_BIN ?? "python";
    this.scriptPath =
      deps.scriptPath ??
      process.env.TS_AGENT_DOCX_WRITER_SCRIPT ??
      getWriterScriptPath();
    this.timeoutMs = deps.timeoutMs ?? 15000;
  }

  async validate(input: ToolExecutionInput): Promise<void> {
    if (!input.operation) {
      throw new AgentError({
        code: "E_INVALID_OPERATION",
        message: "Write operation is required.",
        retryable: false
      });
    }
    normalizeWriteOperationPayload(input.operation);
    const outputDocxPath = readOutputDocxPath(input.doc);
    if (!input.context.dryRun && !outputDocxPath) {
      throw new AgentError({
        code: "E_OUTPUT_PATH_REQUIRED",
        message: "document.metadata.outputDocxPath is required for write_operation.",
        retryable: false
      });
    }
  }

  async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    const op = input.operation!;
    const targetNodeId = op.targetNodeId;
    if (!targetNodeId) {
      throw new AgentError({
        code: "E_INVALID_OPERATION",
        message: "Write operation requires targetNodeId after selector expansion.",
        retryable: false
      });
    }
    const normalizedStyle = normalizeWriteOperationPayload(op);
    const next = structuredClone(input.doc);
    const target = next.nodes.find((n) => n.id === targetNodeId);
    if (!target) {
      throw new AgentError({
        code: "E_TARGET_NOT_FOUND",
        message: `Target node not found: ${targetNodeId}`,
        retryable: false
      });
    }

    target.style = { ...(target.style ?? {}), ...normalizedStyle, operation: op.type };
    const outputDocxPath = readOutputDocxPath(next);

    if (input.context.dryRun) {
      return {
        doc: next,
        summary: `Dry-run: ${op.type} prepared for ${targetNodeId}.`,
        rollbackToken: `rb_${input.context.stepId}`
      };
    }

    const snapshot = await createFileSnapshot(outputDocxPath!);

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ts-agent-docx-write-"));
    const inputJsonPath = path.join(tempDir, "doc-ir.json");
    try {
      await writeFile(inputJsonPath, JSON.stringify(next), "utf8");
      await execFileAsync(this.pythonBin, [
        this.scriptPath,
        "--input-json",
        inputJsonPath,
        "--output-docx",
        outputDocxPath!
      ], {
        timeout: this.timeoutMs
      });
    } catch (err) {
      await restoreFileSnapshot(snapshot);
      const info = asAppError(err, "E_DOCX_WRITE_FAILED");
      throw new AgentError({
        code: info.code,
        message: `DOCX write failed: ${info.message}`,
        retryable: true,
        cause: err
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    const rollbackToken = encodeRollbackToken(snapshot);
    return {
      doc: next,
      summary: `Applied ${op.type} to ${targetNodeId}; wrote ${outputDocxPath}.`,
      rollbackToken,
      artifacts: { outputDocxPath }
    };
  }

  async rollback(rollbackToken: string, doc: DocumentIR): Promise<DocumentIR> {
    const snapshot = decodeRollbackToken(rollbackToken);
    if (snapshot) {
      await restoreFileSnapshot(snapshot);
    }
    const next = structuredClone(doc);
    next.metadata = { ...(next.metadata ?? {}), lastRollbackToken: rollbackToken };
    return next;
  }
}

interface OutputFileSnapshot {
  outputDocxPath: string;
  backupPath?: string;
  backupDir?: string;
  existedBefore: boolean;
}

async function createFileSnapshot(outputDocxPath: string): Promise<OutputFileSnapshot> {
  try {
    await access(outputDocxPath);
    const backupDir = await mkdtemp(path.join(os.tmpdir(), "ts-agent-docx-backup-"));
    const backupPath = path.join(backupDir, "backup.docx");
    await copyFile(outputDocxPath, backupPath);
    return { outputDocxPath, backupPath, backupDir, existedBefore: true };
  } catch {
    return { outputDocxPath, existedBefore: false };
  }
}

async function restoreFileSnapshot(snapshot: OutputFileSnapshot): Promise<void> {
  if (snapshot.existedBefore) {
    if (snapshot.backupPath) {
      await copyFile(snapshot.backupPath, snapshot.outputDocxPath);
    }
  } else {
    await rm(snapshot.outputDocxPath, { force: true });
  }
  if (snapshot.backupDir) {
    await rm(snapshot.backupDir, { recursive: true, force: true });
  }
}

function encodeRollbackToken(snapshot: OutputFileSnapshot): string {
  return `rb_file:${Buffer.from(JSON.stringify(snapshot), "utf8").toString("base64url")}`;
}

function decodeRollbackToken(token: string): OutputFileSnapshot | undefined {
  if (!token.startsWith("rb_file:")) {
    return undefined;
  }
  try {
    const encoded = token.slice("rb_file:".length);
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<OutputFileSnapshot>;
    if (typeof parsed.outputDocxPath !== "string" || typeof parsed.existedBefore !== "boolean") {
      return undefined;
    }
    return {
      outputDocxPath: parsed.outputDocxPath,
      backupPath: typeof parsed.backupPath === "string" ? parsed.backupPath : undefined,
      backupDir: typeof parsed.backupDir === "string" ? parsed.backupDir : undefined,
      existedBefore: parsed.existedBefore
    };
  } catch {
    return undefined;
  }
}

function readOutputDocxPath(doc: DocumentIR): string | undefined {
  const metadata = doc.metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const outputPath = (metadata as Record<string, unknown>).outputDocxPath;
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    return undefined;
  }
  return outputPath.trim();
}
