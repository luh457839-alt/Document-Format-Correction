import path from "node:path";
import { AgentError, asAppError } from "../core/errors.js";
import { getOutputDir } from "../core/project-paths.js";
import type { ConversationMessage, DocumentIR, ExecutionResult, NodeSelector, OperationType } from "../core/types.js";
import { createMvpRuntime, type AgentRuntime } from "./engine.js";
import {
  LlmAgentModelGateway,
  normalizeTurnDecision,
  type AgentModelGateway,
  type AgentTurnMode,
  type TurnDecision
} from "./model-gateway.js";
import {
  type AgentTurnRunSnapshot,
  type AgentTurnRunStatus,
  type AgentTurnRunStep,
  SqliteAgentStateStore,
  type AgentSessionListItem,
  type AgentSessionSnapshot
} from "./state/sqlite-agent-state-store.js";
import { buildStructureIndex, documentStateToNodes } from "./document-state.js";
import { observeDocxStateWithPython, type PythonDocxObservationState } from "../tools/python-tool-client.js";

export interface SubmitUserTurnInput {
  sessionId: string;
  userInput: string;
  forceMode?: AgentTurnMode;
}

export interface AgentSessionResponse {
  session: AgentSessionSnapshot;
  response: {
    mode: AgentTurnMode;
    goal: string;
    content: string;
    outputDocxPath?: string;
  };
}

export interface AgentSessionServiceDeps {
  store?: SqliteAgentStateStore;
  modelGateway?: AgentModelGateway;
  runtimeFactory?: () => Pick<AgentRuntime, "run">;
  observeDocument?: (docxPath: string) => Promise<PythonDocxObservationState>;
  outputRootDir?: string;
}

type DocumentRequirementMode = AgentTurnMode | "clarification";
interface ExecutionGoalNormalizationResult {
  decision: TurnDecision;
  bodyDefaultIncludesListItem: boolean;
}

interface ExecutionContentOptions {
  bodyDefaultIncludesListItem?: boolean;
}

const BODY_LIST_ITEM_DEFAULT_GOAL_CLAUSE = "其中“正文”默认包含普通正文和项目符号/编号段落";
const BODY_LIST_ITEM_DEFAULT_REPLY_NOTE = "说明：本次按默认规则同时修改了普通正文和 list_item。";

export class AgentSessionService {
  private readonly store: SqliteAgentStateStore;
  private readonly modelGateway?: AgentModelGateway;
  private readonly runtimeFactory?: () => Pick<AgentRuntime, "run">;
  private readonly observeDocument: (docxPath: string) => Promise<PythonDocxObservationState>;
  private readonly outputRootDir: string;

  constructor(deps: AgentSessionServiceDeps = {}) {
    this.store = deps.store ?? new SqliteAgentStateStore();
    this.modelGateway = deps.modelGateway;
    this.runtimeFactory = deps.runtimeFactory;
    this.observeDocument = deps.observeDocument ?? observeDocxStateWithPython;
    this.outputRootDir = deps.outputRootDir ?? getOutputDir();
  }

  async attachDocument(sessionId: string, docxPath: string): Promise<{ session: AgentSessionSnapshot }> {
    const normalizedSessionId = normalizeRequired(sessionId, "sessionId");
    const normalizedDocxPath = normalizeRequired(docxPath, "docxPath");
    const session = await this.store.attachDocument(normalizedSessionId, normalizedDocxPath);
    return { session };
  }

  async getSessionState(sessionId: string): Promise<AgentSessionSnapshot> {
    return await this.store.getSession(normalizeRequired(sessionId, "sessionId"));
  }

