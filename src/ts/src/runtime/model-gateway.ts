import { AgentError, asAppError } from "../core/errors.js";
import type { ChatModelConfig, ConversationMessage, PlannerModelConfig } from "../core/types.js";
import {
  asCompatibleModelRequestError,
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
  "You route one user turn for a document-format assistant. Return exactly one JSON object and no other text. " +
  "The object must contain exactly these fields: mode, goal, requiresDocument, needsClarification, clarificationKind, clarificationReason. Do not add extra fields. " +
  "mode must be one of chat, inspect, execute. " +
  "goal must be a non-empty string after trimming and must describe the concrete reply or document task to perform. " +
  "requiresDocument must be a boolean. needsClarification must be a boolean. clarificationKind must be one of none, selector_scope, heading_scope, paragraph_scope, semantic_anchor, other. clarificationReason must be a string. " +
  "When needsClarification=true, mode must be chat, clarificationKind must not be none, clarificationReason must explain the ambiguity, and requiresDocument may be true if you need the attached document structure to ask a better follow-up question. " +
  "When needsClarification=false, clarificationKind must be none and clarificationReason must be an empty string. " +
  "Use mode=execute for clear formatting or editing requests, mode=inspect for clear read/summarize/explain-document requests, otherwise mode=chat. " +
  "If the user explicitly asks to modify an attached document, do not fall back to chat because of missing internal fields. output execute or needsClarification=true. " +
  "If a document-editing request is risky because the target scope could mean multiple valid things, do not guess. Set needsClarification=true instead. " +
  "Examples include 正文 vs numbered/bulleted list paragraphs, ambiguous heading ranges, or unclear paragraph anchors. " +
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
  private readonly fetchImpl: typeof fetch;

  constructor(deps: LlmAgentModelGatewayDeps = {}) {
    this.chatConfig = resolveChatModelConfig(deps.chatConfig, deps.env);
    this.plannerConfig = resolvePlannerModelConfig(deps.plannerConfig, deps.env);
    this.fetchImpl = deps.fetchImpl ?? fetch;
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
    const content = await this.requestCompletion(
      {
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: JSON.stringify(input.userPayload, null, 2) }
        ],
        ...(config.useJsonSchema === false
          ? {}
          : {
              responseFormat: {
                type: "json_schema",
                json_schema: {
                  name: input.schemaName,
                  strict: config.schemaStrict !== false,
                  schema: input.schema
                }
              }
            })
      },
      config
    );
    return input.parseContent(content);
  }

  private async requestText(
    input: {
      systemPrompt: string;
      messages: ConversationMessage[];
    },
    config: ChatModelConfig
  ): Promise<string> {
    return await this.requestCompletion(
      {
        messages: [{ role: "system", content: input.systemPrompt }, ...input.messages]
      },
      config
    );
  }

  private async requestCompletion(
    input: {
      messages: ConversationMessage[];
      responseFormat?: Record<string, unknown>;
    },
    config: ChatModelConfig | PlannerModelConfig
  ): Promise<string> {
    const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const maxRetries = config.maxRetries ?? 0;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30000);
      try {
        const resp = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`
          },
          body: JSON.stringify({
            model: config.model,
            temperature: config.temperature ?? 0,
            messages: input.messages,
            ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
            stream: false
          }),
          signal: controller.signal
        });
        const raw = await resp.text();
        if (!resp.ok) {
          throw new AgentError({
            code: "E_AGENT_MODEL_UPSTREAM",
            message: `Agent model request failed (${resp.status}): ${raw.slice(0, 200)}`,
            retryable: resp.status >= 500
          });
        }
        return extractContent(raw);
      } catch (err) {
        lastErr = err;
        const appErr = asAppError(err, "E_AGENT_MODEL_REQUEST");
        if (!appErr.retryable || attempt === maxRetries) {
          break;
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    throw asCompatibleModelRequestError(
      lastErr ?? new Error("Unknown model request failure"),
      "E_AGENT_MODEL_REQUEST",
      "Agent model request"
    );
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

function extractContent(rawText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new AgentError({
      code: "E_AGENT_MODEL_RESPONSE",
      message: `Model returned invalid envelope JSON: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("choices" in parsed) ||
    !Array.isArray((parsed as { choices?: unknown[] }).choices)
  ) {
    throw new AgentError({
      code: "E_AGENT_MODEL_RESPONSE",
      message: "Model payload is missing choices[].",
      retryable: false
    });
  }

  const content = (parsed as { choices: Array<{ message?: { content?: unknown } }> }).choices[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new AgentError({
      code: "E_AGENT_MODEL_RESPONSE",
      message: "Model payload has empty message content.",
      retryable: false
    });
  }
  return content.trim();
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

  const raw = candidate as {
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
  if (!isAgentTurnMode(raw.mode)) {
    throw invalidTurnDecision(`turn decision mode must be ${AGENT_TURN_MODES.join(" | ")}`);
  }

  const goal = typeof raw.goal === "string" ? raw.goal.trim() : "";
  if (!goal) {
    throw invalidTurnDecision("turn decision goal is required");
  }
  if (typeof raw.requiresDocument !== "boolean") {
    throw invalidTurnDecision("turn decision requiresDocument must be boolean");
  }
  if (typeof raw.needsClarification !== "boolean") {
    throw invalidTurnDecision("turn decision needsClarification must be boolean");
  }
  if (!isClarificationKind(raw.clarificationKind)) {
    throw invalidTurnDecision(`turn decision clarificationKind must be ${CLARIFICATION_KINDS.join(" | ")}`);
  }
  if (typeof raw.clarificationReason !== "string") {
    throw invalidTurnDecision("turn decision clarificationReason must be a string");
  }
  const clarificationReason = raw.clarificationReason.trim();
  if (raw.needsClarification) {
    if (raw.mode !== "chat") {
      throw invalidTurnDecision("turn decision needsClarification=true requires mode=chat");
    }
    if (raw.clarificationKind === "none") {
      throw invalidTurnDecision("turn decision clarificationKind must not be none when needsClarification=true");
    }
    if (!clarificationReason) {
      throw invalidTurnDecision("turn decision clarificationReason is required when needsClarification=true");
    }
  } else {
    if (raw.clarificationKind !== "none") {
      throw invalidTurnDecision("turn decision clarificationKind must be none when needsClarification=false");
    }
    if (clarificationReason) {
      throw invalidTurnDecision("turn decision clarificationReason must be empty when needsClarification=false");
    }
  }

  return {
    mode: raw.mode,
    goal,
    requiresDocument: raw.requiresDocument,
    needsClarification: raw.needsClarification,
    clarificationKind: raw.clarificationKind,
    clarificationReason
  };
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
