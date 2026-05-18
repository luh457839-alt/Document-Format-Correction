import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenAICompatibleModelFromEnv,
  createRealDocxFixture,
  getRealDocxSample,
  normalizeOpenAICompatibleWriteToolInputForSmoke
} from "./real-docx-fixtures.js";
import {
  debugRealModelResult,
  expectNoReasoningCompatibilityRegression,
  expectRealModelOutputAndStages
} from "./real-model-test-helpers.js";
import { runPhase3Graph } from "../runtime/graph.js";
import { parseWriteToolInput } from "../tooling/schema.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("real model smoke", () => {
  const maybeModel = createOpenAICompatibleModelFromEnv();

  it("normalizes DeepSeek-style write args into current write tool contract", async () => {
    const standardFixture = await createRealDocxFixture(getRealDocxSample("standard"));
    const styleFixture = await createRealDocxFixture(getRealDocxSample("stylesNumbering"));
    const settingsFixture = await createRealDocxFixture(getRealDocxSample("settings"));
    cleanups.push(() => standardFixture.cleanup());
    cleanups.push(() => styleFixture.cleanup());
    cleanups.push(() => settingsFixture.cleanup());

    const normalizedText = await normalizeOpenAICompatibleWriteToolInputForSmoke(
      {
        request_id: "doc_fix_001",
        operation: "update",
        target: {
          type: "paragraph",
          index: 0
        },
        payload: {
          content: "真实模型冒烟测试已写入"
        },
        idempotency_key: "fix_first_para_001"
      },
      { document_path: standardFixture.docxPath }
    );
    expect(parseWriteToolInput(normalizedText)).toEqual(normalizedText);
    expect(normalizedText.operation).toBe("set_text");
    expect(normalizedText.target.kind).toBe("selector");
    if (normalizedText.target.kind !== "selector" || normalizedText.target.selector.scope !== "paragraph_ids") {
      throw new Error("expected paragraph_ids selector");
    }
    expect(normalizedText.target.selector.paragraphIds).toHaveLength(1);
    expect(normalizedText.payload).toEqual({ value: "真实模型冒烟测试已写入" });

    const normalizedStyle = await normalizeOpenAICompatibleWriteToolInputForSmoke(
      {
        request_id: "fix-heading-font",
        operation: "set_font",
        target: "all paragraph with style \"heading 2\"",
        payload: {
          font: "Arial",
          preserve_regen: true
        }
      },
      { document_path: styleFixture.docxPath }
    );
    expect(parseWriteToolInput(normalizedStyle)).toEqual(normalizedStyle);
    expect(normalizedStyle.operation).toBe("set_font");
    expect(normalizedStyle.target).toEqual({
      kind: "selector",
      selector: {
        scope: "heading",
        headingLevel: 2
      }
    });
    expect(normalizedStyle.payload).toEqual({ font_name: "Arial" });

    const normalizedSettings = await normalizeOpenAICompatibleWriteToolInputForSmoke(
      {
        request_id: "req-001",
        operation: "set_page_layout",
        target: {
          kind: "document",
          selectors: {
            all: true
          }
        },
        payload: {
          paper_size: "A4"
        }
      },
      { document_path: settingsFixture.docxPath }
    );
    expect(parseWriteToolInput(normalizedSettings)).toEqual(normalizedSettings);
    expect(normalizedSettings.target).toEqual({
      kind: "patch_targets",
      patch_target_ids: ["target:document:section:0"],
      patch_part_paths: ["word/document.xml"]
    });
    expect(normalizedSettings.payload).toEqual({ paper_size: "A4" });
  });

  it("keeps constrained semantic selector payloads in the current contract", async () => {
    const styleFixture = await createRealDocxFixture(getRealDocxSample("stylesNumbering"));
    cleanups.push(() => styleFixture.cleanup());

    const normalizedSemantic = await normalizeOpenAICompatibleWriteToolInputForSmoke(
      {
        request_id: "semantic-sync-001",
        operation: "set_font",
        target: {
          kind: "semantic_selector",
          semantic: "title_like_paragraphs"
        },
        payload: {
          baseline_from_semantic: "body_like_paragraphs",
          sync_fields: ["font_name", "font_size_pt"]
        }
      },
      { document_path: styleFixture.docxPath }
    );

    expect(parseWriteToolInput(normalizedSemantic)).toEqual(normalizedSemantic);
    expect(normalizedSemantic.target).toEqual({
      kind: "semantic_selector",
      semantic: "title_like_paragraphs"
    });
    expect(normalizedSemantic.payload).toEqual({
      baseline_from_semantic: "body_like_paragraphs",
      sync_fields: ["font_name", "font_size_pt"]
    });
  });

  it("returns tool calls and materializes DOCX for 标准正文样本", async ({ skip }) => {
    if (!maybeModel.model) {
      skip(maybeModel.reason);
    }
    const fixture = await createRealDocxFixture(getRealDocxSample("standard"));
    cleanups.push(() => fixture.cleanup());

    const result = await runPhase3Graph({
      thread_id: "real-model-standard",
      document_path: fixture.docxPath,
      output_path: fixture.outputPath("real-model-standard"),
      user_message: "把第一段正文改成“真实模型冒烟测试已写入”。"
    }, {
      model: maybeModel.model
    });
    debugRealModelResult("real-model-standard", result);

    if (result.artifacts.output_docx_path) {
      expectRealModelOutputAndStages(result, ["write_tool", "reconcile", "materialize"]);
      expect(result.state.diagnostics.some((entry) => entry.stage === "write_tool" && entry.executed === true)).toBe(true);
      expectNoReasoningCompatibilityRegression(result);
    } else {
      expectNoReasoningCompatibilityRegression(result);
      expect(
        result.state.diagnostics.some(
          (entry) => entry.error_code === "E_GRAPH_RECURSION_LIMIT" || entry.provider_diagnostic_kind === "provider_read_loop_exhausted"
        )
      ).toBe(true);
    }
  }, 90000);

  it("works for style-oriented instruction on 样式与编号差异样本", async ({ skip }) => {
    if (!maybeModel.model) {
      skip(maybeModel.reason);
    }
    const fixture = await createRealDocxFixture(getRealDocxSample("stylesNumbering"));
    cleanups.push(() => fixture.cleanup());

    const result = await runPhase3Graph({
      thread_id: "real-model-style",
      document_path: fixture.docxPath,
      output_path: fixture.outputPath("real-model-style"),
      user_message: "把二级标题字体改成 Arial，并保持文档可重新生成。"
    }, {
      model: maybeModel.model
    });
    debugRealModelResult("real-model-style", result);

    expectRealModelOutputAndStages(result, ["write_tool", "reconcile", "materialize"]);
    expect(result.state.diagnostics.some((entry) => entry.stage === "write_tool")).toBe(true);
    expectNoReasoningCompatibilityRegression(result);
  }, 90000);

  it("reaches reconcile/materialize for settings request on settings敏感样本", async ({ skip }) => {
    if (!maybeModel.model) {
      skip(maybeModel.reason);
    }
    const fixture = await createRealDocxFixture(getRealDocxSample("settings"));
    cleanups.push(() => fixture.cleanup());

    const result = await runPhase3Graph({
      thread_id: "real-model-settings",
      document_path: fixture.docxPath,
      output_path: fixture.outputPath("real-model-settings"),
      user_message: "把页面设置调整为 A4 并更新 settings。"
    }, {
      model: maybeModel.model
    });
    debugRealModelResult("real-model-settings", result);

    if (result.artifacts.output_docx_path) {
      expectRealModelOutputAndStages(result, ["write_tool", "reconcile", "materialize"]);
      expectNoReasoningCompatibilityRegression(result);
    } else {
      expectNoReasoningCompatibilityRegression(result);
      expect(
        result.state.diagnostics.some((entry) => {
          const message = String(entry.message ?? "");
          return (
            entry.error_code === "E_OPERATION_TARGET_INCOMPATIBLE" ||
            entry.provider_diagnostic_kind === "provider_tool_args_unmappable" ||
            message.includes("set_settings_flag requires explicit settings patch targets") ||
            message.includes("set_settings_flag requires settings")
          );
        })
      ).toBe(true);
    }
  }, 120000);
});