  async createSession(sessionId: string): Promise<{ session: AgentSessionSnapshot }> {
    const session = await this.store.createSession(normalizeRequired(sessionId, "sessionId"));
    return { session };
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<{ session: AgentSessionSnapshot }> {
    const session = await this.store.updateSessionTitle(
      normalizeRequired(sessionId, "sessionId"),
      normalizeRequired(title, "title")
    );
    return { session };
  }

  async deleteSession(sessionId: string): Promise<{ deletedSessionId: string }> {
    const normalizedSessionId = normalizeRequired(sessionId, "sessionId");
    await this.store.deleteSession(normalizedSessionId);
    return { deletedSessionId: normalizedSessionId };
  }

  async listSessions(): Promise<{ sessions: AgentSessionListItem[] }> {
    return { sessions: await this.store.listSessions() };
  }

  async getTurnRunStatus(input: {
    sessionId?: string;
    turnRunId?: string;
  }): Promise<{ turnRun: AgentTurnRunSnapshot | null }> {
    const turnRunId = input.turnRunId?.trim();
    if (turnRunId) {
      return { turnRun: (await this.store.getTurnRun(turnRunId)) ?? null };
    }
    const sessionId = normalizeRequired(input.sessionId ?? "", "sessionId");
    return { turnRun: (await this.store.getLatestTurnRun(sessionId)) ?? null };
  }

  async submitUserTurn(input: SubmitUserTurnInput): Promise<AgentSessionResponse> {
    const sessionId = normalizeRequired(input.sessionId, "sessionId");
    const userInput = normalizeRequired(input.userInput, "userInput");
    const modelGateway = this.modelGateway ?? new LlmAgentModelGateway();
    let tracker = await this.store.createTurnRun(sessionId, userInput, {
      status: "running",
      summary: "正在判定本轮处理模式",
      steps: [createTurnRunStep("decide_mode", "判定模式", "running")]
    });

    try {
      await this.store.appendTurn(sessionId, "user", userInput);
      const sessionBefore = await this.store.getSession(sessionId);
      const rawDecision = await modelGateway.decideTurn({
        session: sessionBefore,
        userInput,
        forceMode: input.forceMode
      });
      const normalizedDecision = normalizeDecisionForSession(rawDecision, sessionBefore);
      const { decision, bodyDefaultIncludesListItem } = normalizeExecutionGoal(normalizedDecision, userInput);

      tracker = await this.store.updateTurnRun(tracker.turnRunId, {
        mode: decision.mode,
        goal: decision.goal,
        summary: describeTurnDecision(decision),
        steps: upsertTurnRunStep(
          tracker.steps,
          createTurnRunStep("decide_mode", "判定模式", "completed", describeTurnDecision(decision))
        )
      });

      let content = "";
      let outputDocxPath: string | undefined;

      if (decision.needsClarification) {
        let observation;
        let steps = tracker.steps;
        if (decision.requiresDocument) {
          const document = requireAttachedDocument(sessionBefore, "clarification");
          steps = upsertTurnRunStep(steps, createTurnRunStep("read_document", "读取文档", "running"));
          tracker = await this.store.updateTurnRun(tracker.turnRunId, {
            summary: "正在读取文档结构以生成澄清问题",
            steps
          });
          observation = await this.observeDocument(document.path);
          steps = upsertTurnRunStep(
            steps,
            createTurnRunStep("read_document", "读取文档", "completed", "已完成文档结构读取")
          );
          tracker = await this.store.updateTurnRun(tracker.turnRunId, {
            summary: "正在生成澄清问题",
            steps
          });
        }
        tracker = await this.store.updateTurnRun(tracker.turnRunId, {
          summary: "正在生成澄清问题",
          steps: upsertTurnRunStep(
            tracker.steps,
            createTurnRunStep("generate_reply", "生成回复", "running")
          )
        });
        content = await modelGateway.respondToClarification({
          session: sessionBefore,
          goal: decision.goal,
          clarificationKind: decision.clarificationKind,
          clarificationReason: decision.clarificationReason,
          messages: toConversationMessages(sessionBefore),
          observation
        });
      } else if (decision.mode === "chat") {
        await this.store.saveGoal(sessionId, decision.goal, decision.mode, "active");
        tracker = await this.store.updateTurnRun(tracker.turnRunId, {
          summary: "正在生成回复",
          steps: upsertTurnRunStep(
            tracker.steps,
            createTurnRunStep("generate_reply", "生成回复", "running")
          )
        });
        content = await modelGateway.respondToConversation({
          session: sessionBefore,
          messages: toConversationMessages(sessionBefore)
        });
        await this.store.saveGoal(sessionId, decision.goal, decision.mode, "completed");
      } else if (decision.mode === "inspect") {
        await this.store.saveGoal(sessionId, decision.goal, decision.mode, "active");
        const document = requireAttachedDocument(sessionBefore, decision.mode);
        tracker = await this.store.updateTurnRun(tracker.turnRunId, {
          summary: "正在读取文档内容",
          steps: upsertTurnRunStep(
            tracker.steps,
            createTurnRunStep("read_document", "读取文档", "running")
          )
        });
        const observation = await this.observeDocument(document.path);
        tracker = await this.store.updateTurnRun(tracker.turnRunId, {
          summary: "正在生成观察结果",
          steps: upsertTurnRunStep(
            upsertTurnRunStep(
              tracker.steps,
              createTurnRunStep("read_document", "读取文档", "completed", "已完成文档结构读取")
            ),
            createTurnRunStep("generate_reply", "生成观察结果", "running")
          )
        });
        content = await modelGateway.respondToDocumentObservation({
          session: sessionBefore,
          goal: decision.goal,
          messages: toConversationMessages(sessionBefore),
          observation
        });
        await this.store.saveGoal(sessionId, decision.goal, decision.mode, "completed");
      } else {
        await this.store.saveGoal(sessionId, decision.goal, decision.mode, "active");
        const document = requireAttachedDocument(sessionBefore, decision.mode);
        const runtime = (this.runtimeFactory ?? (() => createMvpRuntime()))();
        tracker = await this.store.updateTurnRun(tracker.turnRunId, {
          summary: "正在读取文档内容",
          steps: upsertTurnRunStep(
            tracker.steps,
            createTurnRunStep("read_document", "读取文档", "running")
          )
        });
        const executionDoc = await buildExecutionDocument(
          sessionId,
          document.path,
          this.outputRootDir,
          this.observeDocument
        );
        const runtimeStepAggregationContext = createRuntimeStepAggregationContext(executionDoc);
        tracker = await this.store.updateTurnRun(tracker.turnRunId, {
          summary: "正在规划并执行步骤",
          steps: upsertTurnRunStep(
            upsertTurnRunStep(
              tracker.steps,
              createTurnRunStep("read_document", "读取文档", "completed", "已完成文档结构读取")
            ),
            createTurnRunStep("execute_runtime", "规划并执行步骤", "running")
          )
        });
        const runtimeResult = await runtime.run(decision.goal, executionDoc, {
          taskId: tracker.turnRunId,
          dryRun: false,
          sessionContext: toConversationMessages(sessionBefore),
          onExecutionEvent: async (event) => {
            tracker = await this.store.updateTurnRun(
              tracker.turnRunId,
              buildRuntimeTurnRunPatch(tracker, event, runtimeStepAggregationContext)
            );
          }
        });
        outputDocxPath = readOutputPath(runtimeResult);
        content = formatExecutionContent(runtimeResult, outputDocxPath, {
          bodyDefaultIncludesListItem
        });
        await this.store.saveGoal(
          sessionId,
          decision.goal,
          decision.mode,
          runtimeResult.status === "completed" ? "completed" : runtimeResult.status === "waiting_user" ? "active" : "failed"
        );
        tracker = await this.store.updateTurnRun(tracker.turnRunId, {
          status: mapExecutionStatus(runtimeResult.status),
          summary: describeExecutionSummary(runtimeResult),
          steps: upsertTurnRunStep(
            tracker.steps,
            createTurnRunStep(
              "execute_runtime",
              "规划并执行步骤",
              runtimeResult.status === "failed" || runtimeResult.status === "rolled_back" ? "failed" : "completed",
              runtimeResult.summary
            )
          )
        });
      }

      await this.store.appendTurn(sessionId, "assistant", content);
      const session = await this.store.getSession(sessionId);
      const finalizedSteps =
        decision.mode === "execute"
          ? tracker.steps
          : upsertTurnRunStep(
              tracker.steps,
              createTurnRunStep(
                "generate_reply",
                decision.mode === "inspect" ? "生成观察结果" : "生成回复",
                tracker.status === "waiting_user" ? "running" : "completed",
                tracker.status === "waiting_user" ? tracker.summary : "已完成回复生成"
              )
            );
      tracker = await this.store.updateTurnRun(tracker.turnRunId, {
        status: tracker.status === "failed" ? "failed" : tracker.status === "waiting_user" ? "waiting_user" : "completed",
        summary:
          tracker.status === "failed"
            ? tracker.summary
            : tracker.status === "waiting_user"
              ? tracker.summary
              : "本轮处理已完成",
        steps: finalizedSteps,
        completedAt: tracker.status === "waiting_user" ? undefined : Date.now()
      });
      return {
        session,
        response: {
          mode: decision.mode,
          goal: decision.goal,
          content,
          outputDocxPath
        }
      };
    } catch (err) {
      const error = asAppError(err, "E_TURN_FAILED");
      await this.store.updateTurnRun(tracker.turnRunId, {
        status: "failed",
        summary: error.message,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable
        },
        completedAt: Date.now(),
        steps: markLatestRunningStepFailed(tracker.steps, error.message)
      });
      throw err;
    }
  }
}

