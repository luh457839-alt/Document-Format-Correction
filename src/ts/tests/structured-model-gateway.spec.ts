import { describe, expect, it } from "vitest";
import { AgentError } from "../src/core/errors.js";
import { OpenAiStructuredModelGateway } from "../src/model-gateway/structured-model-gateway.js";

function abortingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as typeof fetch;
}

describe("OpenAiStructuredModelGateway", () => {
  it("omits response_format when planner json schema is disabled", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const gateway = new OpenAiStructuredModelGateway({
      plannerConfig: {
        apiKey: "k",
        baseUrl: "https://mock/v1",
        model: "m",
        timeoutMs: 30_000,
        maxRetries: 0,
        useJsonSchema: false
      },
      fetchImpl: (async (_url, init) => {
        requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ ok: true })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }) as typeof fetch
    });

    const result = await gateway.requestJson({
      messages: [{ role: "user", content: "return json" }],
      requestCode: "E_STRUCT_REQUEST",
      upstreamCode: "E_STRUCT_UPSTREAM",
      responseCode: "E_STRUCT_RESPONSE",
      requestLabel: "Structured request",
      payloadLabel: "Structured payload",
      schemaUnsupportedCode: "E_STRUCT_SCHEMA_UNSUPPORTED",
      schemaName: "structured_result",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      },
      parseContent: (content) => JSON.parse(content) as Record<string, unknown>
    });

    expect(result).toEqual({ ok: true });
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]?.response_format).toBeUndefined();
    expect(JSON.stringify(requestBodies[0]?.messages)).toContain("structured_result");
    expect(JSON.stringify(requestBodies[0]?.messages)).toContain("JSON Schema");
  });

  it("falls back without response_format when schema requests are unsupported", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const gateway = new OpenAiStructuredModelGateway({
      plannerConfig: {
        apiKey: "k",
        baseUrl: "https://mock/v1",
        model: "m",
        timeoutMs: 30_000,
        maxRetries: 0
      },
      fetchImpl: (async (_url, init) => {
        requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        if (requestBodies.length === 1) {
          return new Response(JSON.stringify({ error: "response_format json_schema unsupported" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ ok: true })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }) as typeof fetch
    });

    const result = await gateway.requestJson({
      messages: [{ role: "user", content: "return json" }],
      requestCode: "E_STRUCT_REQUEST",
      upstreamCode: "E_STRUCT_UPSTREAM",
      responseCode: "E_STRUCT_RESPONSE",
      requestLabel: "Structured request",
      payloadLabel: "Structured payload",
      schemaUnsupportedCode: "E_STRUCT_SCHEMA_UNSUPPORTED",
      schemaName: "structured_result",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {}
      },
      parseContent: (content) => JSON.parse(content) as Record<string, unknown>
    });

    expect(result).toEqual({ ok: true });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.response_format).toMatchObject({ type: "json_schema" });
    expect(requestBodies[1]?.response_format).toBeUndefined();
  });

  it("preserves schema unsupported failures in strict compat mode", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const gateway = new OpenAiStructuredModelGateway({
      plannerConfig: {
        apiKey: "k",
        baseUrl: "https://mock/v1",
        model: "m",
        timeoutMs: 30_000,
        maxRetries: 0,
        compatMode: "strict"
      },
      fetchImpl: (async (_url, init) => {
        requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            error: "response_format json_schema unsupported"
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" }
          }
        );
      }) as typeof fetch
    });

    await expect(
      gateway.requestJson({
        messages: [{ role: "user", content: "return json" }],
        requestCode: "E_STRUCT_REQUEST",
        upstreamCode: "E_STRUCT_UPSTREAM",
        responseCode: "E_STRUCT_RESPONSE",
        requestLabel: "Structured request",
        payloadLabel: "Structured payload",
        schemaUnsupportedCode: "E_STRUCT_SCHEMA_UNSUPPORTED",
        schemaName: "structured_result",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {}
        },
        parseContent: (content) => JSON.parse(content) as Record<string, unknown>
      })
    ).rejects.toMatchObject({
      info: expect.objectContaining({
        code: "E_STRUCT_SCHEMA_UNSUPPORTED"
      })
    });

    expect(requestBodies).toHaveLength(1);
  });

  it("applies request-level timeout control to structured JSON requests", async () => {
    const gateway = new OpenAiStructuredModelGateway({
      plannerConfig: {
        apiKey: "k",
        baseUrl: "https://mock/v1",
        model: "m",
        timeoutMs: 30_000,
        maxRetries: 0
      },
      fetchImpl: abortingFetch()
    });

    await expect(
      gateway.requestJson(
        {
          messages: [{ role: "user", content: "return json" }],
          requestCode: "E_STRUCT_REQUEST",
          upstreamCode: "E_STRUCT_UPSTREAM",
          responseCode: "E_STRUCT_RESPONSE",
          requestLabel: "Structured request",
          payloadLabel: "Structured payload",
          schemaUnsupportedCode: "E_STRUCT_SCHEMA_UNSUPPORTED",
          schemaName: "structured_result",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {}
          },
          parseContent: (content) => JSON.parse(content) as Record<string, unknown>,
          requestTimeoutMs: 1
        },
        {}
      )
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_TASK_TIMEOUT" &&
        err.info.message.includes("Task budget exceeded while waiting for structured request response.") &&
        err.info.message.includes("stage=model_request") &&
        err.info.message.includes("endpoint=mock/v1/chat/completions") &&
        err.info.message.includes("model=m") &&
        err.info.message.includes("timeoutMs=1")
    );
  });
});
