import { AgentError, asAppError } from "../core/errors.js";
import {
  buildModelResponseErrorMessage,
  parseOpenAiCompatibleChatText
} from "../core/model-response.js";
import type { ChatModelConfig, ConversationMessage } from "../core/types.js";

export interface OpenAiCompatibleClientDeps {
  fetchImpl?: typeof fetch;
  diagnosticSink?: (event: OpenAiRequestDiagnosticEvent) => void;
}

export interface OpenAiCompatibleRequestInput {
  messages: ConversationMessage[];
  responseFormat?: Record<string, unknown>;
  requestCode: string;
  upstreamCode: string;
  responseCode: string;
  requestLabel: string;
  payloadLabel: string;
  requestTimeoutMs?: number;
  schemaUnsupportedCode?: string;
  onAbortError?: (cause: unknown) => AgentError;
  diagnosticStage?: string;
  diagnosticMetadata?: OpenAiRequestDiagnosticMetadata;
}

export interface OpenAiCompatibleJsonRequestInput<T> extends Omit<OpenAiCompatibleRequestInput, "responseFormat"> {
  schemaName: string;
  schema: Record<string, unknown>;
  strict?: boolean;
  parseContent: (content: string) => T;
}

export interface OpenAiRequestDiagnosticEvent {
  type: "model_request_diagnostic";
  phase: string;
  requestLabel: string;
  endpointHost: string;
  endpointPath: string;
  model: string;
  timeoutMs: number;
  jsonSchemaEnabled: boolean;
  attempt: number;
  requestMode?: string;
  promptBytes?: number;
  schemaBytes?: number;
  paragraphCount?: number;
  semanticBlockCount?: number;
  fallbackAttempt?: number;
  batchType?: string;
  batchIndex?: number;
  batchCount?: number;
  batchParagraphCount?: number;
}

export type OpenAiRequestDiagnosticMetadata = Partial<
  Pick<
    OpenAiRequestDiagnosticEvent,
    | "requestMode"
    | "promptBytes"
    | "schemaBytes"
    | "paragraphCount"
    | "semanticBlockCount"
    | "fallbackAttempt"
    | "batchType"
    | "batchIndex"
    | "batchCount"
    | "batchParagraphCount"
  >
>;

export class OpenAiCompatibleChatClient<TConfig extends ChatModelConfig = ChatModelConfig> {
  private readonly fetchImpl: typeof fetch;
  private readonly diagnosticSink: (event: OpenAiRequestDiagnosticEvent) => void;

  constructor(
    private readonly config: TConfig,
    deps: OpenAiCompatibleClientDeps = {}
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.diagnosticSink = deps.diagnosticSink ?? logDiagnosticEvent;
  }

