import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../src/executor/default-executor.js";
import { InMemoryToolRegistry } from "../src/tools/tool-registry.js";
import { FixedPlanner } from "../src/planner/fixed-planner.js";
import { WriteOperationTool } from "../src/tools/mock-tools.js";
import { parseDocxToState } from "../src/tools/docx-observation-tool.js";
import { AgentRuntime, createMvpRuntime } from "../src/runtime/engine.js";
import { DefaultValidator } from "../src/validator/default-validator.js";
import type {
  DocumentIR,
  Plan,
  PlanStep,
  Tool,
  ToolExecutionInput,
  ToolExecutionOutput
} from "../src/core/types.js";

const baseDoc: DocumentIR = {
  id: "demo",
  version: "v1",
  nodes: [{ id: "n1", text: "hello" }]
};

class DelayReadTool implements Tool {
  constructor(public name: string, private readonly ms: number, private readonly marks: number[]) {}
  readOnly = true;
  async validate(_input: ToolExecutionInput): Promise<void> {}
  async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    this.marks.push(Date.now());
    await new Promise((r) => setTimeout(r, this.ms));
    return { doc: structuredClone(input.doc), summary: `${this.name} done` };
  }
}

class DelayWriteTool implements Tool {
  readOnly = false;
  public readonly name = "write";
  constructor(private readonly marks: string[]) {}
  async validate(_input: ToolExecutionInput): Promise<void> {}
  async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    this.marks.push(`start:${input.context.stepId}`);
    await new Promise((r) => setTimeout(r, 30));
    const doc = structuredClone(input.doc);
    const node = doc.nodes[0];
    node.style = { ...(node.style ?? {}), [input.context.stepId]: true };
    this.marks.push(`end:${input.context.stepId}`);
    return { doc, summary: input.context.stepId, rollbackToken: `rb_${input.context.stepId}` };
  }
  async rollback(token: string, doc: DocumentIR): Promise<DocumentIR> {
    const next = structuredClone(doc);
    next.metadata = { ...(next.metadata ?? {}), rollback: token };
    return next;
  }
}

describe("planner", () => {
  it("outputs deterministic fixed plan", async () => {
    const planner = new FixedPlanner();
    const p1 = await planner.createPlan("目标A", baseDoc);
    const p2 = await planner.createPlan("目标A", baseDoc);
    expect(p1).toEqual(p2);
    expect(p1.steps[0].readOnly).toBe(true);
    expect(p1.steps[1].readOnly).toBe(false);
  });
});

