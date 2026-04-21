import type { AppError } from "./types.js";

export class AgentError extends Error {
  public readonly info: AppError;

  constructor(info: AppError) {
    super(info.message);
    this.name = "AgentError";
    this.info = info;
  }
}

export function asAppError(err: unknown, fallbackCode = "E_INTERNAL"): AppError {
  if (err instanceof AgentError) return err.info;
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err &&
    "retryable" in err
  ) {
    const e = err as { code: unknown; message: unknown; retryable: unknown; cause?: unknown };
    return {
      code: String(e.code),
      message: String(e.message),
      retryable: Boolean(e.retryable),
      cause: e.cause
    };
  }
  if (err instanceof Error) {
    return { code: fallbackCode, message: err.message, retryable: false, cause: err };
  }
  return { code: fallbackCode, message: String(err), retryable: false, cause: err };
}
