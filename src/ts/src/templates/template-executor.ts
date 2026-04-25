import path from "node:path";
import { AgentError } from "../core/errors.js";
import { createDocumentExecutionFacade } from "../document-execution/facade.js";
import { createDocumentToolingFacade } from "../document-tooling/facade.js";
import type { DocumentIR, ExecutionResult, Plan } from "../core/types.js";
import { InMemoryToolRegistry } from "../tools/tool-registry.js";
import type { TemplateWritePlanExecutionInput, TemplateWritePlanExecutionResult, TemplateWritePlanItem } from "./types.js";

export async function executeTemplateWritePlan(
  input: TemplateWritePlanExecutionInput
): Promise<TemplateWritePlanExecutionResult> {
  if (input.writePlan.length > 0 && !input.outputDocxPath.trim()) {
    throw new AgentError({
      code: "E_OUTPUT_PATH_REQUIRED",
      message: "template execution requires outputDocxPath when write_plan is not empty.",
      retryable: false
    });
  }

  const registry = new InMemoryToolRegistry();
  registry.register(createDocumentToolingFacade().createWriteOperationTool());
  const execution = createDocumentExecutionFacade({ toolRegistry: registry });

  const document = withTemplateDocumentPaths(input.context.document, input.context.docxPath, input.outputDocxPath);
  const plan = buildExecutionPlan(document, input.writePlan);
  const result = await execution.executePlan(plan, document, { dryRun: false });
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
      executed_step_count: result.steps.filter((step) => step.status === "success").length,
      change_set_summary: {
        change_count: result.changeSet.changes.length,
        rolled_back: result.changeSet.rolledBack,
        summaries: result.changeSet.changes.map((change) => change.summary)
      },
      ...(input.debug ? { step_summaries: stepSummaries } : {})
    }
  };
}

export function deriveTemplateOutputDocxPath(docxPath: string): string {
  const parsed = path.parse(docxPath);
  return path.join(parsed.dir, `${parsed.name}.template-output${parsed.ext || ".docx"}`);
}

function buildExecutionPlan(document: DocumentIR, writePlan: TemplateWritePlanItem[]): Plan {
  return {
    taskId: `template:${document.id}`,
    goal: "apply_template_write_plan",
    steps: writePlan.map((operation) => ({
      id: operation.id,
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: buildTemplateIdempotencyKey(operation),
      operation
    }))
  };
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

function buildTemplateIdempotencyKey(operation: TemplateWritePlanItem): string {
  const paragraphIds = operation.targetSelector?.scope === "paragraph_ids" ? operation.targetSelector.paragraphIds ?? [] : [];
  return `template:${operation.type}:${operation.id}:${paragraphIds.join(",")}`;
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
    code: "E_TEMPLATE_WRITE_EXECUTION_FAILED",
    message: result.summary,
    retryable: false,
    cause: result
  });
}

function buildExecutionSummary(result: ExecutionResult, stepSummaries: string[]): string | undefined {
  const parts = [...stepSummaries, result.summary.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}
