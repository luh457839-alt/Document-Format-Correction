import type { DocumentIR, Tool } from "../core/types.js";
import {
  materializeDocumentWithPython,
  type PythonDocxObservationState,
  type PythonToolClientDeps
} from "../tools/python-tool-client.js";
import {
  buildInspectDocumentTool,
  buildWriteOperationTool
} from "../tools/python-tool-proxy.js";
import {
  createDocxObservationToolWithFallback,
  observeDocumentWithFallback,
  type DocumentObservationDeps
} from "./observation.js";

export interface DocumentToolingFacade {
  observeDocument(docxPath: string, options?: PythonToolClientDeps): Promise<PythonDocxObservationState>;
  materializeDocument(
    doc: DocumentIR,
    options?: PythonToolClientDeps
  ): Promise<{ doc: DocumentIR; summary: string; artifacts?: Record<string, unknown> }>;
  createInspectDocumentTool(options?: PythonToolClientDeps): Tool;
  createDocxObservationTool(options?: PythonToolClientDeps): Tool;
  createWriteOperationTool(options?: PythonToolClientDeps): Tool;
}

export interface DocumentToolingFacadeDeps extends DocumentObservationDeps {
  observeDocument?: (
    docxPath: string,
    options?: PythonToolClientDeps
  ) => Promise<PythonDocxObservationState>;
  materializeDocument?: (
    doc: DocumentIR,
    options?: PythonToolClientDeps
  ) => Promise<{ doc: DocumentIR; summary: string; artifacts?: Record<string, unknown> }>;
  inspectDocumentToolFactory?: (options?: PythonToolClientDeps) => Tool;
  docxObservationToolFactory?: (options?: PythonToolClientDeps) => Tool;
  writeOperationToolFactory?: (options?: PythonToolClientDeps) => Tool;
}

export function createDocumentToolingFacade(deps: DocumentToolingFacadeDeps = {}): DocumentToolingFacade {
  const baseOptions: PythonToolClientDeps = {
    pythonBin: deps.pythonBin,
    runnerPath: deps.runnerPath,
    timeoutMs: deps.timeoutMs,
    cwd: deps.cwd
  };
  const withBaseOptions = (override?: PythonToolClientDeps): PythonToolClientDeps | undefined => {
    const merged = {
      ...baseOptions,
      ...(override ?? {})
    };
    return Object.values(merged).some((value) => value !== undefined) ? merged : undefined;
  };
  const buildObservationDeps = (override?: PythonToolClientDeps): DocumentObservationDeps => ({
    ...withBaseOptions(override),
    ...(deps.pythonObserveDocument ? { pythonObserveDocument: deps.pythonObserveDocument } : {}),
    ...(deps.nativeObserveDocument ? { nativeObserveDocument: deps.nativeObserveDocument } : {})
  });

  return {
    observeDocument: async (docxPath, options) =>
      await (deps.observeDocument
        ? deps.observeDocument(docxPath, withBaseOptions(options))
        : observeDocumentWithFallback(docxPath, buildObservationDeps(options))),
    materializeDocument: async (doc, options) =>
      await (deps.materializeDocument ?? materializeDocumentWithPython)(doc, withBaseOptions(options)),
    createInspectDocumentTool: (options) =>
      (deps.inspectDocumentToolFactory ?? buildInspectDocumentTool)(withBaseOptions(options)),
    createDocxObservationTool: (options) =>
      deps.docxObservationToolFactory?.(withBaseOptions(options)) ??
      createDocxObservationToolWithFallback(
        async (docxPath, override) =>
          await (deps.observeDocument
            ? deps.observeDocument(docxPath, withBaseOptions({ ...withBaseOptions(options), ...(override ?? {}) }))
            : observeDocumentWithFallback(docxPath, buildObservationDeps({ ...withBaseOptions(options), ...(override ?? {}) }))),
        withBaseOptions(options)
      ),
    createWriteOperationTool: (options) =>
      (deps.writeOperationToolFactory ?? buildWriteOperationTool)(withBaseOptions(options))
  };
}
