import { describe, expect, it } from "vitest";
import { buildEmphasisRunIndex, buildStructureIndex, documentStateToNodes } from "../src/runtime/document-state.js";
import type { DocumentIR } from "../src/core/types.js";
import type { PythonDocxObservationState } from "../src/tools/python-tool-client.js";

const observation: PythonDocxObservationState = {
  document_meta: {
    total_paragraphs: 4,
    total_tables: 0
  },
  paragraphs: [
    {
      id: "p_0",
      text: "主标题",
      role: "heading",
      heading_level: 1,
      style_name: "Heading 1",
      run_ids: ["p_0_r_0"],
      in_table: false
    },
    {
      id: "p_1",
      text: "摘要：第一段正文",
      role: "body",
      style_name: "Normal",
      run_ids: ["p_1_r_0", "p_1_r_1"],
      in_table: false
    },
    {
      id: "p_2",
      text: "关键词：第二段正文",
      role: "body",
      style_name: "Normal",
      run_ids: ["p_2_r_0", "p_2_r_1"],
      in_table: false
    },
    {
      id: "p_3",
      text: "列表项",
      role: "list_item",
      list_level: 0,
      style_name: "List Paragraph",
      run_ids: ["p_3_r_0"],
      in_table: false
    }
  ],
  nodes: [
    {
      id: "p_0",
      node_type: "paragraph",
      children: [{ id: "p_0_r_0", node_type: "text_run", content: "主标题", style: { is_bold: true } }]
    },
    {
      id: "p_1",
      node_type: "paragraph",
      children: [
        { id: "p_1_r_0", node_type: "text_run", content: "摘要", style: { is_bold: true } },
        { id: "p_1_r_1", node_type: "text_run", content: "：第一段正文", style: {} }
      ]
    },
    {
      id: "p_2",
      node_type: "paragraph",
      children: [
        { id: "p_2_r_0", node_type: "text_run", content: "关键词", style: { highlight_color: "yellow" } },
        { id: "p_2_r_1", node_type: "text_run", content: "：第二段正文", style: {} }
      ]
    },
    {
      id: "p_3",
      node_type: "paragraph",
      children: [{ id: "p_3_r_0", node_type: "text_run", content: "列表项", style: {} }]
    }
  ]
};

describe("document state helpers", () => {
  it("flattens text runs into document nodes", () => {
    expect(documentStateToNodes(observation)).toEqual([
      { id: "p_0_r_0", text: "主标题", style: { is_bold: true } },
      { id: "p_1_r_0", text: "摘要", style: { is_bold: true } },
      { id: "p_1_r_1", text: "：第一段正文", style: {} },
      { id: "p_2_r_0", text: "关键词", style: { highlight_color: "yellow" } },
      { id: "p_2_r_1", text: "：第二段正文", style: {} },
      { id: "p_3_r_0", text: "列表项", style: {} }
    ]);
  });

  it("builds paragraph role counts and paragraph map", () => {
    const structure = buildStructureIndex(observation);

    expect(structure.roleCounts).toEqual({
      heading: 1,
      body: 2,
      list_item: 1
    });
    expect(structure.paragraphs[1]).toMatchObject({
      id: "p_1",
      role: "body",
      runNodeIds: ["p_1_r_0", "p_1_r_1"]
    });
    expect(structure.paragraphMap["p_0"]).toMatchObject({
      headingLevel: 1
    });
  });

  it("builds emphasis index items linked to paragraph ids", () => {
    const doc: DocumentIR = {
      id: "demo",
      version: "v1",
      nodes: documentStateToNodes(observation),
      metadata: {
        structureIndex: buildStructureIndex(observation)
      }
    };

    expect(buildEmphasisRunIndex(doc)).toEqual([
      {
        runId: "p_0_r_0",
        text: "主标题",
        paragraphId: "p_0",
        paragraphTextPreview: "主标题",
        emphasisFlags: {
          isBold: true,
          isItalic: false,
          isUnderline: false,
          highlightColor: undefined
        }
      },
      {
        runId: "p_1_r_0",
        text: "摘要",
        paragraphId: "p_1",
        paragraphTextPreview: "摘要：第一段正文",
        emphasisFlags: {
          isBold: true,
          isItalic: false,
          isUnderline: false,
          highlightColor: undefined
        }
      },
      {
        runId: "p_2_r_0",
        text: "关键词",
        paragraphId: "p_2",
        paragraphTextPreview: "关键词：第二段正文",
        emphasisFlags: {
          isBold: false,
          isItalic: false,
          isUnderline: false,
          highlightColor: "yellow"
        }
      }
    ]);
  });
});