async function buildExecutionDocument(
  sessionId: string,
  inputDocxPath: string,
  outputRootDir: string,
  observeDocument: (docxPath: string) => Promise<PythonDocxObservationState>
): Promise<DocumentIR> {
  const observation = await observeDocument(inputDocxPath);
  const nodes = documentStateToNodes(observation);
  if (nodes.length === 0) {
    throw new AgentError({
      code: "E_DOCX_EMPTY",
      message: "Loaded input DOCX has no editable text nodes.",
      retryable: false
    });
  }

  return {
    id: `session_${sessionId}`,
    version: "v1",
    nodes,
    metadata: {
      inputDocxPath,
      outputDocxPath: path.join(outputRootDir, `${sessionId}.docx`),
      sourceDocumentMeta: observation.document_meta,
      structureIndex: buildStructureIndex(observation)
    }
  };
}

function toConversationMessages(session: AgentSessionSnapshot): ConversationMessage[] {
  return session.turns.map((turn) => ({
    role: turn.role,
    content: turn.content
  }));
}

function requireAttachedDocument(session: AgentSessionSnapshot, mode: DocumentRequirementMode) {
  if (session.attachedDocument?.path) {
    return session.attachedDocument;
  }
  throw new AgentError({
    code: "E_DOCUMENT_REQUIRED",
    message: `${mode} mode requires an attached document.`,
    retryable: false
  });
}

