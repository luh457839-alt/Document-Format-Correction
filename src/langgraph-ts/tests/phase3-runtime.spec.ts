import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import type { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { writePhaseOneFixtureDocx } from "./test-fixtures.js";
import { createRealDocxFixture, getRealDocxSample } from "./real-docx-fixtures.js";
import { parseDocumentBundle } from "../document-core/parse-document-bundle.js";
import type { ParsedDocumentBundle } from "../contracts/document-contracts.js";
import type { WriteToolInput } from "../tooling/contracts.js";
import { runPhase3Graph } from "../runtime/graph.js";
import type {
  Phase3Checkpointer,
  Phase3ModelAdapter,
  Phase3ProjectionIntent,
  Phase3RuntimeInput,
  Phase3TemplateTaskPayload
} from "../runtime/contracts.js";
import { createSemanticProjectionBundle } from "./semantic-fixtures.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "langgraph-phase3-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("phase 3 runtime graph", () => {
  it("routes template payloads into template mode and applies the same write tool path", async () => {
    const fixture = await createFixture();
    const model = new StaticModelAdapter([]);
    const templateTask: Phase3TemplateTaskPayload = {
      template_id: "gov-notice",
      instructions: "将正文第一段替换为模板文本",
      tool_input: {
        request_id: "tpl-write-1",
        operation: "set_text",
        target: {
          kind: "patch_targets",
          patch_target_ids: [fixture.firstInlineTargetId],
          patch_part_paths: [fixture.firstInlinePartPath]
        },
        payload: { value: "模板链路写入结果" }
      },
      semantic_tags: ["government_notice", "body_replace"]
    };

    const result = await runPhase3Graph({
      thread_id: "template-thread",
      document_path: fixture.docxPath,
      user_message: "应用固定模板",
      template_task: templateTask
    }, {
      model,
      checkpoint: new InMemoryCheckpointer()
    });

    expect(result.state.mode).toBe("template");
    expect(result.state.semantic_tags.length).toBeGreaterThan(0);
    expect(result.state.semantic_tags).not.toEqual(["government_notice", "body_replace"]);
    expect(result.state.diagnostics.some((entry) => entry.stage === "template_classifier")).toBe(true);
    expect(result.state.executed_patch_keys).toHaveLength(1);
    expect(result.state.document_bundle.document_ast.inlineNodes.find((node) => node.id === fixture.firstRunId)?.text).toBe("模板链路写入结果");
    expect(result.artifacts.output_docx_path).toBeTruthy();
    expect(result.reply).toContain("模板");
  });

  it("routes write requests into chat mode, updates bundle truth, and materializes a docx", async () => {
    const fixture = await createFixture();
    const model = new StaticModelAdapter([
      {
        type: "ai",
        text: "调用写工具修改正文。",
        toolCalls: [
          {
            id: "tool-call-1",
            name: "write_document",
            args: {
              request_id: "chat-write-1",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [fixture.firstInlineTargetId],
                patch_part_paths: [fixture.firstInlinePartPath]
              },
              payload: { value: "聊天链路写入结果" }
            } satisfies WriteToolInput
          }
        ]
      },
      {
        type: "ai",
        text: "已完成文档修改。"
      }
    ]);

    const result = await runPhase3Graph({
      thread_id: "chat-thread",
      document_path: fixture.docxPath,
      user_message: "把第一段正文改成聊天链路写入结果"
    }, {
      model,
      checkpoint: new InMemoryCheckpointer()
    });

    expect(result.state.mode).toBe("chat");
    expect(result.state.executed_patch_keys).toHaveLength(1);
    expect(result.state.diagnostics.some((entry) => entry.stage === "write_tool")).toBe(true);
    expect(result.state.document_bundle.document_ast.inlineNodes.find((node) => node.id === fixture.firstRunId)?.text).toBe("聊天链路写入结果");
    expect(result.artifacts.output_docx_path).toBeTruthy();
    const outputBuffer = await readFile(result.artifacts.output_docx_path);
    expect(outputBuffer.byteLength).toBeGreaterThan(0);
    expect(result.reply).toContain("已完成");
  });

  it("materializes non-text style writes through reconcile in chat mode", async () => {
    const fixture = await createFixture();
    const model = new StaticModelAdapter([
      {
        type: "ai",
        text: "调用写工具修改字体。",
        toolCalls: [
          {
            id: "tool-call-style",
            name: "write_document",
            args: {
              request_id: "chat-style-1",
              operation: "set_font",
              target: {
                kind: "patch_targets",
                patch_target_ids: [fixture.firstInlineTargetId],
                patch_part_paths: [fixture.firstInlinePartPath]
              },
              payload: { font_name: "Arial" }
            } satisfies WriteToolInput
          }
        ]
      },
      {
        type: "ai",
        text: "字体已更新。"
      }
    ]);

    const result = await runPhase3Graph({
      thread_id: "chat-style-thread",
      document_path: fixture.docxPath,
      user_message: "把第一段的字体改成 Arial"
    }, {
      model,
      checkpoint: new InMemoryCheckpointer()
    });

    expect(result.artifacts.output_docx_path).toBeTruthy();
    expect(result.state.diagnostics.some((entry) => entry.stage === "reconcile")).toBe(true);

    const reparsed = await parseDocumentBundle({
      docxPath: result.artifacts.output_docx_path ?? "",
      mediaDir: path.join(fixture.dir, "reparsed-media")
    });
    expect(reparsed.document_ast.inlineNodes.find((node) => node.id === fixture.firstRunId)?.style?.fontName).toBe("Arial");
  });

  it("materializes template writes that require a new settings relationship", async () => {
    const fixture = await createFixture();
    const model = new StaticModelAdapter([]);
    const templateTask: Phase3TemplateTaskPayload = {
      template_id: "gov-notice-settings",
      instructions: "为文档补齐 settings.xml",
      tool_input: {
        request_id: "tpl-settings-1",
        operation: "set_settings_flag",
        target: {
          kind: "patch_targets",
          patch_target_ids: ["target:settings:settings"],
          patch_part_paths: ["word/settings.xml"]
        },
        payload: { settings: { zoom: "bestFit" } }
      }
    };

    const result = await runPhase3Graph({
      thread_id: "template-settings-thread",
      document_path: fixture.docxPath,
      user_message: "应用模板设置",
      template_task: templateTask
    }, {
      model,
      checkpoint: new InMemoryCheckpointer()
    });

    expect(result.artifacts.output_docx_path).toBeTruthy();
    expect(result.state.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: "reconcile", added_relationship_count: 1 })])
    );

    const outputBuffer = await readFile(result.artifacts.output_docx_path ?? "");
    const zip = await JSZip.loadAsync(outputBuffer);
    const settingsXml = await zip.file("word/settings.xml")?.async("string");
    const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string");
    expect(settingsXml).toContain("w:zoom");
    expect(relsXml).toContain("relationships/settings");
  });

  it("routes explanation-only requests into clarify mode without materialize", async () => {
    const fixture = await createFixture();
    const model = new StaticModelAdapter([
      {
        type: "ai",
        text: "这是文档结构说明，不执行修改。"
      }
    ]);

    const result = await runPhase3Graph({
      thread_id: "clarify-thread",
      document_path: fixture.docxPath,
      user_message: "解释一下这个文档的结构，不要修改"
    }, {
      model,
      checkpoint: new InMemoryCheckpointer()
    });

    expect(result.state.mode).toBe("clarify");
    expect(result.state.executed_patch_keys).toEqual([]);
    expect(result.artifacts.output_docx_path).toBeUndefined();
    expect(result.reply).toContain("说明");
  });

  it("returns structured semantic tool failures without polluting bundle truth", async () => {
    const fixture = await createFixture();
    const originalText = fixture.bundle.document_ast.inlineNodes.find((node) => node.id === fixture.firstRunId)?.text;
    const originalDocumentXml = fixture.bundle.package_snapshot.parts["word/document.xml"]?.text;
    const model = new StaticModelAdapter([
      {
        type: "ai",
        text: "尝试调用一个低置信语义选择器。",
        toolCalls: [
          {
            id: "tool-call-semantic",
            name: "write_document",
            args: {
              request_id: "chat-write-semantic",
              operation: "set_font",
              target: {
                kind: "semantic_selector",
                semantic: "title_like_paragraphs"
              },
              payload: {
                baseline_from_semantic: "body_like_paragraphs",
                sync_fields: ["font_name"]
              }
            } satisfies WriteToolInput
          }
        ]
      },
      {
        type: "ai",
        text: "工具失败，等待进一步指示。"
      }
    ]);

    const result = await runPhase3Graph({
      thread_id: "chat-semantic-failure",
      document_path: fixture.docxPath,
      user_message: "把摘要段落字体改成 Arial"
    }, {
      model,
      checkpoint: new InMemoryCheckpointer()
    });

    expect(result.state.executed_patch_keys).toEqual([]);
    expect(result.state.document_bundle.document_ast.inlineNodes.find((node) => node.id === fixture.firstRunId)?.text).toBe(originalText);
    expect(result.state.document_bundle.package_snapshot.parts["word/document.xml"]?.text).toBe(originalDocumentXml);
    expect(
      result.state.diagnostics.some(
        (entry) =>
          entry.error_code === "E_SEMANTIC_TARGET_LOW_CONFIDENCE" ||
          entry.error_code === "E_SEMANTIC_TARGET_AMBIGUOUS" ||
          entry.error_code === "E_BODY_BASELINE_UNDERDETERMINED"
      )
    ).toBe(true);
    expect(result.artifacts.output_docx_path).toBeUndefined();
  });

  it("records semantic alignment audit diagnostics on successful title-to-body font sync", async () => {
    const fixture = await createFixture();
    const checkpoint = new InMemoryCheckpointer();
    await checkpoint.save("chat-semantic-success", {
      messages: [],
      mode: "chat",
      document_path: fixture.docxPath,
      output_path: fixture.docxPath.replace(/\.docx$/i, ".semantic-success.docx"),
      document_bundle: createSemanticProjectionBundle(),
      chat_projection: undefined,
      template_projection: undefined,
      template_config: undefined,
      semantic_tags: [],
      executed_patch_keys: [],
      diagnostics: [],
      artifact_refs: []
    });
    const model = new StaticModelAdapter([
      {
        type: "ai",
        text: "调用语义写工具把标题字体同步到正文。",
        toolCalls: [
          {
            id: "tool-call-semantic-success",
            name: "write_document",
            args: {
              request_id: "chat-write-semantic-success",
              operation: "set_font",
              target: {
                kind: "semantic_selector",
                semantic: "title_like_paragraphs"
              },
              payload: {
                baseline_from_semantic: "body_like_paragraphs",
                sync_fields: ["font_name", "font_size_pt", "is_bold", "is_italic"]
              }
            } satisfies WriteToolInput
          }
        ]
      },
      {
        type: "ai",
        text: "语义字体同步已完成。"
      }
    ]);

    const result = await runPhase3Graph({
      thread_id: "chat-semantic-success",
      document_path: fixture.docxPath,
      user_message: "把标题字体同步为正文"
    }, {
      model,
      checkpoint
    });

    expect(result.artifacts.output_docx_path).toBeTruthy();
    expect(result.state.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "write_tool",
          request_id: "chat-write-semantic-success"
        }),
        expect.objectContaining({
          semantic_selector: "title_like_paragraphs",
          applied_fields: ["font_name", "font_size_pt", "is_bold", "is_italic"]
        })
      ])
    );
  });

  it("persists executed_patch_keys in checkpoint state and skips duplicate mutation on replay", async () => {
    const fixture = await createFixture();
    const checkpoint = new InMemoryCheckpointer();
    const repeatedToolCall = {
      id: "tool-call-dup",
      name: "write_document",
      args: {
        request_id: "chat-write-dup",
        operation: "set_text",
        target: {
          kind: "patch_targets",
          patch_target_ids: [fixture.firstInlineTargetId],
          patch_part_paths: [fixture.firstInlinePartPath]
        },
        payload: { value: "重复执行测试" }
      } satisfies WriteToolInput
    };

    const firstRun = await runPhase3Graph({
      thread_id: "checkpoint-thread",
      document_path: fixture.docxPath,
      user_message: "第一次执行修改"
    }, {
      model: new StaticModelAdapter([
        { type: "ai", text: "第一次调用写工具。", toolCalls: [repeatedToolCall] },
        { type: "ai", text: "第一次执行完成。" }
      ]),
      checkpoint
    });

    const secondRun = await runPhase3Graph({
      thread_id: "checkpoint-thread",
      document_path: fixture.docxPath,
      user_message: "恢复后继续同一修改"
    }, {
      model: new StaticModelAdapter([
        { type: "ai", text: "恢复后再次调用同一写工具。", toolCalls: [repeatedToolCall] },
        { type: "ai", text: "恢复执行结束。" }
      ]),
      checkpoint
    });

    expect(firstRun.state.executed_patch_keys).toHaveLength(1);
    expect(firstRun.artifacts.output_docx_path).toBeTruthy();
    expect(firstRun.state.diagnostics.filter((entry) => entry.stage === "materialize")).toHaveLength(1);
    expect(secondRun.state.executed_patch_keys).toHaveLength(1);
    expect(secondRun.state.diagnostics.some((entry) => entry.skip_reason === "idempotency_hit")).toBe(true);
    expect(secondRun.state.diagnostics.filter((entry) => entry.stage === "materialize")).toHaveLength(1);
    expect(secondRun.artifacts.output_docx_path).toBeUndefined();
    expect(secondRun.state.document_bundle.document_ast.inlineNodes.find((node) => node.id === fixture.firstRunId)?.text).toBe("重复执行测试");
  });

  it("records provider adapter failures and does not materialize when provider compatibility breaks", async () => {
    const fixture = await createFixture();
    const result = await runPhase3Graph({
      thread_id: "provider-adapter-failure",
      document_path: fixture.docxPath,
      user_message: "把第一段正文改掉"
    }, {
      model: {
        async invoke(): Promise<AIMessage> {
          const { AIMessage } = await import("@langchain/core/messages");
          return new AIMessage({
            content: "provider_tool_args_unmappable: unsupported provider args",
            additional_kwargs: {
              phase3_diagnostics: [
                {
                  stage: "provider_adapter",
                  provider: "deepseek",
                  provider_diagnostic_kind: "provider_tool_args_unmappable",
                  message: "unsupported provider args"
                }
              ]
            }
          });
        }
      },
      checkpoint: new InMemoryCheckpointer()
    });

    expect(result.artifacts.output_docx_path).toBeUndefined();
    expect(result.state.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "provider_adapter",
          provider: "deepseek",
          provider_diagnostic_kind: "provider_tool_args_unmappable"
        })
      ])
    );
    expect(result.state.diagnostics.some((entry) => entry.stage === "materialize")).toBe(false);
  });

  it("passes projection intent into projection builder and reasoning context", async () => {
    const fixture = await createFixture();
    const model = new CapturingModelAdapter([{ type: "ai", text: "已读取焦点投影。" }]);
    const projectionIntent: Phase3ProjectionIntent = {
      focus_regex_probe: "标题段",
      chat_text_budget: 320
    };

    const result = await runPhase3Graph({
      thread_id: "projection-intent-thread",
      document_path: fixture.docxPath,
      user_message: "把第一段正文改成新的内容",
      projection_intent: projectionIntent
    }, {
      model,
      checkpoint: new InMemoryCheckpointer()
    });

    expect(result.state.chat_projection?.diagnostics.focusRegexProbe).toBe("标题段");
    expect(model.lastInvocationMessages.join("\n")).toContain("regex_hit");
    expect(model.lastInvocationMessages.join("\n")).toContain("标题段");
  });

  it("keeps runtime chat/template projection diagnostics aligned for the same projection intent", async () => {
    const fixture = await createFixture();
    const model = new StaticModelAdapter([{ type: "ai", text: "已读取投影上下文。" }]);
    const projectionIntent: Phase3ProjectionIntent = {
      focus_regex_probe: "标题段",
      chat_text_budget: 320,
      template_text_budget: 480,
      template_batch_budget: 220,
      chat_neighbor_window: 1,
      template_local_context_window: 1
    };

    const result = await runPhase3Graph({
      thread_id: "projection-alignment-thread",
      document_path: fixture.docxPath,
      user_message: "解释当前投影",
      projection_intent: projectionIntent
    }, {
      model,
      checkpoint: new InMemoryCheckpointer()
    });

    expect(result.state.chat_projection?.diagnostics.textBudget).toBe(320);
    expect(result.state.template_projection?.diagnostics.textBudget).toBe(480);
    expect(result.state.chat_projection?.traceability.paragraphIds).toEqual(
      result.state.template_projection?.paragraphs.map((paragraph) => paragraph.paragraphId)
    );
    expect(result.state.template_projection?.diagnostics.batchCount).toBeGreaterThanOrEqual(1);
  });

  it("classifies template projections from real projection batches instead of trusting template_config semantic_tags", async () => {
    const fixture = await createFixture();
    const model = new StaticModelAdapter([]);
    const templateTask: Phase3TemplateTaskPayload = {
      template_id: "gov-notice-runtime",
      instructions: "按模板修改正文",
      tool_input: {
        request_id: "tpl-runtime-1",
        operation: "set_text",
        target: {
          kind: "patch_targets",
          patch_target_ids: [fixture.firstInlineTargetId],
          patch_part_paths: [fixture.firstInlinePartPath]
        },
        payload: { value: "分类后模板写入结果" }
      },
      semantic_tags: ["do_not_trust_config"]
    };

    const result = await runPhase3Graph({
      thread_id: "template-classifier-runtime",
      document_path: fixture.docxPath,
      user_message: "应用模板",
      template_task: templateTask,
      projection_intent: {
        template_text_budget: 480,
        template_batch_budget: 220
      }
    }, {
      model,
      checkpoint: new InMemoryCheckpointer()
    });

    expect(result.state.semantic_tags).not.toEqual(["do_not_trust_config"]);
    expect(result.state.semantic_tags.length).toBeGreaterThan(0);
    expect(
      result.state.diagnostics.some(
        (entry) => entry.stage === "template_classifier" && Array.isArray(entry.semantic_tags) && entry.semantic_tags.length > 0
      )
    ).toBe(true);
    expect(result.state.document_bundle.document_ast.inlineNodes.find((node) => node.id === fixture.firstRunId)?.text).toBe(
      "分类后模板写入结果"
    );
  });

  it("records structured reconcile failures instead of throwing when relationship repair fails", async () => {
    const fixture = await createRealDocxFixture(getRealDocxSample("hyperlink"));
    const bodyTarget = fixture.findInlineTargetByText("该样本用于验证 hyperlink 与 .rels 写回时不会静默产出损坏包。");
    const hyperlinkEdge = fixture.bundle.relationship_graph.edges.find((edge) => /hyperlink/i.test(edge.type));
    if (!hyperlinkEdge) {
      throw new Error("expected hyperlink relationship");
    }

    const brokenBundle = structuredClone(fixture.bundle);
    brokenBundle.package_snapshot.parts["word/_rels/document.xml.rels"] = {
      path: "word/_rels/document.xml.rels",
      kind: "xml",
      text:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="${hyperlinkEdge.id}" Type="${hyperlinkEdge.type}"/></Relationships>`
    };

    const checkpoint = new InMemoryCheckpointer();
    await checkpoint.save("broken-reconcile-thread", {
      messages: [],
      mode: "template",
      document_path: fixture.docxPath,
      output_path: path.join(fixture.dir, "broken-reconcile.docx"),
      document_bundle: brokenBundle,
      semantic_tags: ["broken"],
      executed_patch_keys: [],
      diagnostics: [],
      artifact_refs: []
    });

    const result = await runPhase3Graph(
      {
        thread_id: "broken-reconcile-thread",
        document_path: fixture.docxPath,
        output_path: path.join(fixture.dir, "broken-reconcile.docx"),
        user_message: "应用模板并输出",
        template_task: {
          template_id: "broken-reconcile-template",
          instructions: "触发关系调和失败",
          tool_input: {
            request_id: "broken-reconcile-1",
            operation: "set_text",
            target: {
              kind: "patch_targets",
              patch_target_ids: [bodyTarget.target.id],
              patch_part_paths: [bodyTarget.target.part_path]
            },
            payload: { value: "修复失败" }
          }
        }
      },
      {
        model: new StaticModelAdapter([
          {
            type: "ai",
            text: "生成模板写入动作。",
            toolCalls: [
              {
                id: "tool-call-broken-reconcile",
                name: "write_document",
                args: {
                  request_id: "broken-reconcile-1",
                  operation: "set_text",
                  target: {
                    kind: "patch_targets",
                    patch_target_ids: [bodyTarget.id],
                    patch_part_paths: [bodyTarget.part_path]
                  },
                  payload: { value: "修复失败" }
                } satisfies WriteToolInput
              }
            ]
          }
        ]),
        checkpoint
      }
    );

    expect(result.state.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "reconcile",
          error_code: expect.stringMatching(/^E_/)
        })
      ])
    );
  });
});

class StaticModelAdapter implements Phase3ModelAdapter {
  private readonly steps: ModelStep[];
  private index = 0;

  constructor(steps: ModelStep[]) {
    this.steps = steps;
  }

  async invoke(messages: BaseMessage[], _input: Phase3RuntimeInput): Promise<AIMessage> {
    const step = this.steps[this.index] ?? { type: "ai", text: "默认回复。" };
    this.index += 1;
    const { AIMessage } = await import("@langchain/core/messages");
    if (step.type !== "ai") {
      throw new Error("Only AI steps are supported.");
    }
    return new AIMessage({
      content: step.text,
      tool_calls: step.toolCalls?.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.args
      }))
    });
  }
}

class CapturingModelAdapter implements Phase3ModelAdapter {
  readonly lastInvocationMessages: string[] = [];
  private readonly steps: ModelStep[];
  private index = 0;

  constructor(steps: ModelStep[]) {
    this.steps = steps;
  }

  async invoke(messages: BaseMessage[], _input: Phase3RuntimeInput): Promise<AIMessage> {
    this.lastInvocationMessages.splice(0, this.lastInvocationMessages.length, ...messages.map((message) => JSON.stringify(message)));
    const step = this.steps[this.index] ?? { type: "ai", text: "默认回复。" };
    this.index += 1;
    const { AIMessage } = await import("@langchain/core/messages");
    return new AIMessage({
      content: step.text,
      tool_calls: step.toolCalls?.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.args
      }))
    });
  }
}

class InMemoryCheckpointer implements Phase3Checkpointer {
  private readonly state = new Map<string, unknown>();

  async load(threadId: string): Promise<unknown | undefined> {
    return this.state.get(threadId);
  }

  async save(threadId: string, state: unknown): Promise<void> {
    this.state.set(threadId, structuredClone(state));
  }
}

type ModelStep =
  | {
      type: "ai";
      text: string;
      toolCalls?: Array<{
        id: string;
        name: string;
        args: WriteToolInput;
      }>;
    };

async function createFixture(): Promise<{
  dir: string;
  docxPath: string;
  bundle: ParsedDocumentBundle;
  firstInlineTargetId: string;
  firstInlinePartPath: string;
  firstRunId: string;
}> {
  const dir = await makeTempDir();
  const docxPath = path.join(dir, "sample.docx");
  await writePhaseOneFixtureDocx(docxPath);
  const bundle = await parseDocumentBundle({ docxPath, mediaDir: path.join(dir, "media") });
  const firstInline = bundle.document_ast.inlineNodes.find((node) => node.nodeType === "text" && node.id && node.text);
  if (!firstInline) {
    throw new Error("expected a writable inline text node");
  }
  return {
    dir,
    docxPath,
    bundle,
    firstInlineTargetId: `target:inline:${firstInline.id}`,
    firstInlinePartPath: firstInline.partPath,
    firstRunId: firstInline.id
  };
}
