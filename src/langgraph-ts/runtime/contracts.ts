import type { BaseMessage } from "@langchain/core/messages";
import type { ChatDocumentProjection, ParsedDocumentBundle, TemplateDocumentProjection } from "../contracts/document-contracts.js";
import type { WriteToolInput } from "../tooling/contracts.js";

export type Phase3Mode = "chat" | "template" | "clarify";

export interface Phase3TemplateTaskPayload {
  template_id: string;
  instructions: string;
  tool_input: WriteToolInput;
  semantic_tags?: string[];
}

export interface Phase3ProjectionIntent {
  focus_regex_probe?: string;
  chat_text_budget?: number;
  template_text_budget?: number;
  template_batch_budget?: number;
  chat_neighbor_window?: number;
  template_local_context_window?: number;
}

export interface Phase3RuntimeInput {
  thread_id: string;
  document_path: string;
  user_message: string;
  output_path?: string;
  template_task?: Phase3TemplateTaskPayload;
  projection_intent?: Phase3ProjectionIntent;
}

export interface Phase3Diagnostic extends Record<string, unknown> {
  stage: string;
  reconciled_part_count?: number;
  added_relationship_count?: number;
  removed_relationship_count?: number;
  unsupported_reference_kind?: string;
  provider?: string;
  provider_model?: string;
  provider_base_url?: string;
  provider_diagnostic_kind?:
    | "provider_protocol_error"
    | "provider_read_loop_exhausted"
    | "provider_tool_args_unmappable"
    | "provider_reasoning_context_missing";
}

export interface Phase3ArtifactRef {
  kind: string;
  path: string;
}

export interface Phase3AgentState {
  messages: BaseMessage[];
  mode?: Phase3Mode;
  document_path?: string;
  output_path?: string;
  document_bundle?: ParsedDocumentBundle;
  chat_projection?: ChatDocumentProjection;
  template_projection?: TemplateDocumentProjection;
  projection_intent?: Phase3ProjectionIntent;
  template_config?: Phase3TemplateTaskPayload;
  semantic_tags: string[];
  executed_patch_keys: string[];
  diagnostics: Phase3Diagnostic[];
  artifact_refs: Phase3ArtifactRef[];
}

export interface Phase3RunResult {
  state: Phase3AgentState;
  reply: string;
  artifacts: {
    output_docx_path?: string;
  };
}

export interface Phase3Checkpointer {
  load(threadId: string): Promise<unknown | undefined>;
  save(threadId: string, state: unknown): Promise<void>;
}

export interface Phase3ModelAdapter {
  invoke(messages: BaseMessage[], input: Phase3RuntimeInput): Promise<BaseMessage>;
}

export interface Phase3RuntimeDeps {
  model: Phase3ModelAdapter;
  checkpoint?: Phase3Checkpointer;
}

export interface Phase3StoredAgentState extends Omit<Phase3AgentState, "messages"> {
  messages: unknown[];
}
