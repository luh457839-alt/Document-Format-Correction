import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DocumentIR } from "../src/core/types.js";
import { DefaultExecutor } from "../src/executor/default-executor.js";
import { FixedPlanner } from "../src/planner/fixed-planner.js";
import { AgentRuntime } from "../src/runtime/engine.js";
import { DefaultValidator } from "../src/validator/default-validator.js";
import { InMemoryToolRegistry } from "../src/tools/tool-registry.js";
import { InspectDocumentTool, WriteOperationTool } from "../src/tools/mock-tools.js";
import { SqliteTaskAuditStore } from "../src/runtime/audit/sqlite-task-audit-store.js";
import type { ReActDecision, ReActTurnInput } from "../src/core/types.js";

const baseDoc: DocumentIR = {
  id: "audit-doc",
  version: "v1",
  nodes: [{ id: "n1", text: "hello" }]
};

describe("runtime audit persistence", () => {
  it("persists waiting_user and can resume with approved decision", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ts-agent-audit-"));
    const dbPath = path.join(tempDir, "runtime.db");
    let auditStore: SqliteTaskAuditStore | undefined;
    try {
      auditStore = new SqliteTaskAuditStore({ dbPath });
      const registry = new InMemoryToolRegistry();
      registry.register(new InspectDocumentTool());
      registry.register(new WriteOperationTool());
      const runtime = new AgentRuntime(
        new FixedPlanner(),
        new DefaultExecutor({
          toolRegistry: registry,
          riskPolicy: { requiresConfirmation: () => true }
        }),
        new DefaultValidator(),
        auditStore
      );

      const waiting = await runtime.run("goal", baseDoc);
      expect(waiting.status).toBe("waiting_user");
      const pending = await runtime.getPendingTask(waiting.changeSet.taskId);
      expect(pending).toBeTruthy();
      expect(pending?.pendingConfirmation.step.id).toBe("step_read_structure");

      const resumed = await runtime.resumePendingTask(waiting.changeSet.taskId, "approved");
      expect(resumed.status).toBe("completed");
      const after = await runtime.getPendingTask(waiting.changeSet.taskId);
      expect(after).toBeNull();
    } finally {
      auditStore?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("clears pending task when user rejects confirmation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ts-agent-audit-"));
    const dbPath = path.join(tempDir, "runtime.db");
    let auditStore: SqliteTaskAuditStore | undefined;
    try {
      auditStore = new SqliteTaskAuditStore({ dbPath });
      const registry = new InMemoryToolRegistry();
      registry.register(new InspectDocumentTool());
      registry.register(new WriteOperationTool());
      const runtime = new AgentRuntime(
        new FixedPlanner(),
        new DefaultExecutor({
          toolRegistry: registry,
          riskPolicy: { requiresConfirmation: () => true }
        }),
        new DefaultValidator(),
        auditStore
      );

      const waiting = await runtime.run("goal", baseDoc);
      expect(waiting.status).toBe("waiting_user");
      const rejected = await runtime.resumePendingTask(waiting.changeSet.taskId, "rejected");
      expect(rejected.status).toBe("failed");
      expect(rejected.summary).toContain("rejected");
      const pending = await runtime.getPendingTask(waiting.changeSet.taskId);
      expect(pending).toBeNull();
    } finally {
      auditStore?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("stores and queries turn-level react trace", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ts-agent-audit-"));
    const dbPath = path.join(tempDir, "runtime.db");
    let auditStore: SqliteTaskAuditStore | undefined;
    try {
      auditStore = new SqliteTaskAuditStore({ dbPath });
      const registry = new InMemoryToolRegistry();
      registry.register(new WriteOperationTool());
      const runtime = new AgentRuntime(
        undefined,
        new DefaultExecutor({ toolRegistry: registry }),
        new DefaultValidator(),
        auditStore,
        {
          async decideNext(input: ReActTurnInput): Promise<ReActDecision> {
            if (input.turnIndex === 0) {
              return {
                kind: "act",
                thought: "write once",
                step: {
                  id: "react_write_1",
                  toolName: "write_operation",
                  readOnly: false,
                  idempotencyKey: "react:write:1",
                  operation: {
                    id: "op_react_write_1",
                    type: "set_font",
                    targetNodeId: "n1",
                    payload: { fontName: "A" }
                  }
                }
              };
            }
            return { kind: "finish", summary: "done" };
          }
        },
        "react_loop"
      );

      const result = await runtime.run("goal", baseDoc, { runtimeMode: "react_loop", taskId: "react-task-1" });
      expect(result.status).toBe("completed");

      const turns = await runtime.queryReActTrace({ taskId: "react-task-1" });
      expect(turns).toHaveLength(1);
      expect(turns[0].thought).toBe("write once");
      expect(turns[0].observation).toContain("Applied set_font");
      expect(turns[0].taskId).toBe("react-task-1");
      expect(turns[0].runId).toContain("react-task-1");
    } finally {
      auditStore?.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