function readOutputPath(result: ExecutionResult): string | undefined {
  const metadata = result.finalDoc.metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const outputDocxPath = (metadata as Record<string, unknown>).outputDocxPath;
  return typeof outputDocxPath === "string" && outputDocxPath.trim() ? outputDocxPath.trim() : undefined;
}

function formatExecutionContent(
  result: ExecutionResult,
  outputDocxPath?: string,
  options: ExecutionContentOptions = {}
): string {
  const parts = [result.summary.trim()];
  if (outputDocxPath) {
    parts.push(`输出文件：${outputDocxPath}`);
  }
  if (result.status === "completed" && options.bodyDefaultIncludesListItem) {
    parts.push(BODY_LIST_ITEM_DEFAULT_REPLY_NOTE);
  }
  return parts.filter(Boolean).join("\n");
}

function createTurnRunStep(
  id: string,
  title: string,
  status: AgentTurnRunStep["status"],
  detail?: string
): AgentTurnRunStep {
  const now = Date.now();
  return {
    id,
    title,
    status,
    detail,
    startedAt: status === "queued" ? undefined : now,
    updatedAt: now
  };
}

function upsertTurnRunStep(steps: AgentTurnRunStep[], nextStep: AgentTurnRunStep): AgentTurnRunStep[] {
  const existingIndex = steps.findIndex((step) => step.id === nextStep.id);
  if (existingIndex < 0) {
    return [...steps, nextStep];
  }
  const existing = steps[existingIndex];
  const merged: AgentTurnRunStep = {
    ...existing,
    ...nextStep,
    startedAt: existing.startedAt ?? nextStep.startedAt
  };
  const next = [...steps];
  next.splice(existingIndex, 1, merged);
  return next;
}

function markLatestRunningStepFailed(steps: AgentTurnRunStep[], message: string): AgentTurnRunStep[] {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].status === "running") {
      return upsertTurnRunStep(
        steps,
        createTurnRunStep(steps[index].id, steps[index].title, "failed", message)
      );
    }
  }
  return steps;
}

function describeTurnDecision(decision: TurnDecision): string {
  if (decision.needsClarification) {
    return "需要先向用户确认范围后再继续";
  }
  if (decision.mode === "chat") {
    return "已判定为直接对话回复";
  }
  if (decision.mode === "inspect") {
    return "已判定为读取文档并生成观察结果";
  }
  return "已判定为执行文档修改";
}

function describeExecutionSummary(result: ExecutionResult): string {
  if (result.status === "waiting_user") {
    return "等待用户确认后继续执行";
  }
  if (result.status === "completed") {
    return "执行完成";
  }
  return result.summary;
}

function mapExecutionStatus(status: ExecutionResult["status"]): AgentTurnRunStatus {
  if (status === "waiting_user") {
    return "waiting_user";
  }
  if (status === "completed") {
    return "completed";
  }
  return "failed";
}

