import { AgentError, asAppError } from "../core/errors.js";
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

const OPERATION_TYPES: ReadonlySet<OperationType> = new Set([
  "set_font",
  "set_size",
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
const REACT_REQUIRED_STEP_FIELDS = ["id", "toolName", "readOnly", "idempotencyKey"] as const;
const REACT_REQUIRED_OPERATION_FIELDS = ["id", "type", "payload"] as const;
const REACT_DECISION_CORRECTION_ATTEMPTS = 2;
const REACT_DECISION_SYSTEM_PROMPT =
  "You are a ReAct decision engine. Return ONLY one valid JSON object for the next decision. " +
  "kind must be either 'act' or 'finish'. " +
  "If kind='act', step is required and must include all required step fields: id, toolName, readOnly, idempotencyKey. " +
  "If step.toolName='write_operation', operation must include all required operation fields: id, type, payload. " +
  "Every write_operation must be semantically executable against the provided document structure. " +
  "Never use placeholder ids like 'placeholder', 'unused', or 'target'. Never emit an empty payload for style-changing writes. " +
  "If kind='finish', summary must be a non-empty string. " +
  "Do not omit or null any required field. Do not add commentary, markdown, or code fences.";
const REACT_DECISION_CORRECTION_SYSTEM_PROMPT =
  "You are correcting a previously invalid ReAct decision. Return ONLY one corrected JSON object. " +
  "Do not explain the fix. Do not return a patch, diff, or markdown. " +
  "The corrected object must satisfy all required fields and constraints exactly. " +
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
      const raw = await this.requestDecisionJson(prompt, systemPrompt);
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

  private async requestDecisionJson(prompt: string, systemPrompt = REACT_DECISION_SYSTEM_PROMPT): Promise<string> {
    return this.requestDecisionJsonWithMode(prompt, systemPrompt, {
      includeJsonSchema: this.config.useJsonSchema !== false,
      allowSchemaFallback: this.config.useJsonSchema !== false && this.config.compatMode !== "strict"
    });
  }

  private async requestDecisionJsonWithMode(
    prompt: string,
    systemPrompt: string,
    options: { includeJsonSchema: boolean; allowSchemaFallback: boolean }
  ): Promise<string> {
    const endpoint = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const maxRetries = this.config.maxRetries ?? 0;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30000);
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
                  allowSchemaFallback: false
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
        return extractContent(payload);
      } catch (err) {
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
        "Decide the next single ReAct step. Return kind='act' with one complete step object, or kind='finish' with a non-empty summary.",
      constraints: {
        allowedOperationTypes: Array.from(OPERATION_TYPES),
        requiredStepFields: Array.from(REACT_REQUIRED_STEP_FIELDS),
        requiredOperationFields: Array.from(REACT_REQUIRED_OPERATION_FIELDS),
        availableSelectorScopes: ["body", "heading", "list_item", "all_text", "paragraph_ids"],
        operationPayloadSchemas: {
          set_font: { font_name: "string" },
          set_size: { font_size_pt: "number (pt)" },
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
          "operation must include targetNodeId or targetSelector.",
          "operation.targetNodeId must exactly match an existing document node id when present.",
          "operation.targetSelector.scope must be one of availableSelectorScopes when present.",
          "operation.payload must be a JSON object.",
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
        "The previous ReAct decision was invalid. Return ONLY one corrected JSON object that fully replaces the invalid output.",
      constraints: {
        requiredStepFields: Array.from(REACT_REQUIRED_STEP_FIELDS),
        requiredOperationFields: Array.from(REACT_REQUIRED_OPERATION_FIELDS),
        availableSelectorScopes: ["body", "heading", "list_item", "all_text", "paragraph_ids"],
        operationPayloadSchemas: {
          set_font: { font_name: "string" },
          set_size: { font_size_pt: "number (pt)" },
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
        correctionRules: [
          "Return ONLY one corrected JSON object.",
          "Do not repeat the previous mistake.",
          "Do not omit or null any required field.",
          "If kind='finish', include a non-empty summary.",
          "If kind='act', include a complete step object.",
          "Use targetSelector for semantic batch scopes like body or headings.",
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

function extractContent(rawText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new AgentError({
      code: "E_REACT_PLANNER_MODEL_RESPONSE",
      message: `ReAct planner upstream returned non-JSON envelope: ${String(err)}`,
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
      code: "E_REACT_PLANNER_MODEL_RESPONSE",
      message: "ReAct planner payload is missing choices[].",
      retryable: false
    });
  }

  const firstChoice = (parsed as { choices: Array<{ message?: { content?: unknown } }> }).choices[0];
  const content = firstChoice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new AgentError({
      code: "E_REACT_PLANNER_MODEL_RESPONSE",
      message: "ReAct planner payload has empty message content.",
      retryable: false
    });
  }
  return content.trim();
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
    toolName?: unknown;
    readOnly?: unknown;
    timeoutMs?: unknown;
    retryLimit?: unknown;
    idempotencyKey?: unknown;
    operation?: unknown;
  };
  if (!isNonEmptyString(raw.id)) throw invalidStep("id is required");
  if (!isNonEmptyString(raw.toolName)) throw invalidStep("toolName is required");
  if (typeof raw.readOnly !== "boolean") throw invalidStep("readOnly must be boolean");
  if (!isNonEmptyString(raw.idempotencyKey)) throw invalidStep("idempotencyKey is required");
  if (raw.timeoutMs !== undefined && !isNonNegativeNumber(raw.timeoutMs)) {
    throw invalidStep("timeoutMs must be a non-negative number");
  }
  if (raw.retryLimit !== undefined && !isNonNegativeNumber(raw.retryLimit)) {
    throw invalidStep("retryLimit must be a non-negative number");
  }
  if (raw.toolName === "write_operation" && raw.operation === undefined) {
    throw invalidStep("write_operation requires operation");
  }

  return {
    id: raw.id,
    toolName: raw.toolName,
    readOnly: raw.readOnly,
    timeoutMs: raw.timeoutMs as number | undefined,
    retryLimit: raw.retryLimit as number | undefined,
    idempotencyKey: raw.idempotencyKey,
    operation: raw.operation === undefined ? undefined : parseOperation(raw.operation, targetContext)
  };
}

function parseOperation(op: unknown, targetContext?: TargetContext): Operation {
  if (!op || typeof op !== "object") {
    throw invalidStep("operation must be an object");
  }
  const raw = op as {
    id?: unknown;
    type?: unknown;
    targetNodeId?: unknown;
    targetSelector?: unknown;
    payload?: unknown;
  };
  if (!isNonEmptyString(raw.id)) throw invalidStep("operation.id is required");
  if (!isObject(raw.payload)) throw invalidStep("operation.payload must be an object");
  if (!isNonEmptyString(raw.type) || !OPERATION_TYPES.has(raw.type as OperationType)) {
    throw invalidStep("operation.type is invalid");
  }
  const targetNodeId = isNonEmptyString(raw.targetNodeId) ? raw.targetNodeId.trim() : undefined;
  const targetSelector = raw.targetSelector === undefined ? undefined : parseTargetSelector(raw.targetSelector);
  if (!targetNodeId && !targetSelector) {
    throw invalidStep("operation.targetNodeId or operation.targetSelector is required");
  }
  if (targetNodeId && isPlaceholderTargetId(targetNodeId)) {
    throw invalidStep(`operation.targetNodeId must not use placeholder ids like '${targetNodeId}'`);
  }
  if (targetNodeId && targetContext && !targetContext.nodeIds.has(targetNodeId)) {
    throw invalidStep(`operation.targetNodeId must match an existing document node id: ${targetNodeId}`);
  }
  validateExecutableTarget(raw.type as OperationType, targetSelector, targetContext);
  validateExecutablePayload(raw.type as OperationType, raw.payload);
  return {
    id: raw.id,
    type: raw.type as OperationType,
    targetNodeId,
    targetSelector,
    payload: raw.payload as Record<string, unknown>
  };
}

function parseTargetSelector(value: unknown): NodeSelector {
  if (!isObject(value)) {
    throw invalidStep("operation.targetSelector must be an object");
  }
  const raw = value as {
    scope?: unknown;
    headingLevel?: unknown;
    paragraphIds?: unknown;
  };
  if (!isNonEmptyString(raw.scope)) {
    throw invalidStep("operation.targetSelector.scope is required");
  }
  const scope = raw.scope.trim() as NodeSelector["scope"];
  if (!["body", "heading", "list_item", "all_text", "paragraph_ids"].includes(scope)) {
    throw invalidStep("operation.targetSelector.scope is invalid");
  }
  if (raw.headingLevel !== undefined && !isNonNegativeNumber(raw.headingLevel)) {
    throw invalidStep("operation.targetSelector.headingLevel must be a non-negative number");
  }
  if (raw.paragraphIds !== undefined) {
    if (!Array.isArray(raw.paragraphIds) || raw.paragraphIds.some((item) => !isNonEmptyString(item))) {
      throw invalidStep("operation.targetSelector.paragraphIds must be a string array");
    }
  }
  if (scope === "paragraph_ids" && (!Array.isArray(raw.paragraphIds) || raw.paragraphIds.length === 0)) {
    throw invalidStep("operation.targetSelector.paragraphIds is required for paragraph_ids scope");
  }
  return {
    scope,
    headingLevel: raw.headingLevel as number | undefined,
    paragraphIds: raw.paragraphIds as string[] | undefined
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
}

function isPlaceholderTargetId(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ["placeholder", "unused", "target", "todo", "tbd"].includes(normalized);
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
