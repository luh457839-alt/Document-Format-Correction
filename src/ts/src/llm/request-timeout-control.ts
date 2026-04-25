import { AgentError } from "../core/errors.js";

export interface RequestTimeoutMessages {
  requestTimeoutCode: string;
  requestTimeoutMessage: string;
  budgetTimeoutCode?: string;
  budgetTimeoutMessage: string | ((timeoutMs: number) => string);
}

export interface RequestTimeoutControl {
  timeoutMs: number;
  budgetClipped: boolean;
  toTimeoutError: (cause?: unknown) => AgentError;
}

export function resolveRequestTimeoutControl(
  configuredTimeoutMs: number | undefined,
  requestTimeoutMs: number | undefined,
  messages: RequestTimeoutMessages
): RequestTimeoutControl {
  const baseTimeoutMs = configuredTimeoutMs ?? 30_000;
  const hasRequestBudget = typeof requestTimeoutMs === "number" && Number.isFinite(requestTimeoutMs);
  const budgetClipped = hasRequestBudget && requestTimeoutMs < baseTimeoutMs;
  const timeoutMs = hasRequestBudget ? Math.max(0, Math.min(baseTimeoutMs, requestTimeoutMs)) : baseTimeoutMs;

  return {
    timeoutMs,
    budgetClipped,
    toTimeoutError: (cause?: unknown) =>
      new AgentError({
        code: budgetClipped ? messages.budgetTimeoutCode ?? "E_TASK_TIMEOUT" : messages.requestTimeoutCode,
        message: budgetClipped
          ? resolveBudgetTimeoutMessage(messages.budgetTimeoutMessage, timeoutMs)
          : `${messages.requestTimeoutMessage} after ${timeoutMs}ms.`,
        retryable: false,
        cause
      })
  };
}

function resolveBudgetTimeoutMessage(
  message: RequestTimeoutMessages["budgetTimeoutMessage"],
  timeoutMs: number
): string {
  return typeof message === "function" ? message(timeoutMs) : message;
}
