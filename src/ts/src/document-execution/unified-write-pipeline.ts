import { AgentError } from "../core/errors.js";
import type {
  DocumentIR,
  Executor,
  ExecutorOptions,
  NodeSelector,
  Operation,
  OperationType,
  Plan,
  Validator
} from "../core/types.js";
import type { DocumentStructureIndex, StructuredParagraph } from "../runtime/document-state.js";
import { compileOperationToPatchSet } from "../tools/docx-patching.js";
import type { DocxPatchSet } from "../tools/docx-observation-schema.js";

export interface SelectorTargetAnalysis {
  matchedParagraphIds: string[];
  missingParagraphIds: string[];
  unwritableParagraphIds: string[];
  skippedParagraphIds: string[];
  skipReason?: "no_writable_runs";
  targetNodeIds: string[];
  patchTargetIds: string[];
  patchPartPaths: string[];
  missingNodeIds: string[];
}

export type WriteTargetSpec =
  | { kind: "selector"; selector: NodeSelector }
  | { kind: "paragraph_ids"; paragraphIds: string[] }
  | { kind: "node_ids"; nodeIds: string[] }
  | { kind: "patch_targets"; patchTargetIds: string[]; patchPartPaths?: string[] };

export interface WriteIntent {
  id: string;
  type: OperationType;
  payload: Record<string, unknown>;
  target: WriteTargetSpec;
}

export interface PreparedWriteOperation {
  intent: WriteIntent;
  operation: Operation;
  targetAnalysis: SelectorTargetAnalysis;
  patchSet: DocxPatchSet;
  patchTargetIds: string[];
  patchPartPaths: string[];
  patchTargetCount: number;
}

export interface UnifiedWritePipelineInput extends ExecutorOptions {
  doc: DocumentIR;
  intents: WriteIntent[];
  taskId?: string;
  goal?: string;
  materialize?: boolean;
}

export interface UnifiedWritePipelineResult {
  operations: Operation[];
  preparedOperations: PreparedWriteOperation[];
  executionResult: Awaited<ReturnType<Executor["execute"]>>;
  artifacts?: Record<string, unknown>;
  materializeResult?: {
    doc: DocumentIR;
    summary: string;
    artifacts?: Record<string, unknown>;
  };
  finalDoc: DocumentIR;
  changeSummary: string;
}

export interface UnifiedWritePipelineDeps {
  executor: Executor;
  validator: Validator;
  materializeDocument?: (
    doc: DocumentIR
  ) => Promise<{ doc: DocumentIR; summary: string; artifacts?: Record<string, unknown> }>;
}

export function resolveSelectorTargets(doc: DocumentIR, selector: NodeSelector): string[] {
  return analyzeSelectorTargets(doc, selector).targetNodeIds;
}

export function analyzeSelectorTargets(doc: DocumentIR, selector: NodeSelector): SelectorTargetAnalysis {
  return analyzeWriteTargetSpec(doc, { kind: "selector", selector });
}

export function analyzeWriteTargetSpec(doc: DocumentIR, target: WriteTargetSpec): SelectorTargetAnalysis {
  switch (target.kind) {
    case "selector":
      return analyzeSelectorTarget(doc, target.selector);
    case "paragraph_ids":
      return analyzeParagraphTargets(doc, target.paragraphIds);
    case "node_ids":
      return analyzeNodeTargets(doc, target.nodeIds);
    case "patch_targets":
      return analyzePatchTargets(target.patchTargetIds, target.patchPartPaths);
  }
}

