import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentError } from "../../core/errors.js";
import { getWriterScriptPath } from "../../core/project-paths.js";
import type { DocumentIR } from "../../core/types.js";
import { observeDocxStateWithPython } from "../../tools/python-tool-client.js";

export interface DocxAdapter {
  load(source: string): Promise<DocumentIR>;
  save(doc: DocumentIR, target: string): Promise<void>;
}

export interface PythonDocxAdapterOptions {
  mode?: "legacy" | "runner";
  pythonCommand?: string;
  parseScriptPath?: string;
  toolRunnerPath?: string;
  writerScriptPath?: string;
  mediaDir?: string;
  allowFallback?: boolean;
}

export class PythonDocxAdapter implements DocxAdapter {
  constructor(private readonly options: PythonDocxAdapterOptions = {}) {}

  async load(source: string): Promise<DocumentIR> {
    const mode = resolveLoadMode(this.options);
    const state = mode === "runner"
      ? await observeDocxStateWithPython(source, {
          pythonBin: this.options.pythonCommand,
          runnerPath: this.options.toolRunnerPath
        })
      : await parseDocxWithLegacyScript(source, {
          pythonCommand: this.options.pythonCommand,
          parseScriptPath: this.options.parseScriptPath,
          mediaDir: this.options.mediaDir
        });

    const nodes = state.nodes.map((node, index) => {
      const parts = collectTextParts(node);
      return {
        id: readStringField(node, "id") ?? `node_${index}`,
        text: parts.map((item) => item.text).join(""),
        style: parts.find((item) => item.style)?.style
      };
    });

    return {
      id: `doc_${randomUUID()}`,
      version: "v1",
      nodes,
      metadata: {
        source,
        documentMeta: state.document_meta
      }
    };
  }

  async save(doc: DocumentIR, target: string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "docx-ir-"));
    const inputJson = path.join(tempDir, "document-ir.json");
    const writerScriptPath =
      this.options.writerScriptPath ??
      DEFAULT_WRITER_SCRIPT_PATH;

    try {
      await writeFile(inputJson, JSON.stringify(doc), "utf8");
      await runProcess(this.options.pythonCommand ?? "python", [
        writerScriptPath,
        "--input-json",
        inputJson,
        "--output-docx",
        target
      ]);
    } catch (err) {
      throw toAgentError(err, "E_DOCX_SAVE_FAILED", "Failed to save DocumentIR to .docx.");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export class MockDocxAdapter extends PythonDocxAdapter {}

const DEFAULT_WRITER_SCRIPT_PATH = getWriterScriptPath();

interface TextPart {
  text: string;
  style?: Record<string, unknown>;
}

function collectTextParts(value: unknown): TextPart[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextParts(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  const nodeType = readStringField(value, "node_type");
  if (nodeType === "text_run") {
    const content = readStringField(value, "content");
    if (!content) {
      return [];
    }
    return [{ text: content, style: readRecordField(value, "style") }];
  }

  return Object.values(value).flatMap((item) => collectTextParts(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringField(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readRecordField(source: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const value = source[key];
  return isRecord(value) ? value : undefined;
}

function toAgentError(err: unknown, code: string, message: string): AgentError {
  if (err instanceof AgentError) {
    return err;
  }
  return new AgentError({
    code,
    message: `${message} ${String(err)}`,
    retryable: false,
    cause: err
  });
}

function resolveLoadMode(options: PythonDocxAdapterOptions): "legacy" | "runner" {
  if (options.mode) {
    return options.mode;
  }
  if (options.toolRunnerPath) {
    return "runner";
  }
  if (options.parseScriptPath) {
    return "legacy";
  }
  return "runner";
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      reject(
        new AgentError({
          code: "E_PROCESS_SPAWN_FAILED",
          message: `Failed to spawn writer process: ${String(err)}`,
          retryable: false,
          cause: err
        })
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new AgentError({
            code: "E_PROCESS_EXIT_NONZERO",
            message: `Writer process exited with code ${code}: ${stderr}`,
            retryable: false
          })
        );
        return;
      }
      resolve();
    });
  });
}

async function parseDocxWithLegacyScript(
  source: string,
  options: Pick<PythonDocxAdapterOptions, "pythonCommand" | "parseScriptPath" | "mediaDir">
): Promise<{
  document_meta: Record<string, unknown>;
  nodes: unknown[];
}> {
  const command = options.pythonCommand ?? "python";
  const scriptPath = options.parseScriptPath;
  if (!scriptPath) {
    throw new AgentError({
      code: "E_DOCX_PARSE_FAILED",
      message: "parseScriptPath is required for legacy parser mode.",
      retryable: false
    });
  }
  const args = [scriptPath, "--input", source];
  if (options.mediaDir) {
    args.push("--media-dir", options.mediaDir);
  }

  const stdout = await runJsonProcess(command, args);
  if (!stdout || typeof stdout !== "object" || !Array.isArray((stdout as { nodes?: unknown[] }).nodes)) {
    throw new AgentError({
      code: "E_DOCX_PARSE_FAILED",
      message: "Legacy parser output has invalid shape.",
      retryable: false
    });
  }
  return stdout as { document_meta: Record<string, unknown>; nodes: unknown[] };
}

async function runJsonProcess(command: string, args: string[]): Promise<unknown> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      reject(
        new AgentError({
          code: "E_PROCESS_SPAWN_FAILED",
          message: `Failed to spawn parser process: ${String(err)}`,
          retryable: false,
          cause: err
        })
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new AgentError({
            code: "E_PROCESS_EXIT_NONZERO",
            message: `Parser process exited with code ${code}: ${stderr}`,
            retryable: false
          })
        );
        return;
      }
      resolve(stdout);
    });
  });

  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new AgentError({
      code: "E_DOCX_PARSE_FAILED",
      message: `Legacy parser output is not valid JSON: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }
}