  async requestJson<T>(input: OpenAiCompatibleJsonRequestInput<T>): Promise<T> {
    const content = await this.requestCompletion({
      ...input,
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: input.schemaName,
          strict: input.strict !== false,
          schema: input.schema
        }
      }
    });
    return input.parseContent(content);
  }

  async requestCompletion(input: OpenAiCompatibleRequestInput): Promise<string> {
    const endpoint = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const endpointInfo = parseEndpointInfo(endpoint);
    const timeoutMs = input.requestTimeoutMs ?? this.config.timeoutMs ?? 30000;
    const diagnosticStage = normalizeDiagnosticStage(input.diagnosticStage);
    const diagnosticContext: RequestDiagnosticContext = {
      stage: diagnosticStage,
      endpointHost: endpointInfo.host,
      endpointPath: endpointInfo.path,
      model: this.config.model,
      timeoutMs
    };
    const maxRetries = this.config.maxRetries ?? 0;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      this.emitDiagnostic({
        phase: `${diagnosticStage}_start`,
        requestLabel: input.requestLabel,
        endpointHost: endpointInfo.host,
        endpointPath: endpointInfo.path,
        model: this.config.model,
        timeoutMs,
        jsonSchemaEnabled: hasJsonSchemaResponseFormat(input.responseFormat),
        attempt,
        ...input.diagnosticMetadata
      });
      let failureLogged = false;

      try {
        const resp = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`
          },
          body: JSON.stringify({
            model: this.config.model,
            temperature: this.config.temperature ?? 0,
            messages: input.messages,
            ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
            stream: false
          }),
          signal: controller.signal
        });
        const raw = await resp.text();
        if (!resp.ok) {
          this.emitDiagnostic({
            phase: `${diagnosticStage}_failed`,
            requestLabel: input.requestLabel,
            endpointHost: endpointInfo.host,
            endpointPath: endpointInfo.path,
            model: this.config.model,
            timeoutMs,
            jsonSchemaEnabled: hasJsonSchemaResponseFormat(input.responseFormat),
            attempt,
            ...input.diagnosticMetadata
          });
          failureLogged = true;
          if (input.schemaUnsupportedCode && input.responseFormat && isSchemaUnsupported(resp.status, raw)) {
            throw new AgentError({
              code: input.schemaUnsupportedCode,
              message: `${input.requestLabel} upstream does not support response_format json_schema (${resp.status}).`,
              retryable: false
            });
          }
          throw new AgentError({
            code: input.upstreamCode,
            message: `${input.requestLabel} failed (${resp.status}): ${raw.slice(0, 200)}`,
            retryable: resp.status >= 500
          });
        }
        const content = extractOpenAiCompatibleContent(raw, input.responseCode, input.payloadLabel);
        this.emitDiagnostic({
          phase: `${diagnosticStage}_done`,
          requestLabel: input.requestLabel,
          endpointHost: endpointInfo.host,
          endpointPath: endpointInfo.path,
          model: this.config.model,
          timeoutMs,
          jsonSchemaEnabled: hasJsonSchemaResponseFormat(input.responseFormat),
          attempt,
          ...input.diagnosticMetadata
        });
        return content;
      } catch (err) {
        if (controller.signal.aborted) {
          this.emitDiagnostic({
            phase: `${diagnosticStage}_abort`,
            requestLabel: input.requestLabel,
            endpointHost: endpointInfo.host,
            endpointPath: endpointInfo.path,
            model: this.config.model,
            timeoutMs,
            jsonSchemaEnabled: hasJsonSchemaResponseFormat(input.responseFormat),
            attempt,
            ...input.diagnosticMetadata
          });
        } else if (!failureLogged) {
          this.emitDiagnostic({
            phase: `${diagnosticStage}_failed`,
            requestLabel: input.requestLabel,
            endpointHost: endpointInfo.host,
            endpointPath: endpointInfo.path,
            model: this.config.model,
            timeoutMs,
            jsonSchemaEnabled: hasJsonSchemaResponseFormat(input.responseFormat),
            attempt,
            ...input.diagnosticMetadata
          });
        }
        const normalizedBaseErr = controller.signal.aborted && input.onAbortError ? input.onAbortError(err) : err;
        const normalizedErr = controller.signal.aborted
          ? withRequestContext(normalizedBaseErr, input.requestCode, diagnosticContext)
          : normalizedBaseErr;
        lastErr = normalizedErr;
        const appErr = asAppError(normalizedErr, input.requestCode);
        if (controller.signal.aborted && attempt < maxRetries && appErr.code !== "E_TASK_TIMEOUT") {
          await sleep(150 * (attempt + 1));
          continue;
        }
        const retryable = appErr.retryable || isNetworkError(normalizedErr);
        if (!retryable || attempt === maxRetries) {
          break;
        }
        await sleep(150 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw asCompatibleModelRequestError(
      lastErr ?? new Error("Unknown model request failure"),
      input.requestCode,
      input.requestLabel,
      diagnosticContext
    );
  }

  private emitDiagnostic(event: Omit<OpenAiRequestDiagnosticEvent, "type">): void {
    this.diagnosticSink({
      type: "model_request_diagnostic",
      ...event
    });
  }
}

export function extractOpenAiCompatibleContent(
  rawText: string,
  responseCode: string,
  payloadLabel: string
): string {
  try {
    const result = parseOpenAiCompatibleChatText(rawText);
    if (result.content === null) {
      throw new AgentError({
        code: responseCode,
        message: buildModelResponseErrorMessage(payloadLabel, result),
        retryable: false
      });
    }
    return result.content;
  } catch (err) {
    if (err instanceof AgentError) {
      throw err;
    }
    throw new AgentError({
      code: responseCode,
      message: `Model returned invalid envelope JSON: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }
}

