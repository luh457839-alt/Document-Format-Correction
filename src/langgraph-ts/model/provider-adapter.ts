import path from "node:path";
import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import {
  OpenAIClient,
  convertCompletionsMessageToBaseMessage,
  convertMessagesToCompletionsMessageParams
} from "@langchain/openai";
import { getEndpoint } from "@langchain/openai";
import { parseDocumentBundle } from "../document-core/parse-document-bundle.js";
import type { ParsedDocumentBundle } from "../contracts/document-contracts.js";
import type { OperationType } from "../core/types.js";
import { buildChatProjection } from "../projections/build-chat-projection.js";
import { buildTemplateProjection } from "../projections/build-template-projection.js";
import type { Phase3Diagnostic, Phase3ModelAdapter, Phase3RuntimeInput } from "../runtime/contracts.js";
import type { WriteToolInput } from "../tooling/contracts.js";
import { normalizeWriteToolPayload } from "../tooling/payload-normalization.js";
import { parseWriteToolInput } from "../tooling/schema.js";

type ProviderOperation = OperationType | "read";

const writeToolOperations = [
  "set_font",
  "set_size",
  "set_line_spacing",
  "set_alignment",
  "set_font_color",
  "set_bold",
  "set_italic",
  "set_underline",
  "set_strike",
  "set_highlight_color",
  "set_all_caps",
  "set_page_layout",
  "set_paragraph_spacing",
  "set_paragraph_indent",
  "set_style_definition",
  "set_numbering_level",
  "set_settings_flag",
  "set_attr",
  "remove_attr",
  "set_text",
  "remove_node",
  "ensure_node",
  "replace_node_xml",
  "merge_paragraph",
  "split_paragraph"
] as const satisfies readonly OperationType[];

const providerOperationValues = ["read", ...writeToolOperations] as const;

export const PHASE3_STRONG_SYSTEM_PROMPT = [
  "你是文档格式修复助手。",
  "你只能使用 write_document 工具，不得输出自由文本形式的修改指令。",
  "优先一次性直接输出最终 write_document。",
  "只有在信息不足、必须先查看文档结构时，才允许先发起 operation=read。",
  "最终写入必须严格遵守 WriteToolInput：request_id、operation、target、payload。",
  "semantic_selector 只允许 title_like_paragraphs 或 body_like_paragraphs。",
  "语义样式同步 payload 只允许 baseline_from_semantic=body_like_paragraphs 和受限 sync_fields。",
  "禁止自由文本 target，禁止自造 operation，禁止使用未定义 payload 字段。"
].join("\n");

export interface ProviderAdapterConfig {
  provider: string;
  baseUrl: string;
  model: string;
  supportsReasoningContextReplay?: boolean;
  maxInternalTurns?: number;
}

export interface ProviderTransportRequest {
  config: ProviderAdapterConfig;
  input: Phase3RuntimeInput;
  messages: BaseMessage[];
  tools: ProviderToolDefinition[];
  toolChoice: "auto";
}

export interface ProviderTransport {
  invoke(request: ProviderTransportRequest): Promise<AIMessage>;
}

interface ProviderToolDefinition {
  type: "function";
  function: {
    name: "write_document";
    description: string;
    strict: true;
    parameters: Record<string, unknown>;
  };
}

