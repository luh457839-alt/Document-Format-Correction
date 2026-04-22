import { create } from 'zustand';
import {
  attachDocument,
  createSession,
  deleteSession as deleteRemoteSession,
  fetchMessageJob,
  fetchModelConfig,
  fetchSessionState,
  fetchSessions,
  normalizeMessages,
  saveModelConfig,
  submitTurnAsync,
  updateSessionTitle as updateRemoteSessionTitle,
} from '../services/api';
import {
  AttachedDocument,
  ChatMessage,
  ChatSession,
  FrontendSessionState,
  PendingDocument,
  TurnJobSnapshot,
  TurnProgressStep,
  UserSettings,
} from '../types';

interface ChatState {
  sessions: ChatSession[];
  messages: Record<string, ChatMessage[]>;
  localMessages: Record<string, ChatMessage[]>;
  turnJobs: Record<string, TurnJobSnapshot[]>;
  currentSessionId: string | null;
  shouldCreateNewSession: boolean;
  attachedDocuments: Record<string, AttachedDocument | null>;
  pendingDocuments: Record<string, PendingDocument | null>;
  settings: UserSettings;
  isSettingsOpen: boolean;
  isInitializing: boolean;
  isLoadingSessions: boolean;
  isSending: boolean;
  isUploading: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  reloadSettings: () => Promise<void>;
  loadSessions: () => Promise<void>;
  startDraftSession: () => void;
  renameSession: (sessionId: string, title: string) => Promise<boolean>;
  deleteSession: (sessionId: string) => Promise<boolean>;
  setCurrentSession: (sessionId: string) => Promise<void>;
  refreshCurrentSession: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  importDocument: (file: File) => Promise<void>;
  updateSettings: (newSettings: Partial<UserSettings>) => void;
  persistSettings: (nextSettings?: UserSettings) => Promise<void>;
  toggleSettings: (isOpen: boolean) => void;
  toggleTurnJobExpanded: (sessionId: string, jobId: string) => void;
  clearError: () => void;
}

const DRAFT_SESSION_PREFIX = 'draft:';
const DEFAULT_DRAFT_TITLE = '新对话';
const FILE_ONLY_FALLBACK_PROMPT = '请先分析我上传的文档并开始处理。';

const defaultSettings: UserSettings = {
  apiBaseUrl: 'http://localhost:8080/v1',
  apiKey: 'sk-local-gemma4',
  selectedModel: 'gemma-4',
  plannerModel: 'gemma-4',
  plannerBaseUrl: 'http://localhost:8080/v1',
  plannerApiKey: 'sk-local-gemma4',
  plannerTimeoutMs: null,
  stepTimeoutMs: 60000,
  taskTimeoutMs: null,
  pythonToolTimeoutMs: null,
  maxTurns: 24,
  syncRequestTimeoutMs: 300000,
  runtimeMode: 'react_loop',
};

function mapModelConfigToSettings(modelConfig: {
  chat: { baseUrl: string; apiKey: string; model: string };
  planner: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs?: number | null;
    stepTimeoutMs?: number;
    taskTimeoutMs?: number | null;
    pythonToolTimeoutMs?: number | null;
    maxTurns?: number;
    syncRequestTimeoutMs?: number;
    runtimeMode?: 'plan_once' | 'react_loop' | null;
  };
}): UserSettings {
  return {
    apiBaseUrl: modelConfig.chat.baseUrl,
    apiKey: modelConfig.chat.apiKey,
    selectedModel: modelConfig.chat.model,
    plannerModel: modelConfig.planner.model,
    plannerBaseUrl: modelConfig.planner.baseUrl,
    plannerApiKey: modelConfig.planner.apiKey,
    plannerTimeoutMs: modelConfig.planner.timeoutMs ?? defaultSettings.plannerTimeoutMs,
    stepTimeoutMs: modelConfig.planner.stepTimeoutMs ?? defaultSettings.stepTimeoutMs,
    taskTimeoutMs: modelConfig.planner.taskTimeoutMs ?? defaultSettings.taskTimeoutMs,
    pythonToolTimeoutMs:
      modelConfig.planner.pythonToolTimeoutMs ?? defaultSettings.pythonToolTimeoutMs,
    maxTurns: modelConfig.planner.maxTurns ?? defaultSettings.maxTurns,
    syncRequestTimeoutMs:
      modelConfig.planner.syncRequestTimeoutMs ?? defaultSettings.syncRequestTimeoutMs,
    runtimeMode: modelConfig.planner.runtimeMode === 'plan_once' ? 'plan_once' : 'react_loop',
  };
}

