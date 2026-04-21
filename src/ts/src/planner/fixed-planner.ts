import type { DocumentIR, Plan, Planner } from "../core/types.js";

export class FixedPlanner implements Planner {
  async createPlan(goal: string, doc: DocumentIR): Promise<Plan> {
    const firstNode = doc.nodes[0];
    const targetId = firstNode?.id ?? "node_0";
    return {
      taskId: `task_${doc.id}`,
      goal,
      steps: [
        {
          id: "step_read_structure",
          toolName: "inspect_document",
          readOnly: true,
          timeoutMs: 1000,
          retryLimit: 1,
          idempotencyKey: "inspect_document:step_read_structure"
        },
        {
          id: "step_set_font",
          toolName: "write_operation",
          readOnly: false,
          timeoutMs: 1000,
          retryLimit: 1,
          idempotencyKey: "write_operation:step_set_font",
          operation: {
            id: "op_set_font_1",
            type: "set_font",
            targetNodeId: targetId,
            payload: { font_name: "SimSun" }
          }
        }
      ]
    };
  }
}
