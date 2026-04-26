import { describe, expect, it, vi } from "vitest";
import { AgentError } from "../src/core/errors.js";
import { buildTemplateContextFromObservation } from "../src/templates/template-context-builder.js";
import { classifyTemplateParagraphs } from "../src/templates/template-classifier.js";
import type { TemplateContract } from "../src/templates/template-contract.js";
import type { PythonDocxObservationState } from "../src/tools/python-tool-client.js";

const template: TemplateContract = {
  template_meta: {
    id: "official_doc_body",
    name: "公文正文模板",
    version: "1.0.0",
    schema_version: "2.0"
  },
  semantic_blocks: [
    {
      key: "title",
      label: "标题",
      description: "公文标题",
      required: true,
      multiple: false
    }
  ],
  layout_rules: {
    global_rules: {
      document_scope: "full_document",
      ordering: ["title"],
      allow_unclassified_paragraphs: false
    },
    semantic_rules: []
  },
  operation_blocks: [],
  classification_contract: {
    scope: "paragraph",
    single_owner_per_paragraph: true
  },
  validation_policy: {
    enforce_validation: true,
    min_confidence: 0.8,
    require_all_required_semantics: true,
    reject_conflicting_matches: true,
    reject_order_violations: true,
    reject_style_violations: true,
    reject_unmatched_when_required: true
  }
};

const observation: PythonDocxObservationState = {
  document_meta: {
    total_paragraphs: 1,
    total_tables: 0
  },
  paragraphs: [
    {
      id: "p1",
      text: "关于开展年度检查工作的通知",
      role: "heading",
      heading_level: 1,
      style_name: "Heading 1",
      run_ids: ["p1_r1"],
      in_table: false
    }
  ],
  nodes: [
    {
      id: "p1",
      node_type: "paragraph",
      children: [
        {
          id: "p1_r1",
          node_type: "text_run",
          content: "关于开展年度检查工作的通知",
          style: {}
        }
      ]
    }
  ]
};

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

function successfulClassificationFetch(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                scope: "paragraph",
                template_id: "official_doc_body",
                matches: [
                  {
                    semantic_key: "title",
                    paragraph_ids: ["p1"],
                    confidence: 0.95,
                    reason: "标题段落"
                  }
                ],
                unmatched_paragraph_ids: [],
                conflicts: [],
                overall_confidence: 0.95
              })
            },
            finish_reason: "stop"
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    )) as typeof fetch;
}

function abortThenSuccessfulClassificationFetch(): typeof fetch {
  let calls = 0;
  return ((_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    return successfulClassificationFetch()(_input, init);
  }) as typeof fetch;
}

function readDiagnosticEvents(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((call) => String(call[0] ?? ""))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((event) => event.type === "model_request_diagnostic");
}

describe("classifyTemplateParagraphs timeout control", () => {
  it("emits start and success diagnostics for template classification fetches", async () => {
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let events: Array<Record<string, unknown>> = [];
    try {
      await classifyTemplateParagraphs(
        {
          template,
          context,
          llm: {
            apiKey: "secret-key",
            baseUrl: "https://mock.example/v1",
            model: "m",
            timeoutMs: 1000,
            maxRetries: 0
          }
        },
        {
          fetchImpl: successfulClassificationFetch()
        }
      );
      events = readDiagnosticEvents(stderrSpy);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(events.map((event) => event.phase)).toEqual([
      "classification_request_start",
      "classification_request_done"
    ]);
    expect(events[0]).toMatchObject({
      endpointHost: "mock.example",
      endpointPath: "/v1/chat/completions",
      model: "m",
      timeoutMs: 1000,
      jsonSchemaEnabled: true,
      requestMode: "json_schema",
      batchType: "heading",
      batchIndex: 1,
      batchCount: 1,
      batchParagraphCount: 1,
      paragraphCount: 1,
      semanticBlockCount: 1,
      fallbackAttempt: 0
    });
    expect(typeof events[0]?.promptBytes).toBe("number");
    expect(typeof events[0]?.schemaBytes).toBe("number");
    expect(JSON.stringify(events)).not.toContain("secret-key");
  });

  it("falls back to plain JSON after a schema request abort", async () => {
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let events: Array<Record<string, unknown>> = [];

    try {
      const result = await classifyTemplateParagraphs(
        {
          template,
          context,
          llm: {
            apiKey: "secret-key",
            baseUrl: "https://mock/v1",
            model: "m",
            timeoutMs: 1,
            maxRetries: 0
          }
        },
        {
          fetchImpl: abortThenSuccessfulClassificationFetch()
        }
      );
      events = readDiagnosticEvents(stderrSpy);
      expect(result.matches[0]?.semantic_key).toBe("title");
    } finally {
      stderrSpy.mockRestore();
    }

    expect(events.map((event) => event.phase)).toEqual([
      "classification_request_start",
      "classification_request_abort",
      "classification_fallback_start",
      "classification_fallback_done"
    ]);
    expect(events.map((event) => event.requestMode)).toEqual([
      "json_schema",
      "json_schema",
      "fallback_json",
      "fallback_json"
    ]);
    expect(events[2]).toMatchObject({
      jsonSchemaEnabled: false,
      fallbackAttempt: 1,
      batchType: "heading",
      batchIndex: 1,
      batchCount: 1,
      batchParagraphCount: 1,
      paragraphCount: 1,
      semanticBlockCount: 1
    });
    expect(JSON.stringify(events)).not.toContain("secret-key");
  });

  it("keeps template classification timeout errors on the template request code", async () => {
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let events: Array<Record<string, unknown>> = [];

    try {
      await expect(
        classifyTemplateParagraphs(
          {
            template,
            context,
            llm: {
              apiKey: "secret-key",
              baseUrl: "https://mock/v1",
              model: "m",
              timeoutMs: 1,
              maxRetries: 0
            }
          },
          {
            fetchImpl: abortingFetch()
          }
        )
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof AgentError &&
          err.info.code === "E_TEMPLATE_CLASSIFICATION_REQUEST" &&
          err.info.message.includes("Template classification request timed out after 1ms.") &&
          err.info.message.includes("fallback failed") &&
          err.info.message.includes("requestMode=fallback_json") &&
          err.info.message.includes("stage=classification_fallback") &&
          err.info.message.includes("endpoint=mock/v1/chat/completions") &&
          err.info.message.includes("model=m") &&
          err.info.message.includes("timeoutMs=1") &&
          !err.info.message.includes("secret-key")
      );
      events = readDiagnosticEvents(stderrSpy);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(events.map((event) => event.phase)).toEqual([
      "classification_request_start",
      "classification_request_abort",
      "classification_fallback_start",
      "classification_fallback_abort"
    ]);
  });

  it("clips template classification requests to a smaller request budget", async () => {
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation
    });

    await expect(
      classifyTemplateParagraphs(
        {
          template,
          context,
          llm: {
            apiKey: "k",
            baseUrl: "https://mock/v1",
            model: "m",
            timeoutMs: 30_000,
            maxRetries: 0
          },
          requestTimeoutMs: 1
        },
        {
          fetchImpl: abortingFetch()
        }
      )
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_TEMPLATE_CLASSIFICATION_REQUEST" &&
        err.info.message.includes("Template classification request timed out after 1ms.") &&
        err.info.message.includes("fallback failed") &&
        err.info.message.includes("stage=classification_fallback") &&
        err.info.message.includes("requestMode=fallback_json") &&
        err.info.message.includes("timeoutMs=1")
    );
  });
});
