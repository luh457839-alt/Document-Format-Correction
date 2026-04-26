import type { ChatModelConfig, DocumentIR, Operation, PlannerModelConfig } from "../core/types.js";
import type { WriteIntent } from "../document-execution/unified-write-pipeline.js";
import type { DocumentStructureIndex } from "../runtime/document-state.js";
import type { DocxPatchSet } from "../tools/docx-observation-schema.js";
import type { PythonDocxObservationState } from "../tools/python-tool-client.js";
import type {
  ClassificationConflict,
  ClassificationMatch,
  DerivedSemanticBlock,
  TemplateContract,
  TemplatePatchBlock,
  TemplatePatchOperation,
  TemplatePatchSelector,
  TemplateMeta
} from "./template-contract.js";

export type TemplateLlmConfig = Partial<PlannerModelConfig | ChatModelConfig>;
export type TemplateRunStatus = "classified" | "validated" | "planned" | "executed" | "failed";

export interface TemplateRunInput {
  docxPath: string;
  templatePath: string;
  llm?: TemplateLlmConfig;
  debug?: boolean;
}

export interface TemplateParagraphSummary {
  paragraph_id: string;
  text_excerpt: string;
  role: string;
  heading_level?: number;
  list_level?: number;
  style_name?: string;
  in_table: boolean;
  paragraph_index: number;
  is_first_paragraph: boolean;
  is_last_paragraph: boolean;
  bucket_type: TemplateParagraphBucketType;
  has_image_evidence: boolean;
  image_count: number;
  is_image_dominant: boolean;
}

export type TemplateParagraphBucketType = "heading" | "title" | "list_item" | "body" | "table_text" | "unknown";

export interface TemplateSealDetectionSummary {
  supported: boolean;
  detected: boolean;
  reason?: string;
}

export interface TemplateEvidenceSummary {
  table_count: number;
  image_count: number;
  image_paragraph_count: number;
  image_dominant_paragraph_count: number;
  numbering_patterns: string[];
  style_name_counts: Record<string, number>;
  seal_detection: TemplateSealDetectionSummary;
}

export interface TemplateObservationSummary {
  document_meta: PythonDocxObservationState["document_meta"];
  paragraph_count: number;
  classifiable_paragraphs: TemplateParagraphSummary[];
  evidence_summary: TemplateEvidenceSummary;
}

export interface TemplateParagraphContext {
  paragraph_id: string;
  text: string;
  role: string;
  heading_level?: number;
  list_level?: number;
  style_name?: string;
  in_table: boolean;
  paragraph_index: number;
  is_first_paragraph: boolean;
  is_last_paragraph: boolean;
  bucket_type: TemplateParagraphBucketType;
  has_image_evidence: boolean;
  image_count: number;
  is_image_dominant: boolean;
  run_node_ids: string[];
  run_styles: Array<Record<string, unknown>>;
}

export interface TemplateClassificationInput {
  template_id: string;
  paragraphs: TemplateParagraphContext[];
  evidence_summary: TemplateEvidenceSummary;
  document_meta: PythonDocxObservationState["document_meta"];
}

export interface TemplateContext {
  docxPath: string;
  observation: PythonDocxObservationState;
  document: DocumentIR;
  structureIndex: DocumentStructureIndex;
  observationSummary: TemplateObservationSummary;
  classificationInput: TemplateClassificationInput;
}

export interface TemplateClassificationResult {
  template_id: string;
  matches: ClassificationMatch[];
  unmatched_paragraph_ids: string[];
  conflicts: ClassificationConflict[];
  diagnostics?: TemplateClassificationDiagnostics;
  overall_confidence?: number;
}

export interface TemplateRunStageTimings {
  observation_ms: number;
  classification_request_ms: number;
  refinement_ms: number;
  validation_ms: number;
  execution_ms: number;
}

export interface TemplateValidationIssue {
  error_code: string;
  message: string;
  semantic_key?: string;
  paragraph_ids?: string[];
  diagnostics?: TemplateValidationIssueDiagnostics;
}

