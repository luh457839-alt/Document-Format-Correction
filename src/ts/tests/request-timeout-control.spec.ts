import { describe, expect, it } from "vitest";
import { AgentError } from "../src/core/errors.js";
import { resolveRequestTimeoutControl } from "../src/llm/request-timeout-control.js";

const timeoutMessages = {
  requestTimeoutCode: "E_TEST_REQUEST_TIMEOUT",
  requestTimeoutMessage: "Test request timed out",
  budgetTimeoutMessage: "Task budget exceeded while waiting for test response."
};

describe("resolveRequestTimeoutControl", () => {
  it("uses the configured timeout when no request budget is provided", () => {
    const control = resolveRequestTimeoutControl(45_000, undefined, timeoutMessages);

    expect(control.timeoutMs).toBe(45_000);
    expect(control.budgetClipped).toBe(false);
  });

  it("clips timeout to a smaller request budget and emits a budget timeout", () => {
    const control = resolveRequestTimeoutControl(45_000, 5_000, timeoutMessages);
    const err = control.toTimeoutError(new Error("aborted"));

    expect(control.timeoutMs).toBe(5_000);
    expect(control.budgetClipped).toBe(true);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.info.code).toBe("E_TASK_TIMEOUT");
    expect(err.info.message).toBe("Task budget exceeded while waiting for test response.");
  });

  it("keeps the configured timeout when request budget is larger", () => {
    const control = resolveRequestTimeoutControl(45_000, 60_000, timeoutMessages);

    expect(control.timeoutMs).toBe(45_000);
    expect(control.budgetClipped).toBe(false);
    expect(control.toTimeoutError().info).toMatchObject({
      code: "E_TEST_REQUEST_TIMEOUT",
      message: "Test request timed out after 45000ms.",
      retryable: false
    });
  });
});
