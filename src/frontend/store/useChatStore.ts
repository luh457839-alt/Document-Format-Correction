import { create } from 'zustand';
import {
  attachDocument,
  createSession,
  deleteSession as deleteRemoteSession,
  fetchModelConfig,
  fetchSessionState,
  fetchSessions,
  normalizeMessages,
  saveModelConfig,
  submitTurn,
  updateSessionTitle as updateRemoteSessionTitle,
} from '../services/api';
import {
  AttachedDocument,
  ChatMessage,
  ChatSession,
  FrontendSessionState,
  PendingDocument,
  UserSettings,
} from '../types';

interface ChatState {
  sessions: ChatSession[];
  messages: Record<string, ChatMessage[]>;
  currentSessionId: string | null;
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
  sendMessage: (text: string) => Promise<boolean>;
  importDocument: (file: File) => Promise<void>;
  updateSettings: (newSettings: Partial<UserSettings>) => void;
  persistSettings: (nextSettings?: UserSettings) => Promise<void>;
  toggleSettings: (isOpen: boolean) => void;
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
  runtimeMode: 'react_loop',
};

function mapModelConfigToSettings(modelConfig: {
  chat: { baseUrl: string; apiKey: string; model: string };
  planner: { baseUrl: string; apiKey: string; model: string; runtimeMode?: 'plan_once' | 'react_loop' | null };
}): UserSettings {
  return {
    apiBaseUrl: modelConfig.chat.baseUrl,
    apiKey: modelConfig.chat.apiKey,
    selectedModel: modelConfig.chat.model,
    plannerModel: modelConfig.planner.model,
    plannerBaseUrl: modelConfig.planner.baseUrl,
    plannerApiKey: modelConfig.planner.apiKey,
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

function removeSessionCaches(
  state: ChatState,
  sessionId: string
): Pick<ChatState, 'messages' | 'attachedDocuments' | 'pendingDocuments'> {
  const nextMessages = { ...state.messages };
  const nextAttachedDocuments = { ...state.attachedDocuments };
  const nextPendingDocuments = { ...state.pendingDocuments };
  delete nextMessages[sessionId];
  delete nextAttachedDocuments[sessionId];
  delete nextPendingDocuments[sessionId];
  return {
    messages: nextMessages,
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
    };
  });
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  messages: {},
  currentSessionId: null,
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
      const visibleSessions = combineVisibleSessions(get(), remoteSessions);
      const nextCurrentSessionId =
        get().currentSessionId && visibleSessions.some((session) => session.sessionId === get().currentSessionId)
          ? get().currentSessionId
          : visibleSessions.find((session) => !isDraftSession(session))?.sessionId ??
            visibleSessions[0]?.sessionId ??
            null;

      set({
        sessions: visibleSessions,
        settings: mapModelConfigToSettings(modelConfig),
        currentSessionId: nextCurrentSessionId,
      });

      if (nextCurrentSessionId && !isDraftSessionId(nextCurrentSessionId)) {
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
        const currentSessionId =
          state.currentSessionId && sessions.some((session) => session.sessionId === state.currentSessionId)
            ? state.currentSessionId
            : sessions.find((session) => !isDraftSession(session))?.sessionId ??
              sessions[0]?.sessionId ??
              null;

        return {
          sessions,
          currentSessionId,
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
      set({ currentSessionId: existingDraft.sessionId, error: null });
      return;
    }

    const draft = createDraftSession();
    set((state) => ({
      sessions: [draft, ...state.sessions],
      currentSessionId: draft.sessionId,
      messages: {
        ...state.messages,
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
        return {
          sessions: state.sessions.filter((session) => session.sessionId !== sessionId),
          currentSessionId: state.currentSessionId === sessionId ? nextSessionId : state.currentSessionId,
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
      set({ currentSessionId: sessionId, error: null });
      return;
    }

    set({ currentSessionId: sessionId, error: null });
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
    const state = get();
    const currentSession = getSessionById(state, state.currentSessionId);
    const pendingDocument =
      state.currentSessionId ? state.pendingDocuments[state.currentSessionId] ?? null : null;
    if (!currentSession || (!trimmedText && !pendingDocument)) {
      return false;
    }

    set({ isSending: true, error: null });
    try {
      if (isDraftSession(currentSession)) {
        let remoteSessionId = currentSession.remoteSessionId;
        if (!remoteSessionId) {
          const createdSession = await createSession();
          remoteSessionId = createdSession.sessionId;
          persistDraftRemoteState(set, currentSession.sessionId, createdSession);
        }

        const preferredTitle =
          currentSession.title.trim() && currentSession.title.trim() !== DEFAULT_DRAFT_TITLE
            ? currentSession.title.trim()
            : undefined;
        if (preferredTitle) {
          try {
            await updateRemoteSessionTitle(remoteSessionId, preferredTitle);
          } catch {
            // Ignore rename sync failure here; the draft stays editable for retry.
          }
        }

        if (pendingDocument) {
          set({ isUploading: true });
          try {
            const attachedSession = await attachDocument(remoteSessionId, pendingDocument.file);
            persistDraftRemoteState(set, currentSession.sessionId, attachedSession);
          } finally {
            set({ isUploading: false });
          }
        }

        const session = await submitTurn(
          remoteSessionId,
          trimmedText || FILE_ONLY_FALLBACK_PROMPT
        );
        finalizeDraftSession(set, currentSession.sessionId, session, preferredTitle);
        await get().loadSessions();
        return true;
      }

      if (pendingDocument) {
        set({ isUploading: true });
        try {
          const attachedSession = await attachDocument(currentSession.sessionId, pendingDocument.file);
          mergeRemoteSessionState(set, attachedSession);
        } finally {
          set({ isUploading: false });
        }
      }

      const session = await submitTurn(
        currentSession.sessionId,
        trimmedText || FILE_ONLY_FALLBACK_PROMPT
      );
      set((state) => ({
        pendingDocuments: {
          ...state.pendingDocuments,
          [currentSession.sessionId]: null,
        },
      }));
      mergeRemoteSessionState(set, session);
      await get().loadSessions();
      return true;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : '发送消息失败。',
      });
      return false;
    } finally {
      set({ isSending: false, isUploading: false });
    }
  },

  importDocument: async (file) => {
    const currentSession = getSessionById(get(), get().currentSessionId);
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

  clearError: () => {
    set({ error: null });
  },
}));
