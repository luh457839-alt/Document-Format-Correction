import { createMvpRuntime } from "./engine.js";
import type { DocumentIR } from "../core/types.js";
import { FixedPlanner } from "../planner/fixed-planner.js";

export async function runMockFlow(goal: string): Promise<{ changeSet: unknown; summary: string }> {
  const runtime = createMvpRuntime({ planner: new FixedPlanner() });
  const doc: DocumentIR = {
    id: "mock-doc",
    version: "v1",
    nodes: [{ id: "n1", text: "这是一段文本" }]
  };
  const result = await runtime.run(goal, doc, { dryRun: false, maxConcurrentReadOnly: 2 });
  return { changeSet: result.changeSet, summary: result.summary };
}