function mapSettingsToModelConfig(settings: UserSettings) {
  return {
    chat: {
      baseUrl: settings.apiBaseUrl,
      apiKey: settings.apiKey,
      model: settings.selectedModel,
    },
    planner: {
      baseUrl: settings.plannerBaseUrl,
      apiKey: settings.plannerApiKey,
      model: settings.plannerModel,
      timeoutMs: settings.plannerTimeoutMs,
      stepTimeoutMs: settings.stepTimeoutMs,
      taskTimeoutMs: settings.taskTimeoutMs,
      pythonToolTimeoutMs: settings.pythonToolTimeoutMs,
      maxTurns: settings.maxTurns,
      syncRequestTimeoutMs: settings.syncRequestTimeoutMs,
      runtimeMode: settings.runtimeMode,
    },
  };
}

function isDraftSessionId(sessionId: string): boolean {
  return sessionId.startsWith(DRAFT_SESSION_PREFIX);
}

function isDraftSession(session: ChatSession): boolean {
  return session.isDraft === true || isDraftSessionId(session.sessionId);
}

function createDraftSession(): ChatSession {
  const now = Date.now();
  return {
    sessionId: `${DRAFT_SESSION_PREFIX}${now}`,
    title: DEFAULT_DRAFT_TITLE,
    createdAt: now,
    updatedAt: now,
    isDraft: true,
  };
}

function toSidebarSession(session: FrontendSessionState): ChatSession {
  return {
    sessionId: session.sessionId,
    title: session.title || session.sessionId,
    createdAt: 0,
    updatedAt: Date.now(),
  };
}

function upsertSession(sessions: ChatSession[], nextSession: ChatSession): ChatSession[] {
  const existing = sessions.find((session) => session.sessionId === nextSession.sessionId);
  if (!existing) {
    return [nextSession, ...sessions];
  }
  return sessions.map((session) =>
    session.sessionId === nextSession.sessionId
      ? { ...session, ...nextSession, updatedAt: Date.now() }
      : session
  );
}

function getDraftSession(sessions: ChatSession[]): ChatSession | undefined {
  return sessions.find(isDraftSession);
}

function hidePendingRemoteSessions(
  remoteSessions: ChatSession[],
  draftSessions: ChatSession[]
): ChatSession[] {
  const hiddenIds = new Set(
    draftSessions
      .map((session) => session.remoteSessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId))
  );
  return remoteSessions.filter((session) => !hiddenIds.has(session.sessionId));
}

function combineVisibleSessions(state: ChatState, remoteSessions: ChatSession[]): ChatSession[] {
  const drafts = state.sessions.filter(isDraftSession);
  return [...drafts, ...hidePendingRemoteSessions(remoteSessions, drafts)];
}

function getSessionById(state: ChatState, sessionId: string | null): ChatSession | undefined {
  return state.sessions.find((session) => session.sessionId === sessionId);
}

function resolveCurrentSessionId(state: Pick<ChatState, 'currentSessionId' | 'shouldCreateNewSession'>, sessions: ChatSession[]): string | null {
  const currentSession =
    state.currentSessionId ? sessions.find((session) => session.sessionId === state.currentSessionId) : undefined;
  if (currentSession) {
    if (isDraftSession(currentSession)) {
      return currentSession.sessionId;
    }
    if (!state.shouldCreateNewSession) {
      return currentSession.sessionId;
    }
  }

  if (state.shouldCreateNewSession) {
    return getDraftSession(sessions)?.sessionId ?? null;
  }

  return sessions.find((session) => !isDraftSession(session))?.sessionId ?? getDraftSession(sessions)?.sessionId ?? null;
}

