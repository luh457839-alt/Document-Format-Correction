import { AgentError, asAppError } from "../core/errors.js";
import type { TemplateRunStageTimings } from "./types.js";

export type TemplatePipelineStage =
  | "observe_docx"
  | "classification_request_failed"
  | "validation"
  | "execution";

export class TemplateStageError extends AgentError {
  public readonly stage: TemplatePipelineStage;
  public readonly stageTimingsMs?: TemplateRunStageTimings;

  constructor(
    info: ConstructorParameters<typeof AgentError>[0],
    stage: TemplatePipelineStage,
    stageTimingsMs?: TemplateRunStageTimings
  ) {
    super(info);
    this.stage = stage;
    this.stageTimingsMs = stageTimingsMs;
  }
}

export function asTemplateStageError(
  stage: TemplatePipelineStage,
  err: unknown,
  stageTimingsMs?: TemplateRunStageTimings
): TemplateStageError {
  const info = asAppError(err, fallbackCodeForStage(stage));
  return new TemplateStageError(info, stage, stageTimingsMs);
}

export function readTemplateStageErrorMetadata(err: unknown): {
  stage?: TemplatePipelineStage;
  stageTimingsMs?: TemplateRunStageTimings;
} {
  if (err instanceof TemplateStageError) {
    return {
      stage: err.stage,
      stageTimingsMs: err.stageTimingsMs
    };
  }
  if (typeof err !== "object" || err === null) {
    return {};
  }
  const stage = "stage" in err && typeof err.stage === "string" ? err.stage : undefined;
  const stageTimingsMs =
    "stageTimingsMs" in err && err.stageTimingsMs && typeof err.stageTimingsMs === "object"
      ? (err.stageTimingsMs as TemplateRunStageTimings)
      : undefined;
  return {
    stage: isTemplatePipelineStage(stage) ? stage : undefined,
    stageTimingsMs
  };
}

function fallbackCodeForStage(stage: TemplatePipelineStage): string {
  switch (stage) {
    case "observe_docx":
      return "E_TEMPLATE_OBSERVATION_FAILED";
    case "classification_request_failed":
      return "E_TEMPLATE_CLASSIFICATION_REQUEST";
    case "validation":
      return "E_TEMPLATE_VALIDATION_FAILED";
    case "execution":
      return "E_TEMPLATE_EXECUTION_FAILED";
    default:
      return "E_TEMPLATE_PIPELINE_FAILED";
  }
}

function isTemplatePipelineStage(value: string | undefined): value is TemplatePipelineStage {
  return (
    value === "observe_docx" ||
    value === "classification_request_failed" ||
    value === "validation" ||
    value === "execution"
  );
}
