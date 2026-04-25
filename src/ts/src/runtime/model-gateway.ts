import { AgentError } from "../core/errors.js";
import type { ChatModelConfig, ConversationMessage, PlannerModelConfig } from "../core/types.js";
import { OpenAiCompatibleChatClient } from "../llm/openai-compatible-client.js";
import {
  resolveChatModelConfig,
  resolvePlannerModelConfig
} from "../planner/llm-planner.js";
import type { AgentSessionSnapshot } from "./state/sqlite-agent-state-store.js";
import type { PythonDocxObservationState } from "../tools/python-tool-client.js";

export type AgentTurnMode = "chat" | "inspect" | "execute";
export const AGENT_TURN_MODES = ["chat", "inspect", "execute"] as const;
export type ClarificationKind =
  | "none"
  | "selector_scope"
  | "heading_scope"
  | "paragraph_scope"
  | "semantic_anchor"
  | "other";

export const CLARIFICATION_KINDS = [
  "none",
  "selector_scope",
  "heading_scope",
  "paragraph_scope",
  "semantic_anchor",
  "other"
] as const;

const TURN_DECISION_FIELDS = [
  "mode",
  "goal",
  "requiresDocument",
  "needsClarification",
  "clarificationKind",
  "clarificationReason"
] as const;
const TURN_DECISION_SYSTEM_PROMPT =
  "你负责为文档格式助手判定单轮请求。请只返回 1 个 JSON 对象，不要输出其他文本。 " +
  "对象必须且只能包含这些字段：mode、goal、requiresDocument、needsClarification、clarificationKind、clarificationReason，不要添加额外字段。 " +
  "mode 只能是 chat、inspect、execute。goal 必须是去除首尾空白后的非空字符串，并且要描述本轮要执行的具体回复或文档任务。 " +
  "requiresDocument 必须是 boolean；needsClarification 必须是 boolean；clarificationKind 只能是 none、selector_scope、heading_scope、paragraph_scope、semantic_anchor、other；clarificationReason 必须是字符串。 " +
  "当 needsClarification=true 时，mode 必须为 chat，clarificationKind 不能为 none，clarificationReason 必须解释歧义；如果为了提出更好的追问需要查看附加文档结构，requiresDocument 可以为 true。 " +
  "当 needsClarification=false 时，clarificationKind 必须为 none，clarificationReason 必须为空字符串。 " +
  "明确的格式修改或编辑请求使用 mode=execute；明确的读取、总结、解释文档请求使用 mode=inspect；其他情况使用 mode=chat。 " +
  "如果用户明确要求修改已附加文档，不要因为内部字段缺失就退回 chat，应输出 execute 或 needsClarification=true。 " +
  "如果文档编辑请求因为目标范围可能有多种合理解释而存在风险，不要猜，改为 needsClarification=true。标题范围不清、段落锚点不明确，都属于这类情况。 " +
  "如果最近的 assistant 消息里有以【需求澄清】开头的澄清问题，而当前用户回复是在选择或澄清该问题，就应把它转成已解决后的最终 goal，而不是再次追问。 " +
  "You route one user turn for a document-format assistant. Return exactly one JSON object and no other text. " +
  "The object must contain exactly these fields: mode, goal, requiresDocument, needsClarification, clarificationKind, clarificationReason. Do not add extra fields. " +
  "mode must be one of chat, inspect, execute. goal must be a non-empty string after trimming and must describe the concrete reply or document task to perform. " +
  "requiresDocument must be a boolean. needsClarification must be a boolean. clarificationKind must be one of none, selector_scope, heading_scope, paragraph_scope, semantic_anchor, other. clarificationReason must be a string. " +
  "When needsClarification=true, mode must be chat, clarificationKind must not be none, clarificationReason must explain the ambiguity, and requiresDocument may be true if you need the attached document structure to ask a better follow-up question. " +
  "When needsClarification=false, clarificationKind must be none and clarificationReason must be an empty string. Use mode=execute for clear formatting or editing requests, mode=inspect for clear read/summarize/explain-document requests, otherwise mode=chat. " +
  "If the user explicitly asks to modify an attached document, do not fall back to chat because of missing internal fields. output execute or needsClarification=true. " +
  "If a document-editing request is risky because the target scope could mean multiple valid things, do not guess. Set needsClarification=true instead. Examples include ambiguous heading ranges, or unclear paragraph anchors. " +
  "If recent assistant turns include a clarification message prefixed with 【需求澄清】 and the current user reply selects or clarifies that question, convert it into the resolved final goal instead of asking again.";