export function createProviderModelAdapter(
  config: ProviderAdapterConfig,
  transport: ProviderTransport
): Phase3ModelAdapter {
  return {
    async invoke(messages, input) {
      const loadBundle = createBundleLoader(input.document_path);
      const tools = [buildProviderWriteDocumentTool()];
      const maxInternalTurns = config.maxInternalTurns ?? 3;
      let workingMessages = withStrongSystemPrompt(messages);
      let latestReasoningContent: string | undefined;

      for (let turn = 0; turn < maxInternalTurns; turn += 1) {
        let remoteMessage: AIMessage;
        try {
          remoteMessage = await transport.invoke({
            config,
            input,
            messages: workingMessages,
            tools,
            toolChoice: "auto"
          });
        } catch (error) {
          return buildProviderFailureMessage(
            config,
            "provider_protocol_error",
            `provider invocation failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        const reasoningContent = readNonEmptyString(remoteMessage.additional_kwargs?.reasoning_content);
        if (reasoningContent) {
          latestReasoningContent = reasoningContent;
        }

        const toolCalls = remoteMessage.tool_calls ?? [];
        if (toolCalls.length === 0) {
          return remoteMessage;
        }

        const readToolCalls = toolCalls.filter((toolCall) => isProviderReadOperation(toolCall.args));
        if (readToolCalls.length > 0) {
          if (readToolCalls.length !== toolCalls.length || readToolCalls.length !== 1) {
            return buildProviderFailureMessage(
              config,
              "provider_protocol_error",
              "provider returned an unsupported mix of read and write tool calls"
            );
          }
          if (config.supportsReasoningContextReplay && !latestReasoningContent) {
            return buildProviderFailureMessage(
              config,
              "provider_reasoning_context_missing",
              "provider adapter expected reasoning_content before replaying the next internal turn"
            );
          }

          let readResult: Record<string, unknown>;
          try {
            readResult = await buildProviderReadToolResult(readToolCalls[0]?.args, loadBundle, input);
          } catch (error) {
            return buildProviderFailureMessage(
              config,
              "provider_protocol_error",
              `provider read tool failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }

          workingMessages = appendAssistantMessageForReplay(workingMessages, remoteMessage, latestReasoningContent).concat([
            new ToolMessage({
              content: JSON.stringify(readResult),
              tool_call_id: readToolCalls[0]?.id ?? "provider-read",
              status: "success"
            })
          ]);
          continue;
        }

        try {
          const normalizedToolCalls = await Promise.all(
            toolCalls.map(async (toolCall) => {
              if (toolCall.name !== "write_document") {
                throw new Error(`unsupported tool '${toolCall.name}'`);
              }
              return {
                id: toolCall.id,
                name: "write_document" as const,
                args: await normalizeProviderWriteToolInput(toolCall.args, input, loadBundle)
              };
            })
          );
          return new AIMessage({
            content: remoteMessage.content,
            tool_calls: normalizedToolCalls,
            additional_kwargs: remoteMessage.additional_kwargs,
            response_metadata: remoteMessage.response_metadata,
            id: remoteMessage.id
          });
        } catch (error) {
          return buildProviderFailureMessage(
            config,
            "provider_tool_args_unmappable",
            error instanceof Error ? error.message : String(error)
          );
        }
      }

      return buildProviderFailureMessage(
        config,
        "provider_read_loop_exhausted",
        `provider did not return an executable write_document within ${maxInternalTurns} internal turns`
      );
    }
  };
}

export function createChatOpenAITransport(llm: ChatOpenAI): ProviderTransport {
  return {
    async invoke(request) {
      const client = getChatOpenAIClient(llm);
      const response = await client.chat.completions.create({
        model: request.config.model,
        messages: convertToProviderWireMessages(request.messages, request.config.model),
        tools: request.tools,
        tool_choice: request.toolChoice
      });
      const choice = response.choices[0];
      if (!choice) {
        throw new Error("provider returned no completion choices");
      }
      return convertCompletionsMessageToBaseMessage({
        message: choice.message,
        rawResponse: response
      }) as AIMessage;
    }
  };
}

export function convertToProviderWireMessages(
  messages: BaseMessage[],
  model: string
): OpenAIClient.Chat.Completions.ChatCompletionMessageParam[] {
  const wireMessages = convertMessagesToCompletionsMessageParams({ messages, model });
  return wireMessages.map((wireMessage, index) => {
    const sourceMessage = messages[index];
    if (sourceMessage instanceof AIMessage) {
      const reasoningContent = readNonEmptyString(sourceMessage.additional_kwargs?.reasoning_content);
      if (reasoningContent) {
        return {
          ...wireMessage,
          reasoning_content: reasoningContent
        } as OpenAIClient.Chat.Completions.ChatCompletionAssistantMessageParam & {
          reasoning_content: string;
        };
      }
    }
    return wireMessage;
  });
}

