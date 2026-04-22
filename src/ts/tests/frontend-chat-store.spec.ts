import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession, FrontendSessionState, TurnJobSnapshot } from "../../frontend/types";

const FILE_ONLY_FALLBACK_PROMPT = "请先分析我上传的文档并开始处理。";

function makeSidebarSession(sessionId: string, title = "历史会话"): ChatSession {
  return {
    sessionId,
    title,
    createdAt: 0,
    updatedAt: 0
  };
}

function makeSessionState(overrides: Partial<FrontendSessionState> = {}): FrontendSessionState {
  return {
    sessionId: "chat-remote-1",
    title: "远端会话",
    messages: [],
    attachedDocument: null,
    ...overrides
  };
}

function makeAcceptedJob(sessionId: string, jobId = "job-accepted"): { job: TurnJobSnapshot } {
  const now = Date.now();
  return {
    job: {
      jobId,
      sessionId,
      status: "running",
      acceptedAt: now,
      updatedAt: now,
      summary: "任务已接收",
      steps: []
    }
  };
}

function makeCompletedSnapshot(
  sessionId: string,
  jobId = "job-accepted",
  options?: {
    title?: string;
    content?: string;
    assistantContent?: string;
    attachedDocument?: FrontendSessionState["attachedDocument"];
  }
): { job: TurnJobSnapshot; session: FrontendSessionState } {
  const now = Date.now();
  const content = options?.content ?? "默认消息";
  return {
    job: {
      jobId,
      sessionId,
      status: "completed",
      acceptedAt: now,
      updatedAt: now,
      summary: "任务已完成",
      steps: []
    },
    session: makeSessionState({
      sessionId,
      title: options?.title ?? "已完成会话",
      attachedDocument: options?.attachedDocument ?? null,
      messages: [
        {
          messageId: "user-1",
          sessionId,
          role: "user",
          content
        },
        {
          messageId: "assistant-1",
          sessionId,
          role: "assistant",
          content: options?.assistantContent ?? "已开始处理"
        }
      ]
    })
  };
}

