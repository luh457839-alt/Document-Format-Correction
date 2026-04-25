import { AgentError, asAppError } from "../core/errors.js";
import type { DocumentIR } from "../core/types.js";
import { createDocumentToolingFacade, type DocumentToolingFacade } from "../document-tooling/facade.js";
import { buildTemplateAtomicPlan } from "../templates/template-atomic-planner.js";
import { classifyTemplateParagraphs, normalizeTemplateClassificationResult } from "../templates/template-classifier.js";
import { loadTemplateConfig } from "../templates/template-config.js";
import { buildTemplateContextFromObservation } from "../templates/template-context-builder.js";
import { deriveTemplateOutputDocxPath, executeTemplateWritePlan } from "../templates/template-executor.js";
import { detectTemplateNumberingPrefix } from "../templates/template-numbering.js";
import { asTemplateStageError } from "../templates/template-stage-error.js";
import { validateTemplateClassification } from "../templates/template-validator.js";
import { buildTemplateWritePlan } from "../templates/template-write-planner.js";
import type {
  TemplateExecutionArtifacts,
  TemplateClassificationResult,
  TemplateContext,
  TemplateRunInput,
  TemplateRunReport,
  TemplateRunStageTimings,
  TemplateRunnerDeps,
  TemplateRunWarning,
  TemplateValidationIssue,
  TemplateWritePlanExecutionResult
} from "../templates/types.js";

export interface FixedFormatTemplateOrchestratorDeps extends TemplateRunnerDeps {
  toolingFacade?: DocumentToolingFacade;
}