export function buildProviderWriteDocumentTool(): ProviderToolDefinition {
  return {
    type: "function",
    function: {
      name: "write_document",
      description: "Read document structure when required, then return a final validated document write request.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          request_id: {
            type: "string",
            minLength: 1
          },
          operation: {
            type: "string",
            enum: [...providerOperationValues]
          },
          target: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", enum: ["selector"] },
                  selector: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      scope: {
                        type: "string",
                        enum: ["body", "heading", "list_item", "all_text", "paragraph_ids"]
                      },
                      headingLevel: { type: "integer", minimum: 0 },
                      paragraphIds: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string", minLength: 1 }
                      }
                    },
                    required: ["scope"]
                  }
                },
                required: ["kind", "selector"]
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", enum: ["semantic_selector"] },
                  semantic: { type: "string", enum: ["title_like_paragraphs", "body_like_paragraphs"] }
                },
                required: ["kind", "semantic"]
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", enum: ["node_ids"] },
                  node_ids: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string", minLength: 1 }
                  }
                },
                required: ["kind", "node_ids"]
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", enum: ["patch_targets"] },
                  patch_target_ids: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string", minLength: 1 }
                  },
                  patch_part_paths: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string", minLength: 1 }
                  }
                },
                required: ["kind", "patch_target_ids"]
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  type: { type: "string", enum: ["paragraph"] },
                  index: { type: "integer", minimum: 0 }
                },
                required: ["type", "index"]
              },
              {
                type: "string",
                minLength: 1
              }
            ]
          },
          payload: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  value: { type: "string" },
                  content: { type: "string" },
                  text: { type: "string" }
                }
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  font_name: { type: "string", minLength: 1 },
                  fontName: { type: "string", minLength: 1 },
                  font: { type: "string", minLength: 1 }
                }
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  paragraph_alignment: { type: "string", minLength: 1 },
                  alignment: { type: "string", minLength: 1 }
                }
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  paper_size: { type: "string", enum: ["A4", "Letter", "a4", "letter"] },
                  paperSize: { type: "string", enum: ["A4", "Letter", "a4", "letter"] },
                  margin_top_cm: { type: "number" },
                  margin_bottom_cm: { type: "number" },
                  margin_left_cm: { type: "number" },
                  margin_right_cm: { type: "number" }
                }
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  baseline_from_semantic: {
                    type: "string",
                    enum: ["body_like_paragraphs"]
                  },
                  sync_fields: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "string",
                      enum: ["font_name", "font_size_pt", "is_bold", "is_italic"]
                    }
                  }
                }
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  settings: { type: "object" },
                  flags: { type: "object" }
                }
              },
              {
                type: "object"
              }
            ]
          },
          idempotency_key: {
            type: "string",
            minLength: 1
          }
        },
        required: ["request_id", "operation", "target", "payload"]
      }
    }
  };
}

export async function normalizeProviderWriteToolInput(
  rawInput: unknown,
  runtimeInput: Pick<Phase3RuntimeInput, "document_path">,
  loadBundle?: () => Promise<ParsedDocumentBundle>
): Promise<WriteToolInput> {
  const parsed = parseWriteToolInput(rawInput);
  if (!("ok" in parsed)) {
    return parsed;
  }

  const bundleLoader = loadBundle ?? createBundleLoader(runtimeInput.document_path);
  const source = asRecord(rawInput);
  const operation = normalizeProviderOperation(source.operation);
  if (operation === "read") {
    throw new Error("read is an internal provider-only operation and cannot be returned to runtime");
  }
  const normalizedTarget = await normalizeProviderTarget(operation, source.target, bundleLoader);
  const normalizedPayload = normalizeWriteToolPayload(
    operation,
    mapProviderPayloadAliases(operation, asRecord(source.payload))
  );
  const candidate: WriteToolInput = {
    request_id: readNonEmptyString(source.request_id) ?? `provider-${operation}`,
    operation,
    target: normalizedTarget,
    payload: normalizedPayload,
    ...(readNonEmptyString(source.idempotency_key) ? { idempotency_key: readNonEmptyString(source.idempotency_key) } : {})
  };
  const validated = parseWriteToolInput(candidate);
  if ("ok" in validated) {
    throw new Error(validated.message);
  }
  return validated;
}