function buildRuntimeTurnRunPatch(
  tracker: AgentTurnRunSnapshot,
  event: {
    type: string;
    stepId?: string;
    status?: string;
    payload?: Record<string, unknown>;
  },
  context: RuntimeStepAggregationContext
): Partial<Omit<AgentTurnRunSnapshot, "turnRunId" | "sessionId" | "userInput" | "createdAt">> {
  if (event.type === "run_waiting_user") {
    return {
      status: "waiting_user",
      summary: "等待用户确认",
      steps: tracker.steps
    };
  }

  if (!event.stepId) {
    return {};
  }

  const detail = readRuntimeEventDetail(event.payload);
  const writeSummaryGroup = resolveWriteSummaryGroup(event, context);
  if (writeSummaryGroup) {
    return buildWriteSummaryPatch(tracker, event, writeSummaryGroup, detail);
  }

  const title =
    event.stepId === "execute_runtime"
      ? "规划并执行步骤"
      : `执行步骤 ${event.stepId}`;
  let stepStatus: AgentTurnRunStep["status"] = "running";
  if (event.type === "step_succeeded") {
    stepStatus = "completed";
  } else if (event.type === "step_failed") {
    stepStatus = "failed";
  }

  return {
    status: event.type === "step_failed" ? "failed" : tracker.status,
    summary:
      event.type === "step_failed"
        ? detail ?? "执行失败"
        : event.type === "step_started"
          ? `正在执行 ${title}`
          : tracker.summary,
    steps: upsertTurnRunStep(tracker.steps, createTurnRunStep(`runtime:${event.stepId}`, title, stepStatus, detail))
  };
}

interface RuntimeStepAggregationContext {
  roleByRunId: Map<string, string>;
}

interface WriteSummaryGroup {
  groupId: string;
  rangeLabel: string;
  propertyLabel: string;
}

function createRuntimeStepAggregationContext(doc: DocumentIR): RuntimeStepAggregationContext {
  const roleByRunId = new Map<string, string>();
  const structureIndex = doc.metadata?.structureIndex;
  if (!structureIndex || typeof structureIndex !== "object") {
    return { roleByRunId };
  }
  const paragraphs = (structureIndex as { paragraphs?: Array<{ role?: unknown; runNodeIds?: unknown }> }).paragraphs;
  if (!Array.isArray(paragraphs)) {
    return { roleByRunId };
  }
  for (const paragraph of paragraphs) {
    if (!paragraph || typeof paragraph !== "object") {
      continue;
    }
    const role = typeof paragraph.role === "string" ? paragraph.role : "";
    const runNodeIds = Array.isArray(paragraph.runNodeIds) ? paragraph.runNodeIds : [];
    if (!role) {
      continue;
    }
    for (const runNodeId of runNodeIds) {
      if (typeof runNodeId === "string" && runNodeId.trim()) {
        roleByRunId.set(runNodeId, role);
      }
    }
  }
  return { roleByRunId };
}

function readRuntimeEventDetail(payload?: Record<string, unknown>): string | undefined {
  if (typeof payload?.summary === "string") {
    return payload.summary;
  }
  if (typeof payload?.reason === "string") {
    return payload.reason;
  }
  if (typeof payload?.error === "object" && payload.error && "message" in payload.error) {
    return String((payload.error as { message?: unknown }).message ?? "");
  }
  return undefined;
}

function resolveWriteSummaryGroup(
  event: {
    stepId?: string;
    payload?: Record<string, unknown>;
  },
  context: RuntimeStepAggregationContext
): WriteSummaryGroup | null {
  if (event.payload?.toolName !== "write_operation") {
    return null;
  }

  const operationType = normalizeOperationType(event.payload?.operationType);
  if (!operationType) {
    return null;
  }

  const selectorScope =
    readTargetSelectorScope(event.payload?.targetSelector) ??
    inferScopeFromRunId(readRepresentativeTargetNodeId(event.payload), context) ??
    inferScopeFromStepId(event.stepId);
  if (!selectorScope) {
    return null;
  }

  const rangeLabel = describeScope(selectorScope);
  const propertyLabel = describeOperation(operationType);
  if (!rangeLabel || !propertyLabel) {
    return null;
  }

  return {
    groupId: `runtime:summary:${selectorScope}:${operationType}`,
    rangeLabel,
    propertyLabel
  };
}