export async function runFixedFormatTemplateOrchestrator(
  input: TemplateRunInput,
  deps: FixedFormatTemplateOrchestratorDeps = {}
): Promise<TemplateRunReport> {
  const tooling = deps.toolingFacade ?? createDocumentToolingFacade();
  const loadTemplate = deps.loadTemplate ?? loadTemplateConfig;
  const observeDocx = deps.observeDocx ?? ((docxPath: string) => tooling.observeDocument(docxPath));
  const buildWritePlan = deps.buildWritePlan ?? buildTemplateWritePlan;
  const executeWritePlan = deps.executeWritePlan ?? executeTemplateWritePlan;
  const materializeDoc = deps.materializeDoc ?? ((doc: DocumentIR) => tooling.materializeDocument(doc));
  const stageTimings = createEmptyStageTimings();
  const template = await loadTemplate(input.templatePath);
  const observationStartedAt = Date.now();
  let context: TemplateContext;
  try {
    const observation = await observeDocx(input.docxPath);
    context = buildTemplateContextFromObservation({
      docxPath: input.docxPath,
      observation
    });
  } catch (err) {
    stageTimings.observation_ms = elapsedMs(observationStartedAt);
    throw asTemplateStageError("observe_docx", err, stageTimings);
  }
  context.classificationInput.template_id = template.template_meta.id;
  stageTimings.observation_ms = elapsedMs(observationStartedAt);

  const classificationStartedAt = Date.now();
  let classification: TemplateClassificationResult;
  try {
    classification =
      deps.classifyParagraphs !== undefined
        ? await deps.classifyParagraphs({
            template,
            context,
            llm: input.llm
          })
        : await classifyTemplateParagraphs(
            {
              template,
              context,
              llm: input.llm
            },
            {
              env: deps.env,
              fetchImpl: deps.fetchImpl
            }
          );
  } catch (err) {
    stageTimings.classification_request_ms = elapsedMs(classificationStartedAt);
    throw asTemplateStageError("classification_request_failed", err, stageTimings);
  }
  classification = normalizeTemplateClassificationResult({
    template,
    context,
    classification
  });
  stageTimings.refinement_ms = readRefinementElapsedMs(classification);
  stageTimings.classification_request_ms = Math.max(
    0,
    elapsedMs(classificationStartedAt) - stageTimings.refinement_ms
  );

  const validationStartedAt = Date.now();
  const validation = validateTemplateClassification({
    template,
    context,
    classification
  });
  stageTimings.validation_ms = elapsedMs(validationStartedAt);
  if (!validation.passed) {
    return {
      status: "failed",
      template_meta: template.template_meta,
      stage_timings_ms: stageTimings,
      observation_summary: context.observationSummary,
      classification_result: classification,
      validation_result: validation,
      execution_plan: [],
      write_plan: [],
      execution_result: {
        applied: false,
        issues: validation.issues
      }
    };
  }

  const executionStartedAt = Date.now();
  const executionPlan = buildTemplateAtomicPlan({
    template,
    classification
  });
  const writePlanResult = buildWritePlan({
    template,
    executionPlan,
    document: context.document,
    structureIndex: context.structureIndex
  });
  if (writePlanResult.issues.length > 0) {
    stageTimings.execution_ms = elapsedMs(executionStartedAt);
    return {
      status: "failed",
      template_meta: template.template_meta,
      stage_timings_ms: stageTimings,
      observation_summary: context.observationSummary,
      classification_result: classification,
      validation_result: validation,
      execution_plan: executionPlan,
      write_plan: [],
      execution_result: {
        applied: false,
        issues: writePlanResult.issues
      }
    };
  }

  const outputDocxPath = deriveTemplateOutputDocxPath(input.docxPath);
  if (writePlanResult.writePlan.length > 0 && !outputDocxPath.trim()) {
    stageTimings.execution_ms = elapsedMs(executionStartedAt);
    return failedAfterExecution(
      template.template_meta,
      context.observationSummary,
      classification,
      validation,
      executionPlan,
      writePlanResult.writePlan,
      input.debug,
      stageTimings,
      new AgentError({
        code: "E_OUTPUT_PATH_REQUIRED",
        message: "template execution requires a non-empty output DOCX path",
        retryable: false
      })
    );
  }

  let executed;
  const executionContext = {
    ...context,
    document: writePlanResult.document,
    structureIndex: writePlanResult.structureIndex
  };
  try {
    executed = await executeWritePlan({
      context: executionContext,
      writePlan: writePlanResult.writePlan,
      outputDocxPath,
      debug: input.debug
    });
  } catch (err) {
    stageTimings.execution_ms = elapsedMs(executionStartedAt);
    return failedAfterExecution(
      template.template_meta,
      context.observationSummary,
      classification,
      validation,
      executionPlan,
      writePlanResult.writePlan,
      input.debug,
      stageTimings,
      err
    );
  }

  try {
    ensureMaterializeSourcePath(executed.finalDoc);
    const materialized = await materializeDoc(executed.finalDoc);
    const materializedOutputDocxPath = readOutputDocxPath(materialized.doc) ?? readOutputDocxPath(executed.finalDoc);
    const warnings = buildSuccessfulExecutionWarnings({
      template,
      context: executionContext,
      validation,
      executionPlan,
      writePlan: writePlanResult.writePlan
    });
    stageTimings.execution_ms = elapsedMs(executionStartedAt);
    return {
      status: "executed",
      template_meta: template.template_meta,
      stage_timings_ms: stageTimings,
      observation_summary: context.observationSummary,
      classification_result: classification,
      validation_result: validation,
      ...(warnings.length > 0 ? { warnings } : {}),
      execution_plan: executionPlan,
      write_plan: writePlanResult.writePlan,
      execution_result: {
        applied: true,
        ...(materializedOutputDocxPath ? { output_docx_path: materializedOutputDocxPath } : {}),
        change_summary: joinSummaries(executed.changeSummary, materialized.summary),
        artifacts: buildExecutionArtifacts({
          writeOperationCount: writePlanResult.writePlan.length,
          executedArtifacts: executed.artifacts,
          materialized: true,
          outputDocxPath: materializedOutputDocxPath,
          debug: input.debug,
          materializeArtifacts: materialized.artifacts
        }),
        issues: buildIgnoredUnknownSemanticTagIssues(classification)
      }
    };
  } catch (err) {
    stageTimings.execution_ms = elapsedMs(executionStartedAt);
    return failedAfterExecution(
      template.template_meta,
      context.observationSummary,
      classification,
      validation,
      executionPlan,
      writePlanResult.writePlan,
      input.debug,
      stageTimings,
      err,
      {
        changeSummary: executed.changeSummary,
        artifacts: executed.artifacts
      }
    );
  }
}

function failedAfterExecution(
  templateMeta: TemplateRunReport["template_meta"],
  observationSummary: TemplateRunReport["observation_summary"],
  classification: TemplateRunReport["classification_result"],
  validation: TemplateRunReport["validation_result"],
  executionPlan: TemplateRunReport["execution_plan"],
  writePlan: TemplateRunReport["write_plan"],
  debug: boolean | undefined,
  stageTimings: TemplateRunStageTimings,
  err: unknown,
  partial?: {
    changeSummary?: string;
    artifacts?: TemplateWritePlanExecutionResult["artifacts"];
  }
): TemplateRunReport {
  const info = asAppError(err, "E_TEMPLATE_EXECUTION_FAILED");
  return {
    status: "failed",
    template_meta: templateMeta,
    stage_timings_ms: stageTimings,
    observation_summary: observationSummary,
    classification_result: classification,
    validation_result: validation,
    execution_plan: executionPlan,
    write_plan: writePlan,
    execution_result: {
      applied: false,
      ...(partial?.changeSummary ? { change_summary: partial.changeSummary } : {}),
      ...(partial?.artifacts || writePlan.length > 0
        ? {
            artifacts: buildExecutionArtifacts({
              writeOperationCount: writePlan.length,
              executedArtifacts: partial?.artifacts,
              materialized: false,
              debug
            })
          }
        : {}),
      issues: [
        {
          error_code: info.code,
          message: info.message
        }
      ]
    }
  };
}

