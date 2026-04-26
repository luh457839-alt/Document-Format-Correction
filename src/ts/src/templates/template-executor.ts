import path from "node:path";
import { AgentError } from "../core/errors.js";
import { createDocumentExecutionFacade } from "../document-execution/facade.js";
import { createDocumentToolingFacade } from "../document-tooling/facade.js";
import { operationToWriteIntent } from "../document-execution/unified-write-pipeline.js";
import type { DocumentIR, ExecutionResult } from "../core/types.js";
import { InMemoryToolRegistry } from "../tools/tool-registry.js";
import type {
  TemplatePatchExecutionResult,
  TemplatePatchPlanExecutionInput,
  TemplateWritePlanExecutionInput,
  TemplateWritePlanExecutionResult
} from "./types.js";

export async function executeTemplatePatchPlan(
  input: TemplatePatchPlanExecutionInput
): Promise<TemplatePatchExecutionResult> {
  return await executeTemplateWritePlan(input);
}

export async function executeTemplateWritePlan(
  input: TemplateWritePlanExecutionInput
): Promise<TemplateWritePlanExecutionResult> {
  if (input.patchPlan.length > 0 && !input.outputDocxPath.trim()) {
    throw new AgentError({
      code: "E_OUTPUT_PATH_REQUIRED",
      message: "template execution requires outputDocxPath when patch_plan is not empty.",
      retryable: false
    });
  }

  const registry = new InMemoryToolRegistry();
  registry.register(createDocumentToolingFacade().createWriteOperationTool());
  const execution = createDocumentExecutionFacade({ toolRegistry: registry });

  const document = withTemplateDocumentPaths(input.context.document, input.context.docxPath, input.outputDocxPath);
  const pipelineResult = await execution.runUnifiedWritePipeline({
    doc: document,
    intents: readTemplateWriteIntents(input.writePlan),
    dryRun: false,
    taskId: `template:${document.id}`,
    goal: "apply_template_write_plan"
  });
  const result = pipelineResult.executionResult;
  if (result.status !== "completed") {
    throw toTemplateExecutionError(result);
  }

  const stepSummaries = result.steps
    .map((step) => step.summary?.trim())
    .filter((summary): summary is string => Boolean(summary));

  return {
    applied: true,
    finalDoc: result.finalDoc,
    changeSummary: buildExecutionSummary(result, stepSummaries),
    artifacts: {
      patch_set_count: input.patchPlan.length,
      patch_target_count: unique(input.patchPlan.flatMap((item) => item.patch_target_ids)).length,
      patch_part_paths: unique(input.patchPlan.flatMap((item) => item.patch_part_paths)),
      executed_step_count: result.steps.filter((step) => step.status === "success").length,
      change_set_summary: {
        change_count: result.changeSet.changes.length,
        rolled_back: result.changeSet.rolledBack,
        summaries: result.changeSet.changes.map((change) => change.summary)
      },
      ...(readSkippedParagraphArtifacts(pipelineResult.artifacts) ?? {}),
      ...(input.debug ? { patch_sets: input.patchPlan.map((item) => item.patch_set) } : {}),
      ...(input.debug ? { step_summaries: stepSummaries } : {})
    }
  };
}

export function deriveTemplateOutputDocxPath(docxPath: string): string {
  const parsed = path.parse(docxPath);
  return path.join(parsed.dir, `${parsed.name}.template-output${parsed.ext || ".docx"}`);
}

function withTemplateDocumentPaths(document: DocumentIR, inputDocxPath: string, outputDocxPath: string): DocumentIR {
  return {
    ...document,
    metadata: {
      ...(document.metadata ?? {}),
      inputDocxPath,
      outputDocxPath
    }
  };
}

function readTemplateWriteIntents(writePlan: TemplateWritePlanExecutionInput["writePlan"]) {
  const intents = writePlan
    .map((item) => item.intent ?? (item.legacy_operation ? operationToWriteIntent(item.legacy_operation) : undefined))
    .filter((intent): intent is NonNullable<typeof intent> => Boolean(intent));
  if (intents.length !== writePlan.length) {
    throw new AgentError({
      code: "E_TEMPLATE_WRITE_PLAN_INVALID",
      message: "template write_plan contains items without intent",
      retryable: false
    });
  }
  return intents;
}

function toTemplateExecutionError(result: ExecutionResult): AgentError {
  const failedStep = [...result.steps].reverse().find((step) => step.status === "failed" && step.error);
  if (failedStep?.error) {
    return new AgentError({
      code: failedStep.error.code,
      message: failedStep.error.message,
      retryable: failedStep.error.retryable,
      cause: result
    });
  }
  return new AgentError({
    code: "E_TEMPLATE_PATCH_EXECUTION_FAILED",
    message: result.summary,
    retryable: false,
    cause: result
  });
}

function buildExecutionSummary(result: ExecutionResult, stepSummaries: string[]): string | undefined {
  const parts = [...stepSummaries, result.summary.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
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
