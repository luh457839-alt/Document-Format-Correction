import { describe, expect, it } from "vitest";
import { AgentError } from "../src/core/errors.js";
import { LlmAgentModelGateway } from "../src/runtime/model-gateway.js";
import type { AgentSessionSnapshot } from "../src/runtime/state/sqlite-agent-state-store.js";

const baseConfig = {
  apiKey: "test-key",
  baseUrl: "http://example.test/v1",
  model: "test-model"
};

const baseTurnDecision = {
  mode: "chat",
  goal: "回复用户",
  requiresDocument: false,
  needsClarification: false,
  clarificationKind: "none",
  clarificationReason: ""
} as const;

const emptySession: AgentSessionSnapshot = {
  sessionId: "session-1",
  turns: []
};

function buildGatewayFromRawEnvelope(rawEnvelope: string) {
  return new LlmAgentModelGateway({
    chatConfig: baseConfig,
    plannerConfig: baseConfig,
    fetchImpl: async () =>
      new Response(rawEnvelope, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
  });
}

function buildGatewayFromContent(content: unknown, choice: Record<string, unknown> = {}) {
  return buildGatewayFromRawEnvelope(
    JSON.stringify({
      choices: [{ ...choice, message: { content } }]
    })
  );
}

function createSequentialFetchSpy(
  responses: Array<{ payload: string; status?: number }>
): {
  fetchImpl: typeof fetch;
  getBodies: () => Record<string, unknown>[];
} {
  const requestBodies: Record<string, unknown>[] = [];
  let index = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(response.payload, {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  return {
    fetchImpl,
    getBodies: () => requestBodies
  };
}

async function expectAgentError(
  run: () => Promise<unknown>,
  expectedCode: string,
  expectedMessagePart?: string
) {
  await expect(run).rejects.toMatchObject({
    info: expect.objectContaining({
      code: expectedCode,
      ...(expectedMessagePart ? { message: expect.stringContaining(expectedMessagePart) } : {})
    })
  });
}

describe("LlmAgentModelGateway.decideTurn", () => {
  it("returns a normalized turn decision for valid JSON content", async () => {
    const gateway = buildGatewayFromContent(
      JSON.stringify({
        mode: "inspect",
        goal: "  总结当前文档结构  ",
        requiresDocument: true,
        needsClarification: false,
        clarificationKind: "none",
        clarificationReason: ""
      })
    );

    await expect(
      gateway.decideTurn({
        session: emptySession,
        userInput: "总结文档"
      })
    ).resolves.toEqual({
      mode: "inspect",
      goal: "总结当前文档结构",
      requiresDocument: true,
      needsClarification: false,
      clarificationKind: "none",
      clarificationReason: ""
    });
  });

  it("accepts execute decisions for body edits without forcing a clarification", async () => {
    const gateway = buildGatewayFromContent(
      JSON.stringify({
        mode: "execute",
        goal: "把正文改成红色",
        requiresDocument: true,
        needsClarification: false,
        clarificationKind: "none",
        clarificationReason: ""
      })
    );

    await expect(
      gateway.decideTurn({
        session: emptySession,
        userInput: "把正文改成红色"
      })
    ).resolves.toEqual({
      mode: "execute",
      goal: "把正文改成红色",
      requiresDocument: true,
      needsClarification: false,
      clarificationKind: "none",
      clarificationReason: ""
    });
  });

  it("rejects when goal is missing", async () => {
    const gateway = buildGatewayFromContent(
      JSON.stringify({
        ...baseTurnDecision,
        goal: undefined
      })
    );

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "你好"
        }),
      "E_TURN_DECISION_INVALID",
      "goal is required"
    );
  });

  it("rejects unexpected extra fields", async () => {
    const gateway = buildGatewayFromContent(
      JSON.stringify({
        ...baseTurnDecision,
        confidence: 0.9
      })
    );

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "你好"
        }),
      "E_TURN_DECISION_INVALID",
      "unexpected fields"
    );
  });

  it.each([null, "", "   "])("rejects when goal is %j", async (goalValue) => {
    const gateway = buildGatewayFromContent(
      JSON.stringify({
        ...baseTurnDecision,
        mode: "execute",
        goal: goalValue,
        requiresDocument: true
      })
    );

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "执行文档修正"
        }),
      "E_TURN_DECISION_INVALID",
      "goal is required"
    );
  });

  it("rejects when requiresDocument is not boolean", async () => {
    const gateway = buildGatewayFromContent(
      JSON.stringify({
        ...baseTurnDecision,
        mode: "inspect",
        goal: "总结文档",
        requiresDocument: "yes"
      })
    );

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "总结文档"
        }),
      "E_TURN_DECISION_INVALID",
      "requiresDocument must be boolean"
    );
  });

  it("rejects when mode is not supported", async () => {
    const gateway = buildGatewayFromContent(
      JSON.stringify({
        ...baseTurnDecision,
        mode: "plan"
      })
    );

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "总结文档"
        }),
      "E_TURN_DECISION_INVALID",
      "mode must be"
    );
  });

  it("rejects missing clarification fields", async () => {
    const gateway = buildGatewayFromContent(
      JSON.stringify({
        mode: "chat",
        goal: "澄清正文范围",
        requiresDocument: true,
        needsClarification: true,
        clarificationKind: "selector_scope"
      })
    );

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "把正文改成红色"
        }),
      "E_TURN_DECISION_INVALID",
      "clarificationReason"
    );
  });

  it("rejects when content is not valid JSON", async () => {
    const gateway = buildGatewayFromContent("{not-json");

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "你好"
        }),
      "E_TURN_DECISION_PARSE",
      "invalid JSON"
    );
  });

  it("rejects when envelope has no choices", async () => {
    const gateway = buildGatewayFromRawEnvelope(JSON.stringify({}));

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "你好"
        }),
      "E_AGENT_MODEL_RESPONSE",
      "choices"
    );
  });

  it("rejects when envelope content is empty", async () => {
    const gateway = buildGatewayFromContent("   ", { finish_reason: "stop" });

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "你好"
        }),
      "E_AGENT_MODEL_RESPONSE",
      "empty message content string"
    );
  });

  it("parses array-based message content for turn decisions", async () => {
    const gateway = buildGatewayFromContent([
      { type: "text", text: "{\"mode\":\"inspect\",\"goal\":\"总结当前文档结构\"," },
      {
        type: "text",
        text: "\"requiresDocument\":true,\"needsClarification\":false,\"clarificationKind\":\"none\",\"clarificationReason\":\"\"}"
      }
    ]);

    await expect(
      gateway.decideTurn({
        session: emptySession,
        userInput: "总结文档"
      })
    ).resolves.toEqual({
      mode: "inspect",
      goal: "总结当前文档结构",
      requiresDocument: true,
      needsClarification: false,
      clarificationKind: "none",
      clarificationReason: ""
    });
  });

  it("recovers turn-decision content from choice.text when message.content is missing", async () => {
    const gateway = buildGatewayFromRawEnvelope(
      JSON.stringify({
        choices: [
          {
            text: JSON.stringify({
              mode: "inspect",
              goal: "总结当前文档结构",
              requiresDocument: true,
              needsClarification: false,
              clarificationKind: "none",
              clarificationReason: ""
            }),
            message: {}
          }
        ]
      })
    );

    await expect(
      gateway.decideTurn({
        session: emptySession,
        userInput: "总结文档"
      })
    ).resolves.toEqual({
      mode: "inspect",
      goal: "总结当前文档结构",
      requiresDocument: true,
      needsClarification: false,
      clarificationKind: "none",
      clarificationReason: ""
    });
  });

  it("surfaces refusal diagnostics when envelope contains refusal", async () => {
    const gateway = buildGatewayFromRawEnvelope(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: null,
              refusal: "safety refusal"
            }
          }
        ]
      })
    );

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "你好"
        }),
      "E_AGENT_MODEL_RESPONSE",
      "safety refusal"
    );
  });

  it("surfaces incomplete choice diagnostics when message is missing", async () => {
    const gateway = buildGatewayFromRawEnvelope(
      JSON.stringify({
        choices: [{ finish_reason: "length" }]
      })
    );

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "你好"
        }),
      "E_AGENT_MODEL_RESPONSE",
      "incomplete choices[0]"
    );
  });

  it("normalizes forceMode output through the same decision guard", async () => {
    const gateway = new LlmAgentModelGateway({
      chatConfig: baseConfig,
      plannerConfig: baseConfig,
      fetchImpl: async () => {
        throw new AgentError({
          code: "E_FETCH_UNEXPECTED",
          message: "forceMode should not reach fetch",
          retryable: false
        });
      }
    });

    await expect(
      gateway.decideTurn({
        session: emptySession,
        userInput: "  执行当前文档格式修正  ",
        forceMode: "execute"
      })
    ).resolves.toEqual({
      mode: "execute",
      goal: "执行当前文档格式修正",
      requiresDocument: true,
      needsClarification: false,
      clarificationKind: "none",
      clarificationReason: ""
    });
  });

  it("normalizes mildly dirty turn decisions into the current decision contract", async () => {
    const gateway = buildGatewayFromContent(
      JSON.stringify({
        mode: "execute",
        goal: "  执行正文配色修正  ",
        requires_document: "true",
        needs_clarification: "false",
        clarification_kind: "",
        clarification_reason: ""
      })
    );

    await expect(
      gateway.decideTurn({
        session: emptySession,
        userInput: "把正文改成绿色"
      })
    ).resolves.toEqual({
      mode: "execute",
      goal: "执行正文配色修正",
      requiresDocument: true,
      needsClarification: false,
      clarificationKind: "none",
      clarificationReason: ""
    });
  });

  it("sends a strict turn-decision prompt to the model", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const gateway = new LlmAgentModelGateway({
      chatConfig: baseConfig,
      plannerConfig: baseConfig,
      fetchImpl: async (_url, init) => {
        requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ...baseTurnDecision
                  })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    await gateway.decideTurn({
      session: emptySession,
      userInput: "你好"
    });

    const messages = requestBodies[0]?.messages as Array<{ role?: string; content?: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("你负责为文档格式助手判定单轮请求");
    expect(messages[0]?.content).toContain("You route one user turn for a document-format assistant");
    expect(messages[0]?.content).toContain(
      "exactly these fields: mode, goal, requiresDocument, needsClarification, clarificationKind, clarificationReason"
    );
    expect(messages[0]?.content).toContain("Do not add extra fields");
    expect(messages[0]?.content).toContain("When needsClarification=true, mode must be chat");
    expect(messages[0]?.content).toContain("【需求澄清】");
    expect(messages[0]?.content).toContain("current user reply selects or clarifies that question");
    expect(messages[0]?.content).toContain("do not fall back to chat because of missing internal fields");
    expect(messages[0]?.content).toContain("output execute or needsClarification=true");
    expect(messages[0]?.content).not.toContain("正文是否包含项目符号/编号段落");
    expect(messages[0]?.content).not.toContain("正文 vs numbered/bulleted list paragraphs");
    expect(messages[0]?.content).toContain("标题范围不清、段落锚点不明确");
    expect(messages[0]?.content).toContain("ambiguous heading ranges, or unclear paragraph anchors");
  });

  it("uses bilingual turn-decision prompts to avoid empty upstream content on english-sensitive gateways", async () => {
    const gateway = new LlmAgentModelGateway({
      chatConfig: baseConfig,
      plannerConfig: baseConfig,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ content?: string }>;
        };
        const systemPrompt = String(body.messages?.[0]?.content ?? "");
        const hasChinese = /[\u4e00-\u9fff]/.test(systemPrompt);
        return new Response(
          JSON.stringify(
            hasChinese
              ? {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          ...baseTurnDecision
                        })
                      }
                    }
                  ]
                }
              : {
                  choices: [
                    {
                      finish_reason: "stop",
                      message: {
                        content: "   "
                      }
                    }
                  ]
                }
          ),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    await expect(
      gateway.decideTurn({
        session: emptySession,
        userInput: "你好"
      })
    ).resolves.toEqual({
      ...baseTurnDecision
    });
  });

  it("sends a complete required list for the turn-decision json schema", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const gateway = new LlmAgentModelGateway({
      chatConfig: baseConfig,
      plannerConfig: baseConfig,
      fetchImpl: async (_url, init) => {
        requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ...baseTurnDecision
                  })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    await gateway.decideTurn({
      session: emptySession,
      userInput: "你好"
    });

    expect(
      (
        requestBodies[0]?.response_format as {
          json_schema?: { schema?: { required?: string[] } };
        }
      )?.json_schema?.schema?.required
    ).toEqual([
      "mode",
      "goal",
      "requiresDocument",
      "needsClarification",
      "clarificationKind",
      "clarificationReason"
    ]);
  });

  it("omits response_format when json schema is disabled", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const gateway = new LlmAgentModelGateway({
      chatConfig: baseConfig,
      plannerConfig: {
        ...baseConfig,
        useJsonSchema: false
      },
      fetchImpl: async (_url, init) => {
        requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ...baseTurnDecision
                  })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    await gateway.decideTurn({
      session: emptySession,
      userInput: "你好"
    });

    expect(requestBodies[0]?.response_format).toBeUndefined();
  });

  it("defaults deepseek planner requests to plain json in compat auto mode", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const gateway = new LlmAgentModelGateway({
      chatConfig: baseConfig,
      plannerConfig: {
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-v4-flash"
      },
      fetchImpl: async (_url, init) => {
        requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ...baseTurnDecision
                  })
                }
              }
            ]
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
    });

    await gateway.decideTurn({
      session: emptySession,
      userInput: "你好"
    });

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]?.response_format).toBeUndefined();
  });

  it("falls back once without response_format when upstream rejects turn-decision json_schema", async () => {
    const fetchSpy = createSequentialFetchSpy([
      {
        payload: JSON.stringify({
          error: {
            message: "response_format.json_schema is not supported by this model"
          }
        }),
        status: 400
      },
      {
        payload: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...baseTurnDecision
                })
              }
            }
          ]
        })
      }
    ]);
    const gateway = new LlmAgentModelGateway({
      chatConfig: baseConfig,
      plannerConfig: {
        ...baseConfig,
        useJsonSchema: true,
        compatMode: "auto"
      },
      fetchImpl: fetchSpy.fetchImpl
    });

    await expect(
      gateway.decideTurn({
        session: emptySession,
        userInput: "你好"
      })
    ).resolves.toEqual({
      ...baseTurnDecision
    });

    const requestBodies = fetchSpy.getBodies();
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.response_format).toMatchObject({ type: "json_schema" });
    expect(requestBodies[1]?.response_format).toBeUndefined();
  });

  it("fails with a dedicated schema compatibility error in strict mode", async () => {
    const gateway = new LlmAgentModelGateway({
      chatConfig: baseConfig,
      plannerConfig: {
        ...baseConfig,
        useJsonSchema: true,
        compatMode: "strict"
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "response_format.json_schema is not supported by this model"
            }
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" }
          }
        )
    });

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "你好"
        }),
      "E_AGENT_MODEL_SCHEMA_UNSUPPORTED",
      "response_format json_schema"
    );
  });

  it("surfaces fallback failure context when plain-json retry also fails", async () => {
    const gateway = new LlmAgentModelGateway({
      chatConfig: baseConfig,
      plannerConfig: {
        ...baseConfig,
        useJsonSchema: true,
        compatMode: "auto"
      },
      fetchImpl: createSequentialFetchSpy([
        {
          payload: JSON.stringify({
            error: {
              message: "response_format.json_schema is not supported by this model"
            }
          }),
          status: 400
        },
        {
          payload: JSON.stringify({
            error: {
              message: "upstream overloaded"
            }
          }),
          status: 502
        }
      ]).fetchImpl
    });

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "你好"
        }),
      "E_AGENT_MODEL_SCHEMA_FALLBACK_FAILED",
      "without response_format"
    );
  });

  it("turns aborted requests into an actionable timeout hint", async () => {
    const gateway = new LlmAgentModelGateway({
      chatConfig: {
        ...baseConfig,
        baseUrl: "http://localhost:8080/v1",
        model: "gemma-4"
      },
      plannerConfig: {
        ...baseConfig,
        baseUrl: "http://localhost:8080/v1",
        model: "gemma-4"
      },
      fetchImpl: async () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        throw error;
      }
    });

    await expectAgentError(
      async () =>
        await gateway.decideTurn({
          session: emptySession,
          userInput: "你好"
        }),
      "E_AGENT_MODEL_REQUEST",
      "compatibility mode"
    );
  });
});
