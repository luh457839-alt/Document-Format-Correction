import { describe, expect, it } from "vitest";
import { AgentError } from "../src/core/errors.js";
import {
  LlmPlanner,
  resolvePlannerModelConfig,
  resolvePlannerRuntimeMode
} from "../src/planner/llm-planner.js";
import type { DocumentIR } from "../src/core/types.js";

const baseDoc: DocumentIR = {
  id: "demo",
  version: "v1",
  nodes: [{ id: "n1", text: "hello" }]
};

const anchoredDoc: DocumentIR = {
  id: "demo-anchors",
  version: "v1",
  nodes: [
    { id: "p_0_r_0", text: "主标题", style: { is_bold: true } },
    { id: "p_1_r_0", text: "摘要", style: { is_bold: true } },
    { id: "p_1_r_1", text: "：这是摘要内容" },
    { id: "p_2_r_0", text: "关键词", style: { highlight_color: "yellow" } },
    { id: "p_2_r_1", text: "：机器学习；排版" }
  ],
  metadata: {
    structureIndex: {
      paragraphs: [
        { id: "p_0", text: "主标题", role: "heading", headingLevel: 1, runNodeIds: ["p_0_r_0"] },
        { id: "p_1", text: "摘要：这是摘要内容", role: "body", runNodeIds: ["p_1_r_0", "p_1_r_1"] },
        { id: "p_2", text: "关键词：机器学习；排版", role: "body", runNodeIds: ["p_2_r_0", "p_2_r_1"] }
      ],
      roleCounts: { heading: 1, body: 2 },
      paragraphMap: {}
    }
  }
};

function createEnvelope(planText: string): string {
  return JSON.stringify({
    choices: [{ message: { content: planText } }]
  });
}

function createFetchMock(payload: string, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => payload
    }) as unknown as Response) as typeof fetch;
}

function createFetchSpy(payload: string, status = 200): {
  fetchImpl: typeof fetch;
  getBody: () => Record<string, unknown> | null;
} {
  let lastBody: Record<string, unknown> | null = null;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      lastBody = JSON.parse(init.body) as Record<string, unknown>;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => payload
    } as unknown as Response;
  }) as typeof fetch;

  return {
    fetchImpl,
    getBody: () => lastBody
  };
}

function createSequentialFetchSpy(
  responses: Array<{ payload: string; status?: number }>
): {
  fetchImpl: typeof fetch;
  getBodies: () => Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let index = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: (response.status ?? 200) >= 200 && (response.status ?? 200) < 300,
      status: response.status ?? 200,
      text: async () => response.payload
    } as unknown as Response;
  }) as typeof fetch;

  return {
    fetchImpl,
    getBodies: () => bodies
  };
}

describe("planner config", () => {
  it("prefers explicit config over env defaults", () => {
    const cfg = resolvePlannerModelConfig(
      {
        apiKey: "explicit-key",
        baseUrl: "https://explicit/v1",
        model: "explicit-model"
      },
      {
        TS_AGENT_PLANNER_API_KEY: "env-key",
        TS_AGENT_PLANNER_BASE_URL: "https://env/v1",
        TS_AGENT_PLANNER_MODEL: "env-model"
      }
    );
    expect(cfg.apiKey).toBe("explicit-key");
    expect(cfg.baseUrl).toBe("https://explicit/v1");
    expect(cfg.model).toBe("explicit-model");
  });

  it("auto-enables local-model compatibility defaults", () => {
    const cfg = resolvePlannerModelConfig(
      {},
      {
        TS_AGENT_PLANNER_API_KEY: "env-key",
        TS_AGENT_PLANNER_BASE_URL: "http://localhost:8080/v1",
        TS_AGENT_PLANNER_MODEL: "gemma-4"
      }
    );

    expect(cfg.compatMode).toBe("auto");
    expect(cfg.runtimeMode).toBe("plan_once");
    expect(cfg.timeoutMs).toBe(90000);
    expect(cfg.useJsonSchema).toBe(false);
  });

  it("preserves explicit runtime and schema overrides over compatibility defaults", () => {
    const cfg = resolvePlannerModelConfig(
      {
        compatMode: "auto",
        runtimeMode: "react_loop",
        timeoutMs: 45000,
        useJsonSchema: true
      },
      {
        TS_AGENT_PLANNER_API_KEY: "env-key",
        TS_AGENT_PLANNER_BASE_URL: "http://localhost:8080/v1",
        TS_AGENT_PLANNER_MODEL: "gemma-4"
      }
    );

    expect(cfg.runtimeMode).toBe("react_loop");
    expect(cfg.timeoutMs).toBe(45000);
    expect(cfg.useJsonSchema).toBe(true);
  });

  it("chooses react_loop by default for remote models", () => {
    expect(
      resolvePlannerRuntimeMode(
        {
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini"
        },
        {
          TS_AGENT_PLANNER_API_KEY: "env-key"
        }
      )
    ).toBe("react_loop");
  });

  it("throws when apiKey is unavailable", () => {
    expect(
      () =>
        new LlmPlanner({
          env: {},
          config: { baseUrl: "https://x/v1", model: "m" }
        })
    ).toThrowError(/apiKey is missing/);
  });
});