export function bindWriteIntentToOperations(doc: DocumentIR, intent: WriteIntent): Operation[] {
  const analysis = analyzeWriteTargetSpec(doc, intent.target);
  assertExecutableWriteTarget(intent, analysis);

  if (intent.target.kind === "patch_targets") {
    return [
      {
        id: intent.id,
        type: intent.type,
        ...(analysis.patchTargetIds.length > 0 ? { patchTargetIds: analysis.patchTargetIds } : {}),
        ...(analysis.patchPartPaths.length > 0 ? { patchPartPaths: analysis.patchPartPaths } : {}),
        payload: intent.payload
      }
    ];
  }

  const sourceTargetSelector = toSourceTargetSelector(intent.target);
  const patchTargetIds =
    analysis.patchTargetIds.length > 0
      ? analysis.patchTargetIds
      : analysis.targetNodeIds.map((targetNodeId) => `target:inline:${targetNodeId}`);
  const patchPartPaths =
    analysis.patchPartPaths.length > 0 ? analysis.patchPartPaths : readPatchPartPaths(doc, analysis.targetNodeIds);
  const targetNodeIds = analysis.targetNodeIds;

  if (targetNodeIds.length === 1) {
    return [
      {
        id: intent.id,
        type: intent.type,
        targetNodeId: targetNodeIds[0],
        ...(patchTargetIds.length > 0 ? { patchTargetIds } : {}),
        ...(patchPartPaths.length > 0 ? { patchPartPaths } : {}),
        ...(sourceTargetSelector ? { sourceTargetSelector } : {}),
        payload: intent.payload
      }
    ];
  }

  if (isBatchableWriteOperation(intent.type)) {
    return [
      {
        id: intent.id,
        type: intent.type,
        targetNodeIds,
        ...(patchTargetIds.length > 0 ? { patchTargetIds } : {}),
        ...(patchPartPaths.length > 0 ? { patchPartPaths } : {}),
        ...(sourceTargetSelector ? { sourceTargetSelector } : {}),
        payload: intent.payload
      }
    ];
  }

  return targetNodeIds.map((targetNodeId, index) => ({
    id: `${intent.id}__${index + 1}`,
    type: intent.type,
    targetNodeId,
    patchTargetIds: [`target:inline:${targetNodeId}`],
    ...(patchPartPaths.length > 0 ? { patchPartPaths } : {}),
    ...(sourceTargetSelector ? { sourceTargetSelector } : {}),
    payload: intent.payload
  }));
}

export function prepareWriteIntents(doc: DocumentIR, intents: WriteIntent[]): PreparedWriteOperation[] {
  const prepared: PreparedWriteOperation[] = [];
  for (const intent of intents) {
    const operations = bindWriteIntentToOperations(doc, intent);
    for (const operation of operations) {
      const compiled = compileOperationToPatchSet(doc, operation);
      prepared.push({
        intent,
        operation,
        targetAnalysis: analyzeWriteTargetSpec(doc, intent.target),
        patchSet: compiled.patchSet,
        patchTargetIds: compiled.patchTargetIds,
        patchPartPaths: compiled.partPaths,
        patchTargetCount: compiled.targetCount
      });
    }
  }
  return prepared;
}

export async function runUnifiedWritePipeline(
  input: UnifiedWritePipelineInput,
  deps: UnifiedWritePipelineDeps
): Promise<UnifiedWritePipelineResult> {
  const preparedOperations = prepareWriteIntents(input.doc, input.intents);
  const artifacts = buildPipelineArtifacts(preparedOperations);
  const operations = preparedOperations.map((item) => item.operation);
  const plan: Plan = {
    taskId: input.taskId ?? `write:${input.doc.id}`,
    goal: input.goal ?? "run_unified_write_pipeline",
    steps: operations.map((operation) => ({
      id: operation.id,
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: `write:${operation.id}`,
      operation
    }))
  };

  await deps.validator.preValidate(plan, input.doc);
  const executionResult = await deps.executor.execute(plan, input.doc, input);
  if (executionResult.status !== "completed") {
    return {
      operations,
      preparedOperations,
      executionResult,
      ...(artifacts ? { artifacts } : {}),
      finalDoc: executionResult.finalDoc,
      changeSummary: executionResult.summary
    };
  }

  await deps.validator.postValidate(executionResult.changeSet, executionResult.finalDoc);
  let materializeResult:
    | {
        doc: DocumentIR;
        summary: string;
        artifacts?: Record<string, unknown>;
      }
    | undefined;
  let finalDoc = executionResult.finalDoc;
  let changeSummary = executionResult.summary;

  if (input.materialize && deps.materializeDocument) {
    materializeResult = await deps.materializeDocument(executionResult.finalDoc);
    finalDoc = materializeResult.doc;
    changeSummary = joinSummaries(executionResult.summary, materializeResult.summary);
  }

  return {
    operations,
    preparedOperations,
    executionResult,
    ...(artifacts ? { artifacts } : {}),
    materializeResult,
    finalDoc,
    changeSummary
  };
}

