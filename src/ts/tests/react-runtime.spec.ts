import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../src/executor/default-executor.js";
import { AgentRuntime } from "../src/runtime/engine.js";
import { DefaultValidator } from "../src/validator/default-validator.js";
import { InMemoryToolRegistry } from "../src/tools/tool-registry.js";
import { InspectDocumentTool, WriteOperationTool } from "../src/tools/mock-tools.js";
import type { DocumentIR, ReActDecision, ReActPlanner, ReActTurnInput } from "../src/core/types.js";

const baseDoc: DocumentIR = {
  id: "react-doc",
  version: "v1",
  nodes: [{ id: "n1", text: "hello" }]
};

class SequenceReActPlanner implements ReActPlanner {
  private idx = 0;

  constructor(private readonly decisions: ReActDecision[]) {}

  async decideNext(_input: ReActTurnInput): Promise<ReActDecision> {
    const next = this.decisions[this.idx];
    this.idx += 1;
    if (!next) {
      return {
        kind: "finish",
        summary: "planner exhausted"
      };
    }
    return next;
  }
}

describe("react runtime loop", () => {
  it("executes single-step decisions and completes on finish", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(new InspectDocumentTool());
    registry.register(new WriteOperationTool());
    const runtime = new AgentRuntime(
      undefined,
      new DefaultExecutor({ toolRegistry: registry }),
      new DefaultValidator(),
      undefined,
      new SequenceReActPlanner([
        {
          kind: "act",
          thought: "set font",
          step: {
            id: "r1",
            toolName: "write_operation",
            readOnly: false,
            idempotencyKey: "react:r1",
            operation: {
              id: "op1",
              type: "set_font",
              targetNodeId: "n1",
              payload: { fontName: "SimSun" }
            }
          }
        },
        {
          kind: "finish",
          summary: "done"
        }
      ]),
      "react_loop"
    );

    const result = await runtime.run("goal", baseDoc, { runtimeMode: "react_loop" });
    expect(result.status).toBe("completed");
    expect(result.changeSet.changes).toHaveLength(1);
    expect(result.reactTrace).toHaveLength(1);
    expect(result.reactTrace?.[0].thought).toBe("set font");
  });

  it("feeds observation history into subsequent turns", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(new WriteOperationTool());
    let sawObservation = false;
    const planner: ReActPlanner = {
      async decideNext(input: ReActTurnInput): Promise<ReActDecision> {
        if (input.turnIndex === 0) {
          return {
            kind: "act",
            step: {
              id: "obs_1",
              toolName: "write_operation",
              readOnly: false,
              idempotencyKey: "obs:1",
              operation: {
                id: "op_obs_1",
                type: "set_font",
                targetNodeId: "n1",
                payload: { fontName: "A" }
              }
            }
          };
        }
        if (input.turnIndex === 1) {
          sawObservation = input.history.some((item) => item.observation.includes("Applied set_font"));
          return {
            kind: "finish",
            summary: "done"
          };
        }
        return {
          kind: "finish",
          summary: "unexpected"
        };
      }
    };
    const runtime = new AgentRuntime(
      undefined,
      new DefaultExecutor({ toolRegistry: registry }),
      new DefaultValidator(),
      undefined,
      planner,
      "react_loop"
    );

    const result = await runtime.run("goal", baseDoc, { runtimeMode: "react_loop" });
    expect(result.status).toBe("completed");
    expect(sawObservation).toBe(true);
  });

  it("batches selector-based style writes in react_loop", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(new WriteOperationTool());
    const selectorDoc: DocumentIR = {
      id: "react-doc-batch",
      version: "v1",
      nodes: [
        { id: "p_0_r_0", text: "标题" },
        { id: "p_1_r_0", text: "第一段" },
        { id: "p_1_r_1", text: "正文" },
        { id: "p_2_r_0", text: "第二段正文" }
      ],
      metadata: {
        structureIndex: {
          paragraphs: [
            { id: "p_0", role: "heading", headingLevel: 1, runNodeIds: ["p_0_r_0"] },
            { id: "p_1", role: "body", runNodeIds: ["p_1_r_0", "p_1_r_1"] },
            { id: "p_2", role: "body", runNodeIds: ["p_2_r_0"] }
          ],
          roleCounts: { heading: 1, body: 2 },
          paragraphMap: {}
        }
      }
    };
    const runtime = new AgentRuntime(
      undefined,
      new DefaultExecutor({ toolRegistry: registry }),
      new DefaultValidator(),
      undefined,
      new SequenceReActPlanner([
        {
          kind: "act",
          step: {
            id: "batch_body_font",
            toolName: "write_operation",
            readOnly: false,
            idempotencyKey: "react:batch:body",
            operation: {
              id: "op_batch_body_font",
              type: "set_font",
              targetSelector: { scope: "body" },
              payload: { fontName: "SimSun" }
            }
          }
        },
        {
          kind: "finish",
          summary: "done"
        }
      ]),
      "react_loop"
    );

    const result = await runtime.run("goal", selectorDoc, { runtimeMode: "react_loop" });

    expect(result.status).toBe("completed");
    expect(result.changeSet.changes).toHaveLength(1);
    expect(result.finalDoc.nodes.filter((node) => node.style?.font_name === "SimSun")).toHaveLength(3);
  });

  it("returns waiting_user when confirmation is required", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(new WriteOperationTool());
    const runtime = new AgentRuntime(
      undefined,
      new DefaultExecutor({
        toolRegistry: registry,
        riskPolicy: { requiresConfirmation: () => true }
      }),
      new DefaultValidator(),
      undefined,
      new SequenceReActPlanner([
        {
          kind: "act",
          step: {
            id: "risk_1",
            toolName: "write_operation",
            readOnly: false,
            idempotencyKey: "risk:1",
            operation: {
              id: "risk_op_1",
              type: "set_font",
              targetNodeId: "n1",
              payload: { fontName: "A" }
            }
          }
        }
      ]),
      "react_loop"
    );

    const result = await runtime.run("goal", baseDoc, { runtimeMode: "react_loop" });
    expect(result.status).toBe("waiting_user");
    expect(result.pendingConfirmation?.step.id).toBe("risk_1");
    expect(result.reactTrace).toHaveLength(1);
    expect(result.reactTrace?.[0].status).toBe("waiting_user");
  });

  it("fails when max turns is reached", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(new InspectDocumentTool());
    const runtime = new AgentRuntime(
      undefined,
      new DefaultExecutor({ toolRegistry: registry }),
      new DefaultValidator(),
      undefined,
      {
        async decideNext(input: ReActTurnInput): Promise<ReActDecision> {
          return {
            kind: "act",
            step: {
              id: `loop_${input.turnIndex}`,
              toolName: "inspect_document",
              readOnly: true,
              idempotencyKey: `loop:${input.turnIndex}`
            }
          };
        }
      },
      "react_loop"
    );

    const result = await runtime.run("goal", baseDoc, { runtimeMode: "react_loop", maxTurns: 2 });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("maxTurns=2");
    expect(result.turnCount).toBe(2);
  });

  it("uses a higher default maxTurns budget than 8", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(new InspectDocumentTool());
    const runtime = new AgentRuntime(
      undefined,
      new DefaultExecutor({ toolRegistry: registry }),
      new DefaultValidator(),
      undefined,
      {
        async decideNext(input: ReActTurnInput): Promise<ReActDecision> {
          if (input.turnIndex >= 10) {
            return { kind: "finish", summary: "done" };
          }
          return {
            kind: "act",
            step: {
              id: `loop_${input.turnIndex}`,
              toolName: "inspect_document",
              readOnly: true,
              idempotencyKey: `loop:${input.turnIndex}`
            }
          };
        }
      },
      "react_loop"
    );

    const result = await runtime.run("goal", baseDoc, { runtimeMode: "react_loop" });
    expect(result.status).toBe("completed");
    expect(result.turnCount).toBe(10);
  });

  it("clips execution by remaining task budget", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register({
      name: "slow_write",
      readOnly: false,
      validate: async () => {},
      execute: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { doc: structuredClone(input.doc), summary: "done" };
      }
    });
    const runtime = new AgentRuntime(
      {
        createPlan: async () => ({
          taskId: "task_budget",
          goal: "slow change",
          steps: [{ id: "slow", toolName: "slow_write", readOnly: false, idempotencyKey: "slow:write" }]
        })
      },
      new DefaultExecutor({ toolRegistry: registry }),
      new DefaultValidator()
    );

    const result = await runtime.run("goal", baseDoc, {
      runtimeMode: "plan_once",
      defaultTimeoutMs: 200,
      taskTimeoutMs: 20
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Task budget exceeded");
  });
});
