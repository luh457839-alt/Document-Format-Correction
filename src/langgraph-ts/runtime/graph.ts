import path from "node:path";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage
} from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { AgentError } from "../core/errors.js";
import { buildChatProjection } from "../projections/build-chat-projection.js";
import { buildTemplateProjection } from "../projections/build-template-projection.js";
import { parseDocumentBundle } from "../document-core/parse-document-bundle.js";
import type { OperationType } from "../core/types.js";
import { executeWriteTool } from "../tooling/write-tool.js";
import type { WriteTargetSpec } from "../tooling/contracts.js";
import { analyzeWriteTarget } from "../tooling/target-resolution.js";
import { compileWriteToolPatchSet } from "../tooling/patch-compilation.js";
import type { DocxPatchTarget } from "../document-core/docx-observation-schema.js";
import { DOCUMENT_AGENT_SYSTEM_PROMPT } from "../model/provider-adapter.js";
import { applyPatchOperationsToBundle } from "./bundle-mutation.js";
import type {
  AgentState,
  RuntimeCheckpointer,
  RuntimeMode,
  RunResult,
  RuntimeDeps,
  RuntimeInput,
  StoredAgentState
} from "./contracts.js";
import { materializeBundle } from "./materialize.js";
import { reconcileBundleRelationships } from "./relationship-reconcile.js";

