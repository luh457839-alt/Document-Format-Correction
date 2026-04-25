import { AgentError, asAppError } from "../core/errors.js";
import {
  buildModelResponseErrorMessage,
  parseOpenAiCompatibleChatText,
  shouldRetryMissingModelContent
} from "../core/model-response.js";
import type {
  DocumentIR,
  NodeSelector,
  Operation,
  OperationType,
  PlannerModelConfig,
  PlanStep,
  ReActDecision,
  ReActPlanner,
  ReActTurnInput
} from "../core/types.js";
import {
  buildSemanticSelectorGuidance,
  sanitizePromptMetadata,
  summarizeStructureForPrompt as summarizeStructureForPromptContext
} from "./prompt-context.js";
import {
  asCompatibleModelRequestError,
  isSchemaUnsupported,
  resolvePlannerModelConfig
} from "./llm-planner.js";
import { resolveRequestTimeoutControl } from "../llm/request-timeout-control.js";
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
  "set_page_layout",
  "set_paragraph_spacing",
  "set_paragraph_indent",
  "merge_paragraph",
  "split_paragraph"
]);
const REACT_REQUIRED_STEP_FIELDS = ["id", "toolName", "readOnly", "idempotencyKey"] as const;
const REACT_REQUIRED_OPERATION_FIELDS = ["id", "type", "payload"] as const;
const REACT_DECISION_CORRECTION_ATTEMPTS = 2;
const REACT_DECISION_SYSTEM_PROMPT =
  "你是一个 ReAct 决策引擎。请只返回 1 个有效 JSON 对象作为下一步决策，不要输出解释、Markdown 或代码围栏。 " +
  "kind 只能是 'act' 或 'finish'。如果 kind='act'，step 必填，并且必须包含全部必填字段：id、toolName、readOnly、idempotencyKey。 " +
  "如果 step.toolName='write_operation'，operation 必须包含全部必填字段：id、type、payload。对于可批量的语义写操作，优先输出 1 个带 targetSelector 的语义 step，由 runtime 展开成 targetNodeId 或 targetNodeIds；除非操作本身不可批量，否则不要自己拆分成逐节点 step。每个 write_operation 都必须能基于给定文档结构语义上真实执行。 " +
  "不要使用 'placeholder'、'unused'、'target' 之类的占位 id；样式修改类写操作不要输出空 payload。 " +
  "如果 kind='finish'，summary 必须是非空字符串。不要省略或写成 null。 " +
  "You are a ReAct decision engine. Return exactly one valid JSON object for the next decision, with no commentary, markdown, or code fences. " +
  "kind must be either 'act' or 'finish'. If kind='act', step is required and must include all required step fields: id, toolName, readOnly, idempotencyKey. " +
  "If step.toolName='write_operation', operation must include all required operation fields: id, type, payload. For batchable semantic writes, prefer one executable semantic step with targetSelector; the runtime can expand a semantic selector into targetNodeId or targetNodeIds. Do not split a batchable semantic write into per-node steps unless the operation itself is inherently non-batchable. Every write_operation must be semantically executable against the provided document structure. " +
  "Never use placeholder ids like 'placeholder', 'unused', or 'target'. Never emit an empty payload for style-changing writes. If kind='finish', summary must be a non-empty string. Do not omit or null any required field.";
const REACT_DECISION_CORRECTION_SYSTEM_PROMPT =
  "你正在修复一个先前无效的 ReAct 决策。请只返回 1 个修正后的 JSON 对象，不要解释修复过程，也不要返回 patch、diff 或 Markdown。 " +
  "修正后的对象必须严格满足所有必填字段和约束；在降级到 inspect_document 之前，应先尽量把 step 修成可执行的有效写操作。 " +
  "You are correcting a previously invalid ReAct decision. Return exactly one corrected JSON object. " +
  "Do not explain the fix. Do not return a patch, diff, or markdown. The corrected object must satisfy all required fields and constraints exactly. " +
  "Repair the step into a valid executable write before downgrading to inspect_document.";

