import { describe, expect, it } from "vitest";
import { AgentError } from "../src/core/errors.js";
import type { DocumentIR, ReActTurnInput } from "../src/core/types.js";
import { LlmReActPlanner } from "../src/planner/llm-react-planner.js";

const baseDoc: DocumentIR = {
  id: "react-doc",
  version: "v1",
  nodes: [
    { id: "n1", text: "hello" },
    { id: "n2", text: "world" }
  ]
};

const baseInput: ReActTurnInput = {
  taskId: "react-task-1",
  goal: "normalize font",
  turnIndex: 1,
  doc: baseDoc,
  history: [
    {
      turnIndex: 0,
      thought: "inspect",
      action: {
        id: "step_0",
        toolName: "inspect_document",
        readOnly: true,
        idempotencyKey: "react:0"
      },
      observation: "Inspected 2 nodes.",
      status: "completed"
    }
  ],
  sessionContext: [
    { role: "user", content: "请把标题字体统一一下" },
    { role: "assistant", content: "好的，我先检查当前结构" }
  ]
};

const anchoredDoc: DocumentIR = {
  id: "react-anchors",
  version: "v1",
  nodes: [
    { id: "p_1_r_0", text: "摘要", style: { is_bold: true } },
    { id: "p_1_r_1", text: "：这是摘要内容" },
    { id: "p_2_r_0", text: "关键词", style: { highlight_color: "yellow" } },
    { id: "p_2_r_1", text: "：机器学习；排版" }
  ],
  metadata: {
    structureIndex: {
      paragraphs: [
        { id: "p_1", text: "摘要：这是摘要内容", role: "body", runNodeIds: ["p_1_r_0", "p_1_r_1"] },
        { id: "p_2", text: "关键词：机器学习；排版", role: "body", runNodeIds: ["p_2_r_0", "p_2_r_1"] }
      ],
      roleCounts: { body: 2 },
      paragraphMap: {}
    }
  }
};

function createEnvelope(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content } }]
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

function createSequentialFetchSpy(
  responses: Array<{ content: string; status?: number }>
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
      text: async () => createEnvelope(response.content)
    } as unknown as Response;
  }) as typeof fetch;

  return {
    fetchImpl,
    getBodies: () => bodies
  };
}