const CLARIFICATION_SYSTEM_PROMPT =
  "You are the single runtime brain of a document-format assistant. " +
  "The user has an ambiguous document-editing request, so you must ask one clarification question in concise Chinese before any edit. " +
  "Always start the reply with 【需求澄清】. " +
  "First explain the ambiguity in one short sentence. " +
  "Then provide 2-4 numbered options that are mutually exclusive and directly actionable for the user. " +
  "Prefer user-facing language, not internal implementation jargon. " +
  "For selector_scope ambiguity, explicitly distinguish ordinary body paragraphs, bulleted/numbered paragraphs, both, and user-specified paragraphs when those options fit the document. " +
  "Use the attached document observation when available, but do not invent document contents beyond the observation. " +
  "End with: 请回复选项编号，或直接补充更具体的要求。";

export interface TurnDecision {
  mode: AgentTurnMode;
  goal: string;
  requiresDocument: boolean;
  needsClarification: boolean;
  clarificationKind: ClarificationKind;
  clarificationReason: string;
}

export interface AgentModelGateway {
  decideTurn(input: {
    session: AgentSessionSnapshot;
    userInput: string;
    forceMode?: AgentTurnMode;
  }): Promise<TurnDecision>;
  respondToConversation(input: {
    session: AgentSessionSnapshot;
    messages: ConversationMessage[];
  }): Promise<string>;
  respondToDocumentObservation(input: {
    session: AgentSessionSnapshot;
    goal: string;
    messages: ConversationMessage[];
    observation: PythonDocxObservationState;
  }): Promise<string>;
  respondToClarification(input: {
    session: AgentSessionSnapshot;
    goal: string;
    clarificationKind: ClarificationKind;
    clarificationReason: string;
    messages: ConversationMessage[];
    observation?: PythonDocxObservationState;
  }): Promise<string>;
}

export interface LlmAgentModelGatewayDeps {
  chatConfig?: Partial<ChatModelConfig>;
  plannerConfig?: Partial<PlannerModelConfig>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export class LlmAgentModelGateway implements AgentModelGateway {
  private readonly chatConfig: ChatModelConfig;
  private readonly plannerConfig: PlannerModelConfig;
  private readonly chatClient: OpenAiCompatibleChatClient<ChatModelConfig>;
  private readonly plannerClient: OpenAiCompatibleChatClient<PlannerModelConfig>;

  constructor(deps: LlmAgentModelGatewayDeps = {}) {
    this.chatConfig = resolveChatModelConfig(deps.chatConfig, deps.env);
    this.plannerConfig = resolvePlannerModelConfig(deps.plannerConfig, deps.env);
    this.chatClient = new OpenAiCompatibleChatClient(this.chatConfig, { fetchImpl: deps.fetchImpl });
    this.plannerClient = new OpenAiCompatibleChatClient(this.plannerConfig, { fetchImpl: deps.fetchImpl });
  }

  async decideTurn(input: {
    session: AgentSessionSnapshot;
    userInput: string;
    forceMode?: AgentTurnMode;
  }): Promise<TurnDecision> {
    if (input.forceMode) {
      return normalizeTurnDecision({
        mode: input.forceMode,
        goal: input.userInput,
        requiresDocument: input.forceMode !== "chat",
        needsClarification: false,
        clarificationKind: "none",
        clarificationReason: ""
      });
    }

    return await this.requestJson(
      {
        systemPrompt: TURN_DECISION_SYSTEM_PROMPT,
        userPayload: {
          userInput: input.userInput,
          attachedDocument: input.session.attachedDocument ?? null,
          recentTurns: input.session.turns.slice(-8)
        },
        schemaName: "turn_decision",
        schema: {
          type: "object",
          additionalProperties: false,
          required: [...TURN_DECISION_FIELDS],
          properties: {
            mode: { type: "string", enum: ["chat", "inspect", "execute"] },
            goal: { type: "string", minLength: 1 },
            requiresDocument: { type: "boolean" },
            needsClarification: { type: "boolean" },
            clarificationKind: { type: "string", enum: [...CLARIFICATION_KINDS] },
            clarificationReason: { type: "string" }
          }
        },
        parseContent: parseTurnDecision
      },
      this.plannerConfig
    );
  }

  async respondToConversation(input: {
    session: AgentSessionSnapshot;
    messages: ConversationMessage[];
  }): Promise<string> {
    return await this.requestText(
      {
        systemPrompt:
          "You are the single runtime brain of a document-format assistant. Answer concisely in Chinese using the unified session context.",
        messages: input.messages
      },
      this.chatConfig
    );
  }

  async respondToDocumentObservation(input: {
    session: AgentSessionSnapshot;
    goal: string;
    messages: ConversationMessage[];
    observation: PythonDocxObservationState;
  }): Promise<string> {
    return await this.requestText(
      {
        systemPrompt:
          "You are the single runtime brain of a document-format assistant. " +
          "Answer in Chinese using only the document observation and session context. Do not invent document contents.",
        messages: [
          ...input.messages,
          {
            role: "user",
            content: JSON.stringify(
              {
                goal: input.goal,
                observation: summarizeObservationForReply(input.observation)
              },
              null,
              2
            )
          }
        ]
      },
      this.chatConfig
    );
  }

  async respondToClarification(input: {
    session: AgentSessionSnapshot;
    goal: string;
    clarificationKind: ClarificationKind;
    clarificationReason: string;
    messages: ConversationMessage[];
    observation?: PythonDocxObservationState;
  }): Promise<string> {
    return await this.requestText(
      {
        systemPrompt: CLARIFICATION_SYSTEM_PROMPT,
        messages: [
          ...input.messages,
          {
            role: "user",
            content: JSON.stringify(
              {
                goal: input.goal,
                clarificationKind: input.clarificationKind,
                clarificationReason: input.clarificationReason,
                observation: input.observation ? summarizeObservationForReply(input.observation) : null
              },
              null,
              2
            )
          }
        ]
      },
      this.chatConfig
    );
  }

  private async requestJson<T>(
    input: {
      systemPrompt: string;
      userPayload: Record<string, unknown>;
      schemaName: string;
      schema: Record<string, unknown>;
      parseContent: (content: string) => T;
    },
    config: PlannerModelConfig
  ): Promise<T> {
    const messages: ConversationMessage[] = [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: JSON.stringify(input.userPayload, null, 2) }
    ];
    const content =
      config.useJsonSchema === false
        ? await this.plannerClient.requestCompletion({
            messages,
            requestCode: "E_AGENT_MODEL_REQUEST",
            upstreamCode: "E_AGENT_MODEL_UPSTREAM",
            responseCode: "E_AGENT_MODEL_RESPONSE",
            requestLabel: "Agent model request",
            payloadLabel: "Model payload"
          })
        : await this.plannerClient.requestJson({
            messages,
            requestCode: "E_AGENT_MODEL_REQUEST",
            upstreamCode: "E_AGENT_MODEL_UPSTREAM",
            responseCode: "E_AGENT_MODEL_RESPONSE",
            requestLabel: "Agent model request",
            payloadLabel: "Model payload",
            schemaName: input.schemaName,
            schema: input.schema,
            strict: config.schemaStrict !== false,
            parseContent: (content) => content
          });
    return input.parseContent(content);
  }

