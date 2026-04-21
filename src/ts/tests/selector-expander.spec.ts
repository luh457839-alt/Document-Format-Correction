import { describe, expect, it } from "vitest";
import type { DocumentIR, Plan } from "../src/core/types.js";
import { expandPlanSelectors, resolveSelectorTargets } from "../src/runtime/selector-expander.js";

const doc: DocumentIR = {
  id: "doc1",
  version: "v1",
  nodes: [
    { id: "p_0_r_0", text: "标题" },
    { id: "p_1_r_0", text: "第一段" },
    { id: "p_1_r_1", text: "正文" },
    { id: "p_2_r_0", text: "第二段正文" },
    { id: "p_3_r_0", text: "列表项" }
  ],
  metadata: {
    structureIndex: {
      paragraphs: [
        { id: "p_0", role: "heading", headingLevel: 1, runNodeIds: ["p_0_r_0"] },
        { id: "p_1", role: "body", runNodeIds: ["p_1_r_0", "p_1_r_1"] },
        { id: "p_2", role: "body", runNodeIds: ["p_2_r_0"] },
        { id: "p_3", role: "list_item", runNodeIds: ["p_3_r_0"] }
      ],
      roleCounts: { heading: 1, body: 2, list_item: 1 },
      paragraphMap: {}
    }
  }
};

describe("selector expander", () => {
  it("resolves body selectors to all body run ids", () => {
    expect(resolveSelectorTargets(doc, { scope: "body" })).toEqual(["p_1_r_0", "p_1_r_1", "p_2_r_0"]);
  });

  it("resolves paragraph_ids selectors to all runs in the matched paragraphs", () => {
    expect(resolveSelectorTargets(doc, { scope: "paragraph_ids", paragraphIds: ["p_1", "p_2"] })).toEqual([
      "p_1_r_0",
      "p_1_r_1",
      "p_2_r_0"
    ]);
  });

  it("expands one selector step into concrete write steps", () => {
    const plan: Plan = {
      taskId: "task1",
      goal: "将正文字体颜色设置为红色",
      steps: [
        {
          id: "step_set_font_color_body",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "write:body",
          operation: {
            id: "op_set_font_color_body",
            type: "set_font_color",
            targetSelector: { scope: "body" },
            payload: { font_color: "FF0000" }
          }
        }
      ]
    };

    const expanded = expandPlanSelectors(plan, doc);

    expect(expanded.steps.map((step) => step.operation?.targetNodeId)).toEqual(["p_1_r_0", "p_1_r_1", "p_2_r_0"]);
    expect(expanded.steps.every((step) => step.operation?.targetSelector === undefined)).toBe(true);
  });
});