export function operationToWriteIntent(operation: Operation): WriteIntent {
  if (operation.targetSelector) {
    return {
      id: operation.id,
      type: operation.type,
      payload: operation.payload,
      target: {
        kind: "selector",
        selector: operation.targetSelector
      }
    };
  }

  if (Array.isArray(operation.patchTargetIds) && operation.patchTargetIds.length > 0) {
    return {
      id: operation.id,
      type: operation.type,
      payload: operation.payload,
      target: {
        kind: "patch_targets",
        patchTargetIds: operation.patchTargetIds,
        patchPartPaths: operation.patchPartPaths
      }
    };
  }

  const targetNodeIds = unique([
    ...(operation.targetNodeId ? [operation.targetNodeId] : []),
    ...(operation.targetNodeIds ?? [])
  ]);
  if (targetNodeIds.length > 0) {
    return {
      id: operation.id,
      type: operation.type,
      payload: operation.payload,
      target: {
        kind: "node_ids",
        nodeIds: targetNodeIds
      }
    };
  }

  return {
    id: operation.id,
    type: operation.type,
    payload: operation.payload,
    target: {
      kind: "patch_targets",
      patchTargetIds: operation.patchTargetIds ?? [],
      patchPartPaths: operation.patchPartPaths
    }
  };
}

function analyzeSelectorTarget(doc: DocumentIR, selector: NodeSelector): SelectorTargetAnalysis {
  if (selector.scope === "all_text") {
    const targetNodeIds = doc.nodes.map((node) => node.id);
    return {
      matchedParagraphIds: [],
      missingParagraphIds: [],
      unwritableParagraphIds: [],
      skippedParagraphIds: [],
      targetNodeIds,
      patchTargetIds: targetNodeIds.map((targetNodeId) => `target:inline:${targetNodeId}`),
      patchPartPaths: readPatchPartPaths(doc, targetNodeIds),
      missingNodeIds: []
    };
  }

  const structure = readStructureIndex(doc);
  if (!structure) {
    return emptyTargetAnalysis();
  }

  let paragraphs: StructuredParagraph[] = [];
  let missingParagraphIds: string[] = [];
  switch (selector.scope) {
    case "body":
      paragraphs = structure.paragraphs.filter((paragraph) => paragraph.role === "body");
      break;
    case "heading":
      paragraphs = structure.paragraphs.filter(
        (paragraph) =>
          paragraph.role === "heading" &&
          (selector.headingLevel === undefined || paragraph.headingLevel === selector.headingLevel)
      );
      break;
    case "list_item":
      paragraphs = structure.paragraphs.filter((paragraph) => paragraph.role === "list_item");
      break;
    case "paragraph_ids": {
      const paragraphIds = selector.paragraphIds ?? [];
      const paragraphById = new Map(structure.paragraphs.map((paragraph) => [paragraph.id, paragraph] as const));
      paragraphs = paragraphIds
        .map((paragraphId) => paragraphById.get(paragraphId))
        .filter((paragraph): paragraph is StructuredParagraph => Boolean(paragraph));
      missingParagraphIds = paragraphIds.filter((paragraphId) => !paragraphById.has(paragraphId));
      break;
    }
  }

  return buildParagraphAnalysis(doc, paragraphs, missingParagraphIds);
}

function analyzeParagraphTargets(doc: DocumentIR, paragraphIds: string[]): SelectorTargetAnalysis {
  const structure = readStructureIndex(doc);
  if (!structure) {
    return emptyTargetAnalysis();
  }
  const paragraphById = new Map(structure.paragraphs.map((paragraph) => [paragraph.id, paragraph] as const));
  const paragraphs = unique(paragraphIds)
    .map((paragraphId) => paragraphById.get(paragraphId))
    .filter((paragraph): paragraph is StructuredParagraph => Boolean(paragraph));
  const missingParagraphIds = unique(paragraphIds).filter((paragraphId) => !paragraphById.has(paragraphId));
  return buildParagraphAnalysis(doc, paragraphs, missingParagraphIds);
}