  private async requestText(
    input: {
      systemPrompt: string;
      messages: ConversationMessage[];
    },
    config: ChatModelConfig
  ): Promise<string> {
    const client = config === this.chatConfig ? this.chatClient : this.plannerClient;
    return await client.requestCompletion({
      messages: [{ role: "system", content: input.systemPrompt }, ...input.messages],
      requestCode: "E_AGENT_MODEL_REQUEST",
      upstreamCode: "E_AGENT_MODEL_UPSTREAM",
      responseCode: "E_AGENT_MODEL_RESPONSE",
      requestLabel: "Agent model request",
      payloadLabel: "Model payload"
    });
  }
}

function summarizeObservationForReply(observation: PythonDocxObservationState): Record<string, unknown> {
  const paragraphs = Array.isArray(observation.paragraphs) ? observation.paragraphs : [];
  const roleCounts: Record<string, number> = {};
  for (const paragraph of paragraphs) {
    if (!paragraph.role) {
      continue;
    }
    roleCounts[paragraph.role] = (roleCounts[paragraph.role] ?? 0) + 1;
  }

  return {
    document_meta: observation.document_meta,
    role_counts: roleCounts,
    paragraph_samples: paragraphs.slice(0, 20).map((paragraph) => ({
      id: paragraph.id,
      text: paragraph.text,
      role: paragraph.role,
      heading_level: paragraph.heading_level,
      list_level: paragraph.list_level,
      style_name: paragraph.style_name,
      run_ids: paragraph.run_ids
    })),
    node_samples: observation.nodes.slice(0, 6)
  };
}