interface ReActDecisionFailure {
  attempt: number;
  code: string;
  message: string;
  rawOutput: string;
}

export interface LlmReActPlannerDeps {
  config?: Partial<PlannerModelConfig>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export class LlmReActPlanner implements ReActPlanner {
  private readonly config: PlannerModelConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: LlmReActPlannerDeps = {}) {
    this.config = resolvePlannerModelConfig(deps.config, deps.env);
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async decideNext(input: ReActTurnInput): Promise<ReActDecision> {
    let prompt = buildPrompt(input);
    let systemPrompt = REACT_DECISION_SYSTEM_PROMPT;
    const failures: ReActDecisionFailure[] = [];

    for (let correctionAttempt = 0; correctionAttempt <= REACT_DECISION_CORRECTION_ATTEMPTS; correctionAttempt += 1) {
      const raw = await this.requestDecisionJson(prompt, systemPrompt, input.requestTimeoutMs);
      try {
        return parseAndValidateDecision(raw, input.doc);
      } catch (err) {
        const info = asAppError(err, "E_REACT_DECISION_INVALID");
        failures.push({
          attempt: correctionAttempt + 1,
          code: info.code,
          message: info.message,
          rawOutput: raw
        });
        if (!isRetryableReActDecisionError(info) || correctionAttempt >= REACT_DECISION_CORRECTION_ATTEMPTS) {
          throw finalizeReActDecisionFailure(info, failures);
        }
        prompt = buildCorrectionPrompt(input, failures, correctionAttempt + 1);
        systemPrompt = REACT_DECISION_CORRECTION_SYSTEM_PROMPT;
      }
    }

    throw new AgentError({
      code: "E_REACT_DECISION_INVALID",
      message: "ReAct decision correction loop exhausted unexpectedly.",
      retryable: false
    });
  }

  private async requestDecisionJson(
    prompt: string,
    systemPrompt = REACT_DECISION_SYSTEM_PROMPT,
    requestTimeoutMs?: number
  ): Promise<string> {
    return this.requestDecisionJsonWithMode(prompt, systemPrompt, {
      includeJsonSchema: this.config.useJsonSchema !== false,
      allowSchemaFallback: this.config.useJsonSchema !== false && this.config.compatMode !== "strict",
      requestTimeoutMs
    });
  }

  private async requestDecisionJsonWithMode(
    prompt: string,
    systemPrompt: string,
    options: { includeJsonSchema: boolean; allowSchemaFallback: boolean; requestTimeoutMs?: number }
  ): Promise<string> {
    const endpoint = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const maxRetries = this.config.maxRetries ?? 0;
    let missingContentRetries = 0;
    let lastErr: unknown;
    const timeoutControl = resolveRequestTimeoutControl(this.config.timeoutMs, options.requestTimeoutMs, {
      requestTimeoutCode: "E_REACT_PLANNER_REQUEST_TIMEOUT",
      requestTimeoutMessage: "ReAct planner request timed out",
      budgetTimeoutMessage: "Task budget exceeded while waiting for ReAct planner response."
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
          body: JSON.stringify(buildDecisionRequestBody(this.config, prompt, systemPrompt, options.includeJsonSchema)),
          signal: controller.signal
        });
        const payload = await resp.text();
        if (!resp.ok) {
          if (options.includeJsonSchema && isSchemaUnsupported(resp.status, payload)) {
            if (options.allowSchemaFallback) {
              try {
                return await this.requestDecisionJsonWithMode(prompt, systemPrompt, {
                  includeJsonSchema: false,
                  allowSchemaFallback: false,
                  requestTimeoutMs: options.requestTimeoutMs
                });
              } catch (fallbackErr) {
                throw new AgentError({
                  code: "E_REACT_PLANNER_SCHEMA_FALLBACK_FAILED",
                  message:
                    `ReAct planner detected response_format json_schema incompatibility (${resp.status}) ` +
                    `and attempted fallback without response_format, but the fallback request failed: ` +
                    `${asAppError(fallbackErr, "E_REACT_PLANNER_UPSTREAM").message}`,
                  retryable: false,
                  cause: fallbackErr
                });
              }
            }
            throw new AgentError({
              code: "E_REACT_PLANNER_SCHEMA_UNSUPPORTED",
              message: `ReAct planner upstream does not support response_format json_schema (${resp.status}).`,
              retryable: false
            });
          }
          throw new AgentError({
            code: "E_REACT_PLANNER_UPSTREAM",
            message: `ReAct planner request failed (${resp.status}): ${payload.slice(0, 200)}`,
            retryable: resp.status >= 500
          });
        }
        const result = parseDecisionContent(payload);
        if (result.content !== null) {
          return result.content;
        }
        if (missingContentRetries < 1 && shouldRetryMissingModelContent(result)) {
          missingContentRetries += 1;
          await sleep(150);
          attempt -= 1;
          continue;
        }
        throw new AgentError({
          code: "E_REACT_PLANNER_MODEL_RESPONSE",
          message: buildModelResponseErrorMessage("ReAct planner payload", result),
          retryable: false
        });
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
        const appErr = asAppError(err, "E_REACT_PLANNER_REQUEST");
        const retryable = appErr.retryable || isNetworkError(err);
        if (!retryable || attempt === maxRetries) break;
        await sleep(150 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw asCompatibleModelRequestError(
      lastErr ?? new Error("Unknown ReAct planner request failure"),
      "E_REACT_PLANNER_REQUEST",
      options.includeJsonSchema ? "ReAct planner request" : "ReAct planner fallback request without response_format"
    );
  }
}

function buildDecisionRequestBody(
  config: PlannerModelConfig,
  prompt: string,
  systemPrompt: string,
  includeJsonSchema: boolean
): Record<string, unknown> {
  return {
    model: config.model,
    temperature: config.temperature ?? 0,
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      { role: "user", content: prompt }
    ],
    ...(includeJsonSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "react_decision",
              strict: config.schemaStrict !== false,
              schema: buildDecisionJsonSchema()
            }
          }
        }
      : {}),
    stream: false
  };
}

