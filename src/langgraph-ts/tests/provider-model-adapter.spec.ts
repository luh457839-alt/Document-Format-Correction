import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { writePhaseOneFixtureDocx } from "./test-fixtures.js";
import {
  PHASE3_STRONG_SYSTEM_PROMPT,
  buildProviderWriteDocumentTool,
  convertToProviderWireMessages,
  createProviderModelAdapter,
  type ProviderAdapterConfig,
  type ProviderTransport,
  type ProviderTransportRequest
} from "../model/provider-adapter.js";
import type { Phase3RuntimeInput } from "../runtime/contracts.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "langgraph-provider-adapter-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("provider model adapter", () => {
  it("binds a strict prompt and schema, and passes through standard write_document calls", async () => {
    const fixture = await createFixture();
    const transport = new RecordingTransport([
      new AIMessage({
        content: "执行写入。",
        tool_calls: [
          {
            id: "tool-1",
            name: "write_document",
            args: {
              request_id: "req-1",
              operation: "set_text",
              target: {
                kind: "selector",
                selector: {
                  scope: "body"
                }
              },
              payload: {
                value: "标准写入"
              }
            }
          }
        ]
      })
    ]);
    const adapter = createProviderModelAdapter(
      { provider: "openai-compatible", baseUrl: "https://example.com/v1", model: "test-model" },
      transport
    );

    const result = await adapter.invoke(buildMessages(), fixture.runtimeInput);

    expect(result).toBeInstanceOf(AIMessage);
    const aiResult = result as AIMessage;
    expect(aiResult.tool_calls).toHaveLength(1);
    expect(aiResult.tool_calls?.[0]?.args).toEqual({
      request_id: "req-1",
      operation: "set_text",
      target: {
        kind: "selector",
        selector: {
          scope: "body"
        }
      },
      payload: {
        value: "标准写入"
      }
    });

    expect(transport.requests).toHaveLength(1);
    expect(readSystemPrompt(transport.requests[0].messages)).toContain(PHASE3_STRONG_SYSTEM_PROMPT);
    expect(transport.requests[0].tools).toHaveLength(1);
    expect(transport.requests[0].tools[0]).toEqual(buildProviderWriteDocumentTool());
    expect(JSON.stringify(transport.requests[0].tools[0])).toContain("title_like_paragraphs");
    expect(JSON.stringify(transport.requests[0].tools[0])).toContain("body_like_paragraphs");
  });

  it("normalizes provider-specific write args before returning them to runtime", async () => {
    const fixture = await createFixture();
    const transport = new RecordingTransport([
      new AIMessage({
        content: "转换为标准写入。",
        tool_calls: [
          {
            id: "tool-2",
            name: "write_document",
            args: {
              request_id: "req-2",
              operation: "update",
              target: {
                type: "paragraph",
                index: 0
              },
              payload: {
                content: "归一化后的正文"
              }
            }
          }
        ]
      })
    ]);
    const adapter = createProviderModelAdapter(
      { provider: "openai-compatible", baseUrl: "https://example.com/v1", model: "test-model" },
      transport
    );

    const result = await adapter.invoke(buildMessages(), fixture.runtimeInput);

    expect(result).toBeInstanceOf(AIMessage);
    const aiResult = result as AIMessage;
    expect(aiResult.tool_calls).toHaveLength(1);
    expect(aiResult.tool_calls?.[0]?.args).toEqual({
      request_id: "req-2",
      operation: "set_text",
      target: {
        kind: "selector",
        selector: {
          scope: "paragraph_ids",
          paragraphIds: [fixture.firstBodyParagraphId]
        }
      },
      payload: {
        value: "归一化后的正文"
      }
    });
  });

  it("handles an internal read -> write loop without exposing read to runtime", async () => {
    const fixture = await createFixture();
    const transport = new RecordingTransport([
      new AIMessage({
        content: "先读取第一段正文。",
        tool_calls: [
          {
            id: "tool-read-1",
            name: "write_document",
            args: {
              request_id: "req-read-1",
              operation: "read",
              target: {
                type: "paragraph",
                index: 0
              },
              payload: {}
            }
          }
        ]
      }),
      new AIMessage({
        content: "现在执行写入。",
        tool_calls: [
          {
            id: "tool-write-1",
            name: "write_document",
            args: {
              request_id: "req-write-1",
              operation: "update",
              target: {
                type: "paragraph",
                index: 0
              },
              payload: {
                content: "读后写结果"
              }
            }
          }
        ]
      })
    ]);
    const adapter = createProviderModelAdapter(
      { provider: "deepseek", baseUrl: "https://example.com/v1", model: "deepseek-chat" },
      transport
    );

    const result = await adapter.invoke(buildMessages(), fixture.runtimeInput);

    expect(result).toBeInstanceOf(AIMessage);
    const aiResult = result as AIMessage;
    expect(aiResult.tool_calls).toHaveLength(1);
    expect(aiResult.tool_calls?.[0]?.args).toEqual({
      request_id: "req-write-1",
      operation: "set_text",
      target: {
        kind: "selector",
        selector: {
          scope: "paragraph_ids",
          paragraphIds: [fixture.firstBodyParagraphId]
        }
      },
      payload: {
        value: "读后写结果"
      }
    });

    expect(transport.requests).toHaveLength(2);
    const secondRequestMessages = transport.requests[1].messages;
    expect(secondRequestMessages.some((message) => message instanceof ToolMessage)).toBe(true);
    const toolMessage = secondRequestMessages.find((message) => message instanceof ToolMessage);
    expect(toolMessage).toBeInstanceOf(ToolMessage);
    const toolPayload = JSON.parse(String((toolMessage as ToolMessage).content));
    expect(toolPayload.first_body_paragraph).toEqual(
      expect.objectContaining({
        id: fixture.firstBodyParagraphId
      })
    );
    expect(toolPayload.paragraphs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.firstBodyParagraphId
        })
      ])
    );
    expect(toolPayload.document_summary).toEqual(
      expect.objectContaining({
        sectionCount: expect.any(Number),
        settingsPartPresent: expect.any(Boolean)
      })
    );
    expect(toolPayload.chat_projection).toEqual(
      expect.objectContaining({
        diagnostics: expect.objectContaining({
          focusRegexProbe: "第一段正文"
        })
      })
    );
    expect(toolPayload.template_projection).toEqual(
      expect.objectContaining({
        batches: expect.any(Array),
        diagnostics: expect.objectContaining({
          budgetStatus: expect.any(String)
        })
      })
    );
  });

  it("replays reasoning_content during provider internal turns when configured", async () => {
    const fixture = await createFixture();
    const transport = new RecordingTransport([
      new AIMessage({
        content: "先读取再写入。",
        additional_kwargs: {
          reasoning_content: "需要先确认第一段正文。"
        },
        tool_calls: [
          {
            id: "tool-read-2",
            name: "write_document",
            args: {
              request_id: "req-read-2",
              operation: "read",
              target: {
                type: "paragraph",
                index: 0
              },
              payload: {}
            }
          }
        ]
      }),
      new AIMessage({
        content: "写入完成。",
        tool_calls: [
          {
            id: "tool-write-2",
            name: "write_document",
            args: {
              request_id: "req-write-2",
              operation: "update",
              target: {
                type: "paragraph",
                index: 0
              },
              payload: {
                content: "带 reasoning 回放"
              }
            }
          }
        ]
      })
    ]);
    const config: ProviderAdapterConfig = {
      provider: "deepseek",
      baseUrl: "https://example.com/v1",
      model: "deepseek-reasoner",
      supportsReasoningContextReplay: true
    };
    const adapter = createProviderModelAdapter(config, transport);

    await adapter.invoke(buildMessages(), fixture.runtimeInput);

    expect(transport.requests).toHaveLength(2);
    const secondRequestAssistantMessage = transport.requests[1].messages.find((message) => message instanceof AIMessage);
    expect(secondRequestAssistantMessage).toBeInstanceOf(AIMessage);
    expect((secondRequestAssistantMessage as AIMessage).additional_kwargs?.reasoning_content).toBe("需要先确认第一段正文。");
  });

  it("serializes reasoning_content back into provider wire messages for DeepSeek-style replay", () => {
    const wireMessages = convertToProviderWireMessages(
      [
        new SystemMessage(PHASE3_STRONG_SYSTEM_PROMPT),
        new HumanMessage("请先读取第一段再修改"),
        new AIMessage({
          content: "先读取。",
          additional_kwargs: {
            reasoning_content: "我需要先确认正文位置。"
          },
          tool_calls: [
            {
              id: "call-1",
              name: "write_document",
              args: {
                request_id: "req-read",
                operation: "read",
                target: {
                  type: "paragraph",
                  index: 0
                },
                payload: {}
              }
            }
          ]
        }),
        new ToolMessage({
          tool_call_id: "call-1",
          status: "success",
          content: "{\"ok\":true}"
        })
      ],
      "deepseek-reasoner"
    );

    expect(wireMessages[2]).toEqual(
      expect.objectContaining({
        role: "assistant",
        reasoning_content: "我需要先确认正文位置。",
        tool_calls: [
          expect.objectContaining({
            id: "call-1",
            type: "function"
          })
        ]
      })
    );
  });

  it("serializes tool messages for provider wire replay after internal read", () => {
    const wireMessages = convertToProviderWireMessages(
      [
        new SystemMessage(PHASE3_STRONG_SYSTEM_PROMPT),
        new HumanMessage("请先读取第一段再修改"),
        new AIMessage({
          content: "先读取。",
          additional_kwargs: {
            reasoning_content: "我需要先确认正文位置。"
          },
          tool_calls: [
            {
              id: "call-1",
              name: "write_document",
              args: {
                request_id: "req-read",
                operation: "read",
                target: {
                  type: "paragraph",
                  index: 0
                },
                payload: {}
              }
            }
          ]
        }),
        new ToolMessage({
          tool_call_id: "call-1",
          status: "success",
          content: "{\"ok\":true,\"first_body_paragraph\":{\"id\":\"p-1\"}}"
        })
      ],
      "deepseek-reasoner"
    );

    expect(wireMessages[3]).toEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: "{\"ok\":true,\"first_body_paragraph\":{\"id\":\"p-1\"}}"
    });
  });

  it("returns a structured failure when provider read loop is exhausted", async () => {
    const fixture = await createFixture();
    const transport = new RecordingTransport([
      buildReadResponse("req-read-a"),
      buildReadResponse("req-read-b"),
      buildReadResponse("req-read-c")
    ]);
    const adapter = createProviderModelAdapter(
      {
        provider: "deepseek",
        baseUrl: "https://example.com/v1",
        model: "deepseek-chat",
        maxInternalTurns: 3
      },
      transport
    );

    const result = await adapter.invoke(buildMessages(), fixture.runtimeInput);

    expect(result).toBeInstanceOf(AIMessage);
    const aiResult = result as AIMessage;
    expect(aiResult.tool_calls ?? []).toHaveLength(0);
    expect(aiResult.content).toContain("provider_read_loop_exhausted");
    expect(aiResult.additional_kwargs?.phase3_diagnostics).toEqual([
      expect.objectContaining({
        stage: "provider_adapter",
        provider: "deepseek",
        provider_diagnostic_kind: "provider_read_loop_exhausted"
      })
    ]);
  });
});