function createEmptyStageTimings(): TemplateRunStageTimings {
  return {
    observation_ms: 0,
    classification_request_ms: 0,
    refinement_ms: 0,
    validation_ms: 0,
    execution_ms: 0
  };
}

function readRefinementElapsedMs(classification: TemplateClassificationResult): number {
  return typeof classification.diagnostics?.refinement_elapsed_ms === "number"
    ? Math.max(0, classification.diagnostics.refinement_elapsed_ms)
    : 0;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function joinSummaries(...values: Array<string | undefined>): string | undefined {
  const parts = values.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function buildIgnoredUnknownSemanticTagIssues(
  classification: TemplateRunReport["classification_result"]
): TemplateValidationIssue[] {
  const ignoredMatches = classification.diagnostics?.ignored_unknown_semantic_matches ?? [];
  if (ignoredMatches.length === 0) {
    return [];
  }
  const counts = new Map<string, Set<string>>();
  for (const match of ignoredMatches) {
    const paragraphIds = counts.get(match.semantic_key) ?? new Set<string>();
    match.paragraph_ids.forEach((paragraphId) => paragraphIds.add(paragraphId));
    counts.set(match.semantic_key, paragraphIds);
  }
  return [
    {
      error_code: "ignored_unknown_semantic_tags",
      message: `Ignored unknown semantic tags: ${[...counts.entries()]
        .map(([semanticKey, paragraphIds]) => `${semanticKey}(${paragraphIds.size})`)
        .join(", ")}.`
    }
  ];
}

function readOutputDocxPath(doc: DocumentIR): string | undefined {
  const metadata = doc.metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const outputPath = (metadata as Record<string, unknown>).outputDocxPath;
  return typeof outputPath === "string" && outputPath.trim() ? outputPath.trim() : undefined;
}

function ensureMaterializeSourcePath(doc: DocumentIR): void {
  const metadata = doc.metadata;
  if (!metadata || typeof metadata !== "object") {
    throw new AgentError({
      code: "E_INPUT_PATH_REQUIRED",
      message: "document.metadata.inputDocxPath is required before materialize",
      retryable: false
    });
  }
  const record = metadata as Record<string, unknown>;
  const inputPath = typeof record.inputDocxPath === "string" ? record.inputDocxPath.trim() : "";
  if (!inputPath) {
    throw new AgentError({
      code: "E_INPUT_PATH_REQUIRED",
      message: "document.metadata.inputDocxPath is required before materialize",
      retryable: false
    });
  }
}

function buildExecutionArtifacts(input: {
  writeOperationCount: number;
  executedArtifacts?: Record<string, unknown>;
  materialized: boolean;
  outputDocxPath?: string;
  debug?: boolean;
  materializeArtifacts?: Record<string, unknown>;
}): TemplateExecutionArtifacts | undefined {
  if (input.writeOperationCount === 0 && !input.debug && !input.outputDocxPath && !input.executedArtifacts) {
    return undefined;
  }

  const stableArtifacts: TemplateExecutionArtifacts = {
    write_operation_count: input.writeOperationCount,
    executed_step_count: readExecutedStepCount(input.executedArtifacts),
    materialized: input.materialized,
    ...(input.outputDocxPath ? { output_docx_path: input.outputDocxPath } : {})
  };

  if (!input.debug) {
    return stableArtifacts;
  }

  return {
    ...stableArtifacts,
    ...(readStepSummaries(input.executedArtifacts)
      ? { step_summaries: readStepSummaries(input.executedArtifacts) }
      : {}),
    ...(readChangeSetSummary(input.executedArtifacts)
      ? { change_set_summary: readChangeSetSummary(input.executedArtifacts) }
      : {}),
    ...(input.materializeArtifacts ? { materialize_artifacts_summary: input.materializeArtifacts } : {})
  };
}

function buildSuccessfulExecutionWarnings(input: {
  template: { validation_policy: { enforce_validation?: boolean } };
  context: TemplateContext;
  validation: TemplateRunReport["validation_result"];
  executionPlan: TemplateRunReport["execution_plan"];
  writePlan: TemplateRunReport["write_plan"];
}): TemplateRunWarning[] {
  if (input.template.validation_policy.enforce_validation !== true) {
    return [];
  }

  return dedupeRunWarnings([
    ...(input.validation.runtime_warnings ?? []),
    ...buildPostExecutionWarnings(input)
  ]);
}

function buildPostExecutionWarnings(input: {
  context: TemplateContext;
  executionPlan: TemplateRunReport["execution_plan"];
  writePlan: TemplateRunReport["write_plan"];
}): TemplateRunWarning[] {
  const modifiedParagraphIds = collectModifiedParagraphIds(input.writePlan, input.context.structureIndex.paragraphs);
  if (modifiedParagraphIds.size === 0) {
    return [];
  }

  const paragraphContextMap = new Map(
    input.context.classificationInput.paragraphs.map((paragraph) => [paragraph.paragraph_id, paragraph] as const)
  );
  const semanticByParagraph = new Map<string, Set<string>>();
  for (const item of input.executionPlan) {
    for (const paragraphId of item.paragraph_ids) {
      const semanticKeys = semanticByParagraph.get(paragraphId) ?? new Set<string>();
      semanticKeys.add(item.semantic_key);
      semanticByParagraph.set(paragraphId, semanticKeys);
    }
  }

  const warnings: TemplateRunWarning[] = [];
  for (const paragraphId of modifiedParagraphIds) {
    if (!semanticByParagraph.get(paragraphId)?.has("body_paragraph")) {
      continue;
    }
    const paragraph = paragraphContextMap.get(paragraphId);
    if (!paragraph) {
      continue;
    }
    const detectedPrefix = detectTemplateNumberingPrefix(paragraph.text);
    if (!detectedPrefix) {
      continue;
    }
    warnings.push(buildBodyParagraphNumberingWarning(paragraphId, paragraph.text, detectedPrefix));
  }
  return warnings;
}

function buildBodyParagraphNumberingWarning(
  paragraphId: string,
  paragraphText: string,
  numberingPrefix: string
): TemplateRunWarning {
  return {
    code: "body_paragraph_suspicious_numbering_prefix",
    message: `Paragraph matched body_paragraph but still starts with numbering prefix '${numberingPrefix}'; output was generated with a warning.`,
    paragraph_ids: [paragraphId],
    diagnostics: {
      semantic_key: "body_paragraph",
      text_excerpt: truncateText(paragraphText, 120),
      numbering_prefix: numberingPrefix,
      detected_prefix: numberingPrefix,
      warning_kind: "body_paragraph_numbering_prefix"
    }
  };
}

function dedupeRunWarnings(warnings: TemplateRunWarning[]): TemplateRunWarning[] {
  const uniqueWarnings = new Map<string, TemplateRunWarning>();
  for (const warning of warnings) {
    const paragraphIds = warning.paragraph_ids.join(",");
    const numberingPrefix = warning.diagnostics.numbering_prefix || warning.diagnostics.detected_prefix || "";
    const key = `${warning.code}|${paragraphIds}|${numberingPrefix}`;
    if (!uniqueWarnings.has(key)) {
      uniqueWarnings.set(key, warning);
    }
  }
  return [...uniqueWarnings.values()];
}

function collectModifiedParagraphIds(
  writePlan: TemplateRunReport["write_plan"],
  paragraphs: TemplateContext["structureIndex"]["paragraphs"]
): Set<string> {
  const modifiedParagraphIds = new Set<string>();
  const runNodeToParagraphId = new Map<string, string>();
  for (const paragraph of paragraphs) {
    for (const runNodeId of paragraph.runNodeIds) {
      runNodeToParagraphId.set(runNodeId, paragraph.id);
    }
  }

  for (const operation of writePlan) {
    if (operation.targetSelector?.scope === "paragraph_ids") {
      for (const paragraphId of operation.targetSelector.paragraphIds ?? []) {
        if (paragraphId && paragraphId !== "__document__") {
          modifiedParagraphIds.add(paragraphId);
        }
      }
    }
    if (operation.targetNodeId) {
      const paragraphId = runNodeToParagraphId.get(operation.targetNodeId);
      if (paragraphId) {
        modifiedParagraphIds.add(paragraphId);
      }
    }
    for (const targetNodeId of operation.targetNodeIds ?? []) {
      const paragraphId = runNodeToParagraphId.get(targetNodeId);
      if (paragraphId) {
        modifiedParagraphIds.add(paragraphId);
      }
    }
  }

  return modifiedParagraphIds;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function readExecutedStepCount(artifacts?: Record<string, unknown>): number {
  if (!artifacts || typeof artifacts.executed_step_count !== "number") {
    return 0;
  }
  return artifacts.executed_step_count;
}

function readStepSummaries(artifacts?: Record<string, unknown>): string[] | undefined {
  if (!artifacts || !Array.isArray(artifacts.step_summaries)) {
    return undefined;
  }
  return artifacts.step_summaries.filter((item): item is string => typeof item === "string");
}

function readChangeSetSummary(artifacts?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!artifacts || !artifacts.change_set_summary || typeof artifacts.change_set_summary !== "object") {
    return undefined;
  }
  return artifacts.change_set_summary as Record<string, unknown>;
}
