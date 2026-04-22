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

function createChoiceEnvelope(message: Record<string, unknown>, choice: Record<string, unknown> = {}): string {
  return JSON.stringify({
    choices: [{ ...choice, message }]
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

  it("resolves runtime timeout tuning fields", () => {
    const cfg = resolvePlannerModelConfig(
      {
        apiKey: "explicit-key",
        baseUrl: "https://explicit/v1",
        model: "explicit-model",
        stepTimeoutMs: 61000,
        taskTimeoutMs: 180000,
        pythonToolTimeoutMs: 62000,
        maxTurns: 40,
        syncRequestTimeoutMs: 420000
      },
      {}
    );

    expect(cfg.stepTimeoutMs).toBe(61000);
    expect(cfg.taskTimeoutMs).toBe(180000);
    expect(cfg.pythonToolTimeoutMs).toBe(62000);
    expect(cfg.maxTurns).toBe(40);
    expect(cfg.syncRequestTimeoutMs).toBe(420000);
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

  it("parses array-based message content from compatible envelopes", async () => {
    const plan = {
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
    };
    const spy = createFetchSpy(
      createChoiceEnvelope({
        content: [
          { type: "text", text: "{\"taskId\":\"task_demo\"," },
          { type: "text", text: "\"goal\":\"normalize font\",\"steps\":[{\"id\":\"s1\",\"toolName\":\"inspect_document\",\"readOnly\":true,\"idempotencyKey\":\"inspect:s1\"}]}" }
        ]
      })
    );
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: spy.fetchImpl
    });

    await expect(planner.createPlan("normalize font", baseDoc)).resolves.toEqual(plan);
  });

  it("recovers planner content from choice.text when message.content is missing", async () => {
    const plan = {
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
    };
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: createFetchMock(
        JSON.stringify({
          choices: [
            {
              text: JSON.stringify(plan),
              message: {}
            }
          ]
        })
      )
    });

    await expect(planner.createPlan("normalize font", baseDoc)).resolves.toEqual(plan);
  });

  it("reports empty content strings with diagnostics", async () => {
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: createFetchMock(
        createChoiceEnvelope(
          {
            content: "   "
          },
          { finish_reason: "stop" }
        )
      )
    });

    await expect(planner.createPlan("normalize font", baseDoc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_PLANNER_MODEL_RESPONSE" &&
        err.info.message.includes("empty message content string") &&
        err.info.message.includes("choices=1")
    );
  });

  it("reports refusal diagnostics when the planner response is refused", async () => {
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: createFetchMock(
        createChoiceEnvelope(
          {
            content: null,
            refusal: "policy refusal"
          },
          { finish_reason: "stop" }
        )
      )
    });

    await expect(planner.createPlan("normalize font", baseDoc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_PLANNER_MODEL_RESPONSE" &&
        err.info.message.includes("refusal") &&
        err.info.message.includes("policy refusal")
    );
  });

  it("reports incomplete choice structure when planner message is missing", async () => {
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: createFetchMock(
        JSON.stringify({
          choices: [{ finish_reason: "length" }]
        })
      )
    });

    await expect(planner.createPlan("normalize font", baseDoc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_PLANNER_MODEL_RESPONSE" &&
        err.info.message.includes("incomplete choices[0]") &&
        err.info.message.includes("finish_reason=length")
    );
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
    const systemPrompt = String(body?.messages?.[0]?.content ?? "");
    const prompt = String(body?.messages?.[1]?.content ?? "");
    expect(systemPrompt).toContain("你是一个文档格式规划引擎");
    expect(systemPrompt).toContain("You are a document-format planning engine");
    expect(prompt).toContain("请生成且只生成 1 个 Plan JSON 对象");
    expect(prompt).toContain("Generate exactly one Plan JSON object");
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

  it("prefers one semantic selector step for batchable writes in planner prompt", async () => {
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

    const systemPrompt = String(spy.getBody()?.messages?.[0]?.content ?? "");
    const userPrompt = String(spy.getBody()?.messages?.[1]?.content ?? "");
    expect(systemPrompt).toContain("runtime will expand");
    expect(systemPrompt).toContain("Do not enumerate every matched node yourself");
    expect(userPrompt).toContain("prefer one semantic write_operation step");
    expect(userPrompt).toContain("runtime expands matched selectors into targetNodeId or targetNodeIds");
    expect(userPrompt).not.toContain("if multiple nodes require edits, create multiple write_operation steps");
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

  it("normalizes mildly dirty plan fields into the current plan contract", async () => {
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: createFetchMock(
        createEnvelope(
          JSON.stringify({
            task_id: "task_demo",
            goal: "正文设为红色",
            steps: [
              {
                id: "s1",
                tool_name: "write_operation",
                read_only: "false",
                idempotency_key: "write:s1",
                operation: {
                  operation_id: "op1",
                  type: "set_font_color",
                  target_selector: {
                    scope: "BODY"
                  },
                  payload: {
                    fontColor: "#00ff00"
                  }
                }
              }
            ]
          })
        )
      )
    });

    await expect(
      planner.createPlan("正文设为红色", {
        ...baseDoc,
        metadata: {
          structureIndex: {
            paragraphs: [{ id: "p_1", role: "body", runNodeIds: ["n1"] }],
            roleCounts: { body: 1 },
            paragraphMap: {}
          }
        }
      })
    ).resolves.toEqual({
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
            payload: {
              font_color: "00FF00"
            }
          }
        }
      ]
    });
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

  it("uses bilingual planner prompts to avoid empty upstream content on english-sensitive gateways", async () => {
    const planner = new LlmPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ content?: string }>;
        };
        const systemPrompt = String(body.messages?.[0]?.content ?? "");
        const userPrompt = String(body.messages?.[1]?.content ?? "");
        const hasChinese = /[\u4e00-\u9fff]/.test(systemPrompt) && /[\u4e00-\u9fff]/.test(userPrompt);
        return {
          ok: true,
          status: 200,
          text: async () =>
            hasChinese
              ? createEnvelope(
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
              : createChoiceEnvelope(
                  {
                    content: "   "
                  },
                  { finish_reason: "stop" }
                )
        } as Response;
      }) as typeof fetch
    });

    await expect(planner.createPlan("normalize font", baseDoc)).resolves.toEqual({
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
    });
  });
});
