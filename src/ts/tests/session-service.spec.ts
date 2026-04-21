import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DocumentIR, ExecutionResult } from "../src/core/types.js";
import { LlmAgentModelGateway } from "../src/runtime/model-gateway.js";
import { AgentSessionService } from "../src/runtime/session-service.js";
import { SqliteAgentStateStore } from "../src/runtime/state/sqlite-agent-state-store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ts-agent-session-"));
  tempDirs.push(dir);
  return dir;
}

const baseTurnDecision = {
  mode: "chat",
  goal: "answer the user",
  requiresDocument: false,
  needsClarification: false,
  clarificationKind: "none",
  clarificationReason: ""
} as const;

describe("AgentSessionService", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("attaches document into TS state store", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({ ...baseTurnDecision, goal: "chat" }),
        respondToConversation: async () => "ok",
        respondToDocumentObservation: async () => "ok",
        respondToClarification: async () => "ok"
      },
      runtimeFactory: () => {
        throw new Error("not used");
      },
      observeDocument: async () => ({
        document_meta: { total_paragraphs: 1, total_tables: 0 },
        nodes: []
      })
    });

    try {
      const result = await service.attachDocument("chat-main", "D:/docs/sample.docx");
      expect(result.session.attachedDocument?.path).toBe("D:/docs/sample.docx");

      const snapshot = await service.getSessionState("chat-main");
      expect(snapshot.attachedDocument?.path).toBe("D:/docs/sample.docx");
      expect(snapshot.turns).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("renames and deletes persisted sessions", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({ ...baseTurnDecision }),
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => ({
        run: vi.fn()
      }),
      observeDocument: async () => ({
        document_meta: { total_paragraphs: 0, total_tables: 0 },
        nodes: []
      })
    });

    try {
      await service.createSession("chat-main");
      const renamed = await service.updateSessionTitle("chat-main", "已持久化标题");
      expect(renamed.session.title).toBe("已持久化标题");

      const listResult = await service.listSessions();
      expect(listResult.sessions).toContainEqual(
        expect.objectContaining({
          sessionId: "chat-main",
          title: "已持久化标题"
        })
      );

      await service.deleteSession("chat-main");
      await expect(service.getSessionState("chat-main")).rejects.toMatchObject({
        info: expect.objectContaining({
          code: "E_SESSION_NOT_FOUND"
        })
      });
    } finally {
      store.close();
    }
  });

  it("submits a chat turn entirely through TS and persists turns", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({ ...baseTurnDecision }),
        respondToConversation: async ({ messages }) =>
          `已收到：${String(messages[messages.length - 1]?.content ?? "")}`,
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => {
        throw new Error("not used");
      },
      observeDocument: async () => ({
        document_meta: { total_paragraphs: 0, total_tables: 0 },
        nodes: []
      })
    });

    try {
      const result = await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "你好，请总结当前状态"
      });

      expect(result.response.mode).toBe("chat");
      expect(result.response.goal).toBe("answer the user");
      expect(result.response.content).toContain("你好，请总结当前状态");
      expect(result.session.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
      expect(result.session.activeGoal?.goal).toBe("answer the user");
      expect(result.session.activeGoal?.mode).toBe("chat");
    } finally {
      store.close();
    }
  });

  it("passes unified session context into execute runtime without forcing runtime mode", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const runtimeCalls: Array<{ goal: string; doc: DocumentIR; options: Record<string, unknown> | undefined }> = [];
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          ...baseTurnDecision,
          mode: "execute",
          goal: "把文档字号调成22",
          requiresDocument: true
        }),
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => ({
        run: async (goal: string, doc: DocumentIR, options?: Record<string, unknown>) => {
          runtimeCalls.push({ goal, doc, options });
          return {
            status: "completed",
            finalDoc: {
              ...doc,
              metadata: {
                ...(doc.metadata ?? {}),
                outputDocxPath: "D:/Document Format Correction/output/chat-main.docx"
              }
            },
            changeSet: { taskId: "chat-main-task", changes: [], rolledBack: false },
            steps: [],
            summary: "字号已调整为22"
          } satisfies ExecutionResult;
        }
      }),
      observeDocument: async () => ({
        document_meta: { total_paragraphs: 1, total_tables: 0 },
        nodes: [
          {
            node_type: "paragraph",
            children: [
              {
                id: "p_0_r_0",
                node_type: "text_run",
                content: "第一段",
                style: { font_name: "宋体", font_size_pt: 12, operation: "set_font" }
              }
            ]
          }
        ]
      })
    });

    try {
      await service.attachDocument("chat-main", "D:/docs/sample.docx");
      const result = await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "把字号改成22"
      });

      expect(result.response.mode).toBe("execute");
      expect(result.response.content).toContain("字号已调整为22");
      expect(runtimeCalls).toHaveLength(1);
      expect(runtimeCalls[0]?.goal).toBe("把文档字号调成22");
      expect(runtimeCalls[0]?.doc.metadata?.inputDocxPath).toBe("D:/docs/sample.docx");
      expect(runtimeCalls[0]?.options?.runtimeMode).toBeUndefined();
      expect(Array.isArray(runtimeCalls[0]?.options?.sessionContext)).toBe(true);
      expect((runtimeCalls[0]?.options?.sessionContext as Array<{ role: string; content: string }>)[0]?.content).toBe(
        "把字号改成22"
      );
    } finally {
      store.close();
    }
  });

  it("defaults output path to root output directory", async () => {
    const dir = await makeTempDir();
    const previousCwd = process.cwd();
    const tsRoot = path.join(dir, "src", "ts");
    mkdirSync(tsRoot, { recursive: true });
    process.chdir(tsRoot);

    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "sessions", "state.db") });
    const runtimeCalls: Array<{ doc: DocumentIR }> = [];
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          ...baseTurnDecision,
          mode: "execute",
          goal: "输出到根目录 output",
          requiresDocument: true
        }),
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => ({
        run: async (_goal: string, doc: DocumentIR) => {
          runtimeCalls.push({ doc });
          return {
            status: "completed",
            finalDoc: doc,
            changeSet: { taskId: "chat-main-task", changes: [], rolledBack: false },
            steps: [],
            summary: "ok"
          } satisfies ExecutionResult;
        }
      }),
      observeDocument: async () => ({
        document_meta: { total_paragraphs: 1, total_tables: 0 },
        nodes: [
          {
            node_type: "paragraph",
            children: [{ id: "p_0_r_0", node_type: "text_run", content: "第一段", style: {} }]
          }
        ]
      })
    });

    try {
      await service.attachDocument("chat-main", "D:/docs/sample.docx");
      await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "执行一次"
      });

      expect(runtimeCalls[0]?.doc.metadata?.outputDocxPath).toBe(path.join(dir, "output", "chat-main.docx"));
    } finally {
      process.chdir(previousCwd);
      store.close();
    }
  });

  it("fails early when model returns a decision without goal", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const saveGoalSpy = vi.spyOn(store, "saveGoal");
    const respondToConversation = vi.fn(async () => "unused");
    const respondToDocumentObservation = vi.fn(async () => "unused");
    const respondToClarification = vi.fn(async () => "unused");
    const observeDocument = vi.fn(async () => ({
      document_meta: { total_paragraphs: 0, total_tables: 0 },
      nodes: []
    }));
    const runtimeRun = vi.fn();
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({ ...baseTurnDecision, goal: undefined } as never),
        respondToConversation,
        respondToDocumentObservation,
        respondToClarification
      },
      runtimeFactory: () => ({
        run: runtimeRun
      }),
      observeDocument
    });

    try {
      await expect(
        service.submitUserTurn({
          sessionId: "chat-main",
          userInput: "你好"
        })
      ).rejects.toMatchObject({
        info: expect.objectContaining({
          code: "E_TURN_DECISION_INVALID",
          message: expect.stringContaining("goal is required")
        })
      });

      expect(saveGoalSpy).not.toHaveBeenCalled();
      expect(respondToConversation).not.toHaveBeenCalled();
      expect(respondToDocumentObservation).not.toHaveBeenCalled();
      expect(respondToClarification).not.toHaveBeenCalled();
      expect(observeDocument).not.toHaveBeenCalled();
      expect(runtimeRun).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it.each(["inspect", "execute"] as const)(
    "keeps %s mode on E_DOCUMENT_REQUIRED when no document is attached",
    async (mode) => {
      const dir = await makeTempDir();
      const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
      const saveGoalSpy = vi.spyOn(store, "saveGoal");
      const respondToConversation = vi.fn(async () => "unused");
      const respondToDocumentObservation = vi.fn(async () => "unused");
      const respondToClarification = vi.fn(async () => "unused");
      const runtimeRun = vi.fn();
      const service = new AgentSessionService({
        store,
        modelGateway: {
          decideTurn: async () => ({
            ...baseTurnDecision,
            mode,
            goal: "处理文档",
            requiresDocument: true
          }),
          respondToConversation,
          respondToDocumentObservation,
          respondToClarification
        },
        runtimeFactory: () => ({
          run: runtimeRun
        }),
        observeDocument: async () => ({
          document_meta: { total_paragraphs: 0, total_tables: 0 },
          nodes: []
        })
      });

      try {
        await expect(
          service.submitUserTurn({
            sessionId: "chat-main",
            userInput: "处理文档"
          })
        ).rejects.toMatchObject({
          info: expect.objectContaining({
            code: "E_DOCUMENT_REQUIRED"
          })
        });

        expect(saveGoalSpy).not.toHaveBeenCalled();
        expect(respondToConversation).not.toHaveBeenCalled();
        expect(respondToDocumentObservation).not.toHaveBeenCalled();
        expect(respondToClarification).not.toHaveBeenCalled();
        expect(runtimeRun).not.toHaveBeenCalled();
      } finally {
        store.close();
      }
    }
  );

  it("rejects illegal mode and requiresDocument combinations", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const saveGoalSpy = vi.spyOn(store, "saveGoal");
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          ...baseTurnDecision,
          requiresDocument: true
        }),
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => ({
        run: vi.fn()
      }),
      observeDocument: async () => ({
        document_meta: { total_paragraphs: 0, total_tables: 0 },
        nodes: []
      })
    });

    try {
      await expect(
        service.submitUserTurn({
          sessionId: "chat-main",
          userInput: "你好"
        })
      ).rejects.toMatchObject({
        info: expect.objectContaining({
          code: "E_TURN_DECISION_INVALID",
          message: expect.stringContaining("mode=chat")
        })
      });

      expect(saveGoalSpy).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("uses trimmed userInput as goal for forceMode execute", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const runtimeCalls: Array<{ goal: string; doc: DocumentIR; options: Record<string, unknown> | undefined }> = [];
    const service = new AgentSessionService({
      store,
      modelGateway: new LlmAgentModelGateway({
        chatConfig: {
          apiKey: "test-key",
          baseUrl: "http://example.test/v1",
          model: "test-model"
        },
        plannerConfig: {
          apiKey: "test-key",
          baseUrl: "http://example.test/v1",
          model: "test-model"
        },
        fetchImpl: async () => {
          throw new Error("forceMode should not hit fetch");
        }
      }),
      runtimeFactory: () => ({
        run: async (goal: string, doc: DocumentIR, options?: Record<string, unknown>) => {
          runtimeCalls.push({ goal, doc, options });
          return {
            status: "completed",
            finalDoc: doc,
            changeSet: { taskId: "chat-main-task", changes: [], rolledBack: false },
            steps: [],
            summary: "执行完成"
          } satisfies ExecutionResult;
        }
      }),
      observeDocument: async () => ({
        document_meta: { total_paragraphs: 1, total_tables: 0 },
        nodes: [
          {
            node_type: "paragraph",
            children: [
              {
                id: "p_0_r_0",
                node_type: "text_run",
                content: "第一段",
                style: { font_name: "宋体", font_size_pt: 12, operation: "set_font" }
              }
            ]
          }
        ]
      })
    });

    try {
      await service.attachDocument("chat-main", "D:/docs/sample.docx");
      const result = await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "  执行当前文档格式修正  ",
        forceMode: "execute"
      });

      expect(result.response.mode).toBe("execute");
      expect(result.response.goal).toBe("执行当前文档格式修正");
      expect(runtimeCalls[0]?.goal).toBe("执行当前文档格式修正");
    } finally {
      store.close();
    }
  });

  it("inspects document and asks a clarification question instead of executing ambiguous edits", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const saveGoalSpy = vi.spyOn(store, "saveGoal");
    const observeDocument = vi.fn(async () => ({
      document_meta: { total_paragraphs: 2, total_tables: 0 },
      paragraphs: [
        { id: "p_1", text: "普通正文", role: "body", run_ids: ["p_1_r_0"], in_table: false },
        { id: "p_2", text: "编号正文", role: "list_item", list_level: 0, run_ids: ["p_2_r_0"], in_table: false }
      ],
      nodes: []
    }));
    const runtimeRun = vi.fn();
    const respondToClarification = vi.fn(async () => "【需求澄清】\n1. 只改普通正文\n2. 只改编号段落\n3. 两类都改");
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          mode: "chat",
          goal: "澄清正文范围",
          requiresDocument: true,
          needsClarification: true,
          clarificationKind: "selector_scope",
          clarificationReason: "正文可能不包含项目符号/编号段落"
        }),
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification
      },
      runtimeFactory: () => ({
        run: runtimeRun
      }),
      observeDocument
    });

    try {
      await service.attachDocument("chat-main", "D:/docs/sample.docx");
      const result = await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "把正文改成红色"
      });

      expect(result.response.mode).toBe("chat");
      expect(result.response.content).toContain("【需求澄清】");
      expect(observeDocument).toHaveBeenCalledWith("D:/docs/sample.docx");
      expect(respondToClarification).toHaveBeenCalledOnce();
      expect(saveGoalSpy).not.toHaveBeenCalled();
      expect(result.session.activeGoal).toBeUndefined();
      expect(runtimeRun).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("uses clarification follow-up context to proceed into execute", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const runtimeCalls: Array<{ goal: string; doc: DocumentIR; options: Record<string, unknown> | undefined }> = [];
    let decideCount = 0;
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => {
          decideCount += 1;
          if (decideCount === 1) {
            return {
              mode: "chat",
              goal: "澄清正文范围",
              requiresDocument: true,
              needsClarification: true,
              clarificationKind: "selector_scope",
              clarificationReason: "正文可能不包含项目符号/编号段落"
            };
          }
          return {
            ...baseTurnDecision,
            mode: "execute",
            goal: "将普通正文和项目符号/编号段落都改成红色",
            requiresDocument: true
          };
        },
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () =>
          "【需求澄清】\n1. 只改普通正文\n2. 只改编号段落\n3. 两类都改\n请回复选项编号，或直接补充更具体的要求。"
      },
      runtimeFactory: () => ({
        run: async (goal: string, doc: DocumentIR, options?: Record<string, unknown>) => {
          runtimeCalls.push({ goal, doc, options });
          return {
            status: "completed",
            finalDoc: doc,
            changeSet: { taskId: "chat-main-task", changes: [], rolledBack: false },
            steps: [],
            summary: "执行完成"
          } satisfies ExecutionResult;
        }
      }),
      observeDocument: async () => ({
        document_meta: { total_paragraphs: 2, total_tables: 0 },
        paragraphs: [
          { id: "p_1", text: "普通正文", role: "body", run_ids: ["p_1_r_0"], in_table: false },
          { id: "p_2", text: "编号正文", role: "list_item", list_level: 0, run_ids: ["p_2_r_0"], in_table: false }
        ],
        nodes: [
          { node_type: "paragraph", children: [{ id: "p_1_r_0", node_type: "text_run", content: "普通正文" }] },
          { node_type: "paragraph", children: [{ id: "p_2_r_0", node_type: "text_run", content: "编号正文" }] }
        ]
      })
    });

    try {
      await service.attachDocument("chat-main", "D:/docs/sample.docx");
      await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "把正文改成红色"
      });

      const result = await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "3"
      });

      expect(result.response.mode).toBe("execute");
      expect(runtimeCalls).toHaveLength(1);
      expect(runtimeCalls[0]?.goal).toContain("普通正文和项目符号/编号段落");
      expect(Array.isArray(runtimeCalls[0]?.options?.sessionContext)).toBe(true);
      const sessionContext = runtimeCalls[0]?.options?.sessionContext as Array<{ role: string; content: string }>;
      expect(sessionContext.some((item) => item.content.includes("【需求澄清】"))).toBe(true);
      expect(sessionContext.at(-1)?.content).toBe("3");
    } finally {
      store.close();
    }
  });
});
