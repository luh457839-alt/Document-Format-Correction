import { describe, expect, it } from "vitest";
import { buildEmphasisRunIndex, buildStructureIndex, documentStateToNodes } from "../src/runtime/document-state.js";
import type { DocumentIR } from "../src/core/types.js";
import type { PythonDocxObservationState } from "../src/tools/python-tool-client.js";

const observation: PythonDocxObservationState = {
  package_model: {
    package_meta: {
      part_count: 3,
      xml_part_count: 2,
      media_count: 0,
      relationship_count: 1,
      section_count: 1,
      header_count: 0,
      footer_count: 0,
      footnote_count: 0,
      endnote_count: 0,
      custom_xml_count: 0,
      warnings: []
    },
    parts: [],
    relationship_graph: {
      edges: [],
      by_source: {}
    }
  },
  package_meta: {
    part_count: 3,
    xml_part_count: 2,
    media_count: 0,
    relationship_count: 1,
    section_count: 1,
    header_count: 0,
    footer_count: 0,
    footnote_count: 0,
    endnote_count: 0,
    custom_xml_count: 0,
    warnings: []
  },
  document_meta: {
    total_paragraphs: 4,
    total_tables: 0
  },
  blocks: [
    {
      id: "blk_0",
      block_id: "p_0",
      part_path: "word/document.xml",
      node_type: "paragraph",
      paragraph_id: "p_0",
      role: "heading"
    },
    {
      id: "blk_1",
      block_id: "p_1",
      part_path: "word/document.xml",
      node_type: "paragraph",
      paragraph_id: "p_1",
      role: "body"
    },
    {
      id: "blk_2",
      block_id: "p_2",
      part_path: "word/document.xml",
      node_type: "paragraph",
      paragraph_id: "p_2",
      role: "body"
    },
    {
      id: "blk_3",
      block_id: "p_3",
      part_path: "word/document.xml",
      node_type: "paragraph",
      paragraph_id: "p_3",
      role: "list_item"
    }
  ],
  inline_nodes: [
    { id: "p_0_r_0", block_id: "p_0", part_path: "word/document.xml", node_type: "text", text: "主标题", style: { is_bold: true } },
    { id: "p_1_r_0", block_id: "p_1", part_path: "word/document.xml", node_type: "text", text: "摘要", style: { is_bold: true } },
    { id: "p_1_r_1", block_id: "p_1", part_path: "word/document.xml", node_type: "text", text: "：第一段正文", style: {} },
    { id: "p_2_r_0", block_id: "p_2", part_path: "word/document.xml", node_type: "text", text: "关键词", style: { highlight_color: "yellow" } },
    { id: "p_2_r_1", block_id: "p_2", part_path: "word/document.xml", node_type: "text", text: "：第二段正文", style: {} },
    { id: "p_3_r_0", block_id: "p_3", part_path: "word/document.xml", node_type: "text", text: "列表项", style: {} }
  ],
  structure_index: {
    paragraphs: [
      {
        id: "p_0",
        text: "主标题",
        role: "heading",
        heading_level: 1,
        style_name: "Heading 1",
        run_ids: ["p_0_r_0"],
        in_table: false,
        part_path: "word/document.xml"
      },
      {
        id: "p_1",
        text: "摘要：第一段正文",
        role: "body",
        style_name: "Normal",
        run_ids: ["p_1_r_0", "p_1_r_1"],
        in_table: false,
        part_path: "word/document.xml"
      },
      {
        id: "p_2",
        text: "关键词：第二段正文",
        role: "body",
        style_name: "Normal",
        run_ids: ["p_2_r_0", "p_2_r_1"],
        in_table: false,
        part_path: "word/document.xml"
      },
      {
        id: "p_3",
        text: "列表项",
        role: "list_item",
        list_level: 0,
        style_name: "List Paragraph",
        run_ids: ["p_3_r_0"],
        in_table: false,
        part_path: "word/document.xml"
      }
    ],
    role_counts: {
      heading: 1,
      body: 2,
      list_item: 1
    }
  },
  patch_targets: [
    { id: "target:p_0_r_0", node_id: "p_0_r_0", block_id: "p_0", part_path: "word/document.xml", target_kind: "inline" },
    { id: "target:p_1_r_0", node_id: "p_1_r_0", block_id: "p_1", part_path: "word/document.xml", target_kind: "inline" }
  ],
  styles: {
    defaults: {},
    paragraph_styles: {},
    character_styles: {},
    table_styles: {}
  },
  numbering: {
    instances: []
  },
  nodes: [
    {
      id: "p_0",
      node_type: "paragraph",
      children: [{ id: "p_0_r_0", node_type: "text_run", content: "主标题", style: { is_bold: true } }]
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

  it("tracks paragraphs whose structured run ids do not project to writable text nodes", () => {
    const sparseObservation: PythonDocxObservationState = {
      ...observation,
      inline_nodes: [{ id: "p_0_r_0", block_id: "p_0", part_path: "word/document.xml", node_type: "text", text: "主标题", style: { is_bold: true } }],
      structure_index: {
        paragraphs: [
          {
            id: "p_0",
            text: "主标题",
            role: "heading",
            heading_level: 1,
            style_name: "Heading 1",
            run_ids: ["p_0_r_0"],
            in_table: false,
            part_path: "word/document.xml"
          },
          {
            id: "p_1",
            text: "",
            role: "body",
            style_name: "Normal",
            run_ids: ["p_1_r_missing"],
            in_table: false,
            part_path: "word/document.xml"
          }
        ],
        role_counts: {
          heading: 1,
          body: 1
        }
      }
    };

    expect(documentStateToNodes(sparseObservation)).toEqual([{ id: "p_0_r_0", text: "主标题", style: { is_bold: true } }]);

    const structure = buildStructureIndex(sparseObservation);
    expect(structure.roleCounts).toEqual({
      heading: 1,
      body: 1
    });
    expect(structure.projectionDiagnostics).toEqual({
      paragraphsWithoutProjectedRunNodes: ["p_1"],
      paragraphsWithoutProjectedRunNodeCount: 1,
      totalProjectedRunNodeCount: 1,
      totalStructuredRunNodeCount: 2
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
