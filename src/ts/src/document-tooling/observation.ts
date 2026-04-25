import { AgentError } from "../core/errors.js";
import type { DocumentIR, Tool, ToolExecutionInput, ToolExecutionOutput } from "../core/types.js";
import { parseDocxToState } from "../tools/docx-observation-tool.js";
import {
  observeDocxStateWithPython,
  type PythonDocxObservationState,
  type PythonToolClientDeps
} from "../tools/python-tool-client.js";
import { shouldFallbackToNativeDocxObservation } from "./observation-policy.js";

export interface DocumentObservationDeps extends PythonToolClientDeps {
  pythonObserveDocument?: (
    docxPath: string,
    options?: PythonToolClientDeps
  ) => Promise<PythonDocxObservationState>;
  nativeObserveDocument?: (docxPath: string) => Promise<PythonDocxObservationState>;
}

export async function observeDocumentWithFallback(
  docxPath: string,
  deps: DocumentObservationDeps = {}
): Promise<PythonDocxObservationState> {
  try {
    return await (deps.pythonObserveDocument ?? observeDocxStateWithPython)(docxPath, buildPythonOptions(deps));
  } catch (err) {
    if (!shouldFallbackToNativeDocxObservation(err)) {
      throw err;
    }
    return await (deps.nativeObserveDocument ?? nativeObserveDocument)(docxPath);
  }
}

export function createDocxObservationToolWithFallback(
  observeDocument: (docxPath: string, options?: PythonToolClientDeps) => Promise<PythonDocxObservationState>,
  options?: PythonToolClientDeps
): Tool {
  return {
    name: "docx_observation",
    readOnly: true,
    validate: async (input) => {
      validateDocxObservationInput(input);
    },
    execute: async (input) => {
      validateDocxObservationInput(input);
      const docxPath = String(input.operation?.payload?.docxPath ?? "").trim();
      const observation = await observeDocument(docxPath, options);
      return attachObservationToDocument(input.doc, observation);
    }
  };
}

function buildPythonOptions(deps: PythonToolClientDeps): PythonToolClientDeps | undefined {
  const merged = {
    pythonBin: deps.pythonBin,
    runnerPath: deps.runnerPath,
    timeoutMs: deps.timeoutMs,
    cwd: deps.cwd
  };
  return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
}

async function nativeObserveDocument(docxPath: string): Promise<PythonDocxObservationState> {
  return await parseDocxToState({
    docxPath,
    allowFallback: false
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

function attachObservationToDocument(
  doc: DocumentIR,
  observation: PythonDocxObservationState
): ToolExecutionOutput {
  const nextDoc: DocumentIR = structuredClone(doc);
  nextDoc.metadata = {
    ...(nextDoc.metadata ?? {}),
    docxObservation: observation
  };
  return {
    doc: nextDoc,
    summary: `Observed docx: nodes=${observation.nodes.length}`
  };
}
