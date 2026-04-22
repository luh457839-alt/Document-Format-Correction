import { AgentError, asAppError } from "../core/errors.js";
import {
  buildModelResponseErrorMessage,
  parseOpenAiCompatibleChatText
} from "../core/model-response.js";
import type {
  ChatModelConfig,
  DocumentIR,
  NodeSelector,
  Operation,
  OperationType,
  Plan,
  Planner,
  PlannerCompatMode,
  PlannerModelConfig
} from "../core/types.js";
import {
  buildSemanticSelectorGuidance,
  sanitizePromptMetadata,
  summarizeStructureForPrompt as summarizeStructureForPromptContext
} from "./prompt-context.js";
import { normalizeWriteOperationPayload } from "../tools/style-operation.js";

const OPERATION_TYPES: ReadonlySet<OperationType> = new Set([
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
  "merge_paragraph",
  "split_paragraph"
]);
const PLAN_TOOL_NAMES = ["inspect_document", "write_operation"] as const;
const PLAN_SYSTEM_PROMPT =
  "你是一个文档格式规划引擎。请只返回符合 Plan schema 的有效 JSON，不要输出额外解释。 " +
  "每个 write_operation 步骤都必须包含 operation.id、operation.type 和 operation.payload。 " +
  "只能使用标准化 payload 字段：set_font -> { font_name }，set_size -> { font_size_pt }，set_line_spacing -> { line_spacing }，set_alignment -> { paragraph_alignment }，set_font_color -> { font_color }，set_bold -> { is_bold }，set_italic -> { is_italic }，set_underline -> { is_underline }，set_strike -> { is_strike }，set_highlight_color -> { highlight_color }，set_all_caps -> { is_all_caps }，merge_paragraph -> { }，split_paragraph -> { split_offset }。 " +
  "每个 write_operation 必须指定 operation.targetNodeId 或 operation.targetSelector；针对正文、标题、列表等语义批量范围优先使用 targetSelector。 " +
  "对于可批量的语义写操作，优先输出 1 个带 targetSelector 的语义 step，由 runtime 展开成 targetNodeId 或 targetNodeIds；除非操作本身不可批量，否则不要自己枚举每个命中节点。每个 write_operation 都必须能基于给定文档结构语义上真实执行。 " +
  "不要使用 'placeholder'、'unused'、'target' 之类的占位 id；样式修改类写操作不要输出空 payload。只有在无法落到真实文档范围时，才降级为 inspect_document。 " +
  "You are a document-format planning engine. Return valid JSON matching the Plan schema and no extra commentary. " +
  "Every write_operation step must include operation.id, operation.type, and operation.payload. Use standardized payload fields only: set_font -> { font_name }, set_size -> { font_size_pt }, set_line_spacing -> { line_spacing }, set_alignment -> { paragraph_alignment }, set_font_color -> { font_color }, set_bold -> { is_bold }, set_italic -> { is_italic }, set_underline -> { is_underline }, set_strike -> { is_strike }, set_highlight_color -> { highlight_color }, set_all_caps -> { is_all_caps }, merge_paragraph -> { }, split_paragraph -> { split_offset }. " +
  "Each write_operation must specify either operation.targetNodeId or operation.targetSelector. Use targetSelector for semantic batch requests like body text, headings, or list items. For batchable semantic writes, prefer one semantic write_operation step; the runtime will expand matched selectors into targetNodeId or targetNodeIds. Do not enumerate every matched node yourself unless the operation is inherently non-batchable. Never omit semantic fields. Every write_operation must be semantically executable against the provided document structure. Never use placeholder ids like 'placeholder', 'unused', or 'target'. Never emit an empty payload for style-changing writes. Only downgrade to inspect_document when no real document range can be grounded.";
const PLAN_REPAIR_SYSTEM_PROMPT =
  "你负责修复无效的文档格式 Plan。请只返回 1 个有效的 Plan JSON 对象。 " +
  "尽量保留用户目标和已有的有效字段，并修复校验失败项。只能使用标准化 payload 字段；每个 write_operation 都必须提供 targetNodeId 或 targetSelector。 " +
  "只要文档结构允许，就优先把无效写操作修成语义上可执行的有效写操作；不要使用 'placeholder'、'unused'、'target' 之类的占位 id，也不要输出空 payload。 " +
  "如果某个写操作无法落到真实节点或选择器，就把它改成只读 inspect_document，而不是留空字段。 " +
  "You repair invalid document-format plans. Return exactly one valid Plan JSON object. Preserve the user's goal, preserve valid existing fields when possible, and fix validation failures. " +
  "Use standardized payload fields only: set_font -> { font_name }, set_size -> { font_size_pt }, set_line_spacing -> { line_spacing }, set_alignment -> { paragraph_alignment }, set_font_color -> { font_color }, set_bold -> { is_bold }, set_italic -> { is_italic }, set_underline -> { is_underline }, set_strike -> { is_strike }, set_highlight_color -> { highlight_color }, set_all_caps -> { is_all_caps }, merge_paragraph -> { }, split_paragraph -> { split_offset }. " +
  "Every write_operation must provide targetNodeId or targetSelector. Repair invalid writes into semantically executable writes whenever the document structure allows it. Never use placeholder ids like 'placeholder', 'unused', or 'target'. Never emit an empty payload for style-changing writes. If a write cannot be grounded to a real node or selector, convert it to a read-only inspect_document step instead of leaving fields blank.";
const MAX_PROMPT_NODES = 50;
const MAX_PROMPT_NODE_IDS = 200;
const MAX_NODE_TEXT_PREVIEW = 160;
const DEFAULT_REMOTE_TIMEOUT_MS = 30000;
const DEFAULT_LOCAL_TIMEOUT_MS = 90000;