function buildWriteSummaryPatch(
  tracker: AgentTurnRunSnapshot,
  event: {
    type: string;
    stepId?: string;
    payload?: Record<string, unknown>;
  },
  group: WriteSummaryGroup,
  detail?: string
): Partial<Omit<AgentTurnRunSnapshot, "turnRunId" | "sessionId" | "userInput" | "createdAt">> {
  const existing = tracker.steps.find((step) => step.id === group.groupId);
  const currentCount = parseWriteSummaryCount(existing?.title);
  const nextCount = event.type === "step_succeeded" ? currentCount + readWriteSummaryIncrement(event.payload) : currentCount;

  let status: AgentTurnRunStep["status"] = "running";
  if (event.type === "step_succeeded") {
    status = "completed";
  } else if (event.type === "step_failed") {
    status = "failed";
  }

  const title = buildWriteSummaryTitle(group, nextCount, status);
  const summaryText = `${group.rangeLabel}${group.propertyLabel}修改`;

  return {
    status: event.type === "step_failed" ? "failed" : tracker.status,
    summary:
      event.type === "step_failed"
        ? detail ?? `${summaryText}失败`
        : event.type === "step_started"
          ? `正在执行${summaryText}`
          : tracker.summary,
    steps: upsertTurnRunStep(
      tracker.steps,
      createTurnRunStep(group.groupId, title, status, event.type === "step_failed" ? detail : undefined)
    )
  };
}

function normalizeOperationType(value: unknown): OperationType | null {
  if (typeof value !== "string") {
    return null;
  }
  const candidates: OperationType[] = [
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
  ];
  return candidates.includes(value as OperationType) ? (value as OperationType) : null;
}

function readTargetSelectorScope(value: unknown): NodeSelector["scope"] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const scope = (value as Partial<NodeSelector>).scope;
  if (
    scope === "body" ||
    scope === "heading" ||
    scope === "list_item" ||
    scope === "all_text" ||
    scope === "paragraph_ids"
  ) {
    return scope;
  }
  return null;
}

function inferScopeFromRunId(value: unknown, context: RuntimeStepAggregationContext): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return context.roleByRunId.get(value.trim()) ?? null;
}

function readRepresentativeTargetNodeId(payload?: Record<string, unknown>): string | undefined {
  if (typeof payload?.targetNodeId === "string" && payload.targetNodeId.trim()) {
    return payload.targetNodeId.trim();
  }
  if (Array.isArray(payload?.targetNodeIds)) {
    const first = payload.targetNodeIds.find((value) => typeof value === "string" && value.trim());
    if (typeof first === "string") {
      return first.trim();
    }
  }
  return undefined;
}

function readWriteSummaryIncrement(payload?: Record<string, unknown>): number {
  const targetCount = payload?.targetCount;
  if (typeof targetCount === "number" && Number.isFinite(targetCount) && targetCount > 0) {
    return targetCount;
  }
  if (Array.isArray(payload?.targetNodeIds)) {
    const count = payload.targetNodeIds.filter((value) => typeof value === "string" && value.trim()).length;
    if (count > 0) {
      return count;
    }
  }
  if (typeof payload?.targetNodeId === "string" && payload.targetNodeId.trim()) {
    return 1;
  }
  return 1;
}

function inferScopeFromStepId(stepId?: string): string | null {
  const normalizedStepId = stepId?.trim().toLowerCase() ?? "";
  if (!normalizedStepId) {
    return null;
  }
  if (normalizedStepId.includes("heading")) {
    return "heading";
  }
  if (normalizedStepId.includes("body")) {
    return "body";
  }
  if (normalizedStepId.includes("list")) {
    return "list_item";
  }
  if (normalizedStepId.includes("all_text")) {
    return "all_text";
  }
  if (normalizedStepId.includes("paragraph")) {
    return "paragraph_ids";
  }
  return null;
}

function describeScope(scope: string): string | null {
  if (scope === "body") {
    return "正文";
  }
  if (scope === "heading") {
    return "标题";
  }
  if (scope === "list_item") {
    return "列表";
  }
  if (scope === "all_text") {
    return "全文";
  }
  if (scope === "paragraph_ids") {
    return "指定段落";
  }
  if (scope === "table_text") {
    return "表格";
  }
  return null;
}

