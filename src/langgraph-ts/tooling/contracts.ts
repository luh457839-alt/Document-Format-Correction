import type { OperationType } from "../core/types.js";

export type NodeSelectorScope = "body" | "heading" | "list_item" | "all_text" | "paragraph_ids";

export interface NodeSelector {
  scope: NodeSelectorScope;
  headingLevel?: number;
  paragraphIds?: string[];
}

export type WriteTargetSpec =
  | { kind: "selector"; selector: NodeSelector }
  | { kind: "semantic_selector"; semantic: "title_like_paragraphs" | "body_like_paragraphs" }
  | { kind: "node_ids"; node_ids: string[] }
  | { kind: "patch_targets"; patch_target_ids: string[]; patch_part_paths?: string[] };

export interface WriteToolInput {
  request_id: string;
  operation: OperationType;
  target: WriteTargetSpec;
  payload: Record<string, unknown>;
  idempotency_key?: string;
}

export interface ToolValidationMessage {
  ok: false;
  stage: "target" | "writable" | "payload" | "compatibility" | "compile";
  error_code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ToolExecutionResult {
  ok: true;
  executed: boolean;
  summary: string;
  skip_reason?: "idempotency_hit";
  idempotency_key?: string;
  patch_target_ids: string[];
  patch_part_paths: string[];
  target_count: number;
  diagnostics?: Record<string, unknown>[];
}

export interface SelectorTargetAnalysis {
  matched_paragraph_ids: string[];
  missing_paragraph_ids: string[];
  unwritable_paragraph_ids: string[];
  skipped_paragraph_ids: string[];
  target_node_ids: string[];
  patch_target_ids: string[];
  patch_part_paths: string[];
  missing_node_ids: string[];
  missing_patch_target_ids: string[];
  skip_reason?: "no_writable_runs";
  semantic_selector?: "title_like_paragraphs" | "body_like_paragraphs";
  semantic_target_paragraph_ids?: string[];
  semantic_scores?: Array<{
    paragraph_id: string;
    title_score: number;
    body_score?: number;
    matched_signals: string[];
    confidence: "high" | "medium" | "low";
  }>;
  semantic_low_confidence_reasons?: string[];
  semantic_ambiguity_reasons?: string[];
  body_baseline_source_paragraph_ids?: string[];
  body_baseline_fields?: Record<string, unknown>;
  body_baseline_unstable_fields?: string[];
  body_baseline_underdetermined?: boolean;
  applied_fields?: string[];
}

export interface WriteToolExecutionOptions {
  executed_patch_keys?: string[];
}

export type WriteToolResponse = ToolExecutionResult | ToolValidationMessage;
