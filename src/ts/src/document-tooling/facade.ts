import type { DocumentIR, Tool } from "../core/types.js";
import {
  materializeDocumentWithPython,
  type PythonDocxObservationState,
  type PythonToolClientDeps
} from "../tools/python-tool-client.js";
import {
  ApplyDocxXmlPatchTool,
  materializeDocxPackage,
  PatchFirstWriteOperationTool
} from "../tools/docx-patching.js";
import {
  buildInspectDocumentTool
} from "../tools/python-tool-proxy.js";
import {
  createDocxObservationTool,
  observeDocument,
  parseDocxPackage,
  projectDocxObservation,
  type DocumentObservationDeps
} from "./observation.js";

export interface DocumentToolingFacade {
  parseDocxPackage(docxPath: string, options?: PythonToolClientDeps): Promise<PythonDocxObservationState>;
  projectDocxObservation(doc: DocumentIR, observation: PythonDocxObservationState): ToolExecutionFacadeProjection;
  observeDocument(docxPath: string, options?: PythonToolClientDeps): Promise<PythonDocxObservationState>;
  materializeDocument(
    doc: DocumentIR,
    options?: PythonToolClientDeps
  ): Promise<{ doc: DocumentIR; summary: string; artifacts?: Record<string, unknown> }>;
  createInspectDocumentTool(options?: PythonToolClientDeps): Tool;
  createDocxObservationTool(options?: PythonToolClientDeps): Tool;
  createApplyDocxXmlPatchTool(): Tool;
  createWriteOperationTool(options?: PythonToolClientDeps): Tool;
}

interface ToolExecutionFacadeProjection {
  doc: DocumentIR;
  summary: string;
  rollbackToken?: string;
  artifacts?: Record<string, unknown>;
}

export interface DocumentToolingFacadeDeps extends DocumentObservationDeps {
  parseDocxPackage?: (
    docxPath: string,
    options?: PythonToolClientDeps
  ) => Promise<PythonDocxObservationState>;
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
  applyDocxXmlPatchToolFactory?: () => Tool;
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
    parseDocxPackage: async (docxPath, options) =>
      await (deps.parseDocxPackage
        ? deps.parseDocxPackage(docxPath, withBaseOptions(options))
        : parseDocxPackage(docxPath, buildObservationDeps(options))),
    projectDocxObservation: (doc, observation) => projectDocxObservation(doc, observation),
    observeDocument: async (docxPath, options) =>
      await (deps.observeDocument
        ? deps.observeDocument(docxPath, withBaseOptions(options))
        : observeDocument(docxPath, buildObservationDeps(options))),
    materializeDocument: async (doc, options) =>
      await (deps.materializeDocument
        ? deps.materializeDocument(doc, withBaseOptions(options))
        : shouldMaterializeWithPatchPackage(doc)
          ? materializeDocxPackage(doc)
          : materializeDocumentWithPython(doc, withBaseOptions(options))),
    createInspectDocumentTool: (options) =>
      (deps.inspectDocumentToolFactory ?? buildInspectDocumentTool)(withBaseOptions(options)),
    createDocxObservationTool: (options) =>
      deps.docxObservationToolFactory?.(withBaseOptions(options)) ??
      createDocxObservationTool(
        async (docxPath, override) =>
          await (deps.observeDocument
            ? deps.observeDocument(docxPath, withBaseOptions({ ...withBaseOptions(options), ...(override ?? {}) }))
            : observeDocument(docxPath, buildObservationDeps({ ...withBaseOptions(options), ...(override ?? {}) }))),
        withBaseOptions(options)
      ),
    createApplyDocxXmlPatchTool: () =>
      deps.applyDocxXmlPatchToolFactory?.() ?? new ApplyDocxXmlPatchTool(),
    createWriteOperationTool: (options) =>
      (deps.writeOperationToolFactory ?? (() => new PatchFirstWriteOperationTool()))(withBaseOptions(options))
  };
}

function shouldMaterializeWithPatchPackage(doc: DocumentIR): boolean {
  const metadata = doc.metadata;
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  const inputDocxPath = (metadata as Record<string, unknown>).inputDocxPath;
  const docxObservation = (metadata as Record<string, unknown>).docxObservation;
  return typeof inputDocxPath === "string" && inputDocxPath.trim().length > 0 && Boolean(docxObservation);
}
