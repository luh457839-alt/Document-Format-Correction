import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AgentError } from "../core/errors.js";
import { getProjectRoot, getPythonToolRunnerPath } from "../core/project-paths.js";
import type { DocumentIR, ToolExecutionInput } from "../core/types.js";
import { parseDocxToState } from "./docx-observation-tool.js";
import {
  isDocxObservationState,
  type DocxObservationState,
  type ObservationFormulaNode,
  type ObservationImageNode,
  type ObservationParagraphNode,
  type ObservationParagraphRecord,
  type ObservationTableCell,
  type ObservationTableNode,
  type ObservationTableRow,
  type ObservationTextRunNode
} from "./docx-observation-schema.js";
import { shouldFallbackToNativeDocxObservation } from "../document-tooling/observation-policy.js";

const execFileAsync = promisify(execFile);

interface PythonToolRunnerSuccess<T> {
  ok: true;
  result: T;
}

interface PythonToolRunnerFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

type PythonToolRunnerResponse<T> = PythonToolRunnerSuccess<T> | PythonToolRunnerFailure;

export interface PythonToolClientDeps {
  pythonBin?: string;
  runnerPath?: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface PythonToolExecuteRequest {
  action: "execute";
  toolName: string;
  input: ToolExecutionInput;
}

export interface PythonToolRollbackRequest {
  action: "rollback";
  toolName: string;
  rollbackToken: string;
  doc: DocumentIR;
}

export type PythonToolRequest = PythonToolExecuteRequest | PythonToolRollbackRequest;

export type PythonObservationTextRun = ObservationTextRunNode;
export type PythonObservationImageNode = ObservationImageNode;
export type PythonObservationFormulaNode = ObservationFormulaNode;
export type PythonObservationParagraphNode = ObservationParagraphNode;
export type PythonObservationParagraphRecord = ObservationParagraphRecord;
export type PythonObservationTableParagraph = ObservationParagraphNode;
export type PythonObservationTableCell = ObservationTableCell;
export type PythonObservationTableRow = ObservationTableRow;
export type PythonObservationTableNode = ObservationTableNode;
export type PythonDocxObservationState = DocxObservationState;

export async function runPythonTool<T = unknown>(
  request: PythonToolRequest,
  deps: PythonToolClientDeps = {}
): Promise<T> {
  const pythonBin = deps.pythonBin ?? process.env.TS_AGENT_PYTHON_BIN ?? "python";
  const runnerPath = deps.runnerPath ?? process.env.TS_AGENT_PYTHON_TOOL_RUNNER ?? getPythonToolRunnerPath();
  const timeoutMs = deps.timeoutMs ?? 15000;
  const cwd = deps.cwd ?? getProjectRoot();

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ts-python-tool-"));
  const inputJsonPath = path.join(tempDir, "input.json");
  const outputJsonPath = path.join(tempDir, "output.json");

  try {
    await writeFile(inputJsonPath, JSON.stringify(request), "utf8");
    let stderr = "";
    let exitCode = 0;
    try {
      const completed = await execFileAsync(
        pythonBin,
        [runnerPath, "--input-json", inputJsonPath, "--output-json", outputJsonPath],
        {
          cwd,
          timeout: timeoutMs
        }
      );
      stderr = completed.stderr ?? "";
    } catch (err) {
      const execError = err as NodeJS.ErrnoException & {
        code?: string | number;
        stderr?: string;
        killed?: boolean;
        signal?: NodeJS.Signals;
      };
      if (execError.killed || execError.signal === "SIGTERM") {
        throw new AgentError({
          code: "E_PYTHON_TOOL_TIMEOUT",
          message: `Python tool timed out after ${timeoutMs}ms.`,
          retryable: true,
          cause: err
        });
      }
      if (typeof execError.code === "string") {
        throw new AgentError({
          code: "E_PYTHON_TOOL_START_FAILED",
          message: `Failed to start Python tool ${request.toolName}: ${execError.message}`,
          retryable: true,
          cause: err
        });
      }
      stderr = execError.stderr ?? "";
      exitCode = typeof execError.code === "number" ? execError.code : 1;
    }

    let response: PythonToolRunnerResponse<T>;
    try {
      response = await readRunnerResponse<T>(outputJsonPath);
    } catch (err) {
      if (exitCode !== 0) {
        throw buildExitNonZeroError(request.toolName, exitCode, stderr, err);
      }
      throw err;
    }
    if (!response.ok) {
      throw toRunnerError(response.error, stderr);
    }
    if (exitCode !== 0) {
      throw buildExitNonZeroError(request.toolName, exitCode, stderr);
    }
    return response.result;
  } catch (err) {
    if (err instanceof AgentError) {
      throw err;
    }
    throw new AgentError({
      code: "E_PYTHON_TOOL_START_FAILED",
      message: `Failed to run Python tool ${request.toolName}: ${String(err)}`,
      retryable: true,
      cause: err
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function observeDocxStateWithPython(
  docxPath: string,
  deps: PythonToolClientDeps = {}
): Promise<PythonDocxObservationState> {
  try {
    const result = await runPythonTool<{
      doc: DocumentIR;
      summary: string;
    }>(
      {
        action: "execute",
        toolName: "docx_observation",
        input: {
          doc: {
            id: "docx_observation",
            version: "v1",
            nodes: []
          },
          operation: {
            id: "observe_docx",
            type: "set_font",
            targetNodeId: "unused",
            payload: { docxPath }
          },
          context: {
            taskId: "observe_docx",
            stepId: "observe_docx",
            dryRun: false
          }
        }
      },
      deps
    );

    const observation = result.doc.metadata?.docxObservation;
    if (!isDocxObservationState(observation)) {
      throw new AgentError({
        code: "E_DOCX_PARSE_FAILED",
        message: "Python docx observation did not return metadata.docxObservation.",
        retryable: false
      });
    }
    return observation;
  } catch (err) {
    if (!shouldFallbackToNativeDocxParser(err)) {
      throw err;
    }
    return await parseDocxToState({ docxPath, allowFallback: false });
  }
}

export async function materializeDocumentWithPython(
  doc: DocumentIR,
  deps: PythonToolClientDeps = {}
): Promise<{ doc: DocumentIR; summary: string; artifacts?: Record<string, unknown> }> {
  return await runPythonTool<{
    doc: DocumentIR;
    summary: string;
    artifacts?: Record<string, unknown>;
  }>(
    {
      action: "execute",
      toolName: "materialize_document",
      input: {
        doc,
        context: {
          taskId: "materialize_document",
          stepId: "materialize_document",
          dryRun: false
        }
      }
    },
    deps
  );
}

async function readRunnerResponse<T>(outputJsonPath: string): Promise<PythonToolRunnerResponse<T>> {
  let raw = "";
  try {
    raw = await readFile(outputJsonPath, "utf8");
  } catch (err) {
    throw new AgentError({
      code: "E_PYTHON_TOOL_OUTPUT_MISSING",
      message: "Python tool did not produce output JSON.",
      retryable: true,
      cause: err
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AgentError({
      code: "E_PYTHON_TOOL_OUTPUT_INVALID_JSON",
      message: "Python tool output is not valid JSON.",
      retryable: true,
      cause: err
    });
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { ok?: unknown }).ok !== "boolean") {
    throw new AgentError({
      code: "E_PYTHON_TOOL_OUTPUT_INVALID_SHAPE",
      message: "Python tool output has invalid shape.",
      retryable: true
    });
  }
  if ((parsed as { ok: boolean }).ok === false) {
    const error = (parsed as { error?: unknown }).error;
    if (
      !error ||
      typeof error !== "object" ||
      typeof (error as { code?: unknown }).code !== "string" ||
      typeof (error as { message?: unknown }).message !== "string" ||
      typeof (error as { retryable?: unknown }).retryable !== "boolean"
    ) {
      throw new AgentError({
        code: "E_PYTHON_TOOL_OUTPUT_INVALID_SHAPE",
        message: "Python tool failure output has invalid shape.",
        retryable: true
      });
    }
  }
  return parsed as PythonToolRunnerResponse<T>;
}

function shouldFallbackToNativeDocxParser(err: unknown): boolean {
  return shouldFallbackToNativeDocxObservation(err);
}

function buildExitNonZeroError(toolName: string, exitCode: number, stderr: string, cause?: unknown): AgentError {
  const runnerImportError = detectRunnerImportError(stderr);
  if (runnerImportError) {
    return new AgentError({
      code: "E_PYTHON_TOOL_START_FAILED",
      message: `Python tool runner environment failed before ${toolName}: ${runnerImportError}`,
      retryable: false,
      cause
    });
  }
  const stderrPreview = stderr.trim().slice(0, 300);
  const suffix = stderrPreview ? ` stderr=${stderrPreview}` : "";
  return new AgentError({
    code: "E_PYTHON_TOOL_EXIT_NONZERO",
    message: `Python tool ${toolName} exited with code ${exitCode}.${suffix}`.trim(),
    retryable: true,
    cause
  });
}

function toRunnerError(
  error: PythonToolRunnerFailure["error"],
  stderr: string
): AgentError {
  const runnerImportError = detectRunnerImportError(`${error.message}\n${stderr}`);
  if (error.code === "E_PYTHON_IMPORT_FAILED" || runnerImportError) {
    return new AgentError({
      code: "E_PYTHON_TOOL_START_FAILED",
      message: `Python tool runner environment failed: ${runnerImportError ?? error.message}`,
      retryable: false
    });
  }
  const stderrPreview = stderr.trim().slice(0, 300);
  const message = stderrPreview ? `${error.message} stderr=${stderrPreview}` : error.message;
  return new AgentError({
    code: error.code,
    message,
    retryable: error.retryable
  });
}

function detectRunnerImportError(stderr: string): string | undefined {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/ModuleNotFoundError:\s+No module named ['"]src['"]/i.test(trimmed)) {
    return undefined;
  }
  return trimmed.slice(0, 300);
}
