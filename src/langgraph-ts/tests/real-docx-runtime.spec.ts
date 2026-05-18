import { afterEach, describe, expect, it } from "vitest";
import {
  createRealDocxFixture,
  getRealDocxSample,
  parseOutputDocx,
  readZipText,
  runPhase3WithStaticModel
} from "./real-docx-fixtures.js";
import type { WriteToolInput } from "../tooling/contracts.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("real docx runtime loop", () => {
  it("keeps key structure stable after body, table, and header/footer writes on 标准正文样本", async () => {
    const fixture = await createRealDocxFixture(getRealDocxSample("standard"));
    cleanups.push(() => fixture.cleanup());

    const body = fixture.findInlineTargetByText("这是一个标准正文段落，用于验证主链基础闭环。");
    const tableCell = fixture.findInlineTargetByText("标题");
    const header = fixture.findBlockTargetByPartTextContains("word/header1.xml", "页眉");
    const footer = fixture.findBlockTargetByPartTextContains("word/footer1.xml", "页脚");
    const paragraphBlock = fixture.findBlockTargetByText("这是一个标准正文段落，用于验证主链基础闭环。");
    const outputPath = fixture.outputPath("runtime-standard");

    const result = await runPhase3WithStaticModel(fixture, {
      thread_id: "real-standard-runtime",
      output_path: outputPath,
      user_message: "修改正文、表格和页眉页脚"
    }, [
      {
        type: "ai",
        text: "依次修改正文、对齐、表格、页眉页脚。",
        toolCalls: [
          {
            id: "body-write",
            name: "write_document",
            args: {
              request_id: "real-standard-body",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [body.target.id],
                patch_part_paths: [body.target.part_path]
              },
              payload: { value: "真实样本文正文已更新" }
            } satisfies WriteToolInput
          },
          {
            id: "align-write",
            name: "write_document",
            args: {
              request_id: "real-standard-align",
              operation: "set_alignment",
              target: {
                kind: "patch_targets",
                patch_target_ids: [paragraphBlock.id],
                patch_part_paths: [paragraphBlock.part_path]
              },
              payload: { paragraph_alignment: "center" }
            } satisfies WriteToolInput
          },
          {
            id: "table-write",
            name: "write_document",
            args: {
              request_id: "real-standard-table",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [tableCell.target.id],
                patch_part_paths: [tableCell.target.part_path]
              },
              payload: { value: "标题列已改写" }
            } satisfies WriteToolInput
          },
          {
            id: "header-write",
            name: "write_document",
            args: {
              request_id: "real-standard-header",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [header.id],
                patch_part_paths: [header.part_path]
              },
              payload: { value: "标准正文页眉已更新" }
            } satisfies WriteToolInput
          },
          {
            id: "footer-write",
            name: "write_document",
            args: {
              request_id: "real-standard-footer",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [footer.id],
                patch_part_paths: [footer.part_path]
              },
              payload: { value: "标准正文页脚已更新" }
            } satisfies WriteToolInput
          }
        ]
      },
      {
        type: "ai",
        text: "已完成真实样本文档改写。"
      }
    ]);

    expect(result.artifacts.output_docx_path).toBe(outputPath);

    const reparsed = await parseOutputDocx(outputPath, "standard");
    expect(reparsed.structure_index.paragraphs).toHaveLength(fixture.bundle.structure_index.paragraphs.length);
    expect(reparsed.document_ast.documentMeta.totalTables).toBe(fixture.bundle.document_ast.documentMeta.totalTables);
    expect(reparsed.document_ast.documentMeta.totalHeaders).toBe(fixture.bundle.document_ast.documentMeta.totalHeaders);
    expect(reparsed.document_ast.documentMeta.totalFooters).toBe(fixture.bundle.document_ast.documentMeta.totalFooters);
    expect(reparsed.document_ast.inlineNodes.find((node) => node.id === body.runId)?.text).toBe("真实样本文正文已更新");
    expect(
      reparsed.structure_index.paragraphs.some(
        (entry) => entry.partPath === "word/header1.xml" && entry.text === "标准正文页眉已更新"
      )
    ).toBe(true);
    expect(
      reparsed.structure_index.paragraphs.some(
        (entry) => entry.partPath === "word/footer1.xml" && entry.text === "标准正文页脚已更新"
      )
    ).toBe(true);
    expect(reparsed.document_ast.inlineNodes.find((node) => node.id === body.runId)?.style?.paragraphAlignment).toBe("center");
  });

  it("preserves image media and image relationship when only caption text is edited on 含图片样本", async () => {
    const fixture = await createRealDocxFixture(getRealDocxSample("image"));
    cleanups.push(() => fixture.cleanup());

    const caption = fixture.findInlineTargetByText("图 1. 本地真实图片素材占位");
    const outputPath = fixture.outputPath("runtime-image");

    const result = await runPhase3WithStaticModel(fixture, {
      thread_id: "real-image-runtime",
      output_path: outputPath,
      user_message: "仅修改图注"
    }, [
      {
        type: "ai",
        text: "修改图片图注。",
        toolCalls: [
          {
            id: "caption-write",
            name: "write_document",
            args: {
              request_id: "real-image-caption",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [caption.target.id],
                patch_part_paths: [caption.target.part_path]
              },
              payload: { value: "图 1. 图注改写后保留图片关系" }
            } satisfies WriteToolInput
          }
        ]
      },
      {
        type: "ai",
        text: "图注已更新。"
      }
    ]);

    expect(result.artifacts.output_docx_path).toBe(outputPath);
    const mediaListing = await readZipText(outputPath, "word/_rels/document.xml.rels");
    const reparsed = await parseOutputDocx(outputPath, "image");

    expect(mediaListing).toMatch(/relationships\/image/);
    expect(reparsed.document_ast.documentMeta.totalImages).toBe(1);
    expect(reparsed.document_ast.inlineNodes.find((node) => node.id === caption.runId)?.text).toBe("图 1. 图注改写后保留图片关系");
  });

  it("writes multi-section header/footer content without changing counts on 含页眉页脚样本", async () => {
    const fixture = await createRealDocxFixture(getRealDocxSample("headersFooters"));
    cleanups.push(() => fixture.cleanup());

    const firstSectionHeader = fixture.findBlockTargetByPartTextContains("word/header2.xml", "2026");
    const secondSectionHeader = fixture.findBlockTargetByPartTextContains("word/header4.xml", "页眉占位");
    const secondSectionFooter = fixture.findBlockTargetByPartTextContains("word/footer4.xml", "页脚占位");
    const outputPath = fixture.outputPath("runtime-headers-footers");

    const result = await runPhase3WithStaticModel(fixture, {
      thread_id: "real-header-footer-runtime",
      output_path: outputPath,
      user_message: "修改多节页眉页脚"
    }, [
      {
        type: "ai",
        text: "分别写入不同节的页眉页脚。",
        toolCalls: [
          {
            id: "header-first",
            name: "write_document",
            args: {
              request_id: "header-first",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [firstSectionHeader.id],
                patch_part_paths: [firstSectionHeader.part_path]
              },
              payload: { value: "第一页页眉（已更新）" }
            } satisfies WriteToolInput
          },
          {
            id: "header-second",
            name: "write_document",
            args: {
              request_id: "header-second",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [secondSectionHeader.id],
                patch_part_paths: [secondSectionHeader.part_path]
              },
              payload: { value: "第二节页眉（已更新）" }
            } satisfies WriteToolInput
          },
          {
            id: "footer-second",
            name: "write_document",
            args: {
              request_id: "footer-second",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [secondSectionFooter.id],
                patch_part_paths: [secondSectionFooter.part_path]
              },
              payload: { value: "第二节页脚（已更新）" }
            } satisfies WriteToolInput
          }
        ]
      },
      {
        type: "ai",
        text: "多节页眉页脚已更新。"
      }
    ]);

    expect(result.artifacts.output_docx_path).toBe(outputPath);
    const reparsed = await parseOutputDocx(outputPath, "headers-footers");
    expect(reparsed.document_ast.documentMeta.totalHeaders).toBe(4);
    expect(reparsed.document_ast.documentMeta.totalFooters).toBe(4);
    expect(reparsed.document_package.packageMeta.relationshipCount).toBeGreaterThanOrEqual(
      reparsed.document_ast.documentMeta.totalHeaders + reparsed.document_ast.documentMeta.totalFooters
    );
    expect(
      reparsed.structure_index.paragraphs.some(
        (entry) => entry.partPath === "word/header2.xml" && entry.text === "第一页页眉（已更新）"
      )
    ).toBe(true);
    expect(
      reparsed.structure_index.paragraphs.some(
        (entry) => entry.partPath === "word/header4.xml" && entry.text === "第二节页眉（已更新）"
      )
    ).toBe(true);
    expect(
      reparsed.structure_index.paragraphs.some(
        (entry) => entry.partPath === "word/footer4.xml" && entry.text === "第二节页脚（已更新）"
      )
    ).toBe(true);
  });

  it("applies styles, numbering, and settings writes on 样式与编号差异样本 and settings敏感样本", async () => {
    const styleFixture = await createRealDocxFixture(getRealDocxSample("stylesNumbering"));
    const settingsFixture = await createRealDocxFixture(getRealDocxSample("settings"));
    cleanups.push(() => styleFixture.cleanup(), () => settingsFixture.cleanup());

    const heading = styleFixture.findInlineTargetByText("二级标题样式");
    const outputStylePath = styleFixture.outputPath("runtime-styles");
    const outputSettingsPath = settingsFixture.outputPath("runtime-settings");

    const styleRun = await runPhase3WithStaticModel(styleFixture, {
      thread_id: "real-style-runtime",
      output_path: outputStylePath,
      user_message: "修改样式、编号和标题对齐"
    }, [
      {
        type: "ai",
        text: "修改标题、样式与编号。",
        toolCalls: [
          {
            id: "style-heading-font",
            name: "write_document",
            args: {
              request_id: "style-heading-font",
              operation: "set_font",
              target: {
                kind: "patch_targets",
                patch_target_ids: [heading.target.id],
                patch_part_paths: [heading.target.part_path]
              },
              payload: { font_name: "Arial" }
            } satisfies WriteToolInput
          },
          {
            id: "style-definition",
            name: "write_document",
            args: {
              request_id: "style-definition",
              operation: "set_style_definition",
              target: {
                kind: "patch_targets",
                patch_target_ids: ["target:styles:style:BodyText"],
                patch_part_paths: ["word/styles.xml"]
              },
              payload: { style_definition: { color: "AA5500" } }
            } satisfies WriteToolInput
          },
          {
            id: "numbering-level",
            name: "write_document",
            args: {
              request_id: "numbering-level",
              operation: "set_numbering_level",
              target: {
                kind: "patch_targets",
                patch_target_ids: ["target:numbering:4:0"],
                patch_part_paths: ["word/numbering.xml"]
              },
              payload: { numbering_level: { lvlText: "%1、" } }
            } satisfies WriteToolInput
          }
        ]
      },
      {
        type: "ai",
        text: "样式与编号已更新。"
      }
    ]);

    expect(styleRun.artifacts.output_docx_path).toBe(outputStylePath);
    expect(await readZipText(outputStylePath, "word/numbering.xml")).toMatch(/%1、/);
    const reparsedStyles = await parseOutputDocx(outputStylePath, "styles");
    expect(reparsedStyles.document_ast.inlineNodes.find((node) => node.id === heading.runId)?.style?.fontName).toBe("Arial");
    expect(reparsedStyles.document_ast.styles.paragraphStyles.BodyText?.resolvedRun.fontColor).toBe("AA5500");

    const settingsRun = await runPhase3WithStaticModel(settingsFixture, {
      thread_id: "real-settings-runtime",
      output_path: outputSettingsPath,
      user_message: "修改页面布局和 settings"
    }, [
      {
        type: "ai",
        text: "修改页面布局与 settings。",
        toolCalls: [
          {
            id: "page-layout",
            name: "write_document",
            args: {
              request_id: "page-layout",
              operation: "set_page_layout",
              target: {
                kind: "patch_targets",
                patch_target_ids: ["target:document:section:0"],
                patch_part_paths: ["word/document.xml"]
              },
              payload: {
                paper_size: "A4",
                margin_top_cm: 2.5,
                margin_bottom_cm: 2.5,
                margin_left_cm: 3.0,
                margin_right_cm: 3.0
              }
            } satisfies WriteToolInput
          },
          {
            id: "settings-flag",
            name: "write_document",
            args: {
              request_id: "settings-flag",
              operation: "set_settings_flag",
              target: {
                kind: "patch_targets",
                patch_target_ids: ["target:settings:settings"],
                patch_part_paths: ["word/settings.xml"]
              },
              payload: { settings: { zoom: "bestFit" } }
            } satisfies WriteToolInput
          }
        ]
      },
      {
        type: "ai",
        text: "页面配置已更新。"
      }
    ]);

    expect(settingsRun.artifacts.output_docx_path).toBe(outputSettingsPath);
    expect(await readZipText(outputSettingsPath, "word/document.xml")).toMatch(/w:pgSz|w:pgMar/);
    expect(await readZipText(outputSettingsPath, "word/settings.xml")).toMatch(/w:zoom/);
    expect(await readZipText(outputSettingsPath, "word/_rels/document.xml.rels")).toMatch(/relationships\/settings/);
  });

  it("synchronizes title-like paragraph font to body baseline on 样式与编号差异样本 without changing structure fields", async () => {
    const fixture = await createRealDocxFixture(getRealDocxSample("stylesNumbering"));
    cleanups.push(() => fixture.cleanup());

    const outputPath = fixture.outputPath("runtime-semantic-title-font");
    const originalNumberingXml = await readZipText(fixture.docxPath, "word/numbering.xml");

    const result = await runPhase3WithStaticModel(fixture, {
      thread_id: "real-semantic-title-font-runtime",
      output_path: outputPath,
      user_message: "把标题字体同步为正文"
    }, [
      {
        type: "ai",
        text: "把标题字体同步为正文样式。",
        toolCalls: [
          {
            id: "semantic-title-font",
            name: "write_document",
            args: {
              request_id: "semantic-title-font",
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
        text: "标题字体已同步。"
      }
    ]);

    if (result.artifacts.output_docx_path) {
      expect(result.artifacts.output_docx_path).toBe(outputPath);
      expect(result.state.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            semantic_selector: "title_like_paragraphs",
            applied_fields: ["font_name", "font_size_pt", "is_bold", "is_italic"]
          })
        ])
      );

      const reparsed = await parseOutputDocx(outputPath, "semantic-title-font");
      expect(reparsed.document_ast.documentMeta.totalParagraphs).toBe(fixture.bundle.document_ast.documentMeta.totalParagraphs);
      expect(await readZipText(outputPath, "word/numbering.xml")).toBe(originalNumberingXml);
      expect(reparsed.structure_index.paragraphs.some((entry) => entry.role === "heading" || entry.text.includes("标题"))).toBe(true);
    } else {
      expect(result.state.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error_code: expect.stringMatching(/^E_SEMANTIC_TARGET_|^E_BODY_BASELINE_UNDERDETERMINED$/)
          })
        ])
      );
    }
  });

  it("keeps hyperlink and image structures intact while editing safe targets on 高风险复杂样本", async () => {
    const fixture = await createRealDocxFixture(getRealDocxSample("complex"));
    cleanups.push(() => fixture.cleanup());

    const body = fixture.findInlineTargetByText("该样本组合图片、超链接、编号、表格与页眉页脚，验证当前 reconcile 边界。");
    const numberingParagraph = fixture.findBlockTargetByText("一级编号项 A");
    const header = fixture.findBlockTargetByPartTextContains("word/header1.xml", "页眉");
    const tableCell = fixture.findInlineTargetByText("组合要素");
    const outputPath = fixture.outputPath("runtime-complex");

    const result = await runPhase3WithStaticModel(fixture, {
      thread_id: "real-complex-runtime",
      output_path: outputPath,
      user_message: "修改普通段落、编号段落、页眉和表格单元格"
    }, [
      {
        type: "ai",
        text: "仅修改安全目标，不触碰 hyperlink XML。",
        toolCalls: [
          {
            id: "complex-body",
            name: "write_document",
            args: {
              request_id: "complex-body",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [body.target.id],
                patch_part_paths: [body.target.part_path]
              },
              payload: { value: "复杂样本普通正文已更新" }
            } satisfies WriteToolInput
          },
          {
            id: "complex-numbering-style",
            name: "write_document",
            args: {
              request_id: "complex-numbering-style",
              operation: "set_alignment",
              target: {
                kind: "patch_targets",
                patch_target_ids: [numberingParagraph.id],
                patch_part_paths: [numberingParagraph.part_path]
              },
              payload: { paragraph_alignment: "right" }
            } satisfies WriteToolInput
          },
          {
            id: "complex-header",
            name: "write_document",
            args: {
              request_id: "complex-header",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [header.id],
                patch_part_paths: [header.part_path]
              },
              payload: { value: "复杂样本页眉（已更新）" }
            } satisfies WriteToolInput
          },
          {
            id: "complex-table",
            name: "write_document",
            args: {
              request_id: "complex-table",
              operation: "set_text",
              target: {
                kind: "patch_targets",
                patch_target_ids: [tableCell.target.id],
                patch_part_paths: [tableCell.target.part_path]
              },
              payload: { value: "组合要素（已改写）" }
            } satisfies WriteToolInput
          }
        ]
      },
      {
        type: "ai",
        text: "复杂样本安全写入完成。"
      }
    ]);

    expect(result.artifacts.output_docx_path).toBe(outputPath);
    const relsXml = await readZipText(outputPath, "word/_rels/document.xml.rels");
    expect(relsXml).toMatch(/relationships\/image/);
    expect(relsXml).toMatch(/relationships\/hyperlink/);

    const reparsed = await parseOutputDocx(outputPath, "complex");
    expect(reparsed.document_ast.documentMeta.totalImages).toBe(1);
    expect(reparsed.document_ast.documentMeta.totalTables).toBe(1);
    expect(reparsed.document_ast.documentMeta.totalHeaders).toBe(1);
    expect(reparsed.document_ast.documentMeta.totalFooters).toBe(1);
    expect(reparsed.document_ast.inlineNodes.find((node) => node.id === body.runId)?.text).toBe("复杂样本普通正文已更新");
    expect(
      reparsed.structure_index.paragraphs.some(
        (entry) => entry.partPath === "word/header1.xml" && entry.text === "复杂样本页眉（已更新）"
      )
    ).toBe(true);
    expect(reparsed.document_ast.inlineNodes.find((node) => node.id === tableCell.runId)?.text).toBe("组合要素（已改写）");
  });

  it("uses template classification batches before executing template writes on 标准正文样本", async () => {
    const fixture = await createRealDocxFixture(getRealDocxSample("standard"));
    cleanups.push(() => fixture.cleanup());

    const body = fixture.findInlineTargetByText("这是一个标准正文段落，用于验证主链基础闭环。");
    const outputPath = fixture.outputPath("runtime-template-classified");

    const result = await runPhase3WithStaticModel(fixture, {
      thread_id: "real-template-classified-runtime",
      output_path: outputPath,
      user_message: "应用模板改写正文",
      template_task: {
        template_id: "standard-template",
        instructions: "基于模板分类结果改写正文",
        tool_input: {
          request_id: "real-template-classified",
          operation: "set_text",
          target: {
            kind: "patch_targets",
            patch_target_ids: [body.target.id],
            patch_part_paths: [body.target.part_path]
          },
          payload: { value: "模板分类后真实正文已更新" }
        },
        semantic_tags: ["ignore_config_tags"]
      },
      projection_intent: {
        template_text_budget: 420,
        template_batch_budget: 220
      }
    }, []);

    expect(result.artifacts.output_docx_path).toBe(outputPath);
    expect(result.state.semantic_tags.length).toBeGreaterThan(0);
    expect(result.state.semantic_tags).not.toEqual(["ignore_config_tags"]);
    expect(result.state.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ stage: "template_classifier" })])
    );

    const reparsed = await parseOutputDocx(outputPath, "template-classified");
    expect(reparsed.document_ast.inlineNodes.find((node) => node.id === body.runId)?.text).toBe("模板分类后真实正文已更新");
  });
});
