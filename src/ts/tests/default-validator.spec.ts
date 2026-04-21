import { describe, expect, it } from "vitest";
import type { DocumentIR, Plan } from "../src/core/types.js";
import { AgentError } from "../src/core/errors.js";
import { DefaultValidator } from "../src/validator/default-validator.js";

const doc: DocumentIR = {
  id: "demo",
  version: "v1",
  nodes: [{ id: "n1", text: "hello" }]
};

function createPlan(step: Plan["steps"][number]): Plan {
  return {
    taskId: "task_demo",
    goal: "set color",
    steps: [step]
  };
}

describe("DefaultValidator.preValidate", () => {
  it("rejects write steps without operation", async () => {
    const validator = new DefaultValidator();
    const plan = createPlan({
      id: "s1",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s1"
    });

    await expect(validator.preValidate(plan, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("write_operation")
    );
  });

  it("rejects write steps without payload or target", async () => {
    const validator = new DefaultValidator();
    const missingPayload = createPlan({
      id: "s1",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s1",
      operation: {
        id: "op1",
        type: "set_font_color",
        targetNodeId: "n1",
        payload: undefined as never
      }
    });
    const missingTarget = createPlan({
      id: "s2",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s2",
      operation: {
        id: "op2",
        type: "set_font_color",
        payload: { font_color: "00FF00" }
      }
    });

    await expect(validator.preValidate(missingPayload, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("payload")
    );
    await expect(validator.preValidate(missingTarget, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("targetNodeId")
    );
  });

  it("rejects placeholder targets and empty executable payloads", async () => {
    const validator = new DefaultValidator();
    const placeholderTarget = createPlan({
      id: "s1",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s1",
      operation: {
        id: "op1",
        type: "set_font_color",
        targetNodeId: "placeholder",
        payload: { font_color: "00FF00" }
      }
    });
    const emptyPayload = createPlan({
      id: "s2",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s2",
      operation: {
        id: "op2",
        type: "set_font",
        targetNodeId: "n1",
        payload: {}
      }
    });

    await expect(validator.preValidate(placeholderTarget, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("placeholder")
    );
    await expect(validator.preValidate(emptyPayload, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("empty")
    );
  });
});