describe("executor", () => {
  it("uses a longer default step timeout than 1000ms", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(new DelayReadTool("slow_read", 1100, []));
    const executor = new DefaultExecutor({ toolRegistry: registry });
    const plan: Plan = {
      taskId: "t_default_timeout",
      goal: "g",
      steps: [{ id: "slow", toolName: "slow_read", readOnly: true, idempotencyKey: "slow:1" }]
    };

    const result = await executor.execute(plan, baseDoc);
    expect(result.status).toBe("completed");
  });

  it("runs readOnly tools in parallel and write tools serially", async () => {
    const registry = new InMemoryToolRegistry();
    const readMarks: number[] = [];
    const writeMarks: string[] = [];
    registry.register(new DelayReadTool("ro1", 80, readMarks));
    registry.register(new DelayReadTool("ro2", 80, readMarks));
    registry.register(new DelayReadTool("ro3", 80, readMarks));
    registry.register(new DelayWriteTool(writeMarks));

    const executor = new DefaultExecutor({ toolRegistry: registry });
    const plan: Plan = {
      taskId: "t1",
      goal: "g",
      steps: [
        { id: "s1", toolName: "ro1", readOnly: true, idempotencyKey: "k1" },
        { id: "s2", toolName: "ro2", readOnly: true, idempotencyKey: "k2" },
        { id: "s3", toolName: "ro3", readOnly: true, idempotencyKey: "k3" },
        { id: "w1", toolName: "write", readOnly: false, idempotencyKey: "wk1" },
        { id: "w2", toolName: "write", readOnly: false, idempotencyKey: "wk2" }
      ]
    };

    const started = Date.now();
    await executor.execute(plan, baseDoc, { maxConcurrentReadOnly: 3 });
    const elapsed = Date.now() - started;
    expect(readMarks.length).toBe(3);
    expect(elapsed).toBeLessThan(300);
    expect(writeMarks).toEqual(["start:w1", "end:w1", "start:w2", "end:w2"]);
  });

  it("dry-run should not mutate document", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(new WriteOperationTool());
    const executor = new DefaultExecutor({ toolRegistry: registry });
    const plan: Plan = {
      taskId: "t2",
      goal: "g",
      steps: [
        {
          id: "w1",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "id1",
          operation: { id: "op1", type: "set_font", targetNodeId: "n1", payload: { fontName: "A" } }
        }
      ]
    };
    const result = await executor.execute(plan, baseDoc, { dryRun: true });
    expect(result.finalDoc.nodes[0].style).toBeUndefined();
  });

  it("triggers rollback when write step fails", async () => {
    const registry = new InMemoryToolRegistry();
    const writer = new DelayWriteTool([]);
    registry.register(writer);
    registry.register({
      name: "fail_write",
      readOnly: false,
      validate: async () => {},
      execute: async () => {
        throw { code: "E_FAIL", message: "forced", retryable: false };
      }
    });
    const executor = new DefaultExecutor({ toolRegistry: registry });
    const plan: Plan = {
      taskId: "t3",
      goal: "g",
      steps: [
        { id: "w1", toolName: "write", readOnly: false, idempotencyKey: "k1" },
        { id: "w2", toolName: "fail_write", readOnly: false, idempotencyKey: "k2" }
      ]
    };
    const result = await executor.execute(plan, baseDoc);
    expect(result.status).toBe("rolled_back");
    expect(result.finalDoc.metadata?.rollback).toBe("rb_w1");
  });

  it("enforces idempotency for repeated write step", async () => {
    const registry = new InMemoryToolRegistry();
    const marks: string[] = [];
    registry.register(new DelayWriteTool(marks));
    const executor = new DefaultExecutor({ toolRegistry: registry });
    const plan: Plan = {
      taskId: "t4",
      goal: "g",
      steps: [
        { id: "w1", toolName: "write", readOnly: false, idempotencyKey: "same-key" },
        { id: "w2", toolName: "write", readOnly: false, idempotencyKey: "same-key" }
      ]
    };
    const result = await executor.execute(plan, baseDoc);
    expect(result.steps.find((s) => s.stepId === "w2")?.status).toBe("skipped");
    expect(marks).toEqual(["start:w1", "end:w1"]);
  });

  it("returns waiting_user when risk step has no confirmation callback", async () => {
    const registry = new InMemoryToolRegistry();
    const marks: string[] = [];
    registry.register(new DelayWriteTool(marks));
    const executor = new DefaultExecutor({
      toolRegistry: registry,
      riskPolicy: { requiresConfirmation: () => true }
    });
    const plan: Plan = {
      taskId: "t5",
      goal: "g",
      steps: [{ id: "w1", toolName: "write", readOnly: false, idempotencyKey: "risk-key" }]
    };

    const result = await executor.execute(plan, baseDoc);
    expect(result.status).toBe("waiting_user");
    expect(result.pendingConfirmation?.step.id).toBe("w1");
    expect(marks).toEqual([]);
  });

  it("executes risk step when confirmation callback approves", async () => {
    const registry = new InMemoryToolRegistry();
    const marks: string[] = [];
    registry.register(new DelayWriteTool(marks));
    const executor = new DefaultExecutor({
      toolRegistry: registry,
      riskPolicy: { requiresConfirmation: () => true }
    });
    const plan: Plan = {
      taskId: "t6",
      goal: "g",
      steps: [{ id: "w1", toolName: "write", readOnly: false, idempotencyKey: "risk-key-2" }]
    };

    const result = await executor.execute(plan, baseDoc, {
      confirmStep: async () => "approved"
    });
    expect(result.status).toBe("completed");
    expect(marks).toEqual(["start:w1", "end:w1"]);
  });

  it("rolls back when later risk step is rejected", async () => {
    const registry = new InMemoryToolRegistry();
    const writer = new DelayWriteTool([]);
    registry.register(writer);
    const executor = new DefaultExecutor({
      toolRegistry: registry,
      riskPolicy: { requiresConfirmation: (step) => step.id === "w2" }
    });
    const plan: Plan = {
      taskId: "t7",
      goal: "g",
      steps: [
        { id: "w1", toolName: "write", readOnly: false, idempotencyKey: "rollback-1" },
        { id: "w2", toolName: "write", readOnly: false, idempotencyKey: "rollback-2" }
      ]
    };

    const result = await executor.execute(plan, baseDoc, {
      confirmStep: async (step) => (step.id === "w2" ? "rejected" : "approved")
    });
    expect(result.status).toBe("rolled_back");
    expect(result.finalDoc.metadata?.rollback).toBe("rb_w1");
  });
});

describe("runtime resume", () => {
  it("can run only a single confirmed step", async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(new WriteOperationTool());
    const runtime = new AgentRuntime(
      new FixedPlanner(),
      new DefaultExecutor({ toolRegistry: registry }),
      new DefaultValidator()
    );
    const step: PlanStep = {
      id: "resume_w1",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "resume-key",
      operation: { id: "op_resume", type: "set_font", targetNodeId: "n1", payload: { fontName: "A" } }
    };

    const result = await runtime.runSingleStep(step, baseDoc);
    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].stepId).toBe("resume_w1");
  });
});

describe("runtime planner wiring", () => {
  it("throws when default LLM planner config is missing", () => {
    const oldPlannerKey = process.env.TS_AGENT_PLANNER_API_KEY;
    const oldOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.TS_AGENT_PLANNER_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      expect(() => createMvpRuntime()).toThrowError(/apiKey is missing/);
    } finally {
      if (oldPlannerKey !== undefined) process.env.TS_AGENT_PLANNER_API_KEY = oldPlannerKey;
      if (oldOpenAiKey !== undefined) process.env.OPENAI_API_KEY = oldOpenAiKey;
    }
  });

  it("accepts explicit FixedPlanner injection for offline flow", () => {
    expect(() => createMvpRuntime({ planner: new FixedPlanner() })).not.toThrow();
  });
});

describe("docx observation tool", () => {
  it("falls back when parser source is unavailable", async () => {
    const state = await parseDocxToState({
      docxPath: "not-exists.docx",
      allowFallback: true
    });
    expect(state.nodes).toEqual([]);
    expect(state.document_meta.warning).toBeDefined();
  });

  it("fails when fallback disabled and source is unavailable", async () => {
    await expect(
      parseDocxToState({
        docxPath: "not-exists.docx",
        allowFallback: false
      })
    ).rejects.toBeDefined();
  });
});
