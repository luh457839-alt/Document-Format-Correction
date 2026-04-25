import { asAppError } from "../core/errors.js";
import type { ConversationMessage } from "../core/types.js";
import { OpenAiCompatibleChatClient } from "../llm/openai-compatible-client.js";
import { resolvePlannerModelConfig } from "../model-gateway/config.js";
import type { TemplateContract } from "./template-contract.js";
import {
  buildTemplateClassificationModelRequest,
  parseTemplateClassificationResult
} from "./template-classifier.js";
import type { TemplateContext, TemplateLlmConfig } from "./types.js";

export type TemplateClassificationProbeMode = "json_schema" | "plain_json" | "template_classification";

export interface TemplateClassificationProbeInput {
  mode: TemplateClassificationProbeMode;
  llm?: TemplateLlmConfig;
  env?: NodeJS.ProcessEnv;
  template?: TemplateContract;
  context?: TemplateContext;
}

export interface TemplateClassificationProbeDeps {
  fetchImpl?: typeof fetch;
}

export interface TemplateClassificationProbeResult {
  mode: TemplateClassificationProbeMode;
  status: "completed" | "failed";
  endpoint: string;
  model: string;
  timeoutMs: number;
  hasResponseFormat: boolean;
  payloadBytes: number;
  schemaBytes: number;
  elapsedMs: number;
  stage: "request" | "parse" | "completed";
  error?: {
    code: string;
    message: string;
  };
}

export async function runTemplateClassificationProbe(
  input: TemplateClassificationProbeInput,
  deps: TemplateClassificationProbeDeps = {}
): Promise<TemplateClassificationProbeResult> {
  const config = resolvePlannerModelConfig(input.llm ?? {}, input.env);
  const request = buildProbeRequest(input);
  const responseFormat = request.schema
    ? {
        type: "json_schema",
        json_schema: {
          name: request.schemaName,
          strict: config.schemaStrict !== false,
          schema: request.schema
        }
      }
    : undefined;
  const payloadBytes = byteLength(
    JSON.stringify({
      model: config.model,
      temperature: config.temperature ?? 0,
      messages: request.messages,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      stream: false
    })
  );
  const baseResult = {
    mode: input.mode,
    endpoint: summarizeEndpoint(config.baseUrl),
    model: config.model,
    timeoutMs: config.timeoutMs ?? 30000,
    hasResponseFormat: responseFormat !== undefined,
    payloadBytes,
    schemaBytes: request.schema ? byteLength(JSON.stringify(request.schema)) : 0
  };
  const client = new OpenAiCompatibleChatClient(config, {
    fetchImpl: deps.fetchImpl,
    diagnosticSink: () => undefined
  });
  const startedAt = Date.now();
  let stage: TemplateClassificationProbeResult["stage"] = "request";

  try {
    const content = await client.requestCompletion({
      messages: request.messages,
      responseFormat,
      requestCode: "E_TEMPLATE_CLASSIFICATION_PROBE_REQUEST",
      upstreamCode: "E_TEMPLATE_CLASSIFICATION_PROBE_UPSTREAM",
      responseCode: "E_TEMPLATE_CLASSIFICATION_PROBE_RESPONSE",
      requestLabel: "Template classification probe request",
      payloadLabel: "Template classification probe payload",
      requestTimeoutMs: config.timeoutMs,
      schemaUnsupportedCode: "E_TEMPLATE_CLASSIFICATION_PROBE_SCHEMA_UNSUPPORTED",
      diagnosticStage: "classification_probe",
      diagnosticMetadata: {
        requestMode: responseFormat ? "json_schema" : "fallback_json"
      }
    });
    stage = "parse";
    request.parseContent(content);
    return {
      ...baseResult,
      status: "completed",
      elapsedMs: Date.now() - startedAt,
      stage: "completed"
    };
  } catch (err) {
    const info = asAppError(err, "E_TEMPLATE_CLASSIFICATION_PROBE_REQUEST");
    return {
      ...baseResult,
      status: "failed",
      elapsedMs: Date.now() - startedAt,
      stage,
      error: {
        code: info.code,
        message: info.message
      }
    };
  }
}

function buildProbeRequest(input: TemplateClassificationProbeInput): {
  messages: ConversationMessage[];
  schemaName: string;
  schema?: Record<string, unknown>;
  parseContent: (content: string) => unknown;
} {
  if (input.mode === "template_classification") {
    if (!input.template || !input.context) {
      throw new Error("template_classification probe requires template and context.");
    }
    const request = buildTemplateClassificationModelRequest(input.template, input.context);
    return {
      messages: request.messages,
      schemaName: request.schemaName,
      schema: request.schema,
      parseContent: (content) =>
        parseTemplateClassificationResult({
          template: input.template as TemplateContract,
          context: input.context as TemplateContext,
          rawContent: content,
          batchDiagnostics: {
            batchType: request.batch.bucket_type,
            batchIndex: request.batch.batch_index,
            batchCount: request.batch.batch_count
          }
        })
    };
  }

  const messages: ConversationMessage[] = [
    {
      role: "system",
      content: "Return JSON only."
    },
    {
      role: "user",
      content: JSON.stringify({ instruction: "Return {\"ok\": true}." })
    }
  ];
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: {
      ok: { type: "boolean" }
    }
  };
  return {
    messages,
    schemaName: "template_classification_probe",
    schema: input.mode === "json_schema" ? schema : undefined,
    parseContent: (content) => JSON.parse(content) as Record<string, unknown>
  };
}

function summarizeEndpoint(baseUrl: string): string {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  try {
    const url = new URL(endpoint);
    return `${url.host}${url.pathname}`;
  } catch {
    return endpoint.replace(/^https?:\/\//i, "");
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
