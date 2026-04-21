import path from "node:path";
import { AgentError } from "../core/errors.js";
import { getOutputDir } from "../core/project-paths.js";
import type { ConversationMessage, DocumentIR, ExecutionResult } from "../core/types.js";
import { createMvpRuntime, type AgentRuntime } from "./engine.js";
import {
  LlmAgentModelGateway,
  normalizeTurnDecision,
  type AgentModelGateway,
  type AgentTurnMode,
  type TurnDecision
} from "./model-gateway.js";
import {
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

  async submitUserTurn(input: SubmitUserTurnInput): Promise<AgentSessionResponse> {
    const sessionId = normalizeRequired(input.sessionId, "sessionId");
    const userInput = normalizeRequired(input.userInput, "userInput");
    const modelGateway = this.modelGateway ?? new LlmAgentModelGateway();
    await this.store.appendTurn(sessionId, "user", userInput);

    const sessionBefore = await this.store.getSession(sessionId);
    const rawDecision = await modelGateway.decideTurn({
      session: sessionBefore,
      userInput,
      forceMode: input.forceMode
    });
    const decision = normalizeDecisionForSession(rawDecision, sessionBefore);

    let content = "";
    let outputDocxPath: string | undefined;

    if (decision.needsClarification) {
      const observation = decision.requiresDocument
        ? await this.observeDocument(requireAttachedDocument(sessionBefore, "clarification").path)
        : undefined;
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
      content = await modelGateway.respondToConversation({
        session: sessionBefore,
        messages: toConversationMessages(sessionBefore)
      });
      await this.store.saveGoal(sessionId, decision.goal, decision.mode, "completed");
    } else if (decision.mode === "inspect") {
      await this.store.saveGoal(sessionId, decision.goal, decision.mode, "active");
      const document = requireAttachedDocument(sessionBefore, decision.mode);
      const observation = await this.observeDocument(document.path);
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
      const executionDoc = await buildExecutionDocument(
        sessionId,
        document.path,
        this.outputRootDir,
        this.observeDocument
      );
      const runtimeResult = await runtime.run(decision.goal, executionDoc, {
        taskId: `${sessionId}-task`,
        dryRun: false,
        sessionContext: toConversationMessages(sessionBefore)
      });
      outputDocxPath = readOutputPath(runtimeResult);
      content = formatExecutionContent(runtimeResult, outputDocxPath);
      await this.store.saveGoal(
        sessionId,
        decision.goal,
        decision.mode,
        runtimeResult.status === "completed" ? "completed" : "failed"
      );
    }

    await this.store.appendTurn(sessionId, "assistant", content);
    const session = await this.store.getSession(sessionId);
    return {
      session,
      response: {
        mode: decision.mode,
        goal: decision.goal,
        content,
        outputDocxPath
      }
    };
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

function formatExecutionContent(result: ExecutionResult, outputDocxPath?: string): string {
  const parts = [result.summary.trim()];
  if (outputDocxPath) {
    parts.push(`输出文件：${outputDocxPath}`);
  }
  return parts.filter(Boolean).join("\n");
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
