import { createHash } from "node:crypto";
import type { SelectorTargetAnalysis, WriteToolInput } from "./contracts.js";
import { stableStringify, unique } from "./utils.js";

export function resolveWriteToolIdempotencyKey(
  input: WriteToolInput,
  normalizedPayload: Record<string, unknown>,
  analysis: SelectorTargetAnalysis
): string {
  if (typeof input.idempotency_key === "string" && input.idempotency_key.trim()) {
    return input.idempotency_key.trim();
  }

  const canonical = stableStringify({
    request_id: input.request_id,
    operation: input.operation,
    target: canonicalizeTarget(input, analysis),
    payload: normalizedPayload
  });
  return `write:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function hasExecutedIdempotencyKey(idempotencyKey: string, executedPatchKeys: string[] | undefined): boolean {
  return unique(executedPatchKeys ?? []).includes(idempotencyKey);
}

function canonicalizeTarget(input: WriteToolInput, analysis: SelectorTargetAnalysis): Record<string, unknown> {
  if (input.target.kind === "selector") {
    return {
      kind: "selector",
      selector: input.target.selector,
      target_node_ids: analysis.target_node_ids
    };
  }
  if (input.target.kind === "semantic_selector") {
    return {
      kind: "semantic_selector",
      semantic: input.target.semantic
    };
  }
  if (input.target.kind === "node_ids") {
    return {
      kind: "node_ids",
      node_ids: unique(input.target.node_ids)
    };
  }
  return {
    kind: "patch_targets",
    patch_target_ids: unique(input.target.patch_target_ids),
    patch_part_paths: unique(input.target.patch_part_paths ?? [])
  };
}