function buildPrompt(input: ReActTurnInput): string {
  const selectorGuidance = buildSemanticSelectorGuidance();
  return JSON.stringify(
    {
      instruction:
        "请决定下一步单个 ReAct 动作，只返回一个 JSON 对象：要么输出 kind='act' 并附带完整 step 对象，要么输出 kind='finish' 并附带非空 summary。 " +
        "Decide the next single ReAct step. Return a single JSON object: either kind='act' with one complete step object, or kind='finish' with a non-empty summary.",
      constraints: {
        allowedOperationTypes: Array.from(OPERATION_TYPES),
        requiredStepFields: Array.from(REACT_REQUIRED_STEP_FIELDS),
        requiredOperationFields: Array.from(REACT_REQUIRED_OPERATION_FIELDS),
        availableSelectorScopes: ["body", "heading", "list_item", "all_text", "paragraph_ids"],
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
          set_page_layout: {
            paper_size: "A4 | Letter",
            margin_top_cm: "positive number",
            margin_bottom_cm: "positive number",
            margin_left_cm: "positive number",
            margin_right_cm: "positive number"
          },
          set_paragraph_spacing: { before_pt: "number >= 0", after_pt: "number >= 0" },
          set_paragraph_indent: { first_line_indent_pt: "number >= 0" },
          merge_paragraph: {},
          split_paragraph: { split_offset: "positive integer" }
        },
        actRules: [
          "If kind='act', step is required.",
          "step.id must be a non-empty string.",
          "step.toolName must be a non-empty string.",
          "step.readOnly must be boolean.",
          "step.idempotencyKey must be a non-empty string.",
          "Do not omit or null any required step field."
        ],
        operationRules: [
          "If step.toolName='write_operation', step.operation is required.",
          "If step.toolName='write_operation', operation.id and operation.type are required.",
          "operation.id must be a non-empty string.",
          "operation.type must be one of allowedOperationTypes.",
          "operation must include targetNodeId or targetSelector except set_page_layout.",
          "operation.targetNodeId must exactly match an existing document node id when present.",
          "operation.targetSelector.scope must be one of availableSelectorScopes when present.",
          "prefer one executable semantic step for batchable semantic writes",
          "runtime expands matched selectors into targetNodeId or targetNodeIds",
          "operation.payload must be a JSON object.",
          "set_page_layout is document-level and must not invent a node target.",
          "every write_operation must be semantically executable against the provided document structure",
          "never use placeholder ids like 'placeholder', 'unused', or 'target'",
          "never emit an empty payload for style-changing writes",
          "targetNodeId or targetSelector must bind to a real document range",
          "repair the step into a valid executable write before downgrading to inspect_document"
        ],
        selectorRules: selectorGuidance.selectorRules,
        selectorExamples: selectorGuidance.selectorExamples,
        finishRules: [
          "If kind='finish', summary is required and must be non-empty.",
          "If kind='finish', do not emit a step object."
        ],
        strictJsonOnly: true
      },
      input: buildPromptContext(input, { maxNodes: 20, maxHistory: 8, maxSessionMessages: 12 })
    },
    null,
    2
  );
}

