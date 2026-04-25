import { AgentError } from "../core/errors.js";
import type { DocumentIR, Tool, ToolExecutionInput, ToolExecutionOutput } from "../core/types.js";
import { normalizeWriteOperationPayload } from "./style-operation.js";
import { runPythonTool, type PythonToolClientDeps } from "./python-tool-client.js";

export interface PythonToolProxyOptions extends PythonToolClientDeps {
  name: string;
  readOnly: boolean;
  validate?: (input: ToolExecutionInput) => Promise<void> | void;
}

export class PythonToolProxy implements Tool {
  readonly name: string;
  readonly readOnly: boolean;
  private readonly validateFn?: (input: ToolExecutionInput) => Promise<void> | void;
  private readonly deps: PythonToolClientDeps;

  constructor(options: PythonToolProxyOptions) {
    this.name = options.name;
    this.readOnly = options.readOnly;
    this.validateFn = options.validate;
    this.deps = {
      pythonBin: options.pythonBin,
      runnerPath: options.runnerPath,
      timeoutMs: options.timeoutMs,
      cwd: options.cwd
    };
  }

  async validate(input: ToolExecutionInput): Promise<void> {
    await this.validateFn?.(input);
  }

  async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    const result = await runPythonTool<unknown>(
      {
        action: "execute",
        toolName: this.name,
        input
      },
      this.deps
    );
    return asToolExecutionOutput(result, this.name);
  }

  async rollback(rollbackToken: string, doc: DocumentIR): Promise<DocumentIR> {
    const result = await runPythonTool<unknown>(
      {
        action: "rollback",
        toolName: this.name,
        rollbackToken,
        doc
      },
      this.deps
    );
    return asDocument(result, this.name);
  }
}

export function buildInspectDocumentTool(options: PythonToolClientDeps = {}): Tool {
  return new PythonToolProxy({
    ...options,
    name: "inspect_document",
    readOnly: true
  });
}

export function buildDocxObservationTool(options: PythonToolClientDeps = {}): Tool {
  return new PythonToolProxy({
    ...options,
    name: "docx_observation",
    readOnly: true,
    validate: validateDocxObservationInput
  });
}

export function buildWriteOperationTool(options: PythonToolClientDeps = {}): Tool {
  return new PythonToolProxy({
    ...options,
    name: "write_operation",
    readOnly: false,
    validate: validateWriteOperationInput
  });
}

function validateDocxObservationInput(input: ToolExecutionInput): void {
  const docxPath = input.operation?.payload?.docxPath;
  if (typeof docxPath !== "string" || !docxPath.trim()) {
    throw new AgentError({
      code: "E_INVALID_DOCX_PATH",
      message: "docx_observation requires operation.payload.docxPath",
      retryable: false
    });
  }
}

function validateWriteOperationInput(input: ToolExecutionInput): void {
  if (!input.operation) {
    throw new AgentError({
      code: "E_INVALID_OPERATION",
      message: "Write operation is required.",
      retryable: false
    });
  }
  if (input.operation.type === "set_page_layout") {
    normalizeWriteOperationPayload(input.operation);
    return;
  }
  if (!input.operation.targetNodeId && !input.operation.targetNodeIds?.length) {
    throw new AgentError({
      code: "E_INVALID_OPERATION",
      message: "Write operation requires targetNodeId or targetNodeIds after selector expansion.",
      retryable: false
    });
  }
  normalizeWriteOperationPayload(input.operation);
}

function asToolExecutionOutput(value: unknown, toolName: string): ToolExecutionOutput {
  if (!value || typeof value !== "object") {
    throw invalidPythonOutput(toolName);
  }
  const result = value as Partial<ToolExecutionOutput>;
  if (!result.doc || typeof result.doc !== "object" || typeof result.summary !== "string") {
    throw invalidPythonOutput(toolName);
  }
  return result as ToolExecutionOutput;
}

function asDocument(value: unknown, toolName: string): DocumentIR {
  if (!value || typeof value !== "object" || !("nodes" in value)) {
    throw invalidPythonOutput(toolName);
  }
  return value as DocumentIR;
}

function invalidPythonOutput(toolName: string): AgentError {
  return new AgentError({
    code: "E_PYTHON_TOOL_FAILED",
    message: `Python tool ${toolName} returned invalid output shape.`,
    retryable: true
  });
}