describe("LlmReActPlanner.decideNext", () => {
  it("retries with a correction prompt when step.id is missing", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        content: JSON.stringify({
          kind: "act",
          step: {
            toolName: "write_operation",
            readOnly: false,
            idempotencyKey: "react:1",
            operation: {
              id: "op1",
              type: "set_font",
              targetNodeId: "n1",
              payload: { font_name: "SimSun" }
            }
          }
        })
      },
      {
        content: JSON.stringify({
          kind: "act",
          thought: "fix missing id",
          step: {
            id: "react_step_1",
            toolName: "write_operation",
            readOnly: false,
            idempotencyKey: "react:1",
            operation: {
              id: "op1",
              type: "set_font",
              targetNodeId: "n1",
              payload: { font_name: "SimSun" }
            }
          }
        })
      }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: fetchSpy.fetchImpl
    });

    const result = await planner.decideNext(baseInput);

    expect(result).toEqual({
      kind: "act",
      thought: "fix missing id",
      step: {
        id: "react_step_1",
        toolName: "write_operation",
        readOnly: false,
        idempotencyKey: "react:1",
        operation: {
          id: "op1",
          type: "set_font",
          targetNodeId: "n1",
          payload: { font_name: "SimSun" }
        }
      }
    });

    const bodies = fetchSpy.getBodies();
    expect(bodies).toHaveLength(2);
    const correctionPrompt = String((bodies[1]?.messages as Array<{ content?: string }>)[1]?.content ?? "");
    expect(correctionPrompt).toContain("previous_model_output");
    expect(correctionPrompt).toContain("Invalid ReAct step: id is required");
    expect(correctionPrompt).toContain("requiredStepFields");
    expect(correctionPrompt).toContain("Return ONLY one corrected JSON object");
  });

  it("retries finish decisions that are missing summary", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        content: JSON.stringify({
          kind: "finish"
        })
      },
      {
        content: JSON.stringify({
          kind: "finish",
          summary: "done"
        })
      }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: fetchSpy.fetchImpl
    });

    const result = await planner.decideNext(baseInput);
    expect(result).toEqual({
      kind: "finish",
      thought: undefined,
      summary: "done"
    });
  });

  it("fails with an aggregated message after exhausting correction attempts", async () => {
    const invalidDecision = JSON.stringify({
      kind: "act",
      step: {
        toolName: "inspect_document",
        readOnly: true,
        idempotencyKey: "react:1"
      }
    });
    const fetchSpy = createSequentialFetchSpy([
      { content: invalidDecision },
      { content: invalidDecision },
      { content: invalidDecision }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: fetchSpy.fetchImpl
    });

    await expect(planner.decideNext(baseInput)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_REACT_DECISION_INVALID" &&
        err.info.message.includes("after 2 correction attempt(s)") &&
        err.info.message.includes("id is required")
    );
    expect(fetchSpy.getBodies()).toHaveLength(3);
  });

  it("does not retry upstream envelope errors", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        content: "",
        status: 200
      }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const baseFetch = fetchSpy.fetchImpl;
        return await baseFetch(_input, {
          ...init,
          body: typeof init?.body === "string" ? init.body : "{}"
        });
      }) as typeof fetch
    });

    await expect(planner.decideNext(baseInput)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError && err.info.code === "E_REACT_PLANNER_MODEL_RESPONSE"
    );
    expect(fetchSpy.getBodies()).toHaveLength(1);
  });

  it("sends a stricter ReAct decision prompt", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        content: JSON.stringify({
          kind: "finish",
          summary: "done"
        })
      }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: fetchSpy.fetchImpl
    });

    await planner.decideNext(baseInput);

    const body = fetchSpy.getBodies()[0];
    const systemPrompt = String((body?.messages as Array<{ content?: string }>)[0]?.content ?? "");
    const userPrompt = String((body?.messages as Array<{ content?: string }>)[1]?.content ?? "");
    expect(systemPrompt).toContain("required step fields");
    expect(systemPrompt).toContain("Do not omit or null any required field");
    expect(userPrompt).toContain("requiredStepFields");
    expect(userPrompt).toContain("requiredOperationFields");
    expect(userPrompt).toContain("finishRules");
    expect(userPrompt).toContain("set_font_color");
    expect(userPrompt).toContain("set_highlight_color");
    expect(userPrompt).toContain("targetSelector");
    expect(userPrompt).toContain("body");
  });

  it("sends a flattened compatible json schema for react decisions", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        content: JSON.stringify({
          kind: "finish",
          summary: "done"
        })
      }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: fetchSpy.fetchImpl
    });

    await planner.decideNext(baseInput);

    const body = fetchSpy.getBodies()[0];
    const responseFormat = body?.response_format as Record<string, unknown>;
    expect(responseFormat?.type).toBe("json_schema");
    const jsonSchema = responseFormat?.json_schema as Record<string, unknown>;
    expect(jsonSchema?.name).toBe("react_decision");
    expect(jsonSchema?.strict).toBe(true);

    const schema = jsonSchema?.schema as Record<string, unknown>;
    expect(schema?.type).toBe("object");
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual(["kind"]);

    const properties = schema?.properties as Record<string, unknown>;
    const stepSchema = properties?.step as Record<string, unknown>;
    expect(stepSchema?.type).toBe("object");
    expect(stepSchema?.additionalProperties).toBe(false);
    expect(stepSchema?.required).toEqual(["id", "toolName", "readOnly", "idempotencyKey"]);
    expect(stepSchema?.allOf).toBeUndefined();

    const operationSchema = (stepSchema?.properties as Record<string, unknown>)?.operation as Record<string, unknown>;
    expect(operationSchema?.type).toBe("object");
    expect(operationSchema?.additionalProperties).toBe(false);
    expect(operationSchema?.required).toEqual(["id", "type", "payload"]);
  });

  it("tightens react prompt with executable-write semantics", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        content: JSON.stringify({
          kind: "finish",
          summary: "done"
        })
      }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: fetchSpy.fetchImpl
    });

    await planner.decideNext({
      ...baseInput,
      goal: "正文改成宋体",
      doc: anchoredDoc
    });

    const userPrompt = String((fetchSpy.getBodies()[0]?.messages as Array<{ content?: string }>)[1]?.content ?? "");
    expect(userPrompt).toContain("semantically executable");
    expect(userPrompt).toContain("never use placeholder ids like 'placeholder', 'unused', or 'target'");
    expect(userPrompt).toContain("never emit an empty payload");
    expect(userPrompt).toContain("repair the step into a valid executable write before downgrading to inspect_document");
  });

  it("retries act decisions when write_operation omits operation", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        content: JSON.stringify({
          kind: "act",
          step: {
            id: "react_step_1",
            toolName: "write_operation",
            readOnly: false,
            idempotencyKey: "react:1"
          }
        })
      },
      {
        content: JSON.stringify({
          kind: "act",
          step: {
            id: "react_step_1",
            toolName: "write_operation",
            readOnly: false,
            idempotencyKey: "react:1",
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
        })
      }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: fetchSpy.fetchImpl
    });

    const result = await planner.decideNext({
      ...baseInput,
      goal: "摘要及关键词段落改为绿色",
      doc: anchoredDoc
    });

    expect(result).toMatchObject({
      kind: "act",
      step: {
        operation: {
          targetSelector: {
            scope: "paragraph_ids",
            paragraphIds: ["p_1", "p_2"]
          }
        }
      }
    });
    const correctionPrompt = String((fetchSpy.getBodies()[1]?.messages as Array<{ content?: string }>)[1]?.content ?? "");
    expect(correctionPrompt).toContain("write_operation");
    expect(correctionPrompt).toContain("operation");
  });

  it("keeps write_operation operation requirements in local validation", async () => {
    const invalidDecision = JSON.stringify({
      kind: "act",
      step: {
        id: "react_step_1",
        toolName: "write_operation",
        readOnly: false,
        idempotencyKey: "react:1"
      }
    });
    const fetchSpy = createSequentialFetchSpy([
      { content: invalidDecision },
      { content: invalidDecision },
      { content: invalidDecision }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: fetchSpy.fetchImpl
    });

    await expect(planner.decideNext(baseInput)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_REACT_DECISION_INVALID" &&
        err.info.message.includes("write_operation requires operation")
    );
    expect(fetchSpy.getBodies()).toHaveLength(3);
  });

  it("omits response_format when react json schema is disabled", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        content: JSON.stringify({
          kind: "finish",
          summary: "done"
        })
      }
    ]);
    const planner = new LlmReActPlanner({
      config: {
        apiKey: "k",
        baseUrl: "http://localhost:8080/v1",
        model: "gemma-4",
        useJsonSchema: false
      },
      fetchImpl: fetchSpy.fetchImpl
    });

    await planner.decideNext(baseInput);

    const body = fetchSpy.getBodies()[0];
    expect(body?.response_format).toBeUndefined();
  });

  it("falls back once without response_format when upstream rejects react json_schema", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        content: JSON.stringify({
          error: {
            message: "response_format.json_schema is not supported by this model"
          }
        }),
        status: 400
      },
      {
        content: JSON.stringify({
          kind: "finish",
          summary: "done"
        })
      }
    ]);
    const planner = new LlmReActPlanner({
      config: {
        apiKey: "k",
        baseUrl: "https://mock/v1",
        model: "m",
        compatMode: "auto"
      },
      fetchImpl: fetchSpy.fetchImpl
    });

    await expect(planner.decideNext(baseInput)).resolves.toEqual({
      kind: "finish",
      thought: undefined,
      summary: "done"
    });

    const bodies = fetchSpy.getBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.response_format).toBeTruthy();
    expect(bodies[1]?.response_format).toBeUndefined();
  });

  it("fails with a dedicated schema compatibility error in strict mode", async () => {
    const planner = new LlmReActPlanner({
      config: {
        apiKey: "k",
        baseUrl: "https://mock/v1",
        model: "m",
        compatMode: "strict"
      },
      fetchImpl: createFetchMock(
        JSON.stringify({
          error: {
            message: "response_format.json_schema is not supported by this model"
          }
        }),
        400
      )
    });

    await expect(planner.decideNext(baseInput)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_REACT_PLANNER_SCHEMA_UNSUPPORTED" &&
        err.info.message.includes("response_format json_schema")
    );
  });

  it("surfaces fallback context when schema downgrade also fails", async () => {
    const planner = new LlmReActPlanner({
      config: {
        apiKey: "k",
        baseUrl: "https://mock/v1",
        model: "m",
        compatMode: "auto"
      },
      fetchImpl: createSequentialFetchSpy([
        {
          content: JSON.stringify({
            error: {
              message: "response_format.json_schema is not supported by this model"
            }
          }),
          status: 400
        },
        {
          content: JSON.stringify({
            error: {
              message: "upstream overloaded"
            }
          }),
          status: 502
        }
      ]).fetchImpl
    });

    await expect(planner.decideNext(baseInput)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_REACT_PLANNER_SCHEMA_FALLBACK_FAILED" &&
        err.info.message.includes("attempted fallback") &&
        err.info.message.includes("without response_format")
    );
  });

  it("rejects placeholder target node ids in react decisions", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        content: JSON.stringify({
          kind: "act",
          step: {
            id: "react_step_1",
            toolName: "write_operation",
            readOnly: false,
            idempotencyKey: "react:1",
            operation: {
              id: "op1",
              type: "set_font",
              targetNodeId: "placeholder",
              payload: { font_name: "SimSun" }
            }
          }
        })
      },
      {
        content: JSON.stringify({
          kind: "act",
          step: {
            id: "react_step_1",
            toolName: "write_operation",
            readOnly: false,
            idempotencyKey: "react:1",
            operation: {
              id: "op1",
              type: "set_font",
              targetNodeId: "placeholder",
              payload: { font_name: "SimSun" }
            }
          }
        })
      },
      {
        content: JSON.stringify({
          kind: "act",
          step: {
            id: "react_step_1",
            toolName: "write_operation",
            readOnly: false,
            idempotencyKey: "react:1",
            operation: {
              id: "op1",
              type: "set_font",
              targetNodeId: "placeholder",
              payload: { font_name: "SimSun" }
            }
          }
        })
      }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: fetchSpy.fetchImpl
    });

    await expect(planner.decideNext(baseInput)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_REACT_DECISION_INVALID" &&
        err.info.message.includes("placeholder")
    );
  });

  it("rejects empty write payloads in react decisions", async () => {
    const invalid = JSON.stringify({
      kind: "act",
      step: {
        id: "react_step_1",
        toolName: "write_operation",
        readOnly: false,
        idempotencyKey: "react:1",
        operation: {
          id: "op1",
          type: "set_font",
          targetSelector: { scope: "body" },
          payload: {}
        }
      }
    });
    const fetchSpy = createSequentialFetchSpy([
      { content: invalid },
      { content: invalid },
      { content: invalid }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: fetchSpy.fetchImpl
    });

    await expect(planner.decideNext(baseInput)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_REACT_DECISION_INVALID" &&
        err.info.message.includes("payload")
    );
  });

  it("includes emphasis index in react prompt context for semantic anchors", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        content: JSON.stringify({
          kind: "act",
          step: {
            id: "react_step_1",
            toolName: "write_operation",
            readOnly: false,
            idempotencyKey: "react:1",
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
        })
      }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: fetchSpy.fetchImpl
    });

    const result = await planner.decideNext({
      ...baseInput,
      goal: "摘要及关键词段落改为绿色",
      doc: anchoredDoc
    });

    expect(result).toMatchObject({
      kind: "act",
      step: {
        operation: {
          targetSelector: {
            scope: "paragraph_ids",
            paragraphIds: ["p_1", "p_2"]
          }
        }
      }
    });
    const prompt = String((fetchSpy.getBodies()[0]?.messages as Array<{ content?: string }>)[1]?.content ?? "");
    expect(prompt).toContain("emphasisIndex");
    expect(prompt).toContain("摘要");
    expect(prompt).toContain("关键词");
    expect(prompt).toContain("paragraph_ids");
  });

  it("accepts target selectors in react write steps", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        content: JSON.stringify({
          kind: "act",
          step: {
            id: "react_step_1",
            toolName: "write_operation",
            readOnly: false,
            idempotencyKey: "react:1",
            operation: {
              id: "op1",
              type: "set_font_color",
              targetSelector: {
                scope: "body"
              },
              payload: { font_color: "FF0000" }
            }
          }
        })
      }
    ]);
    const planner = new LlmReActPlanner({
      config: { apiKey: "k", baseUrl: "https://mock/v1", model: "m" },
      fetchImpl: fetchSpy.fetchImpl
    });

    const result = await planner.decideNext({
      ...baseInput,
      doc: {
        ...baseDoc,
        metadata: {
          structureIndex: {
            paragraphs: [{ id: "p_1", role: "body", runNodeIds: ["n1"] }],
            roleCounts: { body: 1 },
            paragraphMap: {}
          }
        }
      }
    });

    expect(result).toMatchObject({
      kind: "act",
      step: {
        operation: {
          targetSelector: {
            scope: "body"
          }
        }
      }
    });
  });
});