function buildReadResponse(requestId: string): AIMessage {
  return new AIMessage({
    content: "继续读取。",
    tool_calls: [
      {
        id: `${requestId}-tool`,
        name: "write_document",
        args: {
          request_id: requestId,
          operation: "read",
          target: {
            type: "paragraph",
            index: 0
          },
          payload: {}
        }
      }
    ]
  });
}

class RecordingTransport implements ProviderTransport {
  readonly requests: ProviderTransportRequest[] = [];

  constructor(private readonly responses: AIMessage[]) {}

  async invoke(request: ProviderTransportRequest): Promise<AIMessage> {
    this.requests.push({
      ...request,
      messages: [...request.messages],
      tools: structuredClone(request.tools)
    });
    const next = this.responses[this.requests.length - 1];
    if (!next) {
      throw new Error("Unexpected transport invocation.");
    }
    return next;
  }
}

function buildMessages(): BaseMessage[] {
  return [new SystemMessage("你是文档格式修复助手。"), new HumanMessage("请修改正文。")];
}

function readSystemPrompt(messages: BaseMessage[]): string {
  const systemMessage = messages.find((message) => message instanceof SystemMessage);
  return systemMessage instanceof SystemMessage ? String(systemMessage.content) : "";
}

async function createFixture(): Promise<{
  runtimeInput: Phase3RuntimeInput;
  firstBodyParagraphId: string;
}> {
  const dir = await makeTempDir();
  const docxPath = path.join(dir, "sample.docx");
  await writePhaseOneFixtureDocx(docxPath);
  const runtimeInput: Phase3RuntimeInput = {
    thread_id: "provider-adapter-test",
    document_path: docxPath,
    user_message: "把第一段正文改掉",
    projection_intent: {
      focus_regex_probe: "第一段正文",
      chat_text_budget: 320,
      template_text_budget: 420,
      template_batch_budget: 220
    }
  };
  const { parseDocumentBundle } = await import("../document-core/parse-document-bundle.js");
  const bundle = await parseDocumentBundle({ docxPath, mediaDir: path.join(dir, "media") });
  const firstBodyParagraph =
    bundle.structure_index.paragraphs.find((paragraph) => paragraph.role === "body") ??
    bundle.structure_index.paragraphs[0];
  if (!firstBodyParagraph) {
    throw new Error("Expected first body paragraph.");
  }
  return {
    runtimeInput,
    firstBodyParagraphId: firstBodyParagraph.id
  };
}