function buildCorrectionPrompt(
  input: ReActTurnInput,
  failures: ReActDecisionFailure[],
  correctionAttempt: number
): string {
  const includeExtendedContext = correctionAttempt >= 2;
  const selectorGuidance = buildSemanticSelectorGuidance();
  return JSON.stringify(
    {
      instruction:
        "上一次 ReAct 决策无效。请只返回 1 个修正后的 JSON 对象，完整替换之前的无效输出。 " +
        "The previous ReAct decision was invalid. Return exactly one corrected JSON object that fully replaces the invalid output.",
      constraints: {
        requiredStepFields: Array.from(REACT_REQUIRED_STEP_FIELDS),
        requiredOperationFields: Array.from(REACT_REQUIRED_OPERATION_FIELDS),
        availableSelectorScopes: ["body", "heading", "list_item", "all_text", "paragraph_ids"],
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
          set_page_layout: {
            paper_size: "A4 | Letter",
            margin_top_cm: "positive number",
            margin_bottom_cm: "positive number",
            margin_left_cm: "positive number",
            margin_right_cm: "positive number"
          },
          set_paragraph_spacing: { before_pt: "number >= 0", after_pt: "number >= 0" },
          set_paragraph_indent: { first_line_indent_pt: "number >= 0" },
          merge_paragraph: {},
          split_paragraph: { split_offset: "positive integer" }
        },
        correctionRules: [
          "请只返回 1 个修正后的 JSON 对象。",
          "Return exactly one corrected JSON object.",
          "Do not repeat the previous mistake.",
          "Do not omit or null any required field.",
          "If kind='finish', include a non-empty summary.",
          "If kind='act', include a complete step object.",
          "Use targetSelector for semantic batch scopes like body or headings.",
          "Prefer one executable semantic step for batchable semantic writes.",
          "Runtime expands matched selectors into targetNodeId or targetNodeIds.",
          "Repair the step into a valid executable write before downgrading to inspect_document.",
          "Never use placeholder ids like 'placeholder', 'unused', or 'target'.",
          "Never emit an empty payload for style-changing writes."
        ],
        selectorRules: selectorGuidance.selectorRules,
        selectorExamples: selectorGuidance.selectorExamples
      },
      input: buildPromptContext(input, {
        maxNodes: includeExtendedContext ? 40 : 20,
        maxHistory: includeExtendedContext ? input.history.length : 8,
        maxSessionMessages: includeExtendedContext ? input.sessionContext?.length ?? 0 : 12
      }),
      correction_history: failures.map((failure) => ({
        attempt: failure.attempt,
        error_code: failure.code,
        error_message: failure.message,
        previous_model_output: failure.rawOutput
      }))
    },
    null,
    2
  );
}

function buildDecisionJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: {
      kind: { type: "string", enum: ["act", "finish"] },
      thought: { type: "string" },
      summary: { type: "string" },
      step: {
        type: "object",
        additionalProperties: false,
        required: ["id", "toolName", "readOnly", "idempotencyKey"],
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
  };
}

function buildPromptContext(
  input: ReActTurnInput,
  limits: { maxNodes: number; maxHistory: number; maxSessionMessages: number }
): Record<string, unknown> {
  const docSample = input.doc.nodes.slice(0, limits.maxNodes).map((n) => ({
    id: n.id,
    text: n.text,
    style: n.style ?? {}
  }));
  const recentHistory =
    limits.maxHistory > 0
      ? input.history.slice(-limits.maxHistory).map((item) => ({
          turnIndex: item.turnIndex,
          thought: item.thought ?? "",
          action: item.action
            ? {
                id: item.action.id,
                toolName: item.action.toolName,
                readOnly: item.action.readOnly,
                idempotencyKey: item.action.idempotencyKey,
                operation: item.action.operation
              }
            : null,
          observation: item.observation,
          status: item.status
        }))
      : [];
  const sessionContext =
    limits.maxSessionMessages > 0
      ? (input.sessionContext ?? []).slice(-limits.maxSessionMessages).map((message) => ({
          role: message.role,
          content: message.content
        }))
      : [];

  return {
    taskId: input.taskId,
    goal: input.goal,
    turnIndex: input.turnIndex,
    document: {
      id: input.doc.id,
      version: input.doc.version,
      metadata: sanitizePromptMetadata(input.doc.metadata),
      structure: summarizeStructureForPrompt(input.doc),
      nodes: docSample
    },
    sessionContext,
    history: recentHistory
  };
}

