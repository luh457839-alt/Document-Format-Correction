import { afterEach, describe, expect, it } from "vitest";
import { applyPatchOperationsToBundle } from "../runtime/bundle-mutation.js";
import { reconcileBundleRelationships } from "../runtime/relationship-reconcile.js";
import {
  createRealDocxFixture,
  getRealDocxSample,
  parseOutputDocx,
  requirePatchTarget,
  runPhase3WithStaticModel
} from "./real-docx-fixtures.js";
import type { WriteToolInput } from "../tooling/contracts.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("real docx boundary behavior", () => {
  it("does not silently damage existing hyperlink packages when editing safe text on 含超链接样本", async () => {
    const fixture = await createRealDocxFixture(getRealDocxSample("hyperlink"));
    cleanups.push(() => fixture.cleanup());

    const safeText = fixture.findInlineTargetByText("该样本用于验证 hyperlink 与 .rels 写回时不会静默产出损坏包。");
    const outputPath = fixture.outputPath("boundary-hyperlink-safe");

    const result = await runPhase3WithStaticModel(fixture, {
      thread_id: "boundary-hyperlink-safe",
      output_path: outputPath,
      user_message: "仅改写非超链接段落"
    }, [
      {
        type: "ai",
        text: "只改写安全段落。",
        toolCalls: [
          {
            id: "hyperlink-safe",
            name: "write_document",
            args: {
              request_id: "hyperlink-safe",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [safeText.target.id],
                patch_part_paths: [safeText.target.part_path]
              },
              payload: { value: "该样本用于验证 hyperlink 保持稳定。" }
            } satisfies WriteToolInput
          }
        ]
      },
      {
        type: "ai",
        text: "安全段落已更新。"
      }
    ]);

    expect(result.artifacts.output_docx_path).toBe(outputPath);
    const reparsed = await parseOutputDocx(outputPath, "boundary-hyperlink-safe");
    expect(reparsed.relationship_graph.edges.filter((edge) => /hyperlink/i.test(edge.type)).length).toBeGreaterThanOrEqual(
      fixture.bundle.relationship_graph.edges.filter((edge) => /hyperlink/i.test(edge.type)).length
    );
    expect(reparsed.document_package.packageMeta.relationshipCount).toBe(fixture.bundle.document_package.packageMeta.relationshipCount);
  });

  it("fails structurally when forcing a new hyperlink relationship into the package", async () => {
    const fixture = await createRealDocxFixture(getRealDocxSample("hyperlink"));
    cleanups.push(() => fixture.cleanup());

    const paragraphTarget = requirePatchTarget(fixture.bundle, "target:block:p_1");
    const mutated = applyPatchOperationsToBundle(fixture.bundle, [paragraphTarget], [
      {
        id: "force-hyperlink",
        type: "ensure_node",
        target_id: paragraphTarget.id,
        path: "/document/body/p[1]",
        xml_tag: "w:hyperlink",
        attrs: { "r:id": "rIdHyperlinkNew" }
      }
    ]).bundle;

    expect(() => reconcileBundleRelationships(mutated)).toThrow(/E_UNSUPPORTED_REFERENCE_KIND|hyperlink/i);
  });

  it("returns structured semantic failure instead of not-implemented gap on 脏文档样本", async () => {
    const fixture = await createRealDocxFixture(getRealDocxSample("dirty"));
    cleanups.push(() => fixture.cleanup());

    const result = await runPhase3WithStaticModel(fixture, {
      thread_id: "boundary-dirty-semantic",
      user_message: "把视觉标题改成标题字体"
    }, [
      {
        type: "ai",
        text: "尝试语义选择器。",
        toolCalls: [
          {
            id: "dirty-semantic",
            name: "write_document",
            args: {
              request_id: "dirty-semantic",
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
        text: "语义定位失败。"
      }
    ]);

    expect(result.artifacts.output_docx_path).toBeUndefined();
    expect(result.state.executed_patch_keys).toEqual([]);
    expect(result.state.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: expect.stringMatching(/^E_SEMANTIC_TARGET_|^E_BODY_BASELINE_UNDERDETERMINED$/)
        })
      ])
    );
    expect(fixture.bundle.structure_index.paragraphs[0]?.role).toBe("body");
    expect(fixture.bundle.structure_index.paragraphs[0]?.headingLevel).toBeUndefined();
  });

  it("keeps hyperlink boundary explicit inside table-bearing complex sample", async () => {
    const fixture = await createRealDocxFixture(getRealDocxSample("complex"));
    cleanups.push(() => fixture.cleanup());

    const safeTableText = fixture.findInlineTargetByText("写回风险");
    const outputPath = fixture.outputPath("boundary-complex-safe");

    const result = await runPhase3WithStaticModel(fixture, {
      thread_id: "boundary-complex-safe",
      output_path: outputPath,
      user_message: "只改写表格安全文本"
    }, [
      {
        type: "ai",
        text: "改写表格中的普通文本。",
        toolCalls: [
          {
            id: "complex-safe-table",
            name: "write_document",
            args: {
              request_id: "complex-safe-table",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [safeTableText.target.id],
                patch_part_paths: [safeTableText.target.part_path]
              },
              payload: { value: "写回风险（安全改写）" }
            } satisfies WriteToolInput
          }
        ]
      },
      {
        type: "ai",
        text: "安全表格文本已更新。"
      }
    ]);

    expect(result.artifacts.output_docx_path).toBe(outputPath);
    const reparsed = await parseOutputDocx(outputPath, "boundary-complex-safe");
    expect(reparsed.relationship_graph.edges.filter((edge) => /hyperlink/i.test(edge.type)).length).toBeGreaterThanOrEqual(1);
    expect(reparsed.document_ast.documentMeta.totalTables).toBe(1);
  });

  it("returns structured template projection failure when classification budget is impossible", async () => {
    const fixture = await createRealDocxFixture(getRealDocxSample("standard"));
    cleanups.push(() => fixture.cleanup());

    const body = fixture.findInlineTargetByText("这是一个标准正文段落，用于验证主链基础闭环。");

    const result = await runPhase3WithStaticModel(fixture, {
      thread_id: "boundary-template-projection-budget",
      user_message: "应用模板但预算极小",
      template_task: {
        template_id: "impossible-budget-template",
        instructions: "触发模板投影预算失败",
        tool_input: {
          request_id: "impossible-budget-template",
          operation: "set_text",
          target: {
            kind: "patch_targets",
            patch_target_ids: [body.target.id],
            patch_part_paths: [body.target.part_path]
          },
          payload: { value: "不应真正写入" }
        }
      },
      projection_intent: {
        template_text_budget: 8,
        template_batch_budget: 8
      }
    }, []);

    expect(result.artifacts.output_docx_path).toBeUndefined();
    expect(result.state.executed_patch_keys).toEqual([]);
    expect(result.state.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "projection_builder",
          error_code: "E_TEMPLATE_PROJECTION_BUDGET_EXCEEDED"
        })
      ])
    );
  });
});