export interface TemplateValidationResult {
  passed: boolean;
  issues: TemplateValidationIssue[];
  runtime_warnings?: TemplateRunWarning[];
}

export type TemplateUnmatchedParagraphReason = "no_candidate" | "conflict_excluded";

export interface TemplateUnmatchedParagraphDiagnostic {
  paragraph_id: string;
  text_excerpt: string;
  role: string;
  bucket_type: TemplateParagraphBucketType;
  paragraph_index: number;
  reason: TemplateUnmatchedParagraphReason;
  candidate_semantic_keys?: string[];
  conflict_reason?: string;
  model_reported_unmatched?: boolean;
}

export type TemplateRefinementSource = "low_confidence" | "conflict";
export type TemplateRefinementOutcome =
  | "accepted"
  | "accepted_without_confidence"
  | "accepted_blank_or_unknown"
  | "rejected_low_confidence"
  | "rejected_conflict"
  | "rejected_invalid"
  | "rejected_unmatched";

export interface TemplateClassificationRefinementFirstPass {
  semantic_keys?: string[];
  candidate_semantic_keys?: string[];
  confidence?: number;
  reason?: string;
  source: TemplateRefinementSource;
}

export interface TemplateClassificationRefinementSecondPass {
  semantic_key?: string;
  candidate_semantic_keys?: string[];
  confidence?: number;
  reason?: string;
}

export interface TemplateClassificationRefinedParagraphDiagnostic {
  paragraph_id: string;
  first_pass: TemplateClassificationRefinementFirstPass;
  second_pass: TemplateClassificationRefinementSecondPass;
  outcome: TemplateRefinementOutcome;
}

export interface TemplateClassificationDiagnostics {
  unmatched_paragraphs?: TemplateUnmatchedParagraphDiagnostic[];
  ignored_unknown_semantic_matches?: TemplateIgnoredUnknownSemanticMatch[];
  normalization_notes?: string[];
  refined_paragraphs?: TemplateClassificationRefinedParagraphDiagnostic[];
  refinement_elapsed_ms?: number;
}

export interface TemplateIgnoredUnknownSemanticMatch {
  semantic_key: string;
  paragraph_ids: string[];
  confidence?: number;
  reason?: string;
}

export interface TemplateUnmatchedPolicySnapshot {
  allow_unclassified_paragraphs: boolean;
  reject_unmatched_when_required: boolean;
}

export type TemplateNumberingRuleSource = "semantic_rule" | "global_rule";

export interface TemplateValidationIssueDiagnostics {
  semantic_key?: string;
  numbering_prefix?: string;
  rule_source?: TemplateNumberingRuleSource;
  allowed_patterns?: string[];
  unmatched_paragraphs?: TemplateUnmatchedParagraphDiagnostic[];
  policy?: TemplateUnmatchedPolicySnapshot;
}

export interface TemplateAtomicPlanItem {
  semantic_key: string;
  paragraph_ids: string[];
  selector: TemplatePatchSelector;
  operations: TemplatePatchOperation[];
  source_block?: TemplatePatchBlock;
}

export interface TemplateDerivedSemanticPlanItem extends TemplateAtomicPlanItem {
  semantic_key: DerivedSemanticBlock["key"];
}

export type TemplateRunWarningKind = "body_paragraph_numbering_prefix";

export interface TemplateRunWarningDiagnostics {
  semantic_key: string;
  text_excerpt: string;
  numbering_prefix: string;
  detected_prefix?: string;
  warning_kind: TemplateRunWarningKind;
}

export interface TemplateRunWarning {
  code: string;
  message: string;
  paragraph_ids: string[];
  diagnostics: TemplateRunWarningDiagnostics;
}

export interface TemplateRunReport {
  status: TemplateRunStatus;
  template_meta: TemplateMeta;
  stage_timings_ms?: TemplateRunStageTimings;
  observation_summary: TemplateObservationSummary;
  classification_result: TemplateClassificationResult;
  validation_result: TemplateValidationResult;
  warnings?: TemplateRunWarning[];
  execution_plan: TemplateAtomicPlanItem[];
  patch_plan: TemplatePatchPlanItem[];
  write_plan: TemplateWritePlanItem[];
  execution_result: TemplateExecutionResult;
}