function makeDocxFile(name = "sample.docx"): File {
  return new File(["docx"], name, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
}

async function flushSend(sendPromise: Promise<void>) {
  await vi.runAllTimersAsync();
  await sendPromise;
}

async function loadStore(options?: {
  fetchSessionsImpl?: () => Promise<ChatSession[]>;
  fetchSessionStateImpl?: (sessionId: string) => Promise<FrontendSessionState>;
  createSessionImpl?: () => Promise<FrontendSessionState>;
  attachDocumentImpl?: (sessionId: string, file: File) => Promise<FrontendSessionState>;
  submitTurnAsyncImpl?: (sessionId: string, content: string) => Promise<{ job: TurnJobSnapshot }>;
  fetchMessageJobImpl?: (
    sessionId: string,
    jobId: string
  ) => Promise<{ job: TurnJobSnapshot; session?: FrontendSessionState | null }>;
}) {
  const fetchSessions = vi.fn(
    options?.fetchSessionsImpl ?? (() => Promise.resolve([makeSidebarSession("chat-history-1")]))
  );
  const fetchSessionState = vi.fn(
    options?.fetchSessionStateImpl ??
      ((sessionId: string) =>
        Promise.resolve(makeSessionState({ sessionId, title: `历史会话 ${sessionId}` })))
  );
  const createSession = vi.fn(
    options?.createSessionImpl ??
      (() => Promise.resolve(makeSessionState({ sessionId: "chat-created-1", title: "新对话" })))
  );
  const attachDocument = vi.fn(
    options?.attachDocumentImpl ??
      ((sessionId: string, file: File) =>
        Promise.resolve(
          makeSessionState({
            sessionId,
            attachedDocument: { name: file.name, path: `/uploads/${file.name}` }
          })
        ))
  );
  const submitTurnAsync = vi.fn(
    options?.submitTurnAsyncImpl ??
      ((sessionId: string) => Promise.resolve(makeAcceptedJob(sessionId)))
  );
  const fetchMessageJob = vi.fn(
    options?.fetchMessageJobImpl ??
      ((sessionId: string, jobId: string) => Promise.resolve(makeCompletedSnapshot(sessionId, jobId)))
  );

  vi.doMock("../../frontend/services/api", () => ({
    attachDocument,
    createSession,
    deleteSession: vi.fn(),
    fetchMessageJob,
    fetchModelConfig: vi.fn(() =>
      Promise.resolve({
        chat: { baseUrl: "http://localhost:8080/v1", apiKey: "sk", model: "gpt" },
        planner: {
          baseUrl: "http://localhost:8080/v1",
          apiKey: "sk",
          model: "gpt",
          runtimeMode: "react_loop"
        }
      })
    ),
    fetchSessionState,
    fetchSessions,
    normalizeMessages: (messages: unknown[] | undefined) => messages ?? [],
    saveModelConfig: vi.fn(),
    submitTurnAsync,
    updateSessionTitle: vi.fn()
  }));

  const module = await import("../../frontend/store/useChatStore");
  return {
    store: module.useChatStore,
    api: {
      attachDocument,
      createSession,
      fetchMessageJob,
      fetchSessionState,
      fetchSessions,
      submitTurnAsync
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
  vi.unmock("../../frontend/services/api");
});

describe("frontend chat store session selection semantics", () => {
  it("creates a new session for the first send after initialize when history exists but no session was explicitly selected", async () => {
    const callOrder: string[] = [];
    let fetchSessionsCount = 0;
    const { store, api } = await loadStore({
      fetchSessionsImpl: async () => {
        fetchSessionsCount += 1;
        return fetchSessionsCount === 1
          ? [makeSidebarSession("chat-history-1", "历史 A")]
          : [makeSidebarSession("chat-new-1", "新对话"), makeSidebarSession("chat-history-1", "历史 A")];
      },
      createSessionImpl: async () => {
        callOrder.push("create");
        return makeSessionState({ sessionId: "chat-new-1", title: "新对话" });
      },
      submitTurnAsyncImpl: async (sessionId, content) => {
        callOrder.push("submit");
        expect(sessionId).toBe("chat-new-1");
        expect(content).toBe("你好");
        return makeAcceptedJob(sessionId, "job-new-1");
      },
      fetchMessageJobImpl: async (sessionId, jobId) =>
        makeCompletedSnapshot(sessionId, jobId, { title: "新对话", content: "你好" })
    });

    await store.getState().initialize();
    await flushSend(store.getState().sendMessage("你好"));

    expect(api.createSession).toHaveBeenCalledOnce();
    expect(api.submitTurnAsync).toHaveBeenCalledWith("chat-new-1", "你好");
    expect(callOrder).toEqual(["create", "submit"]);
    expect(store.getState().currentSessionId).toBe("chat-new-1");
  });

  it("reuses the selected history session after the user explicitly switches to it", async () => {
    const callOrder: string[] = [];
    const { store, api } = await loadStore({
      fetchSessionsImpl: async () => [makeSidebarSession("chat-history-9", "历史 B")],
      fetchSessionStateImpl: async (sessionId) =>
        makeSessionState({
          sessionId,
          title: "历史 B",
          messages: [
            {
              messageId: "history-1",
              sessionId,
              role: "assistant",
              content: "之前的上下文"
            }
          ]
        }),
      submitTurnAsyncImpl: async (sessionId, content) => {
        callOrder.push("submit");
        expect(sessionId).toBe("chat-history-9");
        expect(content).toBe("继续处理");
        return makeAcceptedJob(sessionId, "job-history-9");
      },
      fetchMessageJobImpl: async (sessionId, jobId) =>
        makeCompletedSnapshot(sessionId, jobId, { title: "历史 B", content: "继续处理" })
    });

    await store.getState().initialize();
    await store.getState().setCurrentSession("chat-history-9");
    await flushSend(store.getState().sendMessage("继续处理"));

    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.submitTurnAsync).toHaveBeenCalledWith("chat-history-9", "继续处理");
    expect(callOrder).toEqual(["submit"]);
    expect(store.getState().currentSessionId).toBe("chat-history-9");
  });

  it("still creates a remote session when sending from an explicit draft session", async () => {
    const callOrder: string[] = [];
    const { store, api } = await loadStore({
      fetchSessionsImpl: async () => [makeSidebarSession("chat-draft-remote", "新建对话")],
      createSessionImpl: async () => {
        callOrder.push("create");
        return makeSessionState({ sessionId: "chat-draft-remote", title: "新建对话" });
      },
      submitTurnAsyncImpl: async (sessionId, content) => {
        callOrder.push("submit");
        expect(sessionId).toBe("chat-draft-remote");
        expect(content).toBe("从草稿开始");
        return makeAcceptedJob(sessionId, "job-draft-remote");
      },
      fetchMessageJobImpl: async (sessionId, jobId) =>
        makeCompletedSnapshot(sessionId, jobId, { title: "新建对话", content: "从草稿开始" })
    });

    store.getState().startDraftSession();
    expect(store.getState().currentSessionId).toMatch(/^draft:/);

    await flushSend(store.getState().sendMessage("从草稿开始"));

    expect(api.createSession).toHaveBeenCalledOnce();
    expect(api.submitTurnAsync).toHaveBeenCalledWith("chat-draft-remote", "从草稿开始");
    expect(callOrder).toEqual(["create", "submit"]);
    expect(store.getState().currentSessionId).toBe("chat-draft-remote");
  });

  it("creates, attaches, and submits in order for a blank first turn with a pending document", async () => {
    const callOrder: string[] = [];
    let fetchSessionsCount = 0;
    const { store, api } = await loadStore({
      fetchSessionsImpl: async () => {
        fetchSessionsCount += 1;
        return fetchSessionsCount === 1
          ? [makeSidebarSession("chat-history-2", "历史 C")]
          : [makeSidebarSession("chat-new-doc", "文档新会话"), makeSidebarSession("chat-history-2", "历史 C")];
      },
      createSessionImpl: async () => {
        callOrder.push("create");
        return makeSessionState({ sessionId: "chat-new-doc", title: "文档新会话" });
      },
      attachDocumentImpl: async (sessionId, file) => {
        callOrder.push("attach");
        return makeSessionState({
          sessionId,
          title: "文档新会话",
          attachedDocument: { name: file.name, path: `/uploads/${file.name}` }
        });
      },
      submitTurnAsyncImpl: async (sessionId, content) => {
        callOrder.push("submit");
        expect(sessionId).toBe("chat-new-doc");
        expect(content).toBe(FILE_ONLY_FALLBACK_PROMPT);
        return makeAcceptedJob(sessionId, "job-new-doc");
      },
      fetchMessageJobImpl: async (sessionId, jobId) =>
        makeCompletedSnapshot(sessionId, jobId, {
          title: "文档新会话",
          content: FILE_ONLY_FALLBACK_PROMPT,
          attachedDocument: { name: "brief.docx", path: "/uploads/brief.docx" }
        })
    });

    await store.getState().initialize();
    await store.getState().importDocument(makeDocxFile("brief.docx"));

    const draftId = store.getState().currentSessionId;
    expect(draftId).toMatch(/^draft:/);
    expect(store.getState().pendingDocuments[draftId!]?.name).toBe("brief.docx");

    await flushSend(store.getState().sendMessage(""));

    expect(api.createSession).toHaveBeenCalledOnce();
    expect(api.attachDocument).toHaveBeenCalledOnce();
    expect(api.submitTurnAsync).toHaveBeenCalledWith("chat-new-doc", FILE_ONLY_FALLBACK_PROMPT);
    expect(callOrder).toEqual(["create", "attach", "submit"]);
    expect(store.getState().currentSessionId).toBe("chat-new-doc");
    expect(store.getState().attachedDocuments["chat-new-doc"]?.name).toBe("brief.docx");
    expect(store.getState().pendingDocuments["chat-new-doc"]).toBeNull();
  });
});