describe("llm planner createPlan", () => {
  it("parses valid plan json", async () => {
    const plan = {
      taskId: "task_demo",
      goal: "normalize font",
      steps: [
        {
          id: "s1",
          toolName: "inspect_document",
          readOnly: true,
          idempotencyKey: "inspect:s1"
        },
        {
          id: "s2",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "write:s2",
          operation: {
            id: "op1",
            type: "set_font",
            targetNodeId: "n1",
            payload: { fontName: "SimSun" }
          }
        }
      ]
    };
    const spy = createFetchSpy(createEnvelope(JSON.stringify(plan)));
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: spy.fetchImpl
    });

    const result = await planner.createPlan("normalize font", baseDoc);
    expect(result).toEqual(plan);

    const body = spy.getBody();
    expect(body).toBeTruthy();
    const responseFormat = body?.response_format as Record<string, unknown>;
    expect(responseFormat?.type).toBe("json_schema");
    const jsonSchema = responseFormat?.json_schema as Record<string, unknown>;
    expect(jsonSchema?.strict).toBe(true);
    expect(jsonSchema?.name).toBe("document_plan");
  });

  it("includes standardized payload field rules in planner prompt", async () => {
    const spy = createFetchSpy(
      createEnvelope(
        JSON.stringify({
          taskId: "task_demo",
          goal: "normalize font",
          steps: [
            {
              id: "s1",
              toolName: "inspect_document",
              readOnly: true,
              idempotencyKey: "inspect:s1"
            }
          ]
        })
      )
    );
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: spy.fetchImpl
    });

    await planner.createPlan("把字号改成22", baseDoc);

    const body = spy.getBody();
    const prompt = String(body?.messages?.[1]?.content ?? "");
    expect(prompt).toContain("font_name");
    expect(prompt).toContain("font_size_pt");
    expect(prompt).toContain("font_color");
    expect(prompt).toContain("highlight_color");
    expect(prompt).toContain("split_offset");
    expect(prompt).toContain("set_font");
    expect(prompt).toContain("set_size");
    expect(prompt).toContain("set_font_color");
    expect(prompt).toContain("set_highlight_color");
    expect(prompt).toContain("set_all_caps");
    expect(prompt).toContain("targetSelector");
    expect(prompt).toContain("body");
    expect(prompt).toContain("heading");
    expect(prompt).toContain("Bulleted/numbered paragraphs are targetSelector.scope='list_item'");
    expect(prompt).toContain("do not guess");
  });

  it("tightens planner prompt with executable-write semantics", async () => {
    const spy = createFetchSpy(
      createEnvelope(
        JSON.stringify({
          taskId: "task_demo",
          goal: "正文改成宋体",
          steps: [
            {
              id: "s1",
              toolName: "inspect_document",
              readOnly: true,
              idempotencyKey: "inspect:s1"
            }
          ]
        })
      )
    );
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: spy.fetchImpl
    });

    await planner.createPlan("正文改成宋体", anchoredDoc);

    const prompt = String(spy.getBody()?.messages?.[1]?.content ?? "");
    expect(prompt).toContain("semantically executable");
    expect(prompt).toContain("never use placeholder ids like 'placeholder', 'unused', or 'target'");
    expect(prompt).toContain("never emit an empty payload");
    expect(prompt).toContain("only downgrade to inspect_document when no real document range can be grounded");
  });

  it("omits response_format when json schema is disabled", async () => {
    const spy = createFetchSpy(
      createEnvelope(
        JSON.stringify({
          taskId: "task_demo",
          goal: "normalize font",
          steps: [
            {
              id: "s1",
              toolName: "inspect_document",
              readOnly: true,
              idempotencyKey: "inspect:s1"
            }
          ]
        })
      )
    );
    const planner = new LlmPlanner({
      config: {
        apiKey: "k",
        baseUrl: "http://localhost:8080/v1",
        model: "gemma-4",
        useJsonSchema: false
      },
      fetchImpl: spy.fetchImpl
    });

    await planner.createPlan("把字号改成22", baseDoc);

    const body = spy.getBody();
    expect(body?.response_format).toBeUndefined();
  });

  it("auto-fills missing step, idempotency, and operation ids", async () => {
    const plan = {
      taskId: "task_demo",
      goal: "normalize font",
      steps: [
        {
          toolName: "inspect_document",
          readOnly: true
        },
        {
          toolName: "write_operation",
          readOnly: false,
          operation: {
            type: "set_font",
            targetNodeId: "n1",
            payload: { fontName: "SimSun" }
          }
        }
      ]
    };
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: createFetchMock(createEnvelope(JSON.stringify(plan)))
    });

    const result = await planner.createPlan("normalize font", baseDoc);

    expect(result.steps[0].id).toBe("step_0");
    expect(result.steps[0].idempotencyKey).toBe("auto:step_0");
    expect(result.steps[1].id).toBe("step_1");
    expect(result.steps[1].idempotencyKey).toBe("auto:step_1");
    expect(result.steps[1].operation?.id).toBe("step_1_op");
  });

  it("fails on non-json planner content", async () => {
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: createFetchMock(createEnvelope("not-json"))
    });

    await expect(planner.createPlan("goal", baseDoc)).rejects.toSatisfy(
      (err: unknown) => err instanceof AgentError && err.info.code === "E_PLANNER_PLAN_PARSE"
    );
  });

  it("fails when plan contains invalid operation type", async () => {
    const invalid = {
      taskId: "task_demo",
      goal: "normalize font",
      steps: [
        {
          id: "s1",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "write:s1",
          operation: {
            id: "op1",
            type: "unsupported",
            targetNodeId: "n1",
            payload: {}
          }
        }
      ]
    };
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: createFetchMock(createEnvelope(JSON.stringify(invalid)))
    });

    await expect(planner.createPlan("goal", baseDoc)).rejects.toSatisfy(
      (err: unknown) => err instanceof AgentError && err.info.code === "E_PLANNER_PLAN_INVALID"
    );
  });

  it("fails when operation target node id is missing", async () => {
    const invalid = {
      taskId: "task_demo",
      goal: "normalize font",
      steps: [
        {
          id: "s1",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "write:s1",
          operation: {
            id: "op1",
            type: "set_font",
            payload: {}
          }
        }
      ]
    };
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: createFetchMock(createEnvelope(JSON.stringify(invalid)))
    });

    await expect(planner.createPlan("goal", baseDoc)).rejects.toSatisfy(
      (err: unknown) => err instanceof AgentError && err.info.code === "E_PLANNER_PLAN_INVALID"
    );
  });

  it("repairs invalid plan when target node id is omitted", async () => {
    const invalid = {
      taskId: "task_demo",
      goal: "normalize font",
      steps: [
        {
          id: "s1",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "write:s1",
          operation: {
            id: "op1",
            type: "set_font",
            payload: { fontName: "SimSun" }
          }
        }
      ]
    };
    const repaired = {
      taskId: "task_demo",
      goal: "normalize font",
      steps: [
        {
          id: "s1",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "write:s1",
          operation: {
            id: "op1",
            type: "set_font",
            targetNodeId: "n1",
            payload: { fontName: "SimSun" }
          }
        }
      ]
    };
    const spy = createSequentialFetchSpy([
      { payload: createEnvelope(JSON.stringify(invalid)) },
      { payload: createEnvelope(JSON.stringify(repaired)) }
    ]);
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: spy.fetchImpl
    });

    const result = await planner.createPlan("normalize font", baseDoc);

    expect(result).toEqual(repaired);
    const bodies = spy.getBodies();
    expect(bodies).toHaveLength(2);
    expect(String(bodies[1]?.messages?.[1]?.content ?? "")).toContain(
      "operation.targetNodeId or operation.targetSelector is required"
    );
    expect(String(bodies[1]?.messages?.[1]?.content ?? "")).toContain("\"n1\"");
  });

  it("repairs write_operation steps when operation is omitted", async () => {
    const invalid = {
      taskId: "task_demo",
      goal: "摘要及关键词段落改为绿色",
      steps: [
        {
          id: "s1",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "write:s1"
        }
      ]
    };
    const repaired = {
      taskId: "task_demo",
      goal: "摘要及关键词段落改为绿色",
      steps: [
        {
          id: "s1",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "write:s1",
          operation: {
            id: "op1",
            type: "set_font_color",
            targetSelector: {
              scope: "paragraph_ids",
              paragraphIds: ["p_1", "p_2"]
            },
            payload: { font_color: "00FF00" }
          }
        }
      ]
    };
    const spy = createSequentialFetchSpy([
      { payload: createEnvelope(JSON.stringify(invalid)) },
      { payload: createEnvelope(JSON.stringify(repaired)) }
    ]);
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: spy.fetchImpl
    });

    const result = await planner.createPlan("摘要及关键词段落改为绿色", anchoredDoc);

    expect(result.steps[0].operation?.targetSelector).toEqual({
      scope: "paragraph_ids",
      paragraphIds: ["p_1", "p_2"]
    });
    const repairPrompt = String(spy.getBodies()[1]?.messages?.[1]?.content ?? "");
    expect(repairPrompt).toContain("write_operation");
    expect(repairPrompt).toContain("operation");
  });

  it("rejects placeholder target node ids during plan repair", async () => {
    const invalid = {
      taskId: "task_demo",
      goal: "正文改成宋体",
      steps: [
        {
          id: "s1",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "write:s1",
          operation: {
            id: "op1",
            type: "set_font",
            targetNodeId: "placeholder",
            payload: { font_name: "SimSun" }
          }
        }
      ]
    };
    const spy = createSequentialFetchSpy([
      { payload: createEnvelope(JSON.stringify(invalid)) },
      { payload: createEnvelope(JSON.stringify(invalid)) }
    ]);
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: spy.fetchImpl
    });

    await expect(planner.createPlan("正文改成宋体", anchoredDoc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_PLANNER_PLAN_INVALID" &&
        err.info.message.includes("placeholder")
    );
  });

  it("rejects empty write payloads during plan repair", async () => {
    const invalid = {
      taskId: "task_demo",
      goal: "正文改成宋体",
      steps: [
        {
          id: "s1",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "write:s1",
          operation: {
            id: "op1",
            type: "set_font",
            targetSelector: { scope: "body" },
            payload: {}
          }
        }
      ]
    };
    const spy = createSequentialFetchSpy([
      { payload: createEnvelope(JSON.stringify(invalid)) },
      { payload: createEnvelope(JSON.stringify(invalid)) }
    ]);
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: spy.fetchImpl
    });

    await expect(planner.createPlan("正文改成宋体", anchoredDoc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_PLANNER_PLAN_INVALID" &&
        err.info.message.includes("payload")
    );
  });

  it("includes emphasis index guidance for semantic anchors", async () => {
    const spy = createFetchSpy(
      createEnvelope(
        JSON.stringify({
          taskId: "task_demo",
          goal: "摘要及关键词段落改为绿色",
          steps: [
            {
              id: "s1",
              toolName: "write_operation",
              readOnly: false,
              idempotencyKey: "write:s1",
              operation: {
                id: "op1",
                type: "set_font_color",
                targetSelector: {
                  scope: "paragraph_ids",
                  paragraphIds: ["p_1", "p_2"]
                },
                payload: { font_color: "00FF00" }
              }
            }
          ]
        })
      )
    );
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: spy.fetchImpl
    });

    const result = await planner.createPlan("摘要及关键词段落改为绿色", anchoredDoc);

    expect(result.steps[0].operation?.targetSelector).toEqual({
      scope: "paragraph_ids",
      paragraphIds: ["p_1", "p_2"]
    });
    const prompt = String(spy.getBody()?.messages?.[1]?.content ?? "");
    expect(prompt).toContain("emphasisIndex");
    expect(prompt).toContain("摘要");
    expect(prompt).toContain("关键词");
    expect(prompt).toContain("paragraph_ids");
  });


  it("accepts target selectors for structure-wide writes", async () => {
    const plan = {
      taskId: "task_demo",
      goal: "正文设为红色",
      steps: [
        {
          id: "s1",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "write:s1",
          operation: {
            id: "op1",
            type: "set_font_color",
            targetSelector: {
              scope: "body"
            },
            payload: { font_color: "FF0000" }
          }
        }
      ]
    };
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: createFetchMock(createEnvelope(JSON.stringify(plan)))
    });

    const result = await planner.createPlan("正文设为红色", {
      ...baseDoc,
      metadata: {
        structureIndex: {
          paragraphs: [{ id: "p_1", role: "body", runNodeIds: ["n1"] }],
          roleCounts: { body: 1 },
          paragraphMap: {}
        }
      }
    });

    expect(result.steps[0].operation).toMatchObject({
      targetSelector: { scope: "body" },
      payload: { font_color: "FF0000" }
    });
  });

  it("fails when steps are empty", async () => {
    const invalid = {
      taskId: "task_demo",
      goal: "normalize font",
      steps: []
    };
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: createFetchMock(createEnvelope(JSON.stringify(invalid)))
    });

    await expect(planner.createPlan("goal", baseDoc)).rejects.toSatisfy(
      (err: unknown) => err instanceof AgentError && err.info.code === "E_PLANNER_PLAN_INVALID"
    );
  });

  it("fails with dedicated error when upstream does not support json_schema", async () => {
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: createFetchMock(
        JSON.stringify({
          error: {
            message: "response_format.json_schema is not supported by this model"
          }
        }),
        400
      )
    });

    await expect(planner.createPlan("goal", baseDoc)).rejects.toSatisfy(
      (err: unknown) => err instanceof AgentError && err.info.code === "E_PLANNER_SCHEMA_UNSUPPORTED"
    );
  });
});