const DocumentAgentGraph = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  mode: Annotation<RuntimeMode | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  document_path: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  output_path: Annotation<string | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  document_bundle: Annotation<AgentState["document_bundle"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  chat_projection: Annotation<AgentState["chat_projection"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  template_projection: Annotation<AgentState["template_projection"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  template_config: Annotation<AgentState["template_config"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  semantic_tags: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  executed_patch_keys: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  diagnostics: Annotation<AgentState["diagnostics"]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  artifact_refs: Annotation<AgentState["artifact_refs"]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  projection_intent: Annotation<AgentState["projection_intent"]>({
    reducer: (_left, right) => right,
    default: () => undefined
  })
});

export async function runDocumentAgentGraph(input: RuntimeInput, deps: RuntimeDeps): Promise<RunResult> {
  const checkpoint = deps.checkpoint;
  const restored = checkpoint ? restoreStoredState((await checkpoint.load(input.thread_id)) as StoredAgentState | undefined) : undefined;
  const restoredArtifactCount = restored?.artifact_refs.length ?? 0;
  const initialMessages = restored?.messages?.length
    ? restored.messages.concat([new HumanMessage(input.user_message)])
    : [new SystemMessage(DOCUMENT_AGENT_SYSTEM_PROMPT), new HumanMessage(input.user_message)];
  const initialState: typeof DocumentAgentGraph.State = {
    messages: initialMessages,
    mode: restored?.mode,
    document_path: input.document_path,
    output_path: restored?.output_path ?? input.output_path ?? defaultOutputPath(input.document_path),
    document_bundle: restored?.document_bundle,
    chat_projection: restored?.chat_projection,
    template_projection: restored?.template_projection,
    projection_intent: input.projection_intent ?? restored?.projection_intent,
    template_config: input.template_task ?? restored?.template_config,
    semantic_tags: restored?.semantic_tags ?? [],
    executed_patch_keys: restored?.executed_patch_keys ?? [],
    diagnostics: restored?.diagnostics ?? [],
    artifact_refs: restored?.artifact_refs ?? []
  };

  const graph = new StateGraph(DocumentAgentGraph)
    .addNode("intent_router", async (state) => routeIntent(state, input))
    .addNode("document_load_and_parse", async (state) => loadDocumentBundle(state, input))
    .addNode("projection_builder", async (state) => buildProjections(state))
    .addNode("reasoning", async (state) => reasoningNode(state, input, deps))
    .addNode("tools", async (state) => invokeWriteTools(state))
    .addNode("template_classifier", async (state) => classifyTemplate(state))
    .addNode("template_engine", async (state) => templateEngineNode(state))
    .addNode("direct_response", async (state) => directResponseNode(state, input, deps))
    .addNode("materialize_and_reconcile", async (state) => materializeNode(state))
    .addEdge(START, "intent_router")
    .addEdge("intent_router", "document_load_and_parse")
    .addEdge("document_load_and_parse", "projection_builder")
    .addConditionalEdges("projection_builder", (state) => routeByMode(state))
    .addConditionalEdges("reasoning", (state) => reactContinueOrFinish(state))
    .addEdge("template_classifier", "template_engine")
    .addConditionalEdges("template_engine", (state) => templateContinueOrFinish(state))
    .addConditionalEdges("tools", (state) => continueAfterTools(state))
    .addEdge("direct_response", END)
    .addEdge("materialize_and_reconcile", END)
    .compile();

  let state: typeof DocumentAgentGraph.State;
  try {
    state = await graph.invoke(initialState, { recursionLimit: 40 });
  } catch (error) {
    if (isGraphRecursionLimitError(error)) {
      const failedState = {
        ...(initialState as AgentState),
        messages: initialMessages.concat([
          new AIMessage("runtime_graph_recursion_limit: model did not reach a stop condition before the graph recursion limit.")
        ]),
        diagnostics: (initialState.diagnostics ?? []).concat([
          {
            stage: "runtime_graph",
            error_code: "E_GRAPH_RECURSION_LIMIT",
            message: error instanceof Error ? error.message : String(error)
          }
        ])
      } satisfies AgentState;
      if (checkpoint) {
        await checkpoint.save(input.thread_id, storeState(failedState));
      }
      return {
        state: failedState,
        reply: extractReply(failedState.messages),
        artifacts: {}
      };
    }
    throw error;
  }
  if (checkpoint) {
    await checkpoint.save(input.thread_id, storeState(state as AgentState));
  }
  const reply = extractReply((state as AgentState).messages);
  const outputDocx = (state as AgentState).artifact_refs.slice(restoredArtifactCount).find((artifact) => artifact.kind === "docx")?.path;
  return {
    state: state as AgentState,
    reply,
    artifacts: {
      ...(outputDocx ? { output_docx_path: outputDocx } : {})
    }
  };
}

function routeIntent(state: typeof DocumentAgentGraph.State, input: RuntimeInput): Partial<typeof DocumentAgentGraph.State> {
  if (input.template_task) {
    return {
      mode: "template",
      template_config: input.template_task,
      projection_intent: input.projection_intent ?? state.projection_intent
    };
  }
  const latestUserMessage = input.user_message;
  if (/(解释|说明|不要修改|clarify)/i.test(latestUserMessage)) {
    return { mode: "clarify", projection_intent: input.projection_intent ?? state.projection_intent };
  }
  return { mode: "chat", projection_intent: input.projection_intent ?? state.projection_intent };
}

async function loadDocumentBundle(
  state: typeof DocumentAgentGraph.State,
  input: RuntimeInput
): Promise<Partial<typeof DocumentAgentGraph.State>> {
  if (state.document_bundle && state.document_path === input.document_path) {
    return {};
  }
  const bundle = await parseDocumentBundle({
    docxPath: input.document_path,
    mediaDir: path.join(path.dirname(input.document_path), ".runtime-media")
  });
  return {
    document_path: input.document_path,
    output_path: state.output_path ?? defaultOutputPath(input.document_path),
    document_bundle: bundle
  };
}

function buildProjections(state: typeof DocumentAgentGraph.State): Partial<typeof DocumentAgentGraph.State> {
  if (!state.document_bundle) {
    return {};
  }
  const diagnostics: AgentState["diagnostics"] = [];
  const update: Partial<typeof DocumentAgentGraph.State> = {};

  try {
    update.chat_projection = buildChatProjection(state.document_bundle, {
      focusRegexProbe: state.projection_intent?.focus_regex_probe,
      textBudget: state.projection_intent?.chat_text_budget,
      neighborWindow: state.projection_intent?.chat_neighbor_window
    });
  } catch (error) {
    diagnostics.push(toProjectionDiagnostic("chat_projection", error));
  }

  try {
    update.template_projection = buildTemplateProjection(state.document_bundle, {
      localContextWindow: state.projection_intent?.template_local_context_window,
      textBudget: state.projection_intent?.template_text_budget,
      maxBatchBudget: state.projection_intent?.template_batch_budget,
      includeSemanticFeatures: true
    });
  } catch (error) {
    diagnostics.push(toProjectionDiagnostic("template_projection", error));
  }

  return {
    ...update,
    ...(diagnostics.length > 0 ? { diagnostics } : {})
  };
}

async function reasoningNode(
  state: typeof DocumentAgentGraph.State,
  input: RuntimeInput,
  deps: RuntimeDeps
): Promise<Partial<typeof DocumentAgentGraph.State>> {
  if (!state.chat_projection) {
    return {
      messages: [new AIMessage("聊天投影构建失败，无法继续推理。")]
    };
  }
  const message = await deps.model.invoke(buildReasoningMessages(state), input);
  const diagnostics = extractModelDiagnostics(message);
  return {
    messages: [message],
    ...(diagnostics.length > 0 ? { diagnostics } : {})
  };
}

function classifyTemplate(state: typeof DocumentAgentGraph.State): Partial<typeof DocumentAgentGraph.State> {
  if (!state.template_projection) {
    return {
      messages: [new AIMessage("模板投影构建失败，无法执行模板分类。")],
      diagnostics: [
        {
          stage: "template_classifier",
          error_code: "E_TEMPLATE_CLASSIFICATION_ABORTED",
          message: "template projection is missing"
        }
      ]
    };
  }
  const paragraphs = state.template_projection.batches.flatMap((batch) => batch.paragraphs);
  if (paragraphs.some((paragraph) => !hasRequiredTemplateFields(paragraph))) {
    return {
      messages: [new AIMessage("模板分类输入字段不完整，已阻断模板执行。")],
      diagnostics: [
        {
          stage: "template_classifier",
          error_code: "E_TEMPLATE_CLASSIFICATION_REQUIRED_FIELDS_MISSING",
          message: "template projection paragraphs are missing classifier-required fields"
        }
      ]
    };
  }
  const semanticTags = classifyTemplateProjection(state.template_projection);
  return {
    semantic_tags: semanticTags,
    diagnostics: [
      {
        stage: "template_classifier",
        semantic_tags: semanticTags,
        batch_count: state.template_projection.batches.length
      }
    ]
  };
}

function templateEngineNode(state: typeof DocumentAgentGraph.State): Partial<typeof DocumentAgentGraph.State> {
  const config = state.template_config;
  if (!config) {
    return {
      messages: [new AIMessage("模板配置缺失，无法执行。")]
    };
  }
  if (!state.semantic_tags.length) {
    return {
      messages: [new AIMessage("模板分类失败，未生成写入动作。")]
    };
  }
  return {
    messages: [
      new AIMessage({
        content: `模板 ${config.template_id} 已基于分类标签生成写入动作。`,
        tool_calls: [
          {
            id: `template-tool-${config.tool_input.request_id}`,
            name: "write_document",
            args: config.tool_input
          }
        ]
      })
    ]
  };
}

async function directResponseNode(
  state: typeof DocumentAgentGraph.State,
  input: RuntimeInput,
  deps: RuntimeDeps
): Promise<Partial<typeof DocumentAgentGraph.State>> {
  const message = await deps.model.invoke(state.messages, input);
  const diagnostics = extractModelDiagnostics(message);
  return {
    messages: [message],
    ...(diagnostics.length > 0 ? { diagnostics } : {})
  };
}

async function materializeNode(state: typeof DocumentAgentGraph.State): Promise<Partial<typeof DocumentAgentGraph.State>> {
  const outputPath = state.output_path;
  if (!outputPath || !state.document_bundle) {
    return {};
  }
  let reconciled;
  try {
    reconciled = reconcileBundleRelationships(state.document_bundle);
  } catch (error) {
    return {
      diagnostics: [
        toMaterializeDiagnostic("reconcile", error)
      ]
    };
  }
  let materialized;
  try {
    materialized = await materializeBundle(reconciled.bundle, outputPath);
  } catch (error) {
    return {
      diagnostics: reconciled.diagnostics.concat([toMaterializeDiagnostic("materialize", error)])
    };
  }
  return {
    document_bundle: reconciled.bundle,
    artifact_refs: [materialized.artifact],
    diagnostics: reconciled.diagnostics.concat(materialized.diagnostics)
  };
}

function routeByMode(state: typeof DocumentAgentGraph.State): string {
  if (state.mode === "template") {
    return "template_classifier";
  }
  if (state.mode === "clarify") {
    return "direct_response";
  }
  return "reasoning";
}

function reactContinueOrFinish(state: typeof DocumentAgentGraph.State): string {
  const last = state.messages.at(-1);
  if (last instanceof AIMessage && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
    return "tools";
  }
  if (shouldMaterialize(state)) {
    return "materialize_and_reconcile";
  }
  return END;
}

function templateContinueOrFinish(state: typeof DocumentAgentGraph.State): string {
  const last = state.messages.at(-1);
  if (last instanceof AIMessage && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
    return "tools";
  }
  return shouldMaterialize(state) ? "materialize_and_reconcile" : END;
}

function invokeWriteTools(state: typeof DocumentAgentGraph.State): Partial<typeof DocumentAgentGraph.State> {
  const last = state.messages.at(-1);
  if (!(last instanceof AIMessage) || !Array.isArray(last.tool_calls) || last.tool_calls.length === 0) {
    return {};
  }

  const toolMessages: ToolMessage[] = [];
  let workingBundle = state.document_bundle;
  const newExecutedPatchKeys: string[] = [];

  for (const toolCall of last.tool_calls) {
    if (toolCall.name !== "write_document") {
      toolMessages.push(
        new ToolMessage({
          content: `Unsupported tool '${toolCall.name}'.`,
          tool_call_id: toolCall.id ?? "unsupported_tool",
          status: "error",
          artifact: {
            state_update: {
              diagnostics: [
                {
                  stage: "write_tool",
                  error_code: "E_UNSUPPORTED_TOOL_NAME",
                  message: `Unsupported tool '${toolCall.name}'.`
                }
              ]
            }
          }
        })
      );
      continue;
    }

    const toolMessage = executeWriteDocumentCall(
      workingBundle,
      state.executed_patch_keys.concat(newExecutedPatchKeys),
      toolCall.args as WriteDocumentToolInput,
      toolCall.id ?? "write_document"
    );
    toolMessages.push(toolMessage);

    const stateUpdate = toolMessage.artifact?.state_update as Partial<typeof DocumentAgentGraph.State> | undefined;
    if (stateUpdate?.document_bundle) {
      workingBundle = stateUpdate.document_bundle;
    }
    if (stateUpdate?.executed_patch_keys) {
      newExecutedPatchKeys.push(...stateUpdate.executed_patch_keys);
    }
  }

  return mergeToolArtifacts(state, toolMessages);
}

type WriteDocumentToolInput = {
  request_id: string;
  operation: OperationType;
  target: WriteTargetSpec;
  payload: Record<string, unknown>;
  idempotency_key?: string;
};

function executeWriteDocumentCall(
  bundle: AgentState["document_bundle"],
  executedPatchKeys: string[],
  rawInput: WriteDocumentToolInput,
  toolCallId: string
): ToolMessage {
  if (!bundle) {
    return new ToolMessage({
      content: "Document bundle is not loaded.",
      tool_call_id: toolCallId,
      status: "error",
      artifact: {
        state_update: {
          diagnostics: [
            {
              stage: "write_tool",
              error_code: "E_DOCUMENT_BUNDLE_MISSING",
              message: "Document bundle is not loaded."
            }
          ]
        }
      }
    });
  }

  const execution = executeWriteTool(bundle, rawInput, {
    executed_patch_keys: executedPatchKeys
  });
  if (!execution.ok) {
    return new ToolMessage({
      content: JSON.stringify(execution),
      tool_call_id: toolCallId,
      status: "error",
      artifact: {
        state_update: {
          diagnostics: [
            {
              ...execution
            }
          ]
        }
      }
    });
  }

  const analysis = analyzeWriteTarget(bundle, rawInput.target, rawInput.payload);
  try {
    const compilation = compileWriteToolPatchSet(bundle, rawInput, analysis);
    const targetMap = new Map(
      ((bundle.document_ast.patchTargets as DocxPatchTarget[]) ?? []).map((target) => [target.id, target] as const)
    );
    const patchTargets = compilation.patchSet.targets?.map((target) => targetMap.get(target.id) ?? target) ?? [];
    const mutation = execution.executed
      ? applyPatchOperationsToBundle(bundle, patchTargets, compilation.patchSet.operations)
      : { bundle, changed: false };
    return new ToolMessage({
      content: execution.summary,
      tool_call_id: toolCallId,
      status: "success",
      artifact: {
        state_update: {
          ...(execution.idempotency_key && execution.executed ? { executed_patch_keys: [execution.idempotency_key] } : {}),
          document_bundle: mutation.bundle,
          diagnostics: [
            {
              stage: "write_tool",
              request_id: rawInput.request_id,
              executed: execution.executed,
              skip_reason: execution.skip_reason,
              idempotency_key: execution.idempotency_key,
              target_count: execution.target_count
            },
            ...(execution.diagnostics ?? []).map((entry) => ({
              ...entry
            }))
          ]
        }
      }
    });
  } catch (error) {
    return new ToolMessage({
      content: error instanceof Error ? error.message : String(error),
      tool_call_id: toolCallId,
      status: "error",
      artifact: {
        state_update: {
          diagnostics: [
            {
              stage: "write_tool",
              request_id: rawInput.request_id,
              executed: false,
              error_code: error instanceof AgentError ? error.code : "E_WRITE_TOOL_FAILED",
              message: error instanceof Error ? error.message : String(error)
            }
          ]
        }
      }
    });
  }
}

function mergeToolArtifacts(
  _state: typeof DocumentAgentGraph.State,
  toolMessages: ToolMessage[]
): Partial<typeof DocumentAgentGraph.State> {
  const update: Partial<typeof DocumentAgentGraph.State> = {
    messages: toolMessages
  };
  for (const message of toolMessages) {
    const stateUpdate = message.artifact?.state_update as Partial<typeof DocumentAgentGraph.State> | undefined;
    if (!stateUpdate) {
      continue;
    }
    if (stateUpdate.document_bundle) {
      update.document_bundle = stateUpdate.document_bundle;
    }
    if (stateUpdate.executed_patch_keys) {
      update.executed_patch_keys = stateUpdate.executed_patch_keys;
    }
    if (stateUpdate.diagnostics) {
      update.diagnostics = (update.diagnostics ?? []).concat(stateUpdate.diagnostics);
    }
  }
  return update;
}

function continueAfterTools(state: typeof DocumentAgentGraph.State): string {
  if (state.mode === "template") {
    return shouldMaterialize(state) ? "materialize_and_reconcile" : END;
  }
  return "reasoning";
}

function shouldMaterialize(state: typeof DocumentAgentGraph.State): boolean {
  for (let index = state.diagnostics.length - 1; index >= 0; index -= 1) {
    const entry = state.diagnostics[index];
    if (entry.stage === "materialize") {
      return false;
    }
    if (entry.stage === "write_tool") {
      return entry.executed !== false;
    }
  }
  return false;
}

function buildReasoningMessages(state: typeof DocumentAgentGraph.State): BaseMessage[] {
  if (!state.chat_projection) {
    return state.messages;
  }
  const projectionSummary = {
    kind: state.chat_projection.kind,
    diagnostics: state.chat_projection.diagnostics,
    focusParagraphs: state.chat_projection.paragraphs
      .filter((paragraph) => paragraph.focusPriority === "regex_hit" || paragraph.focusPriority === "regex_neighbor")
      .map((paragraph) => ({
        paragraphId: paragraph.paragraphId,
        focusPriority: paragraph.focusPriority,
        text: paragraph.text
      })),
    emphasisRuns: state.chat_projection.emphasisRuns.slice(0, 6)
  };
  return state.messages.concat([new HumanMessage(`projection_context=${JSON.stringify(projectionSummary, null, 2)}`)]);
}

function toProjectionDiagnostic(projectionKind: string, error: unknown): AgentState["diagnostics"][number] {
  if (error instanceof AgentError) {
    return {
      stage: "projection_builder",
      projection_kind: projectionKind,
      error_code: error.code,
      message: error.message
    };
  }
  return {
    stage: "projection_builder",
    projection_kind: projectionKind,
    error_code: "E_PROJECTION_BUILD_FAILED",
    message: error instanceof Error ? error.message : String(error)
  };
}

function toMaterializeDiagnostic(stage: "reconcile" | "materialize", error: unknown): AgentState["diagnostics"][number] {
  if (error instanceof AgentError) {
    return {
      stage,
      error_code: error.code,
      message: error.message
    };
  }
  return {
    stage,
    error_code: stage === "reconcile" ? "E_RECONCILE_FAILED" : "E_MATERIALIZE_FAILED",
    message: error instanceof Error ? error.message : String(error)
  };
}

function hasRequiredTemplateFields(paragraph: NonNullable<AgentState["template_projection"]>["paragraphs"][number]): boolean {
  return (
    typeof paragraph.paragraphId === "string" &&
    typeof paragraph.text === "string" &&
    typeof paragraph.bucketType === "string" &&
    typeof paragraph.paragraphIndex === "number" &&
    typeof paragraph.isImageDominant === "boolean" &&
    Boolean(paragraph.localContext) &&
    Array.isArray(paragraph.localContext.before) &&
    Array.isArray(paragraph.localContext.after)
  );
}

function classifyTemplateProjection(projection: NonNullable<AgentState["template_projection"]>): string[] {
  const tags = new Set<string>();
  const paragraphs = projection.batches.flatMap((batch) => batch.paragraphs);
  if (paragraphs.some((paragraph) => paragraph.bucketType === "heading" || paragraph.headingLevel !== undefined)) {
    tags.add("structured_headings");
  }
  if (paragraphs.some((paragraph) => Boolean(paragraph.numberingPattern))) {
    tags.add("numbered_sections");
  }
  if (paragraphs.some((paragraph) => paragraph.isImageDominant)) {
    tags.add("image_dominant_blocks");
  }
  if (paragraphs.some((paragraph) => paragraph.bucketType === "table_text")) {
    tags.add("table_mixed_content");
  }
  if (paragraphs.some((paragraph) => paragraph.bucketType === "body" && paragraph.localContext.after.length > 0)) {
    tags.add("body_text_document");
  }
  if (tags.size === 0 && paragraphs.length > 0) {
    tags.add("template_projection_ready");
  }
  return Array.from(tags);
}

function storeState(state: AgentState): StoredAgentState {
  return {
    ...state,
    messages: mapChatMessagesToStoredMessages(state.messages)
  };
}

function restoreStoredState(state: StoredAgentState | undefined): AgentState | undefined {
  if (!state) {
    return undefined;
  }
  return {
    ...state,
    messages: mapStoredMessagesToChatMessages(state.messages as never[])
  };
}

function defaultOutputPath(documentPath: string): string {
  const parsed = path.parse(documentPath);
  return path.join(parsed.dir, `${parsed.name}.phase3${parsed.ext}`);
}

function extractReply(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof AIMessage) {
      if (typeof message.content === "string" && message.content.trim()) {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        return message.content.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n");
      }
    }
  }
  return "";
}

function extractModelDiagnostics(message: BaseMessage): AgentState["diagnostics"] {
  if (!(message instanceof AIMessage)) {
    return [];
  }
  const diagnostics = message.additional_kwargs?.runtime_diagnostics ?? message.additional_kwargs?.phase3_diagnostics;
  if (!Array.isArray(diagnostics)) {
    return [];
  }
  return diagnostics.filter(
    (entry): entry is AgentState["diagnostics"][number] =>
      typeof entry === "object" && entry !== null && typeof (entry as { stage?: unknown }).stage === "string"
  );
}

function isGraphRecursionLimitError(error: unknown): boolean {
  return error instanceof Error && /Recursion limit/i.test(error.message);
}