export function parseTurnDecision(content: string): TurnDecision {
  let candidate: unknown;
  try {
    candidate = JSON.parse(content);
  } catch (err) {
    throw new AgentError({
      code: "E_TURN_DECISION_PARSE",
      message: `Turn decision returned invalid JSON: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }
  return normalizeTurnDecision(candidate);
}

export function normalizeTurnDecision(candidate: unknown): TurnDecision {
  if (!candidate || typeof candidate !== "object") {
    throw invalidTurnDecision("turn decision must be a JSON object");
  }

  const raw = normalizeTurnDecisionCandidate(candidate as Record<string, unknown>) as {
    mode?: unknown;
    goal?: unknown;
    requiresDocument?: unknown;
    needsClarification?: unknown;
    clarificationKind?: unknown;
    clarificationReason?: unknown;
    [key: string]: unknown;
  };
  const extraKeys = Object.keys(raw).filter((key) => !TURN_DECISION_FIELDS.includes(key as (typeof TURN_DECISION_FIELDS)[number]));
  if (extraKeys.length > 0) {
    throw invalidTurnDecision(`turn decision has unexpected fields: ${extraKeys.join(", ")}`);
  }
  const mode = typeof raw.mode === "string" ? raw.mode.trim().toLowerCase() : raw.mode;
  if (!isAgentTurnMode(mode)) {
    throw invalidTurnDecision(`turn decision mode must be ${AGENT_TURN_MODES.join(" | ")}`);
  }

  const goal = typeof raw.goal === "string" ? raw.goal.trim() : "";
  if (!goal) {
    throw invalidTurnDecision("turn decision goal is required");
  }
  const normalizedRequiresDocument = normalizeBoolean(raw.requiresDocument);
  if (raw.requiresDocument !== undefined && normalizedRequiresDocument === undefined) {
    throw invalidTurnDecision("turn decision requiresDocument must be boolean");
  }
  const requiresDocument = normalizedRequiresDocument ?? (mode === "chat" ? false : true);
  const normalizedClarificationKind = normalizeClarificationKind(raw.clarificationKind);
  const clarificationReason = typeof raw.clarificationReason === "string" ? raw.clarificationReason.trim() : "";
  const normalizedNeedsClarification = normalizeBoolean(raw.needsClarification);
  if (raw.needsClarification !== undefined && normalizedNeedsClarification === undefined) {
    throw invalidTurnDecision("turn decision needsClarification must be boolean");
  }
  const needsClarification =
    normalizedNeedsClarification ??
    (normalizedClarificationKind !== undefined && normalizedClarificationKind !== "none"
      ? true
      : clarificationReason.length > 0);
  if (raw.clarificationReason !== undefined && typeof raw.clarificationReason !== "string") {
    throw invalidTurnDecision("turn decision clarificationReason must be a string");
  }
  const clarificationKind =
    normalizedClarificationKind ?? (needsClarification ? undefined : "none");
  if (!isClarificationKind(clarificationKind)) {
    throw invalidTurnDecision(`turn decision clarificationKind must be ${CLARIFICATION_KINDS.join(" | ")}`);
  }
  if (needsClarification) {
    if (mode !== "chat") {
      throw invalidTurnDecision("turn decision needsClarification=true requires mode=chat");
    }
    if (clarificationKind === "none") {
      throw invalidTurnDecision("turn decision clarificationKind must not be none when needsClarification=true");
    }
    if (!clarificationReason) {
      throw invalidTurnDecision("turn decision clarificationReason is required when needsClarification=true");
    }
  } else {
    if (clarificationKind !== "none") {
      throw invalidTurnDecision("turn decision clarificationKind must be none when needsClarification=false");
    }
    if (clarificationReason) {
      throw invalidTurnDecision("turn decision clarificationReason must be empty when needsClarification=false");
    }
  }

  return {
    mode,
    goal,
    requiresDocument,
    needsClarification,
    clarificationKind,
    clarificationReason
  };
}

function normalizeTurnDecisionCandidate(candidate: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    const canonicalKey = TURN_DECISION_ALIAS_MAP[key] ?? key;
    if (!(canonicalKey in normalized)) {
      normalized[canonicalKey] = value;
    }
  }
  return normalized;
}

export function isAgentTurnMode(value: unknown): value is AgentTurnMode {
  return typeof value === "string" && AGENT_TURN_MODES.includes(value as AgentTurnMode);
}

function isClarificationKind(value: unknown): value is ClarificationKind {
  return typeof value === "string" && CLARIFICATION_KINDS.includes(value as ClarificationKind);
}

function invalidTurnDecision(message: string): AgentError {
  return new AgentError({
    code: "E_TURN_DECISION_INVALID",
    message,
    retryable: false
  });
}

const TURN_DECISION_ALIAS_MAP: Record<string, string> = {
  requires_document: "requiresDocument",
  needs_clarification: "needsClarification",
  clarification_kind: "clarificationKind",
  clarification_reason: "clarificationReason"
};

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && (value === 0 || value === 1)) {
    return value === 1;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return undefined;
}

function normalizeClarificationKind(value: unknown): ClarificationKind | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return isClarificationKind(normalized) ? normalized : undefined;
}
