export class AgentError extends Error {
  code: string;
  retryable: boolean;
  cause?: unknown;

  constructor(input: { code: string; message: string; retryable: boolean; cause?: unknown }) {
    super(input.message);
    this.name = "AgentError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.cause = input.cause;
  }
}