function parseDecisionContent(rawText: string) {
  try {
    return parseOpenAiCompatibleChatText(rawText);
  } catch (err) {
    throw new AgentError({
      code: "E_REACT_PLANNER_MODEL_RESPONSE",
      message: `ReAct planner upstream returned non-JSON envelope: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }
}

function parseAndValidateDecision(content: string, doc?: DocumentIR): ReActDecision {
  const targetContext = buildTargetContext(doc);
  let candidate: unknown;
  try {
    candidate = JSON.parse(content);
  } catch (err) {
    throw new AgentError({
      code: "E_REACT_DECISION_PARSE",
      message: `ReAct planner returned invalid JSON decision: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }

  if (!candidate || typeof candidate !== "object") {
    throw new AgentError({
      code: "E_REACT_DECISION_INVALID",
      message: "ReAct decision must be a JSON object.",
      retryable: false
    });
  }
  const raw = candidate as {
    kind?: unknown;
    thought?: unknown;
    summary?: unknown;
    step?: unknown;
  };
  if (raw.kind !== "act" && raw.kind !== "finish") {
    throw new AgentError({
      code: "E_REACT_DECISION_INVALID",
      message: "ReAct decision kind must be 'act' or 'finish'.",
      retryable: false
    });
  }

  const thought = typeof raw.thought === "string" ? raw.thought.trim() : undefined;
  if (raw.kind === "finish") {
    const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
    if (!summary) {
      throw new AgentError({
        code: "E_REACT_DECISION_INVALID",
        message: "ReAct finish decision requires non-empty summary.",
        retryable: false
      });
    }
    return {
      kind: "finish",
      thought,
      summary
    };
  }

  return {
    kind: "act",
    thought,
    step: parseStep(raw.step, targetContext)
  };
}

function parseStep(step: unknown, targetContext?: TargetContext): PlanStep {
  if (!step || typeof step !== "object") {
    throw new AgentError({
      code: "E_REACT_DECISION_INVALID",
      message: "ReAct act decision requires a step object.",
      retryable: false
    });
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
  const stepId = pickNonEmptyStringValue(raw.id, raw.stepId);
  if (!stepId) throw invalidStep("id is required");
  const toolName = pickNonEmptyStringValue(raw.toolName, raw.tool_name, raw.tool);
  if (!toolName) throw invalidStep("toolName is required");
  const readOnly = normalizeLooseBoolean(raw.readOnly, raw.read_only);
  if (typeof readOnly !== "boolean") throw invalidStep("readOnly must be boolean");
  const idempotencyKey = pickNonEmptyStringValue(raw.idempotencyKey, raw.idempotency_key);
  if (!idempotencyKey) throw invalidStep("idempotencyKey is required");
  const timeoutMs = normalizeLooseNumber(raw.timeoutMs, raw.timeout_ms);
  if ((raw.timeoutMs !== undefined || raw.timeout_ms !== undefined) && !isNonNegativeNumber(timeoutMs)) {
    throw invalidStep("timeoutMs must be a non-negative number");
  }
  const retryLimit = normalizeLooseNumber(raw.retryLimit, raw.retry_limit);
  if ((raw.retryLimit !== undefined || raw.retry_limit !== undefined) && !isNonNegativeNumber(retryLimit)) {
    throw invalidStep("retryLimit must be a non-negative number");
  }
  if (toolName === "write_operation" && raw.operation === undefined) {
    throw invalidStep("write_operation requires operation");
  }

  return {
    id: stepId,
    toolName,
    readOnly,
    idempotencyKey,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(retryLimit !== undefined ? { retryLimit } : {}),
    ...(raw.operation !== undefined ? { operation: parseOperation(raw.operation, targetContext) } : {})
  };
}

function parseOperation(op: unknown, targetContext?: TargetContext): Operation {
  if (!op || typeof op !== "object") {
    throw invalidStep("operation must be an object");
  }
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
  const operationId = pickNonEmptyStringValue(raw.id, raw.operationId, raw.operation_id);
  if (!operationId) throw invalidStep("operation.id is required");
  if (!isObject(raw.payload)) throw invalidStep("operation.payload must be an object");
  const operationType = normalizeOperationType(raw.type);
  if (!operationType) {
    throw invalidStep("operation.type is invalid");
  }
  const targetNodeId = pickNonEmptyStringValue(raw.targetNodeId, raw.target_node_id);
  const targetNodeIds = normalizeTargetNodeIds(raw.targetNodeIds, raw.target_node_ids);
  const selectorInput = firstDefined(raw.targetSelector, raw.target_selector, raw.selector);
  const targetSelector = selectorInput === undefined ? undefined : parseTargetSelector(selectorInput);
  if (operationType !== "set_page_layout" && !targetNodeId && !targetNodeIds?.length && !targetSelector) {
    throw invalidStep("operation.targetNodeId or operation.targetSelector is required");
  }
  if (targetNodeId && isPlaceholderTargetId(targetNodeId)) {
    throw invalidStep(`operation.targetNodeId must not use placeholder ids like '${targetNodeId}'`);
  }
  if (targetNodeId && targetContext && !targetContext.nodeIds.has(targetNodeId)) {
    throw invalidStep(`operation.targetNodeId must match an existing document node id: ${targetNodeId}`);
  }
  if (targetNodeIds?.length) {
    for (const concreteTargetId of targetNodeIds) {
      if (isPlaceholderTargetId(concreteTargetId)) {
        throw invalidStep(`operation.targetNodeIds must not use placeholder ids like '${concreteTargetId}'`);
      }
      if (targetContext && !targetContext.nodeIds.has(concreteTargetId)) {
        throw invalidStep(`operation.targetNodeIds must match existing document node ids: ${concreteTargetId}`);
      }
    }
  }
  validateExecutableTarget(operationType, targetSelector, targetContext);
  const payload = normalizeCompatiblePayload(operationType, raw.payload);
  return {
    id: operationId,
    type: operationType,
    ...(targetNodeId ? { targetNodeId } : {}),
    ...(targetNodeIds?.length ? { targetNodeIds } : {}),
    ...(targetSelector ? { targetSelector } : {}),
    payload
  };
}

function parseTargetSelector(value: unknown): NodeSelector {
  if (!isObject(value)) {
    throw invalidStep("operation.targetSelector must be an object");
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
    throw invalidStep("operation.targetSelector.scope is required");
  }
  const headingLevel = normalizeLooseNumber(raw.headingLevel, raw.heading_level);
  if ((raw.headingLevel !== undefined || raw.heading_level !== undefined) && !isNonNegativeNumber(headingLevel)) {
    throw invalidStep("operation.targetSelector.headingLevel must be a non-negative number");
  }
  const paragraphIds = normalizeParagraphIds(raw.paragraphIds, raw.paragraph_ids);
  if ((raw.paragraphIds !== undefined || raw.paragraph_ids !== undefined) && !paragraphIds?.length) {
    if (scope !== "paragraph_ids") {
      throw invalidStep("operation.targetSelector.paragraphIds must be a string array");
    }
  }
  if (scope === "paragraph_ids" && !paragraphIds?.length) {
    throw invalidStep("operation.targetSelector.paragraphIds is required for paragraph_ids scope");
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
      throw invalidStep(`operation.targetSelector.paragraphIds must match existing paragraph ids: ${missing}`);
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
      `operation.targetSelector.scope='${selector.scope}' does not bind to any real document range for ${operationType}`
    );
  }
}

function normalizeCompatiblePayload(
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
    validateExecutablePayload(operationType, payload);
    return payload;
  }
}

function validateExecutablePayload(operationType: OperationType, payload: unknown): void {
  if (!isObject(payload)) {
    throw invalidStep("operation.payload must be an object");
  }
  if (operationType === "merge_paragraph") {
    if (Object.keys(payload).length > 0) {
      throw invalidStep("merge_paragraph payload must be empty");
    }
    return;
  }
  if (operationType === "set_font" && !hasNonEmptyString(payload, ["font_name", "fontName"])) {
    throw invalidStep("set_font payload must include font_name");
  }
  if (
    operationType === "set_size" &&
    !hasPositiveNumber(payload, ["font_size_pt", "fontSizePt", "fontSize"])
  ) {
    throw invalidStep("set_size payload must include font_size_pt");
  }
  if (operationType === "set_line_spacing" && !hasValidLineSpacing(payload)) {
    throw invalidStep(
      "set_line_spacing payload must include line_spacing as a positive number or { mode: 'exact', pt: positive number }"
    );
  }
  if (operationType === "set_alignment" && !hasNonEmptyString(payload, ["paragraph_alignment", "alignment"])) {
    throw invalidStep("set_alignment payload must include paragraph_alignment");
  }
  if (operationType === "set_font_color" && !hasNonEmptyString(payload, ["font_color", "fontColor"])) {
    throw invalidStep("set_font_color payload must include font_color");
  }
  if (operationType === "set_highlight_color" && !hasNonEmptyString(payload, ["highlight_color", "highlightColor"])) {
    throw invalidStep("set_highlight_color payload must include highlight_color");
  }
  if (operationType === "split_paragraph" && !hasPositiveNumber(payload, ["split_offset", "splitOffset"])) {
    throw invalidStep("split_paragraph payload must include split_offset");
  }
  if (operationType === "set_bold" && !hasBoolean(payload, ["is_bold", "isBold"])) {
    throw invalidStep("set_bold payload must include is_bold");
  }
  if (operationType === "set_italic" && !hasBoolean(payload, ["is_italic", "isItalic"])) {
    throw invalidStep("set_italic payload must include is_italic");
  }
  if (operationType === "set_underline" && !hasBoolean(payload, ["is_underline", "isUnderline"])) {
    throw invalidStep("set_underline payload must include is_underline");
  }
  if (operationType === "set_strike" && !hasBoolean(payload, ["is_strike", "isStrike"])) {
    throw invalidStep("set_strike payload must include is_strike");
  }
  if (operationType === "set_all_caps" && !hasBoolean(payload, ["is_all_caps", "isAllCaps"])) {
    throw invalidStep("set_all_caps payload must include is_all_caps");
  }
  if (
    operationType === "set_page_layout" &&
    !hasNonEmptyString(payload, ["paper_size", "paperSize"]) &&
    !hasPositiveNumber(payload, ["margin_top_cm", "marginTopCm"]) &&
    !hasPositiveNumber(payload, ["margin_bottom_cm", "marginBottomCm"]) &&
    !hasPositiveNumber(payload, ["margin_left_cm", "marginLeftCm"]) &&
    !hasPositiveNumber(payload, ["margin_right_cm", "marginRightCm"])
  ) {
    throw invalidStep("set_page_layout payload must include paper_size or margin_*_cm");
  }
  if (
    operationType === "set_paragraph_spacing" &&
    !hasPositiveNumber(payload, ["before_pt", "beforePt", "space_before_pt", "spaceBeforePt"]) &&
    !hasPositiveNumber(payload, ["after_pt", "afterPt", "space_after_pt", "spaceAfterPt"])
  ) {
    throw invalidStep("set_paragraph_spacing payload must include before_pt or after_pt");
  }
  if (
    operationType === "set_paragraph_indent" &&
    !hasNonNegativeNumber(payload, ["first_line_indent_pt", "firstLineIndentPt"]) &&
    !hasPositiveNumber(payload, ["first_line_indent_chars", "firstLineIndentChars"])
  ) {
    throw invalidStep("set_paragraph_indent payload must include first_line_indent_pt");
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
  if (operationType === "set_page_layout") {
    return (
      hasNonEmptyString(payload, ["paper_size", "paperSize"]) ||
      hasPositiveNumber(payload, ["margin_top_cm", "marginTopCm"]) ||
      hasPositiveNumber(payload, ["margin_bottom_cm", "marginBottomCm"]) ||
      hasPositiveNumber(payload, ["margin_left_cm", "marginLeftCm"]) ||
      hasPositiveNumber(payload, ["margin_right_cm", "marginRightCm"])
    );
  }
  if (operationType === "set_paragraph_spacing") {
    return (
      hasPositiveNumber(payload, ["before_pt", "beforePt", "space_before_pt", "spaceBeforePt"]) ||
      hasPositiveNumber(payload, ["after_pt", "afterPt", "space_after_pt", "spaceAfterPt"])
    );
  }
  if (operationType === "set_paragraph_indent") {
    return (
      hasNonNegativeNumber(payload, ["first_line_indent_pt", "firstLineIndentPt"]) ||
      hasPositiveNumber(payload, ["first_line_indent_chars", "firstLineIndentChars"])
    );
  }
  return false;
}

function hasNonEmptyString(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => isNonEmptyString(payload[key]));
}

function hasPositiveNumber(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => isNonNegativeNumber(payload[key]) && Number(payload[key]) > 0);
}

function hasNonNegativeNumber(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => isNonNegativeNumber(payload[key]));
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

function summarizeStructureForPrompt(doc: DocumentIR): Record<string, unknown> {
  return summarizeStructureForPromptContext(doc);
}

function invalidStep(message: string): AgentError {
  return new AgentError({
    code: "E_REACT_DECISION_INVALID",
    message: `Invalid ReAct step: ${message}`,
    retryable: false
  });
}

function isRetryableReActDecisionError(err: { code?: string }): boolean {
  return err.code === "E_REACT_DECISION_PARSE" || err.code === "E_REACT_DECISION_INVALID";
}

function finalizeReActDecisionFailure(
  info: { code: string; message: string; cause?: unknown },
  failures: ReActDecisionFailure[]
): AgentError {
  if (!isRetryableReActDecisionError(info)) {
    return new AgentError({
      code: info.code,
      message: info.message,
      retryable: false,
      cause: info.cause
    });
  }
  return new AgentError({
    code: info.code,
    message: `ReAct decision remained invalid after ${REACT_DECISION_CORRECTION_ATTEMPTS} correction attempt(s): ${info.message}`,
    retryable: false,
    cause: failures.at(-1)
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