export interface LlmPlannerDeps {
  config?: Partial<PlannerModelConfig>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function resolveChatModelConfig(
  override: Partial<ChatModelConfig> = {},
  env: NodeJS.ProcessEnv = process.env
): ChatModelConfig {
  const apiKey = pickString(override.apiKey, env.TS_AGENT_CHAT_API_KEY, env.OPENAI_API_KEY);
  const baseUrl = pickString(
    override.baseUrl,
    env.TS_AGENT_CHAT_BASE_URL,
    env.OPENAI_BASE_URL,
    "http://localhost:8080/v1"
  );
  const model = pickString(override.model, env.TS_AGENT_CHAT_MODEL, env.OPENAI_MODEL, "gpt-4o-mini");
  const preferLocalCompat = isLikelyLocalModelBackend(baseUrl, model);
  const timeoutMs = pickNumber(
    override.timeoutMs,
    env.TS_AGENT_CHAT_TIMEOUT_MS,
    preferLocalCompat ? DEFAULT_LOCAL_TIMEOUT_MS : DEFAULT_REMOTE_TIMEOUT_MS
  );
  const maxRetries = pickNumber(override.maxRetries, env.TS_AGENT_CHAT_MAX_RETRIES, 0);
  const temperature = pickNumber(override.temperature, env.TS_AGENT_CHAT_TEMPERATURE, 0);

  if (!apiKey) {
    throw new AgentError({
      code: "E_CHAT_CONFIG_MISSING",
      message: "LLM chat apiKey is missing. Set TS_AGENT_CHAT_API_KEY or OPENAI_API_KEY.",
      retryable: false
    });
  }
  if (!baseUrl) {
    throw new AgentError({
      code: "E_CHAT_CONFIG_MISSING",
      message: "LLM chat baseUrl is missing.",
      retryable: false
    });
  }
  if (!model) {
    throw new AgentError({
      code: "E_CHAT_CONFIG_MISSING",
      message: "LLM chat model is missing.",
      retryable: false
    });
  }

  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs,
    maxRetries,
    temperature
  };
}

export function resolvePlannerModelConfig(
  override: Partial<PlannerModelConfig> = {},
  env: NodeJS.ProcessEnv = process.env
): PlannerModelConfig {
  const apiKey = pickString(override.apiKey, env.TS_AGENT_PLANNER_API_KEY, env.OPENAI_API_KEY);
  const baseUrl = pickString(
    override.baseUrl,
    env.TS_AGENT_PLANNER_BASE_URL,
    env.OPENAI_BASE_URL,
    "http://localhost:8080/v1"
  );
  const model = pickString(override.model, env.TS_AGENT_PLANNER_MODEL, env.OPENAI_MODEL, "gpt-4o-mini");
  const compatMode = resolvePlannerCompatMode(override, env);
  const runtimeMode = resolvePlannerRuntimeMode({ ...override, baseUrl, model, compatMode }, env);
  const preferLocalCompat = compatMode !== "strict" && isLikelyLocalModelBackend(baseUrl, model);
  const timeoutMs = pickNumber(
    override.timeoutMs,
    env.TS_AGENT_PLANNER_TIMEOUT_MS,
    preferLocalCompat ? DEFAULT_LOCAL_TIMEOUT_MS : DEFAULT_REMOTE_TIMEOUT_MS
  );
  const maxRetries = pickNumber(override.maxRetries, env.TS_AGENT_PLANNER_MAX_RETRIES, 0);
  const temperature = pickNumber(override.temperature, env.TS_AGENT_PLANNER_TEMPERATURE, 0);
  const useJsonSchema = pickBoolean(
    override.useJsonSchema,
    env.TS_AGENT_PLANNER_USE_JSON_SCHEMA,
    preferLocalCompat ? false : true
  );
  const schemaStrict = pickBoolean(
    override.schemaStrict,
    env.TS_AGENT_PLANNER_SCHEMA_STRICT,
    useJsonSchema === false ? false : true
  );

  if (!apiKey) {
    throw new AgentError({
      code: "E_PLANNER_CONFIG_MISSING",
      message: "LLM planner apiKey is missing. Set TS_AGENT_PLANNER_API_KEY or OPENAI_API_KEY.",
      retryable: false
    });
  }
  if (!baseUrl) {
    throw new AgentError({
      code: "E_PLANNER_CONFIG_MISSING",
      message: "LLM planner baseUrl is missing.",
      retryable: false
    });
  }
  if (!model) {
    throw new AgentError({
      code: "E_PLANNER_CONFIG_MISSING",
      message: "LLM planner model is missing.",
      retryable: false
    });
  }

  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs,
    ...resolvePlannerRuntimeTuning(override, env),
    maxRetries,
    temperature,
    useJsonSchema,
    schemaStrict,
    compatMode,
    runtimeMode
  };
}

export function resolvePlannerRuntimeTuning(
  override: Partial<PlannerModelConfig> = {},
  env: NodeJS.ProcessEnv = process.env
): Pick<
  PlannerModelConfig,
  "stepTimeoutMs" | "taskTimeoutMs" | "pythonToolTimeoutMs" | "maxTurns" | "syncRequestTimeoutMs"
> {
  return {
    stepTimeoutMs: pickNumber(override.stepTimeoutMs, env.TS_AGENT_STEP_TIMEOUT_MS, 60000),
    taskTimeoutMs: pickOptionalNumber(override.taskTimeoutMs, env.TS_AGENT_TASK_TIMEOUT_MS),
    pythonToolTimeoutMs: pickOptionalNumber(
      override.pythonToolTimeoutMs,
      env.TS_AGENT_PYTHON_TOOL_TIMEOUT_MS
    ),
    maxTurns: pickNumber(override.maxTurns, env.TS_AGENT_MAX_TURNS, 24),
    syncRequestTimeoutMs: pickNumber(
      override.syncRequestTimeoutMs,
      env.TS_AGENT_SYNC_REQUEST_TIMEOUT_MS,
      300000
    )
  };
}

export function resolvePlannerRuntimeMode(
  override: Partial<PlannerModelConfig> = {},
  env: NodeJS.ProcessEnv = process.env
): "plan_once" | "react_loop" {
  const explicitMode = pickRuntimeMode(override.runtimeMode, env.TS_AGENT_PLANNER_RUNTIME_MODE);
  if (explicitMode) {
    return explicitMode;
  }
  const baseUrl = pickString(
    override.baseUrl,
    env.TS_AGENT_PLANNER_BASE_URL,
    env.OPENAI_BASE_URL,
    "http://localhost:8080/v1"
  );
  const model = pickString(override.model, env.TS_AGENT_PLANNER_MODEL, env.OPENAI_MODEL, "gpt-4o-mini");
  const compatMode = resolvePlannerCompatMode(override, env);
  return compatMode !== "strict" && isLikelyLocalModelBackend(baseUrl, model) ? "plan_once" : "react_loop";
}

