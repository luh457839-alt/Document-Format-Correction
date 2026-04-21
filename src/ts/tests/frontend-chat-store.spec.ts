import { afterEach, describe, expect, it, vi } from "vitest";

const FILE_ONLY_FALLBACK_PROMPT = "请先分析我上传的文档并开始处理。";

interface MockSessionState {
  sessionId: string;
  title: string;
  messages: Array<{
    messageId: string;
    sessionId: string;
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  attachedDocument: { name?: string; path?: string } | null;
}

function makeSessionState(overrides: Partial<MockSessionState>): MockSessionState {
  return {
    sessionId: "chat-remote-1",
    title: "远端会话",
    messages: [],
    attachedDocument: null,
    ...overrides
  };
}

function makeSidebarSession(sessionId: string, title = "远端会话") {
  return {
    sessionId,
    title,
    createdAt: 0,
    updatedAt: 0
  };
}

function makeDocxFile(name = "sample.docx"): File {
  return new File(["docx"], name, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
}

async function loadStore(options?: {
  createSessionImpl?: () => Promise<MockSessionState>;
  attachDocumentImpl?: (sessionId: string, file: File) => Promise<MockSessionState>;
  submitTurnImpl?: (sessionId: string, content: string) => Promise<MockSessionState>;
  fetchSessionsImpl?: () => Promise<Array<ReturnType<typeof makeSidebarSession>>>;
}) {
  const createSession = vi.fn(
    options?.createSessionImpl ??
      (() => Promise.resolve(makeSessionState({ sessionId: "chat-remote-1" })))
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
  const submitTurn = vi.fn(
    options?.submitTurnImpl ??
      ((sessionId: string, content: string) =>
        Promise.resolve(
          makeSessionState({
            sessionId,
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
                content: "已开始处理"
              }
            ]
          })
        ))
  );
  const fetchSessions = vi.fn(
    options?.fetchSessionsImpl ?? (() => Promise.resolve([makeSidebarSession("chat-remote-1")]))
  );

  vi.doMock("../../frontend/services/api", () => ({
    attachDocument,
    createSession,
    deleteSession: vi.fn(),
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
    fetchSessionState: vi.fn(),
    fetchSessions,
    normalizeMessages: (messages: unknown[] | undefined) => messages ?? [],
    saveModelConfig: vi.fn(),
    submitTurn,
    updateSessionTitle: vi.fn()
  }));

  const module = await import("../../frontend/store/useChatStore");
  return {
    store: module.useChatStore,
    api: {
      createSession,
      attachDocument,
      submitTurn,
      fetchSessions
    }
  };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unmock("../../frontend/services/api");
});

describe("frontend chat store pending document flow", () => {
  it("stages selected document in a draft session without creating upload errors", async () => {
    const { store, api } = await loadStore();

    store.getState().startDraftSession();
    const draftId = store.getState().currentSessionId;
    expect(draftId).toBeTruthy();

    await store.getState().importDocument(makeDocxFile());

    expect(store.getState().error).toBeNull();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.attachDocument).not.toHaveBeenCalled();
    expect(store.getState().pendingDocuments[draftId!]?.name).toBe("sample.docx");
  });

  it("creates a remote session, uploads the pending document, and submits fallback text for file-only send", async () => {
    const callOrder: string[] = [];
    const { store, api } = await loadStore({
      createSessionImpl: async () => {
        callOrder.push("create");
        return makeSessionState({ sessionId: "chat-remote-1" });
      },
      attachDocumentImpl: async (sessionId, file) => {
        callOrder.push("attach");
        return makeSessionState({
          sessionId,
          attachedDocument: { name: file.name, path: `/uploads/${file.name}` }
        });
      },
      submitTurnImpl: async (sessionId, content) => {
        callOrder.push("submit");
        return makeSessionState({
          sessionId,
          messages: [
            { messageId: "user-1", sessionId, role: "user", content },
            { messageId: "assistant-1", sessionId, role: "assistant", content: "已开始处理" }
          ],
          attachedDocument: { name: "sample.docx", path: "/uploads/sample.docx" }
        });
      }
    });

    store.getState().startDraftSession();
    await store.getState().importDocument(makeDocxFile());

    const sent = await store.getState().sendMessage("");

    expect(sent).toBe(true);
    expect(callOrder).toEqual(["create", "attach", "submit"]);
    expect(api.submitTurn).toHaveBeenCalledWith("chat-remote-1", FILE_ONLY_FALLBACK_PROMPT);
    expect(store.getState().currentSessionId).toBe("chat-remote-1");
    expect(store.getState().pendingDocuments["chat-remote-1"]).toBeNull();
    expect(store.getState().attachedDocuments["chat-remote-1"]?.name).toBe("sample.docx");
  });

  it("uploads pending document before sending typed text and clears staged file on success", async () => {
    const callOrder: string[] = [];
    const { store, api } = await loadStore({
      createSessionImpl: async () => {
        callOrder.push("create");
        return makeSessionState({ sessionId: "chat-remote-2" });
      },
      attachDocumentImpl: async (sessionId, file) => {
        callOrder.push("attach");
        return makeSessionState({
          sessionId,
          attachedDocument: { name: file.name, path: `/uploads/${file.name}` }
        });
      },
      submitTurnImpl: async (sessionId, content) => {
        callOrder.push("submit");
        return makeSessionState({
          sessionId,
          messages: [
            { messageId: "user-1", sessionId, role: "user", content },
            { messageId: "assistant-1", sessionId, role: "assistant", content: "已收到文本和文件" }
          ],
          attachedDocument: { name: "brief.docx", path: "/uploads/brief.docx" }
        });
      },
      fetchSessionsImpl: async () => [makeSidebarSession("chat-remote-2")]
    });

    store.getState().startDraftSession();
    await store.getState().importDocument(makeDocxFile("brief.docx"));

    const sent = await store.getState().sendMessage("请帮我总结重点");

    expect(sent).toBe(true);
    expect(callOrder).toEqual(["create", "attach", "submit"]);
    expect(api.submitTurn).toHaveBeenCalledWith("chat-remote-2", "请帮我总结重点");
    expect(store.getState().pendingDocuments["chat-remote-2"]).toBeNull();
    expect(store.getState().messages["chat-remote-2"][0]?.content).toBe("请帮我总结重点");
  });

  it("keeps the pending document when first-turn submit fails after upload", async () => {
    const { store, api } = await loadStore({
      createSessionImpl: async () => makeSessionState({ sessionId: "chat-remote-3" }),
      attachDocumentImpl: async (sessionId, file) =>
        makeSessionState({
          sessionId,
          attachedDocument: { name: file.name, path: `/uploads/${file.name}` }
        }),
      submitTurnImpl: async () => {
        throw new Error("首轮提交失败");
      },
      fetchSessionsImpl: async () => [makeSidebarSession("chat-remote-3")]
    });

    store.getState().startDraftSession();
    const draftId = store.getState().currentSessionId!;
    await store.getState().importDocument(makeDocxFile("retry.docx"));

    const sent = await store.getState().sendMessage("");

    expect(sent).toBe(false);
    expect(api.attachDocument).toHaveBeenCalledOnce();
    expect(store.getState().currentSessionId).toBe(draftId);
    expect(store.getState().sessions.find((session) => session.sessionId === draftId)?.remoteSessionId).toBe(
      "chat-remote-3"
    );
    expect(store.getState().pendingDocuments[draftId]?.name).toBe("retry.docx");
    expect(store.getState().error).toBe("首轮提交失败");
  });
});
