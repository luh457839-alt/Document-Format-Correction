import { AgentError, asAppError } from "../core/errors.js";
import type { DocumentIR } from "../core/types.js";
import { createDocumentExecutionFacade } from "../document-execution/facade.js";
import { createDocumentToolingFacade, type DocumentToolingFacade } from "../document-tooling/facade.js";
import { buildTemplateAtomicPlan } from "../templates/template-atomic-planner.js";
import { classifyTemplateParagraphs, normalizeTemplateClassificationResult } from "../templates/template-classifier.js";
import { loadTemplateConfig } from "../templates/template-config.js";
import { buildTemplateContextFromObservation } from "../templates/template-context-builder.js";
import { deriveTemplateOutputDocxPath, executeTemplatePatchPlan } from "../templates/template-executor.js";
import { detectTemplateNumberingPrefix } from "../templates/template-numbering.js";
import { asTemplateStageError } from "../templates/template-stage-error.js";
import { validateTemplateClassification } from "../templates/template-validator.js";
import { buildTemplatePatchPlan } from "../templates/template-write-planner.js";
import { InMemoryToolRegistry } from "../tools/tool-registry.js";
import type {
  TemplateExecutionArtifacts,
  TemplateClassificationResult,
  TemplateContext,
  TemplatePatchPlanItem,
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
  const buildPatchPlan = deps.buildPatchPlan ?? deps.buildWritePlan ?? buildTemplatePatchPlan;
  const executePatchPlan = deps.executePatchPlan ?? deps.executeWritePlan ?? executeTemplatePatchPlan;
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
      patch_plan: [],
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
  const patchPlanResult = buildPatchPlan({
    template,
    executionPlan,
    document: context.document,
    structureIndex: context.structureIndex
  });
  if (patchPlanResult.issues.length > 0) {
    stageTimings.execution_ms = elapsedMs(executionStartedAt);
    return {
      status: "failed",
      template_meta: template.template_meta,
      stage_timings_ms: stageTimings,
      observation_summary: context.observationSummary,
      classification_result: classification,
      validation_result: validation,
      execution_plan: executionPlan,
      patch_plan: [],
      write_plan: [],
      execution_result: {
        applied: false,
        issues: patchPlanResult.issues
      }
    };
  }

  const outputDocxPath = deriveTemplateOutputDocxPath(input.docxPath);
  if (patchPlanResult.patchPlan.length > 0 && !outputDocxPath.trim()) {
    stageTimings.execution_ms = elapsedMs(executionStartedAt);
    return failedAfterExecution(
      template.template_meta,
      context.observationSummary,
      classification,
      validation,
      executionPlan,
      patchPlanResult.patchPlan,
      patchPlanResult.writePlan,
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
    document: patchPlanResult.document,
    structureIndex: patchPlanResult.structureIndex
  };
  const useLegacyExecutionHooks = deps.executePatchPlan !== undefined || deps.executeWritePlan !== undefined;
  try {
    if (useLegacyExecutionHooks) {
      executed = await executePatchPlan({
        context: executionContext,
        patchPlan: patchPlanResult.patchPlan,
        writePlan: patchPlanResult.writePlan,
        outputDocxPath,
        debug: input.debug
      });
    } else {
      const registry = new InMemoryToolRegistry();
      registry.register(tooling.createWriteOperationTool());
      const executionFacade = createDocumentExecutionFacade({
        toolRegistry: registry,
        materializeDocument: async (doc) => await materializeDoc(doc)
      });
      const document = withExecutionDocumentPaths(patchPlanResult.document, input.docxPath, outputDocxPath);
      const intents = patchPlanResult.writePlan
        .map((item) => item.intent)
        .filter((intent): intent is NonNullable<typeof intent> => Boolean(intent));
      if (intents.length !== patchPlanResult.writePlan.length) {
        throw new AgentError({
          code: "E_TEMPLATE_WRITE_PLAN_INVALID",
          message: "template write_plan contains items without intent",
          retryable: false
        });
      }
      const pipelineResult = await executionFacade.runUnifiedWritePipeline({
        doc: document,
        intents,
        dryRun: false,
        taskId: `template:${document.id}`,
        goal: "apply_template_write_plan",
        materialize: true
      });
      if (pipelineResult.executionResult.status !== "completed") {
        throw new AgentError({
          code: "E_TEMPLATE_PATCH_EXECUTION_FAILED",
          message: pipelineResult.executionResult.summary,
          retryable: false,
          cause: pipelineResult.executionResult
        });
      }
      executed = {
        applied: true,
        finalDoc: pipelineResult.finalDoc,
        changeSummary: pipelineResult.changeSummary,
        artifacts: {
          patch_set_count: patchPlanResult.patchPlan.length,
          patch_target_count: unique(patchPlanResult.patchPlan.flatMap((item) => item.patch_target_ids)).length,
          patch_part_paths: unique(patchPlanResult.patchPlan.flatMap((item) => item.patch_part_paths)),
          executed_step_count: pipelineResult.executionResult.steps.filter((step) => step.status === "success").length,
          change_set_summary: {
            change_count: pipelineResult.executionResult.changeSet.changes.length,
            rolled_back: pipelineResult.executionResult.changeSet.rolledBack,
            summaries: pipelineResult.executionResult.changeSet.changes.map((change) => change.summary)
          },
          ...(readSkippedParagraphArtifacts(pipelineResult.artifacts) ?? {}),
          ...(input.debug ? { patch_sets: patchPlanResult.patchPlan.map((item) => item.patch_set) } : {}),
          ...(input.debug
            ? {
                step_summaries: pipelineResult.executionResult.steps
                  .map((step) => step.summary?.trim())
                  .filter((summary): summary is string => Boolean(summary))
              }
            : {}),
          ...(pipelineResult.materializeResult?.artifacts
            ? { materialize_artifacts_summary: pipelineResult.materializeResult.artifacts }
            : {})
        }
      };
    }
  } catch (err) {
    stageTimings.execution_ms = elapsedMs(executionStartedAt);
    return failedAfterExecution(
      template.template_meta,
      context.observationSummary,
      classification,
      validation,
      executionPlan,
      patchPlanResult.patchPlan,
      patchPlanResult.writePlan,
      input.debug,
      stageTimings,
      err
    );
  }

  try {
    const finalDoc = withExecutionDocumentPaths(executed.finalDoc, input.docxPath, outputDocxPath);
    const materialized = useLegacyExecutionHooks
      ? await (async () => {
          ensureMaterializeSourcePath(finalDoc);
          return await materializeDoc(finalDoc);
        })()
      : {
          doc: finalDoc,
          summary: "",
          artifacts: (executed.artifacts?.materialize_artifacts_summary as Record<string, unknown> | undefined) ?? {}
        };
    const materializedOutputDocxPath = readOutputDocxPath(materialized.doc) ?? readOutputDocxPath(finalDoc);
    const warnings = buildSuccessfulExecutionWarnings({
      template,
      context: executionContext,
      validation,
      executionPlan,
      patchPlan: patchPlanResult.patchPlan
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
      patch_plan: patchPlanResult.patchPlan,
      write_plan: patchPlanResult.writePlan,
      execution_result: {
        applied: true,
        ...(materializedOutputDocxPath ? { output_docx_path: materializedOutputDocxPath } : {}),
        change_summary: joinSummaries(executed.changeSummary, materialized.summary),
        artifacts: buildExecutionArtifacts({
          patchPlan: patchPlanResult.patchPlan,
          writePlan: patchPlanResult.writePlan,
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
      patchPlanResult.patchPlan,
      patchPlanResult.writePlan,
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
  patchPlan: TemplateRunReport["patch_plan"],
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
    patch_plan: patchPlan,
    write_plan: writePlan,
    execution_result: {
      applied: false,
      ...(partial?.changeSummary ? { change_summary: partial.changeSummary } : {}),
      ...(partial?.artifacts || patchPlan.length > 0
        ? {
            artifacts: buildExecutionArtifacts({
              patchPlan,
              writePlan,
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

function withExecutionDocumentPaths(doc: DocumentIR, inputDocxPath: string, outputDocxPath: string): DocumentIR {
  return {
    ...doc,
    metadata: {
      ...(doc.metadata ?? {}),
      inputDocxPath,
      outputDocxPath: readOutputDocxPath(doc) ?? outputDocxPath
    }
  };
}

function buildExecutionArtifacts(input: {
  patchPlan: TemplatePatchPlanItem[];
  writePlan: TemplateRunReport["write_plan"];
  executedArtifacts?: Record<string, unknown>;
  materialized: boolean;
  outputDocxPath?: string;
  debug?: boolean;
  materializeArtifacts?: Record<string, unknown>;
}): TemplateExecutionArtifacts | undefined {
  if (input.patchPlan.length === 0 && !input.debug && !input.outputDocxPath && !input.executedArtifacts) {
    return undefined;
  }

  const patchTargetIds = unique(input.patchPlan.flatMap((item) => item.patch_target_ids));
  const patchPartPaths = unique(input.patchPlan.flatMap((item) => item.patch_part_paths));
  const stableArtifacts: TemplateExecutionArtifacts = {
    patch_set_count: input.patchPlan.length,
    patch_target_count: patchTargetIds.length,
    patch_part_paths: patchPartPaths,
    write_operation_count: input.writePlan.length,
    executed_step_count: readExecutedStepCount(input.executedArtifacts),
    materialized: input.materialized,
    ...(input.outputDocxPath ? { output_docx_path: input.outputDocxPath } : {}),
    ...(readSkippedParagraphArtifacts(input.executedArtifacts) ?? {})
  };

  if (!input.debug) {
    return stableArtifacts;
  }

  return {
    ...stableArtifacts,
    ...(input.patchPlan.length > 0 ? { patch_sets: input.patchPlan.map((item) => item.patch_set) } : {}),
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
  patchPlan: TemplateRunReport["patch_plan"];
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
  patchPlan: TemplateRunReport["patch_plan"];
}): TemplateRunWarning[] {
  const modifiedParagraphIds = collectModifiedParagraphIds(input.patchPlan, input.context.structureIndex.paragraphs);
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
  patchPlan: TemplateRunReport["patch_plan"],
  paragraphs: TemplateContext["structureIndex"]["paragraphs"]
): Set<string> {
  const modifiedParagraphIds = new Set<string>();
  const runNodeToParagraphId = new Map<string, string>();
  for (const paragraph of paragraphs) {
    for (const runNodeId of paragraph.runNodeIds) {
      runNodeToParagraphId.set(runNodeId, paragraph.id);
    }
  }

  for (const item of patchPlan) {
    for (const targetId of item.patch_target_ids) {
      if (targetId.startsWith("target:block:")) {
        modifiedParagraphIds.add(targetId.slice("target:block:".length));
        continue;
      }
      if (targetId.startsWith("target:inline:")) {
        const paragraphId = runNodeToParagraphId.get(targetId.slice("target:inline:".length));
        if (paragraphId) {
          modifiedParagraphIds.add(paragraphId);
        }
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

function readSkippedParagraphArtifacts(artifacts?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!artifacts) {
    return undefined;
  }
  const skippedParagraphIds = Array.isArray(artifacts.skipped_paragraph_ids)
    ? artifacts.skipped_paragraph_ids.filter((item): item is string => typeof item === "string")
    : [];
  const skippedParagraphCount =
    typeof artifacts.skipped_paragraph_count === "number" ? artifacts.skipped_paragraph_count : skippedParagraphIds.length;
  if (skippedParagraphCount <= 0) {
    return undefined;
  }
  return {
    skipped_paragraph_count: skippedParagraphCount,
    ...(skippedParagraphIds.length > 0 ? { skipped_paragraph_ids: skippedParagraphIds } : {})
  };
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
