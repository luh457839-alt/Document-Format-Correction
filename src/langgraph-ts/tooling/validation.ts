import type { SelectorTargetAnalysis, ToolValidationMessage, WriteToolInput } from "./contracts.js";

export function validateTargetAnalysis(input: WriteToolInput, analysis: SelectorTargetAnalysis): ToolValidationMessage | null {
  if (input.target.kind === "semantic_selector" && analysis.semantic_low_confidence_reasons?.length) {
    return {
      ok: false,
      stage: "target",
      error_code: analysis.body_baseline_underdetermined ? "E_BODY_BASELINE_UNDERDETERMINED" : "E_SEMANTIC_TARGET_LOW_CONFIDENCE",
      message: `Semantic target resolution was low confidence for request '${input.request_id}'.`,
      retryable: false,
      details: {
        semantic_selector: analysis.semantic_selector,
        semantic_target_paragraph_ids: analysis.semantic_target_paragraph_ids,
        semantic_scores: analysis.semantic_scores,
        low_confidence_reasons: analysis.semantic_low_confidence_reasons,
        body_baseline_source_paragraph_ids: analysis.body_baseline_source_paragraph_ids,
        body_baseline_fields: analysis.body_baseline_fields
      }
    };
  }

  if (input.target.kind === "semantic_selector" && analysis.semantic_ambiguity_reasons?.length) {
    return {
      ok: false,
      stage: "target",
      error_code: "E_SEMANTIC_TARGET_AMBIGUOUS",
      message: `Semantic target resolution was ambiguous for request '${input.request_id}'.`,
      retryable: false,
      details: {
        semantic_selector: analysis.semantic_selector,
        semantic_target_paragraph_ids: analysis.semantic_target_paragraph_ids,
        semantic_scores: analysis.semantic_scores,
        ambiguity_reasons: analysis.semantic_ambiguity_reasons
      }
    };
  }

  if (analysis.missing_paragraph_ids.length > 0) {
    return {
      ok: false,
      stage: "target",
      error_code: "E_TARGET_PARAGRAPH_NOT_FOUND",
      message: `Target paragraphs were not found: ${analysis.missing_paragraph_ids.join(", ")}.`,
      retryable: false,
      details: {
        missing_paragraph_ids: analysis.missing_paragraph_ids
      }
    };
  }

  if (analysis.missing_node_ids.length > 0) {
    return {
      ok: false,
      stage: "target",
      error_code: "E_TARGET_NODE_NOT_FOUND",
      message: `Target nodes were not found: ${analysis.missing_node_ids.join(", ")}.`,
      retryable: false,
      details: {
        missing_node_ids: analysis.missing_node_ids
      }
    };
  }

  if (input.target.kind === "patch_targets" && analysis.missing_patch_target_ids.length > 0) {
    return {
      ok: false,
      stage: "target",
      error_code: "E_PATCH_TARGET_NOT_FOUND",
      message: `Patch targets were not found: ${analysis.missing_patch_target_ids.join(", ")}.`,
      retryable: false,
      details: {
        missing_patch_target_ids: analysis.missing_patch_target_ids
      }
    };
  }

  if (input.operation !== "set_page_layout" && input.target.kind === "patch_targets" && analysis.patch_target_ids.length === 0) {
    return {
      ok: false,
      stage: "target",
      error_code: "E_PATCH_TARGETS_EMPTY",
      message: "Patch target input did not contain any executable patch target ids.",
      retryable: false
    };
  }

  if (input.operation !== "set_page_layout" && input.target.kind !== "patch_targets" && analysis.target_node_ids.length === 0) {
    if (analysis.matched_paragraph_ids.length > 0) {
      return {
        ok: false,
        stage: "writable",
        error_code: "E_TARGET_NOT_WRITABLE",
        message: `Matched paragraphs are not writable for request '${input.request_id}'.`,
        retryable: false,
        details: {
          matched_paragraph_ids: analysis.matched_paragraph_ids,
          skipped_paragraph_ids: analysis.skipped_paragraph_ids,
          semantic_selector: analysis.semantic_selector,
          semantic_target_paragraph_ids: analysis.semantic_target_paragraph_ids
        }
      };
    }
    return {
      ok: false,
      stage: "target",
      error_code: "E_TARGETS_EMPTY",
      message: `Target '${describeTarget(input)}' did not resolve to any document targets.`,
      retryable: false
    };
  }

  return null;
}

export function validateOperationCompatibility(
  input: WriteToolInput,
  analysis: SelectorTargetAnalysis
): ToolValidationMessage | null {
  if (input.operation === "set_style_definition") {
    if (input.target.kind !== "patch_targets") {
      return incompatible(input, "set_style_definition requires explicit style patch targets.");
    }
    if (!analysis.patch_target_ids.every((targetId) => targetId.startsWith("target:styles:"))) {
      return incompatible(input, "set_style_definition only accepts target:styles:* patch targets.");
    }
  }

  if (input.operation === "set_numbering_level") {
    if (input.target.kind !== "patch_targets") {
      return incompatible(input, "set_numbering_level requires explicit numbering patch targets.");
    }
    if (!analysis.patch_target_ids.every((targetId) => targetId.startsWith("target:numbering:"))) {
      return incompatible(input, "set_numbering_level only accepts target:numbering:* patch targets.");
    }
  }

  if (input.operation === "set_settings_flag") {
    if (input.target.kind !== "patch_targets") {
      return incompatible(input, "set_settings_flag requires explicit settings patch targets.");
    }
    if (!analysis.patch_target_ids.every((targetId) => targetId.startsWith("target:settings:"))) {
      return incompatible(input, "set_settings_flag only accepts target:settings:* patch targets.");
    }
  }

  return null;
}

function incompatible(input: WriteToolInput, message: string): ToolValidationMessage {
  return {
    ok: false,
    stage: "compatibility",
    error_code: "E_OPERATION_TARGET_INCOMPATIBLE",
    message: `${input.operation}: ${message}`,
    retryable: false
  };
}

function describeTarget(input: WriteToolInput): string {
  if (input.target.kind === "selector") {
    return input.target.selector.scope;
  }
  if (input.target.kind === "semantic_selector") {
    return input.target.semantic;
  }
  if (input.target.kind === "node_ids") {
    return input.target.node_ids.join(",");
  }
  return input.target.patch_target_ids.join(",");
}
