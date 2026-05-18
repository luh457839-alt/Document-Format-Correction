import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenAICompatibleModelFromEnv,
  createRealDocxFixture,
  getRealDocxSample
} from "./real-docx-fixtures.js";
import {
  expectControlledRealModelOutcome,
  debugRealModelResult,
  expectNoReasoningCompatibilityRegression,
  expectRealModelOutputAndStages,
  findDiagnostics,
  summarizeDiagnostics
} from "./real-model-test-helpers.js";
import { runPhase3Graph } from "../runtime/graph.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("real model regression", () => {
  const maybeModel = createOpenAICompatibleModelFromEnv();

  it("keeps 标准正文样本 on the full write -> reconcile -> materialize path", async ({ skip }) => {
    if (!maybeModel.model) {
      skip(maybeModel.reason);
    }
    const fixture = await createRealDocxFixture(getRealDocxSample("standard"));
    cleanups.push(() => fixture.cleanup());

    const result = await runPhase3Graph({
      thread_id: "real-model-regression-standard",
      document_path: fixture.docxPath,
      output_path: fixture.outputPath("real-model-regression-standard"),
      user_message: "把第一段正文改成“真实模型回归测试已写入”。"
    }, {
      model: maybeModel.model
    });
    debugRealModelResult("real-model-regression-standard", result);

    if (result.artifacts.output_docx_path) {
      expectRealModelOutputAndStages(result);
      expect(result.state.diagnostics.some((entry) => entry.stage === "write_tool" && entry.executed === true)).toBe(true);
      expectNoReasoningCompatibilityRegression(result);
    } else {
      expectControlledRealModelOutcome(result, [
        "E_GRAPH_RECURSION_LIMIT",
        "provider_read_loop_exhausted"
      ]);
    }
  }, 300000);

  it("keeps 样式与编号差异样本 producing output and write activity", async ({ skip }) => {
    if (!maybeModel.model) {
      skip(maybeModel.reason);
    }
    const fixture = await createRealDocxFixture(getRealDocxSample("stylesNumbering"));
    cleanups.push(() => fixture.cleanup());

    const result = await runPhase3Graph({
      thread_id: "real-model-regression-styles",
      document_path: fixture.docxPath,
      output_path: fixture.outputPath("real-model-regression-styles"),
      user_message: "把二级标题字体改成 Arial，并保持文档可重新生成。"
    }, {
      model: maybeModel.model
    });
    debugRealModelResult("real-model-regression-styles", result);

    if (result.artifacts.output_docx_path) {
      expectRealModelOutputAndStages(result);
      expect(result.state.diagnostics.some((entry) => entry.stage === "write_tool" && entry.executed === true)).toBe(true);
      expectNoReasoningCompatibilityRegression(result);
    } else {
      expectControlledRealModelOutcome(result, [
        "E_GRAPH_RECURSION_LIMIT",
        "provider_read_loop_exhausted",
        "provider_tool_args_unmappable"
      ]);
    }
  }, 90000);

  it("captures or preserves target self-correction evidence for 标准正文样本 without treating it as a chain failure", async ({ skip }) => {
    if (!maybeModel.model) {
      skip(maybeModel.reason);
    }
    const attempts = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fixture = await createRealDocxFixture(getRealDocxSample("standard"));
      cleanups.push(() => fixture.cleanup());
      const threadId = `real-model-regression-standard-known-phenomenon-${attempt + 1}`;
      const result = await runPhase3Graph({
        thread_id: threadId,
        document_path: fixture.docxPath,
        output_path: fixture.outputPath(threadId),
        user_message: "把第一段正文改成“真实模型回归测试已写入”。"
      }, {
        model: maybeModel.model
      });
      debugRealModelResult(threadId, result);
      if (result.artifacts.output_docx_path) {
        expectRealModelOutputAndStages(result);
        expectNoReasoningCompatibilityRegression(result);
      } else {
        expectControlledRealModelOutcome(result, [
          "E_TARGET_NODE_NOT_FOUND",
          "E_PATCH_TARGET_NOT_FOUND",
          "E_GRAPH_RECURSION_LIMIT",
          "provider_read_loop_exhausted"
        ]);
      }
      attempts.push(result);
    }

    const selfCorrectionRuns = attempts.filter((result) =>
      findDiagnostics(result.state.diagnostics, (entry) => entry.error_code === "E_TARGET_NODE_NOT_FOUND").length > 0
    );
    expect(
      selfCorrectionRuns.length > 0,
      `expected at least one target self-correction signal across 3 runs; diagnostics=${attempts
        .map((result) => summarizeDiagnostics(result.state.diagnostics))
        .join(" || ")}`
    ).toBe(true);
  }, 180000);

  it("captures settings compatibility evidence for settings敏感样本 without treating it as a chain failure", async ({ skip }) => {
    if (!maybeModel.model) {
      skip(maybeModel.reason);
    }
    const fixture = await createRealDocxFixture(getRealDocxSample("settings"));
    cleanups.push(() => fixture.cleanup());

    const result = await runPhase3Graph({
      thread_id: "real-model-regression-settings-known-phenomenon",
      document_path: fixture.docxPath,
      output_path: fixture.outputPath("real-model-regression-settings-known-phenomenon"),
      user_message: "把页面设置调整为 A4 并更新 settings。"
    }, {
      model: maybeModel.model
    });
    debugRealModelResult("real-model-regression-settings-known-phenomenon", result);

    expectNoReasoningCompatibilityRegression(result);
    if (result.artifacts.output_docx_path) {
      expectRealModelOutputAndStages(result);
    } else {
      expect(
        findDiagnostics(result.state.diagnostics, (entry) => {
          const message = String(entry.message ?? "");
          return message.includes("set_settings_flag requires explicit settings patch targets")
            || message.includes("set_settings_flag requires settings");
        }).length > 0
      ).toBe(true);
    }
  }, 120000);
});
