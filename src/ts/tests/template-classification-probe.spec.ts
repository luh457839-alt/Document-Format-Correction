import { describe, expect, it } from "vitest";

describe("template classification probe", () => {
  it("reports json_schema request shape without leaking credentials", async () => {
    const { runTemplateClassificationProbe } = await import("../src/templates/template-classification-probe.js");
    const requestBodies: Array<Record<string, unknown>> = [];

    const result = await runTemplateClassificationProbe(
      {
        mode: "json_schema",
        llm: {
          apiKey: "secret-key",
          baseUrl: "https://mock.example/v1",
          model: "m",
          timeoutMs: 1234,
          maxRetries: 0
        }
      },
      {
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
      }
    );

    expect(result).toMatchObject({
      mode: "json_schema",
      status: "completed",
      endpoint: "mock.example/v1/chat/completions",
      model: "m",
      timeoutMs: 1234,
      hasResponseFormat: true,
      stage: "completed"
    });
    expect(result.payloadBytes).toBeGreaterThan(0);
    expect(result.schemaBytes).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(requestBodies[0]?.response_format).toMatchObject({ type: "json_schema" });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("reports plain json request shape without response_format", async () => {
    const { runTemplateClassificationProbe } = await import("../src/templates/template-classification-probe.js");
    const requestBodies: Array<Record<string, unknown>> = [];

    const result = await runTemplateClassificationProbe(
      {
        mode: "plain_json",
        llm: {
          apiKey: "secret-key",
          baseUrl: "https://mock.example/v1",
          model: "m",
          timeoutMs: 1234,
          maxRetries: 0
        }
      },
      {
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
      }
    );

    expect(result).toMatchObject({
      mode: "plain_json",
      status: "completed",
      hasResponseFormat: false,
      schemaBytes: 0
    });
    expect(requestBodies[0]?.response_format).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });
});