export function asCompatibleModelRequestError(
  err: unknown,
  fallbackCode: string,
  requestLabel: string,
  context?: RequestDiagnosticContext
): AgentError {
  const info = asAppError(err, fallbackCode);
  if (err instanceof AgentError) {
    return new AgentError(
      context === undefined
        ? info
        : {
            ...info,
            message: withRequestContextMessage(info.message, context)
          }
    );
  }
  if (isNetworkError(err) && /timeout|aborted/i.test(info.message)) {
    return new AgentError({
      code: fallbackCode,
      message: withRequestContextMessage(
        `${requestLabel} timed out or was aborted. Local/small models may need compatibility mode or a longer timeout.`,
        context
      ),
      retryable: info.retryable,
      cause: info.cause
    });
  }
  return new AgentError(
    context === undefined
      ? info
      : {
          ...info,
          message: withRequestContextMessage(info.message, context)
        }
  );
}

export function isSchemaUnsupported(status: number, payload: string): boolean {
  if (status < 400 || status >= 500) {
    return false;
  }
  const lower = payload.toLowerCase();
  const mentionsSchema = lower.includes("response_format") || lower.includes("json_schema");
  const mentionsUnsupported =
    lower.includes("not support") ||
    lower.includes("unsupported") ||
    lower.includes("unknown") ||
    lower.includes("invalid");
  return mentionsSchema && mentionsUnsupported;
}

export function isNetworkError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      /network|fetch|timeout|aborted/i.test(err.message))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RequestDiagnosticContext {
  stage: string;
  endpointHost: string;
  endpointPath: string;
  model: string;
  timeoutMs: number;
}

function logDiagnosticEvent(event: OpenAiRequestDiagnosticEvent): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(event));
}

function normalizeDiagnosticStage(stage: string | undefined): string {
  const normalized = stage?.trim();
  return normalized ? normalized : "model_request";
}

function parseEndpointInfo(endpoint: string): { host: string; path: string } {
  try {
    const url = new URL(endpoint);
    return {
      host: url.host,
      path: url.pathname
    };
  } catch {
    const stripped = endpoint.replace(/^https?:\/\//i, "");
    const slashIndex = stripped.indexOf("/");
    if (slashIndex < 0) {
      return { host: stripped, path: "/" };
    }
    return {
      host: stripped.slice(0, slashIndex),
      path: stripped.slice(slashIndex) || "/"
    };
  }
}

function hasJsonSchemaResponseFormat(responseFormat: Record<string, unknown> | undefined): boolean {
  if (!responseFormat || typeof responseFormat !== "object") {
    return false;
  }
  return responseFormat.type === "json_schema";
}

function withRequestContext(
  err: unknown,
  fallbackCode: string,
  context: RequestDiagnosticContext
): AgentError {
  const info = asAppError(err, fallbackCode);
  return new AgentError({
    ...info,
    message: withRequestContextMessage(info.message, context)
  });
}

function withRequestContextMessage(message: string, context: RequestDiagnosticContext | undefined): string {
  if (context === undefined) {
    return message;
  }
  const suffix =
    `stage=${context.stage} endpoint=${context.endpointHost}${context.endpointPath} ` +
    `model=${context.model} timeoutMs=${context.timeoutMs}`;
  return message.includes(suffix) ? message : `${message} (${suffix})`;
}
