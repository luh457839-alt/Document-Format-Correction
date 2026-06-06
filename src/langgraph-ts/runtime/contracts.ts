import type { BaseMessage } from "@langchain/core/messages";
import type { ChatDocumentProjection, ParsedDocumentBundle, TemplateDocumentProjection } from "../contracts/document-contracts.js";
import type { WriteToolInput } from "../tooling/contracts.js";

export type RuntimeMode = "chat" | "template" | "clarify";

export interface TemplateTaskPayload {
  template_id: string;
  instructions: string;
  tool_input: WriteToolInput;
  semantic_tags?: string[];
}

export interface ProjectionIntent {
  focus_regex_probe?: string;
  chat_text_budget?: number;
  template_text_budget?: number;
  template_batch_budget?: number;
  chat_neighbor_window?: number;
  template_local_context_window?: number;
}

export interface RuntimeInput {
  thread_id: string;
  document_path: string;
  user_message: string;
  output_path?: string;
  template_task?: TemplateTaskPayload;
  projection_intent?: ProjectionIntent;
}

export interface RuntimeDiagnostic extends Record<string, unknown> {
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
    | "provider_tool_args_invalid"
    | "provider_tool_args_unmappable"
    | "provider_reasoning_context_missing"
    | "provider_tool_call_trace"
    | "provider_tool_call_normalized";
}

export interface RuntimeArtifactRef {
  kind: string;
  path: string;
}

export interface AgentState {
  messages: BaseMessage[];
  mode?: RuntimeMode;
  document_path?: string;
  output_path?: string;
  document_bundle?: ParsedDocumentBundle;
  chat_projection?: ChatDocumentProjection;
  template_projection?: TemplateDocumentProjection;
  projection_intent?: ProjectionIntent;
  template_config?: TemplateTaskPayload;
  semantic_tags: string[];
  executed_patch_keys: string[];
  diagnostics: RuntimeDiagnostic[];
  artifact_refs: RuntimeArtifactRef[];
}

export interface RunResult {
  state: AgentState;
  reply: string;
  artifacts: {
    output_docx_path?: string;
  };
}

export interface RuntimeCheckpointer {
  load(threadId: string): Promise<unknown | undefined>;
  save(threadId: string, state: unknown): Promise<void>;
}

export interface RuntimeModelAdapter {
  invoke(messages: BaseMessage[], input: RuntimeInput): Promise<BaseMessage>;
}

export interface RuntimeDeps {
  model: RuntimeModelAdapter;
  checkpoint?: RuntimeCheckpointer;
}

export interface StoredAgentState extends Omit<AgentState, "messages"> {
  messages: unknown[];
}