function describeOperation(operationType: OperationType): string | null {
  if (operationType === "set_font") {
    return "字体";
  }
  if (operationType === "set_size") {
    return "字号";
  }
  if (operationType === "set_font_color") {
    return "颜色";
  }
  if (operationType === "set_alignment") {
    return "对齐方式";
  }
  if (operationType === "set_bold") {
    return "加粗";
  }
  if (operationType === "set_italic") {
    return "斜体";
  }
  if (operationType === "set_underline") {
    return "下划线";
  }
  if (operationType === "set_strike") {
    return "删除线";
  }
  if (operationType === "set_highlight_color") {
    return "高亮颜色";
  }
  if (operationType === "set_all_caps") {
    return "大写";
  }
  if (operationType === "merge_paragraph") {
    return "段落合并";
  }
  if (operationType === "split_paragraph") {
    return "段落拆分";
  }
  return null;
}

function parseWriteSummaryCount(title?: string): number {
  if (typeof title !== "string") {
    return 0;
  }
  const match = title.match(/共计(\d+)次/);
  if (!match) {
    return 0;
  }
  return Number.parseInt(match[1] ?? "0", 10) || 0;
}

function buildWriteSummaryTitle(
  group: WriteSummaryGroup,
  count: number,
  status: AgentTurnRunStep["status"]
): string {
  if (count > 0) {
    return `已完成${group.rangeLabel}${group.propertyLabel}修改，共计${count}次`;
  }
  if (status === "failed") {
    return `${group.rangeLabel}${group.propertyLabel}修改`;
  }
  return `正在执行${group.rangeLabel}${group.propertyLabel}修改`;
}

function normalizeDecisionForSession(decision: TurnDecision, session: AgentSessionSnapshot): TurnDecision {
  const normalized = normalizeTurnDecision(decision);
  if (normalized.needsClarification) {
    if (normalized.mode !== "chat") {
      throw new AgentError({
        code: "E_TURN_DECISION_INVALID",
        message: "turn decision needsClarification=true requires mode=chat",
        retryable: false
      });
    }
    if (normalized.requiresDocument) {
      requireAttachedDocument(session, "clarification");
    }
    return normalized;
  }

  if (normalized.mode === "chat" && normalized.requiresDocument) {
    throw new AgentError({
      code: "E_TURN_DECISION_INVALID",
      message: "turn decision mode=chat cannot require a document",
      retryable: false
    });
  }
  if (normalized.mode !== "chat" && !normalized.requiresDocument) {
    throw new AgentError({
      code: "E_TURN_DECISION_INVALID",
      message: `turn decision mode=${normalized.mode} requiresDocument must be true`,
      retryable: false
    });
  }
  if (normalized.mode !== "chat") {
    requireAttachedDocument(session, normalized.mode);
  }
  return normalized;
}

function normalizeExecutionGoal(decision: TurnDecision, userInput: string): ExecutionGoalNormalizationResult {
  if (decision.mode !== "execute" || decision.needsClarification) {
    return { decision, bodyDefaultIncludesListItem: false };
  }
  if (!shouldExpandBodyDefaultScope(decision.goal, userInput)) {
    return { decision, bodyDefaultIncludesListItem: false };
  }
  if (decision.goal.includes(BODY_LIST_ITEM_DEFAULT_GOAL_CLAUSE)) {
    return { decision, bodyDefaultIncludesListItem: true };
  }

  const separator = /[。！？!?；;]$/.test(decision.goal) ? "" : "；";
  return {
    decision: {
      ...decision,
      goal: `${decision.goal}${separator}${BODY_LIST_ITEM_DEFAULT_GOAL_CLAUSE}。`
    },
    bodyDefaultIncludesListItem: true
  };
}

function shouldExpandBodyDefaultScope(goal: string, userInput: string): boolean {
  const combined = `${userInput}\n${goal}`;
  if (!combined.includes("正文")) {
    return false;
  }
  if (goal.includes("普通正文和项目符号/编号段落")) {
    return false;
  }
  if (/(list_item|列表项|列表段落|项目符号|编号段落|编号列表|有序列表|无序列表|bullet|numbered)/i.test(combined)) {
    return false;
  }
  if (/(普通正文|纯正文|正文（不含列表）|正文\(不含列表\)|不含列表|不包括列表|排除列表)/.test(combined)) {
    return false;
  }
  return true;
}

function normalizeRequired(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AgentError({
      code: "E_SESSION_INPUT_INVALID",
      message: `${fieldName} is required.`,
      retryable: false
    });
  }
  return normalized;
}