function removeSessionCaches(
  state: ChatState,
  sessionId: string
): Pick<ChatState, 'messages' | 'localMessages' | 'turnJobs' | 'attachedDocuments' | 'pendingDocuments'> {
  const nextMessages = { ...state.messages };
  const nextLocalMessages = { ...state.localMessages };
  const nextTurnJobs = { ...state.turnJobs };
  const nextAttachedDocuments = { ...state.attachedDocuments };
  const nextPendingDocuments = { ...state.pendingDocuments };
  delete nextMessages[sessionId];
  delete nextLocalMessages[sessionId];
  delete nextTurnJobs[sessionId];
  delete nextAttachedDocuments[sessionId];
  delete nextPendingDocuments[sessionId];
  return {
    messages: nextMessages,
    localMessages: nextLocalMessages,
    turnJobs: nextTurnJobs,
    attachedDocuments: nextAttachedDocuments,
    pendingDocuments: nextPendingDocuments,
  };
}

function chooseNextSessionIdAfterDeletion(sessions: ChatSession[], deletedSessionId: string): string | null {
  const deletedIndex = sessions.findIndex((session) => session.sessionId === deletedSessionId);
  const remainingSessions = sessions.filter((session) => session.sessionId !== deletedSessionId);
  const nextRealSession =
    remainingSessions.slice(Math.max(deletedIndex, 0)).find((session) => !isDraftSession(session)) ??
    remainingSessions.slice(0, Math.max(deletedIndex, 0)).find((session) => !isDraftSession(session));
  if (nextRealSession) {
    return nextRealSession.sessionId;
  }
  const draftSession = remainingSessions.find(isDraftSession);
  return draftSession?.sessionId ?? null;
}

function createLocalMessage(sessionId: string, content: string): ChatMessage {
  return {
    messageId: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    role: 'user',
    content,
    clientCreatedAt: Date.now(),
    isTemporary: true,
  };
}

function createJobStep(
  id: string,
  title: string,
  status: TurnProgressStep['status'],
  detail?: string
): TurnProgressStep {
  const now = Date.now();
  return {
    id,
    title,
    status,
    detail,
    startedAt: status === 'queued' ? undefined : now,
    updatedAt: now,
  };
}