function analyzeNodeTargets(doc: DocumentIR, nodeIds: string[]): SelectorTargetAnalysis {
  const uniqueNodeIds = unique(nodeIds);
  const availableNodeIds = new Set(doc.nodes.map((node) => node.id));
  const targetNodeIds = uniqueNodeIds.filter((nodeId) => availableNodeIds.has(nodeId));
  return {
    matchedParagraphIds: readParagraphIdsForRunTargets(doc, targetNodeIds),
    missingParagraphIds: [],
    unwritableParagraphIds: [],
    skippedParagraphIds: [],
    targetNodeIds,
    patchTargetIds: targetNodeIds.map((targetNodeId) => `target:inline:${targetNodeId}`),
    patchPartPaths: readPatchPartPaths(doc, targetNodeIds),
    missingNodeIds: uniqueNodeIds.filter((nodeId) => !availableNodeIds.has(nodeId))
  };
}

function analyzePatchTargets(patchTargetIds: string[], patchPartPaths: string[] | undefined): SelectorTargetAnalysis {
  return {
    matchedParagraphIds: [],
    missingParagraphIds: [],
    unwritableParagraphIds: [],
    skippedParagraphIds: [],
    targetNodeIds: [],
    patchTargetIds: unique(patchTargetIds),
    patchPartPaths: unique((patchPartPaths ?? []).filter((partPath) => typeof partPath === "string" && partPath.length > 0)),
    missingNodeIds: []
  };
}

function buildParagraphAnalysis(
  doc: DocumentIR,
  paragraphs: StructuredParagraph[],
  missingParagraphIds: string[]
): SelectorTargetAnalysis {
  const availableNodeIds = new Set(doc.nodes.map((node) => node.id));
  const paragraphByRunId = new Map<string, StructuredParagraph>();
  for (const paragraph of paragraphs) {
    for (const runNodeId of paragraph.runNodeIds) {
      paragraphByRunId.set(runNodeId, paragraph);
    }
  }

  const targetNodeIds = unique(
    paragraphs.flatMap((paragraph) => paragraph.runNodeIds.filter((runNodeId) => availableNodeIds.has(runNodeId)))
  );
  const unwritableParagraphIds = paragraphs
    .filter((paragraph) => !paragraph.runNodeIds.some((runNodeId) => availableNodeIds.has(runNodeId)))
    .map((paragraph) => paragraph.id);
  return {
    matchedParagraphIds: paragraphs.map((paragraph) => paragraph.id),
    missingParagraphIds,
    unwritableParagraphIds,
    skippedParagraphIds: unwritableParagraphIds,
    ...(unwritableParagraphIds.length > 0 ? { skipReason: "no_writable_runs" as const } : {}),
    targetNodeIds,
    patchTargetIds: targetNodeIds.map((targetNodeId) => `target:inline:${targetNodeId}`),
    patchPartPaths: unique(
      targetNodeIds.map((targetNodeId) => paragraphByRunId.get(targetNodeId)?.partPath ?? "word/document.xml")
    ),
    missingNodeIds: []
  };
}

function assertExecutableWriteTarget(intent: WriteIntent, analysis: SelectorTargetAnalysis): void {
  if (intent.type === "set_page_layout") {
    return;
  }

  if (intent.target.kind === "patch_targets") {
    if (analysis.patchTargetIds.length === 0) {
      throw new AgentError({
        code: "E_INVALID_TARGET",
        message: `Write target ${describeTargetSpec(intent.target)} matched no patch targets.`,
        retryable: false
      });
    }
    return;
  }

  if (analysis.missingParagraphIds.length > 0) {
    throw new AgentError({
      code: "E_INVALID_TARGET",
      message: `Write target ${describeTargetSpec(intent.target)} includes unknown paragraph ids: ${analysis.missingParagraphIds.join(", ")}.`,
      retryable: false
    });
  }

  if (analysis.missingNodeIds.length > 0) {
    throw new AgentError({
      code: "E_INVALID_TARGET",
      message: `Write target ${describeTargetSpec(intent.target)} includes unknown node ids: ${analysis.missingNodeIds.join(", ")}.`,
      retryable: false
    });
  }

  if (analysis.targetNodeIds.length === 0) {
    if (analysis.matchedParagraphIds.length > 0 && analysis.skippedParagraphIds.length === analysis.matchedParagraphIds.length) {
      throw new AgentError({
        code: "E_SELECTOR_TARGETS_EMPTY",
        message:
          `Write target ${describeTargetSpec(intent.target)} matched paragraphs but found no writable targets after filtering: ` +
          `${analysis.skippedParagraphIds.join(", ")}.`,
        retryable: false
      });
    }
    throw new AgentError({
      code: "E_SELECTOR_TARGETS_EMPTY",
      message: `Write target ${describeTargetSpec(intent.target)} matched no document nodes.`,
      retryable: false
    });
  }
}

