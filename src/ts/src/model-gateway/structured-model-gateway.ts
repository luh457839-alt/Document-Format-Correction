import type { ConversationMessage, PlannerModelConfig } from "../core/types.js";
import { AgentError, asAppError } from "../core/errors.js";
import { OpenAiCompatibleChatClient } from "../llm/openai-compatible-client.js";
import {
  resolveRequestTimeoutControl,
  type RequestTimeoutMessages
} from "../llm/request-timeout-control.js";
import { resolvePlannerModelConfig } from "./config.js";

type StructuredRequestMode = "json_schema" | "fallback_json";

export interface StructuredRequestDiagnostics {
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

export interface StructuredJsonRequestInput<T> {
  messages: ConversationMessage[];
  requestCode: string;
  upstreamCode: string;
  responseCode: string;
  requestLabel: string;
  payloadLabel: string;
  schemaUnsupportedCode: string;
  schemaName: string;
  schema: Record<string, unknown>;
  parseContent: (content: string) => T;
  requestTimeoutMs?: number;
  diagnosticStage?: string;
  timeoutMessages?: RequestTimeoutMessages;
  diagnosticMetadata?: StructuredRequestDiagnostics;
}

export interface StructuredModelGateway {
  requestJson<T>(input: StructuredJsonRequestInput<T>, override?: Partial<PlannerModelConfig>): Promise<T>;
}

export interface OpenAiStructuredModelGatewayDeps {
  plannerConfig?: Partial<PlannerModelConfig>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export class OpenAiStructuredModelGateway implements StructuredModelGateway {
  constructor(private readonly deps: OpenAiStructuredModelGatewayDeps = {}) {}

  async requestJson<T>(
    input: StructuredJsonRequestInput<T>,
    override?: Partial<PlannerModelConfig>
  ): Promise<T> {
    const config = resolvePlannerModelConfig(
      {
        ...(this.deps.plannerConfig ?? {}),
        ...(override ?? {})
      },
      this.deps.env
    );
    const timeoutMessages =
      input.timeoutMessages ?? {
        requestTimeoutCode: input.requestCode,
        requestTimeoutMessage: `${input.requestLabel} timed out`,
        budgetTimeoutMessage: `Task budget exceeded while waiting for ${input.requestLabel.toLowerCase()} response.`
      };
    const timeoutControl = resolveRequestTimeoutControl(config.timeoutMs, input.requestTimeoutMs, timeoutMessages);
    if (timeoutControl.timeoutMs <= 0) {
      throw timeoutControl.toTimeoutError();
    }
    const client = new OpenAiCompatibleChatClient(config, { fetchImpl: this.deps.fetchImpl });
    if (config.useJsonSchema === false) {
      return await requestPlainJson(client, input, timeoutControl.timeoutMs, {
        requestMode: "fallback_json",
        fallbackAttempt: input.diagnosticMetadata?.fallbackAttempt ?? 0,
        onAbortError: (cause) => timeoutControl.toTimeoutError(cause)
      });
    }

    try {
      return await client.requestJson({
        messages: input.messages,
        requestCode: input.requestCode,
        upstreamCode: input.upstreamCode,
        responseCode: input.responseCode,
        requestLabel: input.requestLabel,
        payloadLabel: input.payloadLabel,
        schemaUnsupportedCode: input.schemaUnsupportedCode,
        diagnosticStage: input.diagnosticStage,
        schemaName: input.schemaName,
        schema: input.schema,
        strict: config.schemaStrict !== false,
        parseContent: input.parseContent,
        requestTimeoutMs: timeoutControl.timeoutMs,
        onAbortError: (cause) => timeoutControl.toTimeoutError(cause),
        diagnosticMetadata: {
          ...input.diagnosticMetadata,
          requestMode: "json_schema",
          fallbackAttempt: input.diagnosticMetadata?.fallbackAttempt ?? 0
        }
      });
    } catch (err) {
      if (!shouldFallbackFromSchemaRequest(err, input.schemaUnsupportedCode)) {
        throw err;
      }
      return await requestPlainJson(client, input, timeoutControl.timeoutMs, {
        requestMode: "fallback_json",
        fallbackAttempt: 1,
        diagnosticStage: fallbackDiagnosticStage(input.diagnosticStage),
        onAbortError: (cause) => timeoutControl.toTimeoutError(cause)
      });
    }
  }
}

async function requestPlainJson<T>(
  client: OpenAiCompatibleChatClient<PlannerModelConfig>,
  input: StructuredJsonRequestInput<T>,
  requestTimeoutMs: number,
  options: {
    requestMode: StructuredRequestMode;
    fallbackAttempt: number;
    diagnosticStage?: string;
    onAbortError: (cause: unknown) => AgentError;
  }
): Promise<T> {
  const messages = appendPlainJsonSchemaPrompt(input.messages, input.schemaName, input.schema);
  const schemaBytes = byteLength(JSON.stringify(input.schema));
  let content: string;
  try {
    content = await client.requestCompletion({
      messages,
      requestCode: input.requestCode,
      upstreamCode: input.upstreamCode,
      responseCode: input.responseCode,
      requestLabel: input.requestLabel,
      payloadLabel: input.payloadLabel,
      diagnosticStage: options.diagnosticStage ?? input.diagnosticStage,
      requestTimeoutMs,
      onAbortError: options.onAbortError,
      diagnosticMetadata: {
        ...input.diagnosticMetadata,
        promptBytes: estimatePromptBytes(messages),
        schemaBytes,
        requestMode: options.requestMode,
        fallbackAttempt: options.fallbackAttempt
      }
    });
  } catch (err) {
    if (options.fallbackAttempt > 0) {
      throw buildFallbackError(input, err, "fallback failed");
    }
    throw err;
  }

  try {
    return input.parseContent(content);
  } catch (err) {
    if (options.fallbackAttempt > 0) {
      throw buildFallbackError(input, err, "fallback parse failed");
    }
    throw err;
  }
}

function shouldFallbackFromSchemaRequest(err: unknown, schemaUnsupportedCode: string): boolean {
  const info = asAppError(err);
  return info.code === schemaUnsupportedCode || /timed out|abort/i.test(info.message);
}

function buildFallbackError<T>(
  input: StructuredJsonRequestInput<T>,
  err: unknown,
  failureStage: "fallback failed" | "fallback parse failed"
): AgentError {
  const info = asAppError(err, input.requestCode);
  return new AgentError({
    ...info,
    code: input.requestCode,
    message: `${input.requestLabel} ${failureStage}: ${info.message} (requestMode=fallback_json)`,
    retryable: info.retryable
  });
}

function fallbackDiagnosticStage(stage: string | undefined): string | undefined {
  return stage === undefined ? undefined : stage.replace(/request$/, "fallback");
}

function appendPlainJsonSchemaPrompt(
  messages: ConversationMessage[],
  schemaName: string,
  schema: Record<string, unknown>
): ConversationMessage[] {
  return [
    ...messages,
    {
      role: "user",
      content:
        `Return only JSON that satisfies the JSON Schema named "${schemaName}". ` +
        "Do not wrap it in Markdown and do not include explanatory text.\n" +
        JSON.stringify(schema)
    }
  ];
}

function estimatePromptBytes(messages: ConversationMessage[]): number {
  return byteLength(messages.map((message) => message.content).join("\n"));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function createStructuredModelGateway(
  deps: OpenAiStructuredModelGatewayDeps = {}
): StructuredModelGateway {
  return new OpenAiStructuredModelGateway(deps);
}