function createPendingJob(sessionId: string, tempMessageId: string, steps: TurnProgressStep[]): TurnJobSnapshot {
  const now = Date.now();
  return {
    jobId: `local-${now}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    status: 'running',
    acceptedAt: now,
    updatedAt: now,
    summary: steps[0]?.title ? `正在${steps[0].title}` : '正在提交请求',
    steps,
    anchorMessageId: tempMessageId,
    isCollapsed: false,
  };
}

function upsertJobStep(steps: TurnProgressStep[], nextStep: TurnProgressStep): TurnProgressStep[] {
  const index = steps.findIndex((step) => step.id === nextStep.id);
  if (index < 0) {
    return [...steps, nextStep];
  }
  const current = steps[index];
  const merged = {
    ...current,
    ...nextStep,
    startedAt: current.startedAt ?? nextStep.startedAt,
  };
  const next = [...steps];
  next.splice(index, 1, merged);
  return next;
}

function markLatestRunningStepFailed(steps: TurnProgressStep[], detail: string): TurnProgressStep[] {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].status === 'running') {
      return upsertJobStep(
        steps,
        createJobStep(steps[index].id, steps[index].title, 'failed', detail)
      );
    }
  }
  return steps;
}

function mergeJobSteps(clientSteps: TurnProgressStep[], remoteSteps: TurnProgressStep[]): TurnProgressStep[] {
  const merged = [...clientSteps];
  remoteSteps.forEach((step) => {
    merged.push({
      ...step,
      id: `remote:${step.id}`,
    });
  });
  return merged;
}

function replaceTurnJob(
  jobs: TurnJobSnapshot[],
  jobId: string,
  updater: (job: TurnJobSnapshot) => TurnJobSnapshot
): TurnJobSnapshot[] {
  return jobs.map((job) => (job.jobId === jobId ? updater(job) : job));
}

function removeLocalMessage(messages: ChatMessage[], messageId: string): ChatMessage[] {
  return messages.filter((message) => message.messageId !== messageId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function findLatestUserMessageId(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return messages[index].messageId;
    }
  }
  return undefined;
}

function mergeRemoteSessionState(
  set: (
    partial:
      | Partial<ChatState>
      | ((state: ChatState) => Partial<ChatState>)
  ) => void,
  session: FrontendSessionState
): void {
  const normalizedMessages = normalizeMessages(session.messages);
  set((state) => ({
    sessions: upsertSession(state.sessions, toSidebarSession(session)),
    messages: {
      ...state.messages,
      [session.sessionId]: normalizedMessages,
    },
    attachedDocuments: {
      ...state.attachedDocuments,
      [session.sessionId]: session.attachedDocument ?? null,
    },
    currentSessionId: session.sessionId,
    shouldCreateNewSession: false,
  }));
}

function persistDraftRemoteState(
  set: (
    partial:
      | Partial<ChatState>
      | ((state: ChatState) => Partial<ChatState>)
  ) => void,
  draftSessionId: string,
  session: FrontendSessionState
): void {
  set((state) => ({
    sessions: state.sessions.map((item) =>
      item.sessionId === draftSessionId
        ? {
            ...item,
            title: item.title || session.title || DEFAULT_DRAFT_TITLE,
            remoteSessionId: session.sessionId,
            updatedAt: Date.now(),
          }
        : item
    ),
    messages: {
      ...state.messages,
      [draftSessionId]: normalizeMessages(session.messages),
    },
    attachedDocuments: {
      ...state.attachedDocuments,
      [draftSessionId]: session.attachedDocument ?? null,
    },
  }));
}

function finalizeDraftSession(
  set: (
    partial:
      | Partial<ChatState>
      | ((state: ChatState) => Partial<ChatState>)
  ) => void,
  draftSessionId: string,
  session: FrontendSessionState,
  preferredTitle?: string
): void {
  const normalizedMessages = normalizeMessages(session.messages);
  const resolvedTitle = preferredTitle?.trim() || session.title || session.sessionId;
  set((state) => {
    const draftIndex = state.sessions.findIndex((item) => item.sessionId === draftSessionId);
    const nextSessions = state.sessions.filter((item) => item.sessionId !== draftSessionId);
    const replacement = {
      sessionId: session.sessionId,
      title: resolvedTitle,
      createdAt: 0,
      updatedAt: Date.now(),
    } satisfies ChatSession;

    if (draftIndex >= 0) {
      nextSessions.splice(draftIndex, 0, replacement);
    } else {
      nextSessions.unshift(replacement);
    }

    const nextMessages = { ...state.messages };
    const nextAttachedDocuments = { ...state.attachedDocuments };
    const nextPendingDocuments = { ...state.pendingDocuments };
    delete nextMessages[draftSessionId];
    delete nextAttachedDocuments[draftSessionId];
    delete nextPendingDocuments[draftSessionId];
    nextMessages[session.sessionId] = normalizedMessages;
    nextAttachedDocuments[session.sessionId] = session.attachedDocument ?? null;
    nextPendingDocuments[session.sessionId] = null;

    return {
      sessions: nextSessions,
      messages: nextMessages,
      attachedDocuments: nextAttachedDocuments,
      pendingDocuments: nextPendingDocuments,
      currentSessionId: session.sessionId,
      shouldCreateNewSession: false,
    };
  });
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  messages: {},
  localMessages: {},
  turnJobs: {},
  currentSessionId: null,
  shouldCreateNewSession: true,
  attachedDocuments: {},
  pendingDocuments: {},
  settings: defaultSettings,
  isSettingsOpen: false,
  isInitializing: false,
  isLoadingSessions: false,
  isSending: false,
  isUploading: false,
  error: null,

  initialize: async () => {
    if (get().isInitializing) {
      return;
    }
    set({ isInitializing: true, error: null });
    try {
      const [remoteSessions, modelConfig] = await Promise.all([fetchSessions(), fetchModelConfig()]);
      const state = get();
      const visibleSessions = combineVisibleSessions(state, remoteSessions);
      const nextCurrentSessionId = resolveCurrentSessionId(state, visibleSessions);
      const nextShouldCreateNewSession =
        nextCurrentSessionId == null ? true : isDraftSessionId(nextCurrentSessionId) || state.shouldCreateNewSession;

      set({
        sessions: visibleSessions,
        settings: mapModelConfigToSettings(modelConfig),
        currentSessionId: nextCurrentSessionId,
        shouldCreateNewSession: nextShouldCreateNewSession,
      });

      if (nextCurrentSessionId && !isDraftSessionId(nextCurrentSessionId) && !nextShouldCreateNewSession) {
        await get().setCurrentSession(nextCurrentSessionId);
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '初始化失败。',
      });
    } finally {
      set({ isInitializing: false });
    }
  },

  reloadSettings: async () => {
    set({ error: null });
    try {
      const modelConfig = await fetchModelConfig();
      set({
        settings: mapModelConfigToSettings(modelConfig),
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '读取设置失败。',
      });
      throw error;
    }
  },

  loadSessions: async () => {
    set({ isLoadingSessions: true, error: null });
    try {
      const remoteSessions = await fetchSessions();
      set((state) => {
        const sessions = combineVisibleSessions(state, remoteSessions);
        const currentSessionId = resolveCurrentSessionId(state, sessions);
        const shouldCreateNewSession =
          currentSessionId == null ? true : isDraftSessionId(currentSessionId) || state.shouldCreateNewSession;

        return {
          sessions,
          currentSessionId,
          shouldCreateNewSession,
        };
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '加载会话列表失败。',
      });
    } finally {
      set({ isLoadingSessions: false });
    }
  },

  startDraftSession: () => {
    const existingDraft = getDraftSession(get().sessions);
    if (existingDraft) {
      set({ currentSessionId: existingDraft.sessionId, shouldCreateNewSession: true, error: null });
      return;
    }

    const draft = createDraftSession();
    set((state) => ({
      sessions: [draft, ...state.sessions],
      currentSessionId: draft.sessionId,
      shouldCreateNewSession: true,
      messages: {
        ...state.messages,
        [draft.sessionId]: [],
      },
      localMessages: {
        ...state.localMessages,
        [draft.sessionId]: [],
      },
      turnJobs: {
        ...state.turnJobs,
        [draft.sessionId]: [],
      },
      attachedDocuments: {
        ...state.attachedDocuments,
        [draft.sessionId]: null,
      },
      pendingDocuments: {
        ...state.pendingDocuments,
        [draft.sessionId]: null,
      },
      error: null,
    }));
  },

  renameSession: async (sessionId, title) => {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      set({ error: '标题不能为空。' });
      return false;
    }

    const targetSession = getSessionById(get(), sessionId);
    if (!targetSession) {
      set({ error: '未找到对应会话。' });
      return false;
    }

    set({ error: null });
    try {
      if (isDraftSession(targetSession)) {
        if (targetSession.remoteSessionId) {
          await updateRemoteSessionTitle(targetSession.remoteSessionId, normalizedTitle);
        }
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.sessionId === sessionId
              ? {
                  ...session,
                  title: normalizedTitle,
                  updatedAt: Date.now(),
                }
              : session
          ),
        }));
        return true;
      }

      const updated = await updateRemoteSessionTitle(sessionId, normalizedTitle);
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.sessionId === sessionId
            ? {
                ...session,
                title: updated.title || normalizedTitle,
                updatedAt: Date.now(),
              }
            : session
        ),
      }));
      return true;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '重命名会话失败。',
      });
      return false;
    }
  },

  deleteSession: async (sessionId) => {
    const targetSession = getSessionById(get(), sessionId);
    if (!targetSession) {
      set({ error: '未找到对应会话。' });
      return false;
    }

    set({ error: null });
    try {
      const remoteSessionId = isDraftSession(targetSession)
        ? targetSession.remoteSessionId
        : targetSession.sessionId;
      if (remoteSessionId) {
        await deleteRemoteSession(remoteSessionId);
      }

      const nextSessionId = chooseNextSessionIdAfterDeletion(get().sessions, sessionId);
      set((state) => {
        const cacheState = removeSessionCaches(state, sessionId);
        const nextShouldCreateNewSession =
          state.currentSessionId === sessionId ? !nextSessionId || isDraftSessionId(nextSessionId) : state.shouldCreateNewSession;
        return {
          sessions: state.sessions.filter((session) => session.sessionId !== sessionId),
          currentSessionId: state.currentSessionId === sessionId ? nextSessionId : state.currentSessionId,
          shouldCreateNewSession: nextShouldCreateNewSession,
          ...cacheState,
        };
      });

      if (nextSessionId && !isDraftSessionId(nextSessionId) && get().currentSessionId === nextSessionId) {
        await get().setCurrentSession(nextSessionId);
      }
      return true;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '删除会话失败。',
      });
      return false;
    }
  },

  setCurrentSession: async (sessionId) => {
    const targetSession = getSessionById(get(), sessionId);
    if (targetSession && isDraftSession(targetSession)) {
      set({ currentSessionId: sessionId, shouldCreateNewSession: true, error: null });
      return;
    }

    set({ currentSessionId: sessionId, shouldCreateNewSession: false, error: null });
    try {
      const session = await fetchSessionState(sessionId);
      mergeRemoteSessionState(set, session);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '加载会话内容失败。',
      });
    }
  },

  refreshCurrentSession: async () => {
    const currentSession = getSessionById(get(), get().currentSessionId);
    if (!currentSession) {
      return;
    }

    try {
      if (isDraftSession(currentSession)) {
        if (!currentSession.remoteSessionId) {
          return;
        }
        const session = await fetchSessionState(currentSession.remoteSessionId);
        persistDraftRemoteState(set, currentSession.sessionId, session);
        return;
      }

      const session = await fetchSessionState(currentSession.sessionId);
      mergeRemoteSessionState(set, session);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '刷新会话失败。',
      });
    }
  },

  sendMessage: async (text) => {
    const trimmedText = text.trim();
    let state = get();
    let currentSession = getSessionById(state, state.currentSessionId);
    if (!currentSession || (state.shouldCreateNewSession && !isDraftSession(currentSession))) {
      get().startDraftSession();
      state = get();
      currentSession = getSessionById(state, state.currentSessionId);
    }

    const pendingDocument = currentSession ? state.pendingDocuments[currentSession.sessionId] ?? null : null;
    if (!currentSession || (!trimmedText && !pendingDocument)) {
      return;
    }

    const sessionKey = currentSession.sessionId;
    const content = trimmedText || FILE_ONLY_FALLBACK_PROMPT;
    const tempMessage = createLocalMessage(sessionKey, content);
    const localPreflightSteps: TurnProgressStep[] = [];
    if (isDraftSession(currentSession) && !currentSession.remoteSessionId) {
      localPreflightSteps.push(createJobStep('client:create_session', '创建会话', 'queued'));
    }
    if (pendingDocument) {
      localPreflightSteps.push(createJobStep('client:upload_document', '上传文档', 'queued'));
    }
    const initialJob = createPendingJob(sessionKey, tempMessage.messageId, localPreflightSteps);
    let activeJobId = initialJob.jobId;

    const updateJob = (targetSessionId: string, jobId: string, updater: (job: TurnJobSnapshot) => TurnJobSnapshot) => {
      set((innerState) => ({
        turnJobs: {
          ...innerState.turnJobs,
          [targetSessionId]: replaceTurnJob(innerState.turnJobs[targetSessionId] || [], jobId, updater),
        },
      }));
    };

    set((innerState) => ({
      isSending: true,
      error: null,
      localMessages: {
        ...innerState.localMessages,
        [sessionKey]: [...(innerState.localMessages[sessionKey] || []), tempMessage],
      },
      turnJobs: {
        ...innerState.turnJobs,
        [sessionKey]: [...(innerState.turnJobs[sessionKey] || []), initialJob],
      },
      pendingDocuments: {
        ...innerState.pendingDocuments,
        [sessionKey]: null,
      },
    }));

    try {
      let remoteSessionId = isDraftSession(currentSession)
        ? currentSession.remoteSessionId || ''
        : currentSession.sessionId;
      const preferredTitle =
        currentSession.title.trim() && currentSession.title.trim() !== DEFAULT_DRAFT_TITLE
          ? currentSession.title.trim()
          : undefined;

      if (isDraftSession(currentSession) && !remoteSessionId) {
        updateJob(sessionKey, initialJob.jobId, (job) => ({
          ...job,
          summary: '正在创建会话',
          steps: upsertJobStep(job.steps, createJobStep('client:create_session', '创建会话', 'running')),
        }));
        const createdSession = await createSession();
        remoteSessionId = createdSession.sessionId;
        persistDraftRemoteState(set, sessionKey, createdSession);
        updateJob(sessionKey, initialJob.jobId, (job) => ({
          ...job,
          remoteSessionId,
          summary: pendingDocument ? '会话已创建，等待上传文档' : '会话已创建',
          steps: upsertJobStep(
            job.steps,
            createJobStep('client:create_session', '创建会话', 'completed', '会话创建成功')
          ),
        }));
        if (preferredTitle) {
          try {
            await updateRemoteSessionTitle(remoteSessionId, preferredTitle);
          } catch {
            // Ignore rename sync failure here; the draft stays editable for retry.
          }
        }
      }

      if (pendingDocument) {
        set({ isUploading: true });
        updateJob(sessionKey, initialJob.jobId, (job) => ({
          ...job,
          remoteSessionId: remoteSessionId || undefined,
          summary: '正在上传文档',
          steps: upsertJobStep(job.steps, createJobStep('client:upload_document', '上传文档', 'running')),
        }));
        try {
          const attachedSession = await attachDocument(remoteSessionId || currentSession.sessionId, pendingDocument.file);
          if (isDraftSession(currentSession)) {
            persistDraftRemoteState(set, sessionKey, attachedSession);
          } else {
            mergeRemoteSessionState(set, attachedSession);
          }
          updateJob(sessionKey, initialJob.jobId, (job) => ({
            ...job,
            summary: '文档上传完成，等待 TS Agent 开始处理',
            steps: upsertJobStep(
              job.steps,
              createJobStep('client:upload_document', '上传文档', 'completed', `已上传 ${pendingDocument.name}`)
            ),
          }));
        } finally {
          set({ isUploading: false });
        }
      }

      updateJob(sessionKey, initialJob.jobId, (job) => ({
        ...job,
        summary: '正在提交 TS Agent',
      }));
      const accepted = await submitTurnAsync(remoteSessionId || currentSession.sessionId, content);
      updateJob(sessionKey, activeJobId, (job) => ({
        ...job,
        jobId: accepted.job.jobId,
        remoteSessionId: remoteSessionId || undefined,
        acceptedAt: accepted.job.acceptedAt,
        updatedAt: accepted.job.updatedAt,
        status: accepted.job.status,
        summary: accepted.job.summary || job.summary,
        turnRunId: accepted.job.turnRunId,
        steps: mergeJobSteps(job.steps, accepted.job.steps || []),
      }));
      activeJobId = accepted.job.jobId;

      let finalSnapshot: { job: TurnJobSnapshot; session?: FrontendSessionState | null } | null = null;
      for (;;) {
        await sleep(800);
        const snapshot = await fetchMessageJob(remoteSessionId || currentSession.sessionId, activeJobId);
        finalSnapshot = snapshot;
        updateJob(sessionKey, activeJobId, (job) => ({
          ...job,
          remoteSessionId: remoteSessionId || undefined,
          turnRunId: snapshot.job.turnRunId,
          status: snapshot.job.status,
          updatedAt: snapshot.job.updatedAt,
          summary: snapshot.job.summary || job.summary,
          error: snapshot.job.error,
          steps: mergeJobSteps(
            job.steps.filter((step) => step.id.startsWith('client:')),
            snapshot.job.steps || []
          ),
        }));
        if (snapshot.job.status === 'completed' || snapshot.job.status === 'failed' || snapshot.job.status === 'waiting_user') {
          break;
        }
      }

      const completedSession = finalSnapshot?.session ?? null;
      if (completedSession) {
        if (isDraftSession(currentSession)) {
          finalizeDraftSession(set, sessionKey, completedSession, preferredTitle);
          const nextSessionId = completedSession.sessionId;
          set((innerState) => {
            const preservedLocalMessages = removeLocalMessage(innerState.localMessages[sessionKey] || [], tempMessage.messageId);
            const carriedJobs = (innerState.turnJobs[sessionKey] || []).map((job) => ({
              ...job,
              sessionId: nextSessionId,
              remoteSessionId: nextSessionId,
              anchorMessageId:
                job.jobId === activeJobId
                  ? findLatestUserMessageId(normalizeMessages(completedSession.messages))
                  : job.anchorMessageId,
              isCollapsed: job.jobId === activeJobId ? finalSnapshot.job.status === 'completed' : job.isCollapsed,
            }));
            return {
              localMessages: {
                ...innerState.localMessages,
                [sessionKey]: [],
                [nextSessionId]: [...(innerState.localMessages[nextSessionId] || []), ...preservedLocalMessages],
              },
              turnJobs: {
                ...innerState.turnJobs,
                [sessionKey]: [],
                [nextSessionId]: [...(innerState.turnJobs[nextSessionId] || []), ...carriedJobs],
              },
            };
          });
        } else {
          mergeRemoteSessionState(set, completedSession);
          set((innerState) => ({
            localMessages: {
              ...innerState.localMessages,
              [sessionKey]: removeLocalMessage(innerState.localMessages[sessionKey] || [], tempMessage.messageId),
            },
            turnJobs: {
              ...innerState.turnJobs,
              [sessionKey]: replaceTurnJob(innerState.turnJobs[sessionKey] || [], activeJobId, (job) => ({
                ...job,
                anchorMessageId: findLatestUserMessageId(normalizeMessages(completedSession.messages)),
                isCollapsed: finalSnapshot.job.status === 'completed',
              })),
            },
          }));
        }
      } else {
        updateJob(sessionKey, activeJobId, (job) => ({
          ...job,
          isCollapsed: false,
        }));
      }

      await get().loadSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : '发送消息失败。';
      updateJob(sessionKey, activeJobId, (job) => ({
        ...job,
        status: 'failed',
        summary: message,
        error: { message },
        steps: markLatestRunningStepFailed(job.steps, message),
        isCollapsed: false,
      }));
      set({
        error: message,
      });
    } finally {
      set({ isSending: false, isUploading: false });
    }
  },

  importDocument: async (file) => {
    let currentSession = getSessionById(get(), get().currentSessionId);
    if (!currentSession || (get().shouldCreateNewSession && !isDraftSession(currentSession))) {
      get().startDraftSession();
      currentSession = getSessionById(get(), get().currentSessionId);
    }
    if (!currentSession) {
      set({ error: '请先创建或选择会话。' });
      return;
    }

    set((state) => ({
      pendingDocuments: {
        ...state.pendingDocuments,
        [currentSession.sessionId]: {
          file,
          name: file.name,
        },
      },
      error: null,
    }));
  },

  updateSettings: (newSettings) => {
    set((state) => ({
      settings: {
        ...state.settings,
        ...newSettings,
      },
    }));
  },

  persistSettings: async (nextSettings) => {
    const settings = nextSettings ?? get().settings;
    set({ error: null });
    try {
      await saveModelConfig(mapSettingsToModelConfig(settings));
      const latest = await fetchModelConfig();
      set({
        settings: mapModelConfigToSettings(latest),
        isSettingsOpen: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '保存设置失败。',
      });
      throw error;
    }
  },

  toggleSettings: (isOpen) => {
    set({ isSettingsOpen: isOpen });
  },

  toggleTurnJobExpanded: (sessionId, jobId) => {
    set((state) => ({
      turnJobs: {
        ...state.turnJobs,
        [sessionId]: replaceTurnJob(state.turnJobs[sessionId] || [], jobId, (job) => ({
          ...job,
          isCollapsed: !job.isCollapsed,
        })),
      },
    }));
  },

  clearError: () => {
    set({ error: null });
  },
}));