export function isProviderReadOperation(rawInput: unknown): boolean {
  try {
    return normalizeProviderOperation(asRecord(rawInput).operation) === "read";
  } catch {
    return false;
  }
}

export function inferProviderName(baseUrl: string, model: string): string {
  const source = `${baseUrl} ${model}`.toLowerCase();
  if (source.includes("deepseek")) {
    return "deepseek";
  }
  return "openai-compatible";
}

async function buildProviderReadToolResult(
  rawInput: unknown,
  loadBundle: () => Promise<ParsedDocumentBundle>,
  runtimeInput: Phase3RuntimeInput
): Promise<Record<string, unknown>> {
  const bundle = await loadBundle();
  const target = asRecord(asRecord(rawInput).target);
  const paragraphs = bundle.structure_index.paragraphs.map((paragraph) => ({
    id: paragraph.id,
    text: paragraph.text,
    role: paragraph.role,
    headingLevel: paragraph.headingLevel,
    styleName: paragraph.styleName,
    partPath: paragraph.partPath
  }));
  const firstBodyParagraph =
    bundle.structure_index.paragraphs.find((paragraph) => paragraph.role === "body") ??
    bundle.structure_index.paragraphs[0];

  const result: Record<string, unknown> = {
    ok: true,
    paragraphs,
    first_body_paragraph: firstBodyParagraph
      ? {
          id: firstBodyParagraph.id,
          text: firstBodyParagraph.text,
          role: firstBodyParagraph.role,
          headingLevel: firstBodyParagraph.headingLevel,
          styleName: firstBodyParagraph.styleName,
          partPath: firstBodyParagraph.partPath
        }
      : null,
    document_summary: {
      paragraphCount: bundle.structure_index.paragraphs.length,
        sectionCount: bundle.document_package.packageMeta.sectionCount,
        settingsPartPresent: Boolean(bundle.package_snapshot.parts["word/settings.xml"]),
      headerFooterBindings: bundle.document_package.packageMeta.headerFooterBindings.map((binding) => ({
        sectionId: binding.sectionId,
        headers: binding.headers,
        footers: binding.footers
      }))
    },
    chat_projection: safeBuildProjection(() =>
      buildChatProjection(bundle, {
        focusRegexProbe: runtimeInput.projection_intent?.focus_regex_probe,
        textBudget: runtimeInput.projection_intent?.chat_text_budget,
        neighborWindow: runtimeInput.projection_intent?.chat_neighbor_window
      })
    ),
    template_projection: safeBuildProjection(() =>
      buildTemplateProjection(bundle, {
        localContextWindow: runtimeInput.projection_intent?.template_local_context_window,
        textBudget: runtimeInput.projection_intent?.template_text_budget,
        maxBatchBudget: runtimeInput.projection_intent?.template_batch_budget,
        includeSemanticFeatures: true
      })
    )
  };

  if (readNonEmptyString(target.type)?.toLowerCase() === "paragraph") {
    const index = readInteger(target.index) ?? 0;
    const bodyParagraphs = bundle.structure_index.paragraphs.filter((paragraph) => paragraph.role === "body");
    const paragraph = bodyParagraphs[index] ?? bundle.structure_index.paragraphs[index];
    result.requested_paragraph = paragraph
      ? {
          id: paragraph.id,
          text: paragraph.text,
          role: paragraph.role,
          headingLevel: paragraph.headingLevel,
          styleName: paragraph.styleName,
          partPath: paragraph.partPath
        }
      : null;
  }

  return result;
}

