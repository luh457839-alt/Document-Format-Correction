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

  it("persists latest turn-run snapshot and uses a fresh run id for each turn", async () => {
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
      await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "第一条消息"
      });
      const firstRun = await store.getLatestTurnRun("chat-main");
      expect(firstRun?.status).toBe("completed");
      expect(firstRun?.mode).toBe("chat");
      expect(firstRun?.goal).toBe("answer the user");
      expect(firstRun?.steps.map((step) => step.id)).toEqual(["decide_mode", "generate_reply"]);
      expect(firstRun?.steps.every((step) => step.status === "completed")).toBe(true);

      await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "第二条消息"
      });
      const latestRun = await store.getLatestTurnRun("chat-main");
      expect(latestRun?.turnRunId).not.toBe(firstRun?.turnRunId);
      expect(latestRun?.userInput).toBe("第二条消息");
      expect(latestRun?.status).toBe("completed");

      const fetchedById = await store.getTurnRun(latestRun?.turnRunId ?? "");
      expect(fetchedById?.turnRunId).toBe(latestRun?.turnRunId);
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

  it("does not block execute mode when the observation only contains empty structural paragraphs", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const runtimeCalls: Array<{ goal: string; doc: DocumentIR }> = [];
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          ...baseTurnDecision,
          mode: "execute",
          goal: "尝试处理空段落文档",
          requiresDocument: true
        }),
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => ({
        run: async (goal: string, doc: DocumentIR) => {
          runtimeCalls.push({ goal, doc });
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
        paragraphs: [{ id: "p_1", text: "", role: "body", run_ids: ["p_1_r_missing"], in_table: false }],
        nodes: [{ id: "p_1", node_type: "paragraph", children: [] }]
      })
    });

    try {
      await service.attachDocument("chat-main", "D:/docs/sample.docx");
      const result = await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "处理这个空段落文档"
      });

      expect(result.response.mode).toBe("execute");
      expect(runtimeCalls).toHaveLength(1);
      expect(runtimeCalls[0]?.doc.nodes).toEqual([]);
      expect((runtimeCalls[0]?.doc.metadata?.structureIndex as { paragraphs?: Array<{ id: string }> }).paragraphs?.[0]?.id).toBe(
        "p_1"
      );
    } finally {
      store.close();
    }
  });

  it("aggregates repeated write events from the same semantic group into one summary step", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          ...baseTurnDecision,
          mode: "execute",
          goal: "把正文字号改成22",
          requiresDocument: true
        }),
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => ({
        run: async (_goal: string, doc: DocumentIR, options?: Record<string, unknown>) => {
          const emit = options?.onExecutionEvent as
            | ((event: {
                type: string;
                stepId?: string;
                status?: string;
                payload?: Record<string, unknown>;
              }) => Promise<void>)
            | undefined;
          await emit?.({
            type: "step_started",
            stepId: "step_set_size_body__1",
            payload: {
              toolName: "write_operation",
              operationType: "set_size",
              targetNodeId: "p_1_r_0",
              targetSelector: { scope: "body" }
            }
          });
          await emit?.({
            type: "step_succeeded",
            stepId: "step_set_size_body__1",
            payload: {
              toolName: "write_operation",
              operationType: "set_size",
              targetNodeId: "p_1_r_0",
              targetSelector: { scope: "body" },
              summary: "Applied set_size to p_1_r_0."
            }
          });
          await emit?.({
            type: "step_started",
            stepId: "step_set_size_body__2",
            payload: {
              toolName: "write_operation",
              operationType: "set_size",
              targetNodeId: "p_1_r_1",
              targetSelector: { scope: "body" }
            }
          });
          await emit?.({
            type: "step_succeeded",
            stepId: "step_set_size_body__2",
            payload: {
              toolName: "write_operation",
              operationType: "set_size",
              targetNodeId: "p_1_r_1",
              targetSelector: { scope: "body" },
              summary: "Applied set_size to p_1_r_1."
            }
          });

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
              { id: "p_1_r_0", node_type: "text_run", content: "第一段", style: {} },
              { id: "p_1_r_1", node_type: "text_run", content: "第二段", style: {} }
            ]
          }
        ]
      })
    });

    try {
      await service.attachDocument("chat-main", "D:/docs/sample.docx");
      await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "把正文字号改成22"
      });

      const latestRun = await store.getLatestTurnRun("chat-main");
      expect(latestRun?.steps.map((step) => step.id)).not.toContain("runtime:step_set_size_body__1");
      expect(latestRun?.steps.map((step) => step.id)).not.toContain("runtime:step_set_size_body__2");

      const aggregateStep = latestRun?.steps.find((step) => step.id === "runtime:summary:body:set_size");
      expect(aggregateStep).toMatchObject({
        status: "completed",
        title: "已完成正文字号修改，共计2次"
      });
    } finally {
      store.close();
    }
  });

  it("uses batched targetNodeIds count for aggregated write summaries", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          ...baseTurnDecision,
          mode: "execute",
          goal: "把正文字体改成宋体",
          requiresDocument: true
        }),
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => ({
        run: async (_goal: string, doc: DocumentIR, options?: Record<string, unknown>) => {
          const emit = options?.onExecutionEvent as
            | ((event: {
                type: string;
                stepId?: string;
                status?: string;
                payload?: Record<string, unknown>;
              }) => Promise<void>)
            | undefined;
          await emit?.({
            type: "step_started",
            stepId: "step_set_font_body",
            payload: {
              toolName: "write_operation",
              operationType: "set_font",
              targetNodeIds: ["p_1_r_0", "p_1_r_1", "p_2_r_0"],
              targetSelector: { scope: "body" }
            }
          });
          await emit?.({
            type: "step_succeeded",
            stepId: "step_set_font_body",
            payload: {
              toolName: "write_operation",
              operationType: "set_font",
              targetNodeIds: ["p_1_r_0", "p_1_r_1", "p_2_r_0"],
              targetSelector: { scope: "body" },
              summary: "Applied set_font to 3 nodes."
            }
          });

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
        nodes: [
          {
            node_type: "paragraph",
            children: [
              { id: "p_1_r_0", node_type: "text_run", content: "第一段", style: {} },
              { id: "p_1_r_1", node_type: "text_run", content: "第二段", style: {} }
            ]
          },
          {
            node_type: "paragraph",
            children: [{ id: "p_2_r_0", node_type: "text_run", content: "第三段", style: {} }]
          }
        ]
      })
    });

    try {
      await service.attachDocument("chat-main", "D:/docs/sample.docx");
      await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "把正文字体改成宋体"
      });

      const latestRun = await store.getLatestTurnRun("chat-main");
      expect(latestRun?.steps.find((step) => step.id === "runtime:summary:body:set_font")).toMatchObject({
        title: "已完成正文字体修改，共计3次",
        status: "completed"
      });
    } finally {
      store.close();
    }
  });

  it("keeps different semantic groups separate and preserves non-write runtime steps", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          ...baseTurnDecision,
          mode: "execute",
          goal: "批量调整正文和标题样式",
          requiresDocument: true
        }),
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => ({
        run: async (_goal: string, doc: DocumentIR, options?: Record<string, unknown>) => {
          const emit = options?.onExecutionEvent as
            | ((event: {
                type: string;
                stepId?: string;
                status?: string;
                payload?: Record<string, unknown>;
              }) => Promise<void>)
            | undefined;
          await emit?.({
            type: "step_started",
            stepId: "inspect_current_styles",
            payload: {
              toolName: "inspect_document",
              summary: "Inspecting document styles."
            }
          });
          await emit?.({
            type: "step_succeeded",
            stepId: "inspect_current_styles",
            payload: {
              toolName: "inspect_document",
              summary: "Observed document styles."
            }
          });
          await emit?.({
            type: "step_succeeded",
            stepId: "step_set_size_body__1",
            payload: {
              toolName: "write_operation",
              operationType: "set_size",
              targetNodeId: "p_1_r_0",
              targetSelector: { scope: "body" },
              summary: "Applied set_size to p_1_r_0."
            }
          });
          await emit?.({
            type: "step_succeeded",
            stepId: "step_set_font_color_heading__1",
            payload: {
              toolName: "write_operation",
              operationType: "set_font_color",
              targetNodeId: "p_0_r_0",
              targetSelector: { scope: "heading", headingLevel: 1 },
              summary: "Applied set_font_color to p_0_r_0."
            }
          });

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
        nodes: [
          {
            node_type: "paragraph",
            children: [{ id: "p_0_r_0", node_type: "text_run", content: "标题", style: {} }]
          },
          {
            node_type: "paragraph",
            children: [{ id: "p_1_r_0", node_type: "text_run", content: "正文", style: {} }]
          }
        ]
      })
    });

    try {
      await service.attachDocument("chat-main", "D:/docs/sample.docx");
      await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "批量调整正文和标题样式"
      });

      const latestRun = await store.getLatestTurnRun("chat-main");
      expect(latestRun?.steps.find((step) => step.id === "runtime:inspect_current_styles")).toMatchObject({
        status: "completed",
        title: "执行步骤 inspect_current_styles"
      });
      expect(latestRun?.steps.find((step) => step.id === "runtime:summary:body:set_size")).toMatchObject({
        title: "已完成正文字号修改，共计1次"
      });
      expect(latestRun?.steps.find((step) => step.id === "runtime:summary:heading:set_font_color")).toMatchObject({
        title: "已完成标题颜色修改，共计1次"
      });
    } finally {
      store.close();
    }
  });

  it("marks a write summary step as failed and keeps the original error summary", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          ...baseTurnDecision,
          mode: "execute",
          goal: "把标题颜色改成红色",
          requiresDocument: true
        }),
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => ({
        run: async (_goal: string, doc: DocumentIR, options?: Record<string, unknown>) => {
          const emit = options?.onExecutionEvent as
            | ((event: {
                type: string;
                stepId?: string;
                status?: string;
                payload?: Record<string, unknown>;
              }) => Promise<void>)
            | undefined;
          await emit?.({
            type: "step_started",
            stepId: "step_set_font_color_heading__1",
            payload: {
              toolName: "write_operation",
              operationType: "set_font_color",
              targetNodeId: "p_0_r_0",
              targetSelector: { scope: "heading", headingLevel: 1 }
            }
          });
          await emit?.({
            type: "step_failed",
            stepId: "step_set_font_color_heading__1",
            payload: {
              toolName: "write_operation",
              operationType: "set_font_color",
              targetNodeId: "p_0_r_0",
              targetSelector: { scope: "heading", headingLevel: 1 },
              error: {
                code: "E_DOCX_WRITE_FAILED",
                message: "DOCX write failed: permission denied",
                retryable: false
              }
            }
          });

          return {
            status: "failed",
            finalDoc: doc,
            changeSet: { taskId: "chat-main-task", changes: [], rolledBack: false },
            steps: [],
            summary: "执行失败"
          } satisfies ExecutionResult;
        }
      }),
      observeDocument: async () => ({
        document_meta: { total_paragraphs: 1, total_tables: 0 },
        nodes: [
          {
            node_type: "paragraph",
            children: [{ id: "p_0_r_0", node_type: "text_run", content: "标题", style: {} }]
          }
        ]
      })
    });

    try {
      await service.attachDocument("chat-main", "D:/docs/sample.docx");
      await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "把标题颜色改成红色"
      });

      const latestRun = await store.getLatestTurnRun("chat-main");
      expect(latestRun?.status).toBe("failed");
      expect(latestRun?.steps.find((step) => step.id === "runtime:summary:heading:set_font_color")).toMatchObject({
        status: "failed",
        detail: "DOCX write failed: permission denied"
      });
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

  it("defaults body edits to include list items and appends the execution note", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const saveGoalSpy = vi.spyOn(store, "saveGoal");
    const observeDocument = vi.fn(async () => ({
      document_meta: { total_paragraphs: 2, total_tables: 0 },
      paragraphs: [
        { id: "p_1", text: "普通正文", role: "body", run_ids: ["p_1_r_0"], in_table: false },
        { id: "p_2", text: "编号正文", role: "list_item", list_level: 0, run_ids: ["p_2_r_0"], in_table: false }
      ],
      nodes: [
        { node_type: "paragraph", children: [{ id: "p_1_r_0", node_type: "text_run", content: "普通正文" }] },
        { node_type: "paragraph", children: [{ id: "p_2_r_0", node_type: "text_run", content: "编号正文" }] }
      ]
    }));
    const runtimeRun = vi.fn(async (goal: string, doc: DocumentIR) => ({
      status: "completed",
      finalDoc: doc,
      changeSet: { taskId: "chat-main-task", changes: [], rolledBack: false },
      steps: [],
      summary: `已执行：${goal}`
    }));
    const respondToClarification = vi.fn(async () => "unused");
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          mode: "execute",
          goal: "把正文改成红色",
          requiresDocument: true,
          needsClarification: false,
          clarificationKind: "none",
          clarificationReason: ""
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

      expect(result.response.mode).toBe("execute");
      expect(observeDocument).toHaveBeenCalledWith("D:/docs/sample.docx");
      expect(respondToClarification).not.toHaveBeenCalled();
      expect(saveGoalSpy).toHaveBeenCalledWith(
        "chat-main",
        expect.stringContaining("普通正文和项目符号/编号段落"),
        "execute",
        "active"
      );
      expect(result.response.content).toContain("普通正文和项目符号/编号段落");
      expect(result.response.content).toContain("说明：本次按默认规则同时修改了普通正文和 list_item。");
      expect(result.session.activeGoal?.goal).toContain("普通正文和项目符号/编号段落");
      expect(runtimeRun).toHaveBeenCalledOnce();
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
              goal: "澄清标题范围",
              requiresDocument: true,
              needsClarification: true,
              clarificationKind: "heading_scope",
              clarificationReason: "标题范围不明确"
            };
          }
          return {
            ...baseTurnDecision,
            mode: "execute",
            goal: "把所有标题改成红色",
            requiresDocument: true
          };
        },
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () =>
          "【需求澄清】\n1. 只改一级标题\n2. 改所有标题\n请回复选项编号，或直接补充更具体的要求。"
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
        userInput: "2"
      });

      expect(result.response.mode).toBe("execute");
      expect(runtimeCalls).toHaveLength(1);
      expect(runtimeCalls[0]?.goal).toBe("把所有标题改成红色");
      expect(Array.isArray(runtimeCalls[0]?.options?.sessionContext)).toBe(true);
      const sessionContext = runtimeCalls[0]?.options?.sessionContext as Array<{ role: string; content: string }>;
      expect(sessionContext.some((item) => item.content.includes("【需求澄清】"))).toBe(true);
      expect(sessionContext.at(-1)?.content).toBe("2");
      expect(result.response.content).not.toContain("说明：本次按默认规则同时修改了普通正文和 list_item。");
    } finally {
      store.close();
    }
  });

  it("does not expand when the goal explicitly says ordinary body only", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const runtimeRun = vi.fn(async (goal: string, doc: DocumentIR) => ({
      status: "completed",
      finalDoc: doc,
      changeSet: { taskId: "chat-main-task", changes: [], rolledBack: false },
      steps: [],
      summary: `已执行：${goal}`
    }));
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          mode: "execute",
          goal: "只改普通正文为红色",
          requiresDocument: true,
          needsClarification: false,
          clarificationKind: "none",
          clarificationReason: ""
        }),
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => ({
        run: runtimeRun
      }),
      observeDocument: async () => ({
        document_meta: { total_paragraphs: 2, total_tables: 0 },
        nodes: [
          { node_type: "paragraph", children: [{ id: "p_1_r_0", node_type: "text_run", content: "普通正文" }] },
          { node_type: "paragraph", children: [{ id: "p_2_r_0", node_type: "text_run", content: "编号正文" }] }
        ]
      })
    });

    try {
      await service.attachDocument("chat-main", "D:/docs/sample.docx");
      const result = await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "只改普通正文为红色"
      });

      expect(runtimeRun).toHaveBeenCalledOnce();
      expect(runtimeRun.mock.calls[0]?.[0]).toBe("只改普通正文为红色");
      expect(result.response.content).not.toContain("说明：本次按默认规则同时修改了普通正文和 list_item。");
    } finally {
      store.close();
    }
  });

  it("does not expand when the goal explicitly targets list items only", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });
    const runtimeRun = vi.fn(async (goal: string, doc: DocumentIR) => ({
      status: "completed",
      finalDoc: doc,
      changeSet: { taskId: "chat-main-task", changes: [], rolledBack: false },
      steps: [],
      summary: `已执行：${goal}`
    }));
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          mode: "execute",
          goal: "只改编号段落为红色",
          requiresDocument: true,
          needsClarification: false,
          clarificationKind: "none",
          clarificationReason: ""
        }),
        respondToConversation: async () => "unused",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => ({
        run: runtimeRun
      }),
      observeDocument: async () => ({
        document_meta: { total_paragraphs: 2, total_tables: 0 },
        nodes: [
          { node_type: "paragraph", children: [{ id: "p_1_r_0", node_type: "text_run", content: "普通正文" }] },
          { node_type: "paragraph", children: [{ id: "p_2_r_0", node_type: "text_run", content: "编号正文" }] }
        ]
      })
    });

    try {
      await service.attachDocument("chat-main", "D:/docs/sample.docx");
      const result = await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "只改编号段落为红色"
      });

      expect(runtimeRun).toHaveBeenCalledOnce();
      expect(runtimeRun.mock.calls[0]?.[0]).toBe("只改编号段落为红色");
      expect(result.response.content).not.toContain("说明：本次按默认规则同时修改了普通正文和 list_item。");
    } finally {
      store.close();
    }
  });
});
