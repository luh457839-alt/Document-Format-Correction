import { AgentError } from "../core/errors.js";
import type { ParsedDocumentBundle } from "../contracts/document-contracts.js";
import type { ToolValidationMessage, WriteToolExecutionOptions, WriteToolInput, WriteToolResponse } from "./contracts.js";
import { resolveWriteToolIdempotencyKey, hasExecutedIdempotencyKey } from "./idempotency.js";
import { compileWriteToolPatchSet } from "./patch-compilation.js";
import { normalizeWriteToolPayload } from "./payload-normalization.js";
import { parseWriteToolInput } from "./schema.js";
import { analyzeWriteTarget } from "./target-resolution.js";
import { validateOperationCompatibility, validateTargetAnalysis } from "./validation.js";

export function executeWriteTool(
  bundle: ParsedDocumentBundle,
  rawInput: WriteToolInput | unknown,
  options: WriteToolExecutionOptions = {}
): WriteToolResponse {
  const parsedInput = parseWriteToolInput(rawInput);
  if ("ok" in parsedInput && parsedInput.ok === false) {
    return parsedInput;
  }

  const input = parsedInput as WriteToolInput;
  let normalizedPayload: Record<string, unknown>;
  try {
    normalizedPayload = normalizeWriteToolPayload(input.operation, input.payload, input.target);
  } catch (error) {
    return toPayloadValidation(error);
  }

  const analysis = analyzeWriteTarget(bundle, input.target, normalizedPayload);

  const targetValidation = validateTargetAnalysis(input, analysis);
  if (targetValidation) {
    return targetValidation;
  }

  const compatibilityValidation = validateOperationCompatibility(input, analysis);
  if (compatibilityValidation) {
    return compatibilityValidation;
  }

  try {
    const compilation = compileWriteToolPatchSet(bundle, input, analysis);
    const idempotencyKey = resolveWriteToolIdempotencyKey(input, normalizedPayload, analysis);
    if (hasExecutedIdempotencyKey(idempotencyKey, options.executed_patch_keys)) {
      return {
        ok: true,
        executed: false,
        skip_reason: "idempotency_hit",
        summary: `Skipped request '${input.request_id}' because idempotency key '${idempotencyKey}' has already executed.`,
        idempotency_key: idempotencyKey,
        patch_target_ids: compilation.patchTargetIds,
        patch_part_paths: compilation.partPaths,
        target_count: compilation.targetCount,
        diagnostics: buildDiagnostics(input, analysis, compilation.patchSet.operations.length)
      };
    }

    return {
      ok: true,
      executed: true,
      summary: `Compiled ${compilation.patchSet.operations.length} patch operations for ${input.operation} request '${input.request_id}'.`,
      idempotency_key: idempotencyKey,
      patch_target_ids: compilation.patchTargetIds,
      patch_part_paths: compilation.partPaths,
      target_count: compilation.targetCount,
      diagnostics: buildDiagnostics(input, analysis, compilation.patchSet.operations.length)
    };
  } catch (error) {
    return toCompileValidation(error, input.request_id);
  }
}

function buildDiagnostics(
  input: WriteToolInput,
  analysis: ReturnType<typeof analyzeWriteTarget>,
  patchOperationCount: number
): Record<string, unknown>[] {
  return [
    {
      request_id: input.request_id,
      operation: input.operation,
      matched_paragraph_ids: analysis.matched_paragraph_ids,
      skipped_paragraph_ids: analysis.skipped_paragraph_ids,
      patch_operation_count: patchOperationCount,
      ...(analysis.semantic_selector
        ? {
            semantic_selector: analysis.semantic_selector,
            semantic_target_paragraph_ids: analysis.semantic_target_paragraph_ids,
            semantic_scores: analysis.semantic_scores,
            body_baseline_source_paragraph_ids: analysis.body_baseline_source_paragraph_ids,
            body_baseline_fields: analysis.body_baseline_fields,
            applied_fields: analysis.applied_fields,
            low_confidence_reasons: analysis.semantic_low_confidence_reasons,
            ambiguity_reasons: analysis.semantic_ambiguity_reasons
          }
        : {})
    }
  ];
}

function toPayloadValidation(error: unknown): ToolValidationMessage {
  const message = error instanceof AgentError ? error.message : "Invalid write payload.";
  return {
    ok: false,
    stage: "payload",
    error_code: error instanceof AgentError ? error.code : "E_INVALID_OPERATION_PAYLOAD",
    message,
    retryable: false
  };
}

function toCompileValidation(error: unknown, requestId: string): ToolValidationMessage {
  const message =
    error instanceof AgentError ? error.message : `Failed to compile a patch set for request '${requestId}'.`;
  return {
    ok: false,
    stage: "compile",
    error_code: error instanceof AgentError ? error.code : "E_PATCH_COMPILE_FAILED",
    message,
    retryable: false
  };
}
