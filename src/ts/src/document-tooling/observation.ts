import { AgentError } from "../core/errors.js";
import type { DocumentIR, Tool, ToolExecutionInput, ToolExecutionOutput } from "../core/types.js";
import { parseDocxToState } from "../tools/docx-observation-tool.js";
import type {
  PythonDocxObservationState,
  PythonToolClientDeps
} from "../tools/python-tool-client.js";

export interface DocumentObservationDeps extends PythonToolClientDeps {
  pythonObserveDocument?: (
    docxPath: string,
    options?: PythonToolClientDeps
  ) => Promise<PythonDocxObservationState>;
  nativeObserveDocument?: (docxPath: string) => Promise<PythonDocxObservationState>;
}

export async function parseDocxPackage(
  docxPath: string,
  deps: DocumentObservationDeps = {}
): Promise<PythonDocxObservationState> {
  const observe = deps.nativeObserveDocument ?? nativeObserveDocument;
  return await observe(docxPath);
}

export function projectDocxObservation(
  doc: DocumentIR,
  observation: PythonDocxObservationState
): ToolExecutionOutput {
  return attachObservationToDocument(doc, observation);
}

export async function observeDocument(
  docxPath: string,
  deps: DocumentObservationDeps = {}
): Promise<PythonDocxObservationState> {
  return await parseDocxPackage(docxPath, deps);
}

export function createDocxObservationTool(
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
      return projectDocxObservation(input.doc, observation);
    }
  };
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
    docxObservation: observation,
    docxPackageModel: observation.package_model
  };
  return {
    doc: nextDoc,
    summary: `Observed docx package: parts=${observation.package_meta.part_count}, inline_nodes=${observation.inline_nodes.length}`
  };
}