function safeBuildProjection<T>(builder: () => T): T | { error: string } {
  try {
    return builder();
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildProviderFailureMessage(
  config: ProviderAdapterConfig,
  kind: NonNullable<Phase3Diagnostic["provider_diagnostic_kind"]>,
  message: string
): AIMessage {
  const diagnostic: Phase3Diagnostic = {
    stage: "provider_adapter",
    provider: config.provider,
    provider_model: config.model,
    provider_base_url: config.baseUrl,
    provider_diagnostic_kind: kind,
    message
  };
  return new AIMessage({
    content: `${kind}: ${message}`,
    additional_kwargs: {
      phase3_diagnostics: [diagnostic]
    }
  });
}

function withStrongSystemPrompt(messages: BaseMessage[]): BaseMessage[] {
  const nonSystemMessages = messages.filter((message) => !(message instanceof SystemMessage));
  return [new SystemMessage(PHASE3_STRONG_SYSTEM_PROMPT), ...nonSystemMessages];
}

function appendAssistantMessageForReplay(
  messages: BaseMessage[],
  remoteMessage: AIMessage,
  reasoningContent?: string
): BaseMessage[] {
  if (!reasoningContent) {
    return messages.concat([remoteMessage]);
  }
  return messages.concat([
    new AIMessage({
      content: remoteMessage.content,
      tool_calls: remoteMessage.tool_calls,
      additional_kwargs: {
        ...remoteMessage.additional_kwargs,
        reasoning_content: reasoningContent
      },
      response_metadata: remoteMessage.response_metadata,
      id: remoteMessage.id
    })
  ]);
}

function getChatOpenAIClient(llm: ChatOpenAI): {
  chat: {
    completions: {
      create(
        request: OpenAIClient.Chat.Completions.ChatCompletionCreateParamsNonStreaming
      ): Promise<OpenAIClient.Chat.Completions.ChatCompletion>;
    };
  };
} {
  const chatModel = llm as unknown as Record<string, unknown> & {
    client?: unknown;
    clientConfig?: {
      apiKey?: string;
      organization?: string;
      baseURL?: string | null;
      dangerouslyAllowBrowser?: boolean;
      defaultHeaders?: Record<string, string>;
    };
  };
  const existingClient = chatModel.client as
    | {
        chat?: {
          completions?: {
            create?: (
              request: OpenAIClient.Chat.Completions.ChatCompletionCreateParamsNonStreaming
            ) => Promise<OpenAIClient.Chat.Completions.ChatCompletion>;
          };
        };
      }
    | undefined;
  if (!existingClient?.chat?.completions?.create) {
    const endpoint = getEndpoint({ baseURL: chatModel.clientConfig?.baseURL });
    const params = {
      ...chatModel.clientConfig,
      baseURL: endpoint ?? undefined,
      maxRetries: 0
    };
    if (!params.baseURL) {
      delete params.baseURL;
    }
    chatModel.client = new OpenAIClient(params);
  }
  const client = chatModel.client as
    | {
        chat?: {
          completions?: {
            create?: (
              request: OpenAIClient.Chat.Completions.ChatCompletionCreateParamsNonStreaming
            ) => Promise<OpenAIClient.Chat.Completions.ChatCompletion>;
          };
        };
      }
    | undefined;
  if (!client?.chat?.completions?.create) {
    throw new Error("ChatOpenAI client is unavailable");
  }
  return client as {
    chat: {
      completions: {
        create(
          request: OpenAIClient.Chat.Completions.ChatCompletionCreateParamsNonStreaming
        ): Promise<OpenAIClient.Chat.Completions.ChatCompletion>;
      };
    };
  };
}

function createBundleLoader(documentPath: string): () => Promise<ParsedDocumentBundle> {
  let pending: Promise<ParsedDocumentBundle> | undefined;
  return async () => {
    pending ??= parseDocumentBundle({
      docxPath: documentPath,
      mediaDir: path.join(path.dirname(documentPath), ".phase3-provider-media")
    });
    return pending;
  };
}

function normalizeProviderOperation(value: unknown): ProviderOperation {
  const raw = readNonEmptyString(value)?.toLowerCase();
  if (raw === "read") {
    return "read";
  }
  if (raw === "update" || raw === "replace_text") {
    return "set_text";
  }
  if (raw && (writeToolOperations as readonly string[]).includes(raw)) {
    return raw as OperationType;
  }
  throw new Error(`unsupported provider operation '${String(value)}'`);
}

function mapProviderPayloadAliases(operation: OperationType, payload: Record<string, unknown>): Record<string, unknown> {
  switch (operation) {
    case "set_text":
      return {
        ...(pickNonEmptyString(payload.path) ? { path: String(payload.path).trim() } : {}),
        value: payload.value ?? payload.content ?? payload.text ?? ""
      };
    case "set_font":
      return {
        font_name: payload.font_name ?? payload.fontName ?? payload.font
      };
    case "set_alignment":
      return {
        paragraph_alignment: payload.paragraph_alignment ?? payload.alignment
      };
    case "set_page_layout":
      return {
        paper_size: payload.paper_size ?? payload.paperSize,
        margin_top_cm: payload.margin_top_cm ?? payload.marginTopCm,
        margin_bottom_cm: payload.margin_bottom_cm ?? payload.marginBottomCm,
        margin_left_cm: payload.margin_left_cm ?? payload.marginLeftCm,
        margin_right_cm: payload.margin_right_cm ?? payload.marginRightCm
      };
    case "set_settings_flag":
      return {
        settings: asRecord(payload.settings ?? payload.flags ?? payload)
      };
    default:
      return payload;
  }
}

async function normalizeProviderTarget(
  operation: OperationType,
  rawTarget: unknown,
  loadBundle: () => Promise<ParsedDocumentBundle>
): Promise<WriteToolInput["target"]> {
  const source = asRecord(rawTarget);
  const targetKind = readNonEmptyString(source.kind);

  if (
    targetKind === "selector" ||
    targetKind === "semantic_selector" ||
    targetKind === "node_ids" ||
    targetKind === "patch_targets"
  ) {
    return source as WriteToolInput["target"];
  }

  if (typeof rawTarget === "string") {
    const headingLevel = readHeadingLevel(rawTarget);
    if (headingLevel !== undefined) {
      return {
        kind: "selector",
        selector: {
          scope: "heading",
          headingLevel
        }
      };
    }

    const bundle = await loadBundle();
    const quotedStyleName = extractQuotedStyleName(rawTarget);
    const paragraphIds = bundle.structure_index.paragraphs
      .filter((paragraph) => normalizeText(paragraph.styleName) === normalizeText(quotedStyleName))
      .map((paragraph) => paragraph.id);
    if (paragraphIds.length > 0) {
      return {
        kind: "selector",
        selector: {
          scope: "paragraph_ids",
          paragraphIds
        }
      };
    }
  }

  if (readNonEmptyString(source.type)?.toLowerCase() === "paragraph") {
    const paragraphIndex = readInteger(source.index) ?? 0;
    const bundle = await loadBundle();
    const bodyParagraphs = bundle.structure_index.paragraphs.filter((paragraph) => paragraph.role === "body");
    const paragraph = bodyParagraphs[paragraphIndex] ?? bundle.structure_index.paragraphs[paragraphIndex];
    if (!paragraph) {
      throw new Error(`cannot resolve paragraph target at index ${paragraphIndex}`);
    }
    return {
      kind: "selector",
      selector: {
        scope: "paragraph_ids",
        paragraphIds: [paragraph.id]
      }
    };
  }

  if (targetKind === "document" || readNonEmptyString(source.kind)?.toLowerCase() === "document") {
    if (operation === "set_settings_flag") {
      return {
        kind: "patch_targets",
        patch_target_ids: ["target:settings:settings"],
        patch_part_paths: ["word/settings.xml"]
      };
    }
    return {
      kind: "patch_targets",
      patch_target_ids: ["target:document:section:0"],
      patch_part_paths: ["word/document.xml"]
    };
  }

  if (operation === "set_page_layout") {
    return {
      kind: "patch_targets",
      patch_target_ids: ["target:document:section:0"],
      patch_part_paths: ["word/document.xml"]
    };
  }

  return {
    kind: "selector",
    selector: {
      scope: "body"
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function pickNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return pickNonEmptyString(value);
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readHeadingLevel(value: string): number | undefined {
  const match = value.match(/heading\s*([1-9]\d*)/i);
  return match ? Number(match[1]) : undefined;
}

function extractQuotedStyleName(value: string): string {
  const match = value.match(/"([^"]+)"/);
  return match?.[1] ?? value;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