export class LlmPlanner implements Planner {
  private readonly config: PlannerModelConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: LlmPlannerDeps = {}) {
    this.config = resolvePlannerModelConfig(deps.config, deps.env);
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async createPlan(goal: string, doc: DocumentIR, options?: { timeoutMs?: number }): Promise<Plan> {
    const prompt = buildPrompt(goal, doc);
    const raw = await this.requestPlanJson(prompt, PLAN_SYSTEM_PROMPT, options?.timeoutMs);
    return await this.parsePlanWithRepair(raw, goal, doc);
  }

  private async parsePlanWithRepair(content: string, goal: string, doc: DocumentIR): Promise<Plan> {
    try {
      return parseAndValidatePlan(content, doc);
    } catch (err) {
      const appErr = asAppError(err, "E_PLANNER_PLAN_INVALID");
      if (!isRepairablePlanError(appErr)) {
        throw err;
      }
      const repairPrompt = buildRepairPrompt(goal, doc, content, appErr.message);
      const repaired = await this.requestPlanJson(repairPrompt, PLAN_REPAIR_SYSTEM_PROMPT);
      return parseAndValidatePlan(repaired, doc);
    }
  }

  private async requestPlanJson(
    prompt: string,
    systemPrompt = PLAN_SYSTEM_PROMPT,
    requestTimeoutMs?: number
  ): Promise<string> {
    const endpoint = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const maxRetries = this.config.maxRetries ?? 0;
    let lastErr: unknown;
    const timeoutControl = resolveRequestTimeoutControl(this.config.timeoutMs, requestTimeoutMs, {
      requestTimeoutCode: "E_PLANNER_REQUEST_TIMEOUT",
      requestTimeoutMessage: "Planner request timed out",
      taskTimeoutMessage: "Task budget exceeded while waiting for planner response."
    });

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (timeoutControl.timeoutMs <= 0) {
        throw timeoutControl.toTimeoutError();
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutControl.timeoutMs);
      try {
        const resp = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`
          },
          body: JSON.stringify({
            model: this.config.model,
            temperature: this.config.temperature ?? 0,
            messages: [
              {
                role: "system",
                content: systemPrompt
              },
              { role: "user", content: prompt }
            ],
            ...(this.config.useJsonSchema !== false
              ? {
                  response_format: {
                    type: "json_schema",
                    json_schema: {
                      name: "document_plan",
                      strict: this.config.schemaStrict !== false,
                      schema: buildPlanJsonSchema()
                    }
                  }
                }
              : {}),
            stream: false
          }),
          signal: controller.signal
        });
        const payload = await resp.text();
        if (!resp.ok) {
          if (this.config.useJsonSchema !== false && isSchemaUnsupported(resp.status, payload)) {
            throw new AgentError({
              code: "E_PLANNER_SCHEMA_UNSUPPORTED",
              message: `Planner upstream does not support response_format json_schema (${resp.status}).`,
              retryable: false
            });
          }
          throw new AgentError({
            code: "E_PLANNER_UPSTREAM",
            message: `Planner model request failed (${resp.status}): ${payload.slice(0, 200)}`,
            retryable: resp.status >= 500
          });
        }
        const content = extractContent(payload);
        return content;
      } catch (err) {
        if (controller.signal.aborted) {
          const timeoutErr = timeoutControl.toTimeoutError(err);
          if (timeoutControl.budgetClipped) {
            throw timeoutErr;
          }
          lastErr = timeoutErr;
          if (attempt === maxRetries) {
            break;
          }
          await sleep(150 * (attempt + 1));
          continue;
        }
        lastErr = err;
        const appErr = asAppError(err, "E_PLANNER_REQUEST");
        const retryable = appErr.retryable || isNetworkError(err);
        if (!retryable || attempt === maxRetries) break;
        await sleep(150 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw asCompatibleModelRequestError(
      lastErr ?? new Error("Unknown planner request failure"),
      "E_PLANNER_REQUEST",
      "Planner model request"
    );
  }
}

function buildPrompt(goal: string, doc: DocumentIR): string {
  const docSample = summarizeNodesForPrompt(doc, MAX_PROMPT_NODES);
  const selectorGuidance = buildSemanticSelectorGuidance();
  return JSON.stringify(
    {
      instruction:
        "请生成且只生成 1 个 Plan JSON 对象。每个步骤必须包含 id、toolName、readOnly(boolean)、idempotencyKey，以及可选的 timeoutMs/retryLimit/operation。 " +
        "Generate exactly one Plan JSON object. Each step must include id, toolName, readOnly(boolean), idempotencyKey, and optional timeoutMs/retryLimit/operation.",
      constraints: {
        allowedToolNames: Array.from(PLAN_TOOL_NAMES),
        allowedOperationTypes: Array.from(OPERATION_TYPES),
        requiredWriteOperationFields: ["id", "type", "payload"],
        operationPayloadSchemas: {
          set_font: { font_name: "string" },
          set_size: { font_size_pt: "number (pt)" },
          set_line_spacing: {
            line_spacing: "positive number | { mode: 'exact', pt: positive number }"
          },
          set_alignment: { paragraph_alignment: "string" },
          set_font_color: { font_color: "6-char uppercase hex color" },
          set_bold: { is_bold: "boolean" },
          set_italic: { is_italic: "boolean" },
          set_underline: { is_underline: "boolean" },
          set_strike: { is_strike: "boolean" },
          set_highlight_color: { highlight_color: "word-color-name or mapped hex alias" },
          set_all_caps: { is_all_caps: "boolean" },
          merge_paragraph: {},
          split_paragraph: { split_offset: "positive integer" }
        },
        writeOperationRules: [
          "toolName=write_operation requires a non-empty operation object",
          "write_operation must include operation.id and operation.type",
          "operation must include payload",
          "operation must include targetNodeId or targetSelector",
          "operation.targetNodeId must be one of availableNodeIds when present",
          "targetSelector.scope must be one of availableSelectorScopes",
          "use targetSelector for semantic groups like body or headings",
          "prefer one semantic write_operation step for batchable semantic edits",
          "runtime expands matched selectors into targetNodeId or targetNodeIds",
          "every write_operation must be semantically executable against the provided document structure",
          "never use placeholder ids like 'placeholder', 'unused', or 'target'",
          "never emit an empty payload for style-changing writes",
          "targetNodeId or targetSelector must bind to a real document range",
          "set_font payload must use font_name only",
          "set_size payload must use font_size_pt only",
          "set_line_spacing payload must use line_spacing only",
          "set_alignment payload must use paragraph_alignment only",
          "set_font_color payload must use font_color only",
          "set_bold payload must use is_bold only",
          "set_italic payload must use is_italic only",
          "set_underline payload must use is_underline only",
          "set_strike payload must use is_strike only",
          "set_highlight_color payload must use highlight_color only",
          "set_all_caps payload must use is_all_caps only",
          "merge_paragraph payload must be an empty object",
          "split_paragraph payload must use split_offset only",
          "only downgrade to inspect_document when no real document range can be grounded"
        ],
        selectorRules: selectorGuidance.selectorRules,
        selectorExamples: selectorGuidance.selectorExamples,
        strictJsonOnly: true
      },
      input: {
        goal,
        document: {
          id: doc.id,
          version: doc.version,
          metadata: sanitizePromptMetadata(doc.metadata),
          nodeCount: doc.nodes.length,
          availableNodeIds: doc.nodes.slice(0, MAX_PROMPT_NODE_IDS).map((n) => n.id),
          availableSelectorScopes: ["body", "heading", "list_item", "all_text", "paragraph_ids"],
          structure: summarizeStructureForPrompt(doc),
          nodes: docSample
        }
      }
    },
    null,
    2
  );
}

function buildRepairPrompt(
  goal: string,
  doc: DocumentIR,
  invalidPlanText: string,
  validationError: string
): string {
  const selectorGuidance = buildSemanticSelectorGuidance();
  return JSON.stringify(
    {
      instruction:
        "请修复无效的 Plan JSON，并且只返回 1 个有效 Plan 对象，不要输出其他内容。 " +
        "Repair the invalid Plan JSON. Return exactly one valid Plan object and nothing else.",
      validationError,
      constraints: {
        allowedToolNames: Array.from(PLAN_TOOL_NAMES),
        allowedOperationTypes: Array.from(OPERATION_TYPES),
        requiredWriteOperationFields: ["id", "type", "payload"],
        operationPayloadSchemas: {
          set_font: { font_name: "string" },
          set_size: { font_size_pt: "number (pt)" },
          set_line_spacing: {
            line_spacing: "positive number | { mode: 'exact', pt: positive number }"
          },
          set_alignment: { paragraph_alignment: "string" },
          set_font_color: { font_color: "6-char uppercase hex color" },
          set_bold: { is_bold: "boolean" },
          set_italic: { is_italic: "boolean" },
          set_underline: { is_underline: "boolean" },
          set_strike: { is_strike: "boolean" },
          set_highlight_color: { highlight_color: "word-color-name or mapped hex alias" },
          set_all_caps: { is_all_caps: "boolean" },
          merge_paragraph: {},
          split_paragraph: { split_offset: "positive integer" }
        },
        writeOperationRules: [
          "toolName=write_operation requires a non-empty operation object",
          "write_operation must include operation.id and operation.type",
          "operation.targetNodeId must exactly match one value from availableNodeIds when present",
          "operation must include targetNodeId or targetSelector",
          "targetSelector.scope must be one of availableSelectorScopes",
          "prefer one semantic write_operation step for batchable semantic edits",
          "runtime expands matched selectors into targetNodeId or targetNodeIds",
          "never invent placeholder ids",
          "never leave write_operation semantic fields blank",
          "repair invalid writes into semantically executable writes whenever the document structure allows it",
          "never use placeholder ids like 'placeholder', 'unused', or 'target'",
          "never emit an empty payload for style-changing writes",
          "targetNodeId or targetSelector must bind to a real document range",
          "set_font payload must use font_name only",
          "set_size payload must use font_size_pt only",
          "set_line_spacing payload must use line_spacing only",
          "set_alignment payload must use paragraph_alignment only",
          "set_font_color payload must use font_color only",
          "set_bold payload must use is_bold only",
          "set_italic payload must use is_italic only",
          "set_underline payload must use is_underline only",
          "set_strike payload must use is_strike only",
          "set_highlight_color payload must use highlight_color only",
          "set_all_caps payload must use is_all_caps only",
          "merge_paragraph payload must be an empty object",
          "split_paragraph payload must use split_offset only",
          "only downgrade to inspect_document when no real document range can be grounded"
        ],
        selectorRules: selectorGuidance.selectorRules,
        selectorExamples: selectorGuidance.selectorExamples
      },
      input: {
        goal,
        document: {
          id: doc.id,
          version: doc.version,
          metadata: sanitizePromptMetadata(doc.metadata),
          nodeCount: doc.nodes.length,
          availableNodeIds: doc.nodes.slice(0, MAX_PROMPT_NODE_IDS).map((n) => n.id),
          availableSelectorScopes: ["body", "heading", "list_item", "all_text", "paragraph_ids"],
          structure: summarizeStructureForPrompt(doc),
          nodes: summarizeNodesForPrompt(doc, MAX_PROMPT_NODES)
        }
      },
      invalidPlan: invalidPlanText
    },
    null,
    2
  );
}

function buildPlanJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "goal", "steps"],
    properties: {
      taskId: { type: "string", minLength: 1 },
      goal: { type: "string", minLength: 1 },
      steps: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "toolName", "readOnly", "idempotencyKey"],
          allOf: [
            {
              if: {
                properties: {
                  toolName: { const: "write_operation" }
                }
              },
              then: {
                required: ["operation"]
              }
            }
          ],
          properties: {
            id: { type: "string", minLength: 1 },
            toolName: { type: "string", minLength: 1 },
            readOnly: { type: "boolean" },
            timeoutMs: { type: "number", minimum: 0 },
            retryLimit: { type: "number", minimum: 0 },
            idempotencyKey: { type: "string", minLength: 1 },
            operation: {
              type: "object",
              additionalProperties: false,
            required: ["id", "type", "payload"],
            properties: {
              id: { type: "string", minLength: 1 },
              type: { type: "string", enum: Array.from(OPERATION_TYPES) },
              targetNodeId: { type: "string", minLength: 1 },
              targetSelector: buildNodeSelectorJsonSchema(),
              payload: { type: "object" }
            }
          }
          }
        }
      }
    }
  };
}

function extractContent(rawText: string): string {
  try {
    const result = parseOpenAiCompatibleChatText(rawText);
    if (result.content === null) {
      throw new AgentError({
        code: "E_PLANNER_MODEL_RESPONSE",
        message: buildModelResponseErrorMessage("Planner upstream payload", result),
        retryable: false
      });
    }
    return result.content;
  } catch (err) {
    if (err instanceof AgentError) {
      throw err;
    }
    throw new AgentError({
      code: "E_PLANNER_MODEL_RESPONSE",
      message: `Planner upstream returned non-JSON envelope: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }
}

function parseAndValidatePlan(content: string, doc?: DocumentIR): Plan {
  const targetContext = buildTargetContext(doc);
  let candidate: unknown;
  try {
    candidate = JSON.parse(content);
  } catch (err) {
    throw new AgentError({
      code: "E_PLANNER_PLAN_PARSE",
      message: `Planner returned invalid JSON plan: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }

  if (!candidate || typeof candidate !== "object") {
    throw new AgentError({
      code: "E_PLANNER_PLAN_INVALID",
      message: "Planner plan must be a JSON object.",
      retryable: false
    });
  }
  const raw = candidate as {
    taskId?: unknown;
    task_id?: unknown;
    goal?: unknown;
    steps?: unknown;
  };
  const taskId = pickNonEmptyStringValue(raw.taskId, raw.task_id);
  if (!taskId || !isNonEmptyString(raw.goal) || !Array.isArray(raw.steps)) {
    throw new AgentError({
      code: "E_PLANNER_PLAN_INVALID",
      message: "Planner plan must include non-empty taskId, goal, and steps[].",
      retryable: false
    });
  }
  if (raw.steps.length === 0) {
    throw new AgentError({
      code: "E_PLANNER_PLAN_INVALID",
      message: "Planner plan steps[] cannot be empty.",
      retryable: false
    });
  }

  const stepIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const steps = raw.steps.map((step, idx) => parseStep(step, idx, targetContext));
  for (const step of steps) {
    if (stepIds.has(step.id)) {
      throw new AgentError({
        code: "E_PLANNER_PLAN_INVALID",
        message: `Duplicate step id: ${step.id}`,
        retryable: false
      });
    }
    if (idempotencyKeys.has(step.idempotencyKey)) {
      throw new AgentError({
        code: "E_PLANNER_PLAN_INVALID",
        message: `Duplicate idempotencyKey: ${step.idempotencyKey}`,
        retryable: false
      });
    }
    stepIds.add(step.id);
    idempotencyKeys.add(step.idempotencyKey);
  }

  return {
    taskId,
    goal: raw.goal.trim(),
    steps
  };
}

function parseStep(step: unknown, idx: number, targetContext?: TargetContext): Plan["steps"][number] {
  if (!step || typeof step !== "object") {
    throw invalidStep(idx, "step must be an object");
  }
  const raw = step as {
    id?: unknown;
    stepId?: unknown;
    toolName?: unknown;
    tool_name?: unknown;
    tool?: unknown;
    readOnly?: unknown;
    read_only?: unknown;
    timeoutMs?: unknown;
    timeout_ms?: unknown;
    retryLimit?: unknown;
    retry_limit?: unknown;
    idempotencyKey?: unknown;
    idempotency_key?: unknown;
    operation?: unknown;
  };
  const stepId = pickNonEmptyStringValue(raw.id, raw.stepId) ?? `step_${idx}`;
  const toolName = pickNonEmptyStringValue(raw.toolName, raw.tool_name, raw.tool);
  if (!toolName) throw invalidStep(idx, "toolName is required");
  const readOnly = normalizeLooseBoolean(raw.readOnly, raw.read_only);
  if (typeof readOnly !== "boolean") throw invalidStep(idx, "readOnly must be boolean");
  const idempotencyKey =
    pickNonEmptyStringValue(raw.idempotencyKey, raw.idempotency_key) ?? `auto:${stepId}`;
  const timeoutMs = normalizeLooseNumber(raw.timeoutMs, raw.timeout_ms);
  if (raw.timeoutMs !== undefined || raw.timeout_ms !== undefined) {
    if (!isNonNegativeNumber(timeoutMs)) {
      throw invalidStep(idx, "timeoutMs must be a non-negative number");
    }
  }
  const retryLimit = normalizeLooseNumber(raw.retryLimit, raw.retry_limit);
  if (raw.retryLimit !== undefined || raw.retry_limit !== undefined) {
    if (!isNonNegativeNumber(retryLimit)) {
      throw invalidStep(idx, "retryLimit must be a non-negative number");
    }
  }
  if (toolName === "write_operation" && raw.operation === undefined) {
    throw invalidStep(idx, "write_operation requires operation");
  }

  return {
    id: stepId,
    toolName,
    readOnly,
    idempotencyKey,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(retryLimit !== undefined ? { retryLimit } : {}),
    ...(raw.operation !== undefined ? { operation: parseOperation(raw.operation, idx, stepId, targetContext) } : {})
  };
}

function parseOperation(op: unknown, idx: number, stepId: string, targetContext?: TargetContext): Operation {
  if (!op || typeof op !== "object") throw invalidStep(idx, "operation must be an object");
  const raw = op as {
    id?: unknown;
    operationId?: unknown;
    operation_id?: unknown;
    type?: unknown;
    targetNodeId?: unknown;
    target_node_id?: unknown;
    targetNodeIds?: unknown;
    target_node_ids?: unknown;
    targetSelector?: unknown;
    target_selector?: unknown;
    selector?: unknown;
    payload?: unknown;
  };
  const operationType = normalizeOperationType(raw.type);
  const operationId = pickNonEmptyStringValue(raw.id, raw.operationId, raw.operation_id) ?? `${stepId}_op`;
  if (!isObject(raw.payload)) throw invalidStep(idx, "operation.payload must be an object");
  if (!operationType) {
    throw invalidStep(idx, "operation.type is invalid");
  }
  const targetNodeId = pickNonEmptyStringValue(raw.targetNodeId, raw.target_node_id);
  const targetNodeIds = normalizeTargetNodeIds(raw.targetNodeIds, raw.target_node_ids);
  const selectorInput = firstDefined(raw.targetSelector, raw.target_selector, raw.selector);
  const targetSelector = selectorInput === undefined ? undefined : parseTargetSelector(selectorInput, idx);
  if (!targetNodeId && !targetNodeIds?.length && !targetSelector) {
    throw invalidStep(idx, "operation.targetNodeId or operation.targetSelector is required");
  }
  if (targetNodeId && isPlaceholderTargetId(targetNodeId)) {
    throw invalidStep(idx, `operation.targetNodeId must not use placeholder ids like '${targetNodeId}'`);
  }
  if (targetNodeId && targetContext && !targetContext.nodeIds.has(targetNodeId)) {
    throw invalidStep(idx, `operation.targetNodeId must match an existing document node id: ${targetNodeId}`);
  }
  if (targetNodeIds?.length) {
    for (const concreteTargetId of targetNodeIds) {
      if (isPlaceholderTargetId(concreteTargetId)) {
        throw invalidStep(idx, `operation.targetNodeIds must not use placeholder ids like '${concreteTargetId}'`);
      }
      if (targetContext && !targetContext.nodeIds.has(concreteTargetId)) {
        throw invalidStep(idx, `operation.targetNodeIds must match existing document node ids: ${concreteTargetId}`);
      }
    }
  }
  validateExecutableTarget(idx, operationType, targetSelector, targetContext);
  const payload = normalizeCompatiblePayload(idx, operationType, raw.payload);
  return {
    id: operationId,
    type: operationType,
    ...(targetNodeId ? { targetNodeId } : {}),
    ...(targetNodeIds?.length ? { targetNodeIds } : {}),
    ...(targetSelector ? { targetSelector } : {}),
    payload
  };
}

function parseTargetSelector(value: unknown, idx: number): NodeSelector {
  if (!isObject(value)) {
    throw invalidStep(idx, "operation.targetSelector must be an object");
  }
  const raw = value as {
    scope?: unknown;
    headingLevel?: unknown;
    heading_level?: unknown;
    paragraphIds?: unknown;
    paragraph_ids?: unknown;
  };
  const scope = normalizeSelectorScope(raw.scope);
  if (!scope) {
    throw invalidStep(idx, "operation.targetSelector.scope is required");
  }
  const headingLevel = normalizeLooseNumber(raw.headingLevel, raw.heading_level);
  if ((raw.headingLevel !== undefined || raw.heading_level !== undefined) && !isNonNegativeNumber(headingLevel)) {
    throw invalidStep(idx, "operation.targetSelector.headingLevel must be a non-negative number");
  }
  const paragraphIds = normalizeParagraphIds(raw.paragraphIds, raw.paragraph_ids);
  if (
    (raw.paragraphIds !== undefined || raw.paragraph_ids !== undefined) &&
    !paragraphIds?.length &&
    scope !== "paragraph_ids"
  ) {
    throw invalidStep(idx, "operation.targetSelector.paragraphIds must be a string array");
  }
  if (scope === "paragraph_ids" && !paragraphIds?.length) {
    throw invalidStep(idx, "operation.targetSelector.paragraphIds is required for paragraph_ids scope");
  }
  return {
    scope,
    headingLevel: headingLevel as number | undefined,
    paragraphIds
  };
}

function buildNodeSelectorJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["scope"],
    properties: {
      scope: { type: "string", enum: ["body", "heading", "list_item", "all_text", "paragraph_ids"] },
      headingLevel: { type: "number", minimum: 0 },
      paragraphIds: {
        type: "array",
        items: { type: "string", minLength: 1 }
      }
    }
  };
}

interface TargetContext {
  nodeIds: Set<string>;
  paragraphIds: Set<string>;
  roleCounts: Record<string, number>;
}

function buildTargetContext(doc?: DocumentIR): TargetContext | undefined {
  if (!doc) {
    return undefined;
  }
  const metadata = doc.metadata;
  const structureIndex =
    metadata && typeof metadata === "object" && typeof (metadata as { structureIndex?: unknown }).structureIndex === "object"
      ? ((metadata as { structureIndex?: { paragraphs?: Array<{ id?: unknown }>; roleCounts?: Record<string, unknown> } })
          .structureIndex ?? {})
      : {};
  const paragraphs = Array.isArray(structureIndex.paragraphs) ? structureIndex.paragraphs : [];
  const roleCountsRaw =
    structureIndex.roleCounts && typeof structureIndex.roleCounts === "object" ? structureIndex.roleCounts : {};
  const roleCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(roleCountsRaw)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      roleCounts[key] = value;
    }
  }
  return {
    nodeIds: new Set(doc.nodes.map((node) => node.id)),
    paragraphIds: new Set(
      paragraphs
        .map((paragraph) => (typeof paragraph?.id === "string" ? paragraph.id.trim() : ""))
        .filter((paragraphId) => paragraphId.length > 0)
    ),
    roleCounts
  };
}

function validateExecutableTarget(
  idx: number,
  operationType: OperationType,
  selector: NodeSelector | undefined,
  targetContext?: TargetContext
): void {
  if (!selector || !targetContext) {
    return;
  }
  if (selector.scope === "paragraph_ids") {
    if (targetContext.paragraphIds.size === 0) {
      return;
    }
    const paragraphIds = selector.paragraphIds ?? [];
    const missing = paragraphIds.find((paragraphId) => !targetContext.paragraphIds.has(paragraphId));
    if (missing) {
      throw invalidStep(idx, `operation.targetSelector.paragraphIds must match existing paragraph ids: ${missing}`);
    }
    return;
  }
  if (selector.scope === "all_text") {
    return;
  }
  const requiredRole = selector.scope === "heading" ? "heading" : selector.scope;
  if (Object.keys(targetContext.roleCounts).length === 0) {
    return;
  }
  if ((targetContext.roleCounts[requiredRole] ?? 0) === 0) {
    throw invalidStep(
      idx,
      `operation.targetSelector.scope='${selector.scope}' does not bind to any real document range for ${operationType}`
    );
  }
}

function normalizeCompatiblePayload(
  idx: number,
  operationType: OperationType,
  payload: Record<string, unknown>
): Record<string, unknown> {
  try {
    const normalized = normalizeWriteOperationPayload({
      id: "compat",
      type: operationType,
      payload
    });
    return isCanonicalPayload(operationType, payload) ? payload : normalized;
  } catch {
    validateExecutablePayload(idx, operationType, payload);
    return payload;
  }
}

function validateExecutablePayload(idx: number, operationType: OperationType, payload: unknown): void {
  if (!isObject(payload)) {
    throw invalidStep(idx, "operation.payload must be an object");
  }
  if (operationType === "merge_paragraph") {
    if (Object.keys(payload).length > 0) {
      throw invalidStep(idx, "merge_paragraph payload must be empty");
    }
    return;
  }
  if (operationType === "set_font" && !hasNonEmptyString(payload, ["font_name", "fontName"])) {
    throw invalidStep(idx, "set_font payload must include font_name");
  }
  if (
    operationType === "set_size" &&
    !hasPositiveNumber(payload, ["font_size_pt", "fontSizePt", "fontSize"])
  ) {
    throw invalidStep(idx, "set_size payload must include font_size_pt");
  }
  if (operationType === "set_line_spacing" && !hasValidLineSpacing(payload)) {
    throw invalidStep(
      idx,
      "set_line_spacing payload must include line_spacing as a positive number or { mode: 'exact', pt: positive number }"
    );
  }
  if (operationType === "set_alignment" && !hasNonEmptyString(payload, ["paragraph_alignment", "alignment"])) {
    throw invalidStep(idx, "set_alignment payload must include paragraph_alignment");
  }
  if (operationType === "set_font_color" && !hasNonEmptyString(payload, ["font_color", "fontColor"])) {
    throw invalidStep(idx, "set_font_color payload must include font_color");
  }
  if (operationType === "set_highlight_color" && !hasNonEmptyString(payload, ["highlight_color", "highlightColor"])) {
    throw invalidStep(idx, "set_highlight_color payload must include highlight_color");
  }
  if (operationType === "split_paragraph" && !hasPositiveNumber(payload, ["split_offset", "splitOffset"])) {
    throw invalidStep(idx, "split_paragraph payload must include split_offset");
  }
  if (operationType === "set_bold" && !hasBoolean(payload, ["is_bold", "isBold"])) {
    throw invalidStep(idx, "set_bold payload must include is_bold");
  }
  if (operationType === "set_italic" && !hasBoolean(payload, ["is_italic", "isItalic"])) {
    throw invalidStep(idx, "set_italic payload must include is_italic");
  }
  if (operationType === "set_underline" && !hasBoolean(payload, ["is_underline", "isUnderline"])) {
    throw invalidStep(idx, "set_underline payload must include is_underline");
  }
  if (operationType === "set_strike" && !hasBoolean(payload, ["is_strike", "isStrike"])) {
    throw invalidStep(idx, "set_strike payload must include is_strike");
  }
  if (operationType === "set_all_caps" && !hasBoolean(payload, ["is_all_caps", "isAllCaps"])) {
    throw invalidStep(idx, "set_all_caps payload must include is_all_caps");
  }
}

function isPlaceholderTargetId(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ["placeholder", "unused", "target", "todo", "tbd"].includes(normalized);
}

function normalizeOperationType(value: unknown): OperationType | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return OPERATION_TYPES.has(normalized as OperationType) ? (normalized as OperationType) : undefined;
}

function normalizeSelectorScope(value: unknown): NodeSelector["scope"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ["body", "heading", "list_item", "all_text", "paragraph_ids"].includes(normalized)
    ? (normalized as NodeSelector["scope"])
    : undefined;
}

function normalizeTargetNodeIds(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    const normalized = normalizeParagraphIds(value);
    if (normalized?.length) {
      return normalized;
    }
  }
  return undefined;
}

function normalizeParagraphIds(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      const normalized = Array.from(
        new Set(
          value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        )
      );
      if (normalized.length > 0) {
        return normalized;
      }
      continue;
    }
    if (typeof value === "string") {
      const normalized = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (normalized.length > 0) {
        return Array.from(new Set(normalized));
      }
    }
  }
  return undefined;
}

function normalizeLooseBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
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
  }
  return undefined;
}

function normalizeLooseNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickNonEmptyStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstDefined<T>(...values: T[]): T | undefined {
  return values.find((value) => value !== undefined);
}

function isCanonicalPayload(operationType: OperationType, payload: Record<string, unknown>): boolean {
  if (operationType === "merge_paragraph") {
    return Object.keys(payload).length === 0;
  }
  if (operationType === "set_font") {
    return (
      (typeof payload.font_name === "string" && payload.font_name.trim().length > 0) ||
      (typeof payload.fontName === "string" && payload.fontName.trim().length > 0)
    );
  }
  if (operationType === "set_size") {
    return (
      (typeof payload.font_size_pt === "number" && Number.isFinite(payload.font_size_pt) && payload.font_size_pt > 0) ||
      (typeof payload.fontSizePt === "number" && Number.isFinite(payload.fontSizePt) && payload.fontSizePt > 0) ||
      (typeof payload.fontSize === "number" && Number.isFinite(payload.fontSize) && payload.fontSize > 0)
    );
  }
  if (operationType === "set_line_spacing") {
    return hasValidLineSpacing(payload);
  }
  if (operationType === "set_alignment") {
    return (
      (typeof payload.paragraph_alignment === "string" && payload.paragraph_alignment.trim().length > 0) ||
      (typeof payload.alignment === "string" && payload.alignment.trim().length > 0)
    );
  }
  if (operationType === "set_font_color") {
    return (
      (typeof payload.font_color === "string" && /^[0-9A-F]{6}$/.test(payload.font_color.trim())) ||
      (typeof payload.fontColor === "string" && /^[0-9A-F]{6}$/.test(payload.fontColor.trim()))
    );
  }
  if (operationType === "set_highlight_color") {
    return (
      (typeof payload.highlight_color === "string" && payload.highlight_color.trim().length > 0) ||
      (typeof payload.highlightColor === "string" && payload.highlightColor.trim().length > 0)
    );
  }
  if (operationType === "split_paragraph") {
    return (
      (typeof payload.split_offset === "number" && Number.isInteger(payload.split_offset) && payload.split_offset > 0) ||
      (typeof payload.splitOffset === "number" && Number.isInteger(payload.splitOffset) && payload.splitOffset > 0)
    );
  }
  if (operationType === "set_bold") {
    return typeof payload.is_bold === "boolean" || typeof payload.isBold === "boolean";
  }
  if (operationType === "set_italic") {
    return typeof payload.is_italic === "boolean" || typeof payload.isItalic === "boolean";
  }
  if (operationType === "set_underline") {
    return typeof payload.is_underline === "boolean" || typeof payload.isUnderline === "boolean";
  }
  if (operationType === "set_strike") {
    return typeof payload.is_strike === "boolean" || typeof payload.isStrike === "boolean";
  }
  if (operationType === "set_all_caps") {
    return typeof payload.is_all_caps === "boolean" || typeof payload.isAllCaps === "boolean";
  }
  return false;
}

function hasNonEmptyString(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => isNonEmptyString(payload[key]));
}

function hasPositiveNumber(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => isNonNegativeNumber(payload[key]) && Number(payload[key]) > 0);
}

function hasBoolean(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => typeof payload[key] === "boolean");
}

function hasValidLineSpacing(payload: Record<string, unknown>): boolean {
  const lineSpacing = payload.line_spacing;
  if (typeof lineSpacing === "number" && Number.isFinite(lineSpacing) && lineSpacing > 0) {
    return true;
  }
  if (!lineSpacing || typeof lineSpacing !== "object" || Array.isArray(lineSpacing)) {
    return false;
  }
  const mode = (lineSpacing as { mode?: unknown }).mode;
  const pt = (lineSpacing as { pt?: unknown }).pt;
  return mode === "exact" && typeof pt === "number" && Number.isFinite(pt) && pt > 0;
}

function invalidStep(idx: number, message: string): AgentError {
  return new AgentError({
    code: "E_PLANNER_PLAN_INVALID",
    message: `Invalid step at index ${idx}: ${message}`,
    retryable: false
  });
}

function summarizeNodesForPrompt(doc: DocumentIR, maxNodes: number): Array<Record<string, unknown>> {
  return doc.nodes.slice(0, maxNodes).map((node) => ({
    id: node.id,
    text: truncateText(node.text, MAX_NODE_TEXT_PREVIEW),
    style: node.style ?? {}
  }));
}

function summarizeStructureForPrompt(doc: DocumentIR): Record<string, unknown> {
  return summarizeStructureForPromptContext(doc);
}

function truncateText(value: string, maxLength: number): string {
  const text = value.trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function isRepairablePlanError(err: { code?: string }): boolean {
  return err.code === "E_PLANNER_PLAN_PARSE" || err.code === "E_PLANNER_PLAN_INVALID";
}

function pickString(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function pickNumber(...values: Array<number | string | undefined>): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function pickOptionalNumber(...values: Array<number | string | null | undefined>): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function pickBoolean(...values: Array<boolean | string | undefined>): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (v === "true" || v === "1" || v === "yes" || v === "on") {
        return true;
      }
      if (v === "false" || v === "0" || v === "no" || v === "off") {
        return false;
      }
    }
  }
  return undefined;
}

function pickCompatMode(...values: Array<PlannerCompatMode | string | undefined>): PlannerCompatMode | undefined {
  for (const value of values) {
    if (value === "auto" || value === "strict") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "auto" || normalized === "strict") {
        return normalized;
      }
    }
  }
  return undefined;
}

function pickRuntimeMode(...values: Array<"plan_once" | "react_loop" | string | undefined>) {
  for (const value of values) {
    if (value === "plan_once" || value === "react_loop") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "plan_once" || normalized === "react_loop") {
        return normalized as "plan_once" | "react_loop";
      }
    }
  }
  return undefined;
}

function resolvePlannerCompatMode(
  override: Partial<PlannerModelConfig>,
  env: NodeJS.ProcessEnv
): PlannerCompatMode {
  return pickCompatMode(override.compatMode, env.TS_AGENT_PLANNER_COMPAT_MODE, "auto") ?? "auto";
}

function resolveRequestTimeoutControl(
  configuredTimeoutMs: number | undefined,
  requestTimeoutMs: number | undefined,
  messages: {
    requestTimeoutCode: string;
    requestTimeoutMessage: string;
    taskTimeoutMessage: string;
  }
): {
  timeoutMs: number;
  budgetClipped: boolean;
  toTimeoutError: (cause?: unknown) => AgentError;
} {
  const baseTimeoutMs = configuredTimeoutMs ?? 30000;
  const budgetClipped =
    typeof requestTimeoutMs === "number" && Number.isFinite(requestTimeoutMs) && requestTimeoutMs < baseTimeoutMs;
  const timeoutMs =
    typeof requestTimeoutMs === "number" && Number.isFinite(requestTimeoutMs)
      ? Math.max(0, Math.min(baseTimeoutMs, requestTimeoutMs))
      : baseTimeoutMs;
  return {
    timeoutMs,
    budgetClipped,
    toTimeoutError: (cause?: unknown) =>
      new AgentError({
        code: budgetClipped ? "E_TASK_TIMEOUT" : messages.requestTimeoutCode,
        message: budgetClipped
          ? messages.taskTimeoutMessage
          : `${messages.requestTimeoutMessage} after ${timeoutMs}ms.`,
        retryable: false,
        cause
      })
  };
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNetworkError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      /network|fetch|timeout|aborted/i.test(err.message))
  );
}

export function asCompatibleModelRequestError(
  err: unknown,
  fallbackCode: string,
  requestLabel: string
): AgentError {
  const info = asAppError(err, fallbackCode);
  if (isNetworkError(err) && /timeout|aborted/i.test(info.message)) {
    return new AgentError({
      code: fallbackCode,
      message: `${requestLabel} timed out or was aborted. Local/small models may need compatibility mode or a longer timeout.`,
      retryable: info.retryable,
      cause: info.cause
    });
  }
  return new AgentError(info);
}

function isLikelyLocalModelBackend(baseUrl: string | undefined, model: string | undefined): boolean {
  const host = parseHost(baseUrl);
  if (host && isLocalHost(host)) {
    return true;
  }
  if (typeof model === "string" && /gemma|llama|qwen|mistral|phi|glm|local/i.test(model)) {
    return true;
  }
  return false;
}

function parseHost(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
}

export function isSchemaUnsupported(status: number, payload: string): boolean {
  if (status < 400 || status >= 500) {
    return false;
  }
  const lower = payload.toLowerCase();
  const mentionsSchema = lower.includes("response_format") || lower.includes("json_schema");
  const mentionsUnsupported =
    lower.includes("not support") ||
    lower.includes("unsupported") ||
    lower.includes("unknown") ||
    lower.includes("invalid");
  return mentionsSchema && mentionsUnsupported;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