function readParagraphIdsForRunTargets(doc: DocumentIR, targetNodeIds: string[]): string[] {
  const structure = readStructureIndex(doc);
  if (!structure) {
    return [];
  }
  const paragraphIds = new Set<string>();
  for (const paragraph of structure.paragraphs) {
    if (paragraph.runNodeIds.some((runNodeId) => targetNodeIds.includes(runNodeId))) {
      paragraphIds.add(paragraph.id);
    }
  }
  return [...paragraphIds];
}

function readPatchPartPaths(doc: DocumentIR, targetNodeIds: string[]): string[] {
  const structure = readStructureIndex(doc);
  const paragraphByRunId = new Map<string, StructuredParagraph>();
  for (const paragraph of structure?.paragraphs ?? []) {
    for (const runNodeId of paragraph.runNodeIds) {
      paragraphByRunId.set(runNodeId, paragraph);
    }
  }
  return unique(
    targetNodeIds
      .map((targetNodeId) => paragraphByRunId.get(targetNodeId)?.partPath ?? "word/document.xml")
      .filter((partPath) => typeof partPath === "string" && partPath.length > 0)
  );
}

function readStructureIndex(doc: DocumentIR): DocumentStructureIndex | undefined {
  const structureIndex = doc.metadata?.structureIndex;
  if (!structureIndex || typeof structureIndex !== "object") {
    return undefined;
  }
  const candidate = structureIndex as Partial<DocumentStructureIndex>;
  if (!Array.isArray(candidate.paragraphs)) {
    return undefined;
  }
  return candidate as DocumentStructureIndex;
}

function isBatchableWriteOperation(type: OperationType): boolean {
  return type !== "merge_paragraph" && type !== "split_paragraph";
}

function toSourceTargetSelector(target: WriteTargetSpec): NodeSelector | undefined {
  if (target.kind === "selector") {
    return target.selector;
  }
  if (target.kind === "paragraph_ids") {
    return {
      scope: "paragraph_ids",
      paragraphIds: target.paragraphIds
    };
  }
  return undefined;
}

function describeTargetSpec(target: WriteTargetSpec): string {
  if (target.kind === "selector") {
    return describeSelector(target.selector);
  }
  if (target.kind === "paragraph_ids") {
    return `paragraph_ids(${target.paragraphIds.join(",")})`;
  }
  if (target.kind === "node_ids") {
    return `node_ids(${target.nodeIds.join(",")})`;
  }
  return `patch_targets(${target.patchTargetIds.join(",")})`;
}

function describeSelector(selector: NodeSelector): string {
  if (selector.scope === "heading" && selector.headingLevel !== undefined) {
    return `heading(level=${selector.headingLevel})`;
  }
  if (selector.scope === "paragraph_ids") {
    return `paragraph_ids(${(selector.paragraphIds ?? []).join(",")})`;
  }
  return selector.scope;
}

function emptyTargetAnalysis(): SelectorTargetAnalysis {
  return {
    matchedParagraphIds: [],
    missingParagraphIds: [],
    unwritableParagraphIds: [],
    skippedParagraphIds: [],
    targetNodeIds: [],
    patchTargetIds: [],
    patchPartPaths: [],
    missingNodeIds: []
  };
}

function buildPipelineArtifacts(preparedOperations: PreparedWriteOperation[]): Record<string, unknown> | undefined {
  const skippedParagraphIds = unique(
    preparedOperations.flatMap((preparedOperation) => preparedOperation.targetAnalysis.skippedParagraphIds)
  );
  if (skippedParagraphIds.length === 0) {
    return undefined;
  }
  return {
    skipped_paragraph_ids: skippedParagraphIds,
    skipped_paragraph_count: skippedParagraphIds.length
  };
}

function joinSummaries(...values: Array<string | undefined>): string {
  return values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)).join("\n");
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