export interface TemplateRunnerDeps {
  loadTemplate?: (templatePath: string) => Promise<TemplateContract>;
  observeDocx?: (docxPath: string) => Promise<PythonDocxObservationState>;
  classifyParagraphs?: (input: {
    template: TemplateContract;
    context: TemplateContext;
    llm?: TemplateLlmConfig;
  }) => Promise<TemplateClassificationResult>;
  buildPatchPlan?: (input: TemplatePatchPlanBuildInput) => TemplatePatchPlanBuildResult;
  buildWritePlan?: (input: TemplateWritePlanBuildInput) => TemplateWritePlanBuildResult;
  executePatchPlan?: (input: TemplatePatchPlanExecutionInput) => Promise<TemplatePatchExecutionResult>;
  executeWritePlan?: (input: TemplateWritePlanExecutionInput) => Promise<TemplateWritePlanExecutionResult>;
  materializeDoc?: (
    doc: DocumentIR
  ) => Promise<{ doc: DocumentIR; summary: string; artifacts?: Record<string, unknown> }>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface TemplateWritePlanItem {
  id: string;
  semantic_key: string;
  selector?: TemplatePatchSelector;
  operations?: TemplatePatchOperation[];
  intent?: WriteIntent;
  legacy_operation?: Operation;
}

export interface TemplateExecutionArtifactsStable {
  patch_set_count: number;
  patch_target_count: number;
  patch_part_paths: string[];
  write_operation_count: number;
  executed_step_count: number;
  materialized: boolean;
  output_docx_path?: string;
  skipped_paragraph_count?: number;
  skipped_paragraph_ids?: string[];
}

export interface TemplateExecutionArtifactsDebug {
  patch_sets?: DocxPatchSet[];
  step_summaries?: string[];
  change_set_summary?: Record<string, unknown>;
  materialize_artifacts_summary?: Record<string, unknown>;
}

export type TemplateExecutionArtifacts = TemplateExecutionArtifactsStable & Partial<TemplateExecutionArtifactsDebug>;

export interface TemplateExecutionResult {
  applied: boolean;
  output_docx_path?: string;
  change_summary?: string;
  artifacts?: TemplateExecutionArtifacts;
  issues?: TemplateValidationIssue[];
}

export interface TemplateWritePlanBuildInput {
  template?: TemplateContract;
  executionPlan: TemplateAtomicPlanItem[];
  document: DocumentIR;
  structureIndex: DocumentStructureIndex;
}

export interface TemplatePatchPlanItem {
  id: string;
  semantic_key: string;
  operation: TemplateWritePlanItem;
  patch_set: DocxPatchSet;
  patch_target_ids: string[];
  patch_target_count: number;
  patch_part_paths: string[];
}

export interface TemplatePatchPlanBuildResult {
  patchPlan: TemplatePatchPlanItem[];
  writePlan: TemplateWritePlanItem[];
  issues: TemplateValidationIssue[];
  document: DocumentIR;
  structureIndex: DocumentStructureIndex;
}

export type TemplatePatchPlanBuildInput = TemplateWritePlanBuildInput;
export type TemplateWritePlanBuildResult = TemplatePatchPlanBuildResult;

export interface TemplatePatchPlanExecutionInput {
  context: TemplateContext;
  patchPlan: TemplatePatchPlanItem[];
  writePlan: TemplateWritePlanItem[];
  outputDocxPath: string;
  debug?: boolean;
}

export interface TemplatePatchExecutionResult {
  applied: boolean;
  finalDoc: DocumentIR;
  changeSummary?: string;
  artifacts?: Record<string, unknown>;
}

export type TemplateWritePlanExecutionInput = TemplatePatchPlanExecutionInput;
export type TemplateWritePlanExecutionResult = TemplatePatchExecutionResult;
