import { describe, expect, it } from "vitest";
import type { PythonDocxObservationState } from "../src/tools/python-tool-client.js";

const observation: PythonDocxObservationState = {
  package_model: {
    package_meta: {
      part_count: 1,
      xml_part_count: 1,
      media_count: 0,
      relationship_count: 0,
      section_count: 1,
      header_count: 0,
      footer_count: 0,
      footnote_count: 0,
      endnote_count: 0,
      custom_xml_count: 0,
      warnings: [],
      part_paths: ["word/document.xml"]
    },
    parts: [{ path: "word/document.xml", kind: "main_document", relationship_count: 0, xml_root: "document" }],
    relationship_graph: { edges: [], by_source: {} }
  },
  package_meta: {
    part_count: 1,
    xml_part_count: 1,
    media_count: 0,
    relationship_count: 0,
    section_count: 1,
    header_count: 0,
    footer_count: 0,
    footnote_count: 0,
    endnote_count: 0,
    custom_xml_count: 0,
    warnings: [],
    part_paths: ["word/document.xml"]
  },
  document_meta: {
    total_paragraphs: 1,
    total_tables: 0
  },
  blocks: [
    {
      id: "blk_0",
      block_id: "p_0",
      part_path: "word/document.xml",
      node_type: "paragraph",
      paragraph_id: "p_0",
      role: "body",
      anchor: { part_path: "word/document.xml", xml_path: "/document/body/p[0]" }
    }
  ],
  inline_nodes: [
    {
      id: "p_0_r_0",
      block_id: "p_0",
      part_path: "word/document.xml",
      node_type: "text",
      text: "Hello",
      style: {},
      anchor: { part_path: "word/document.xml", xml_path: "/document/body/p[0]/r[0]/t" }
    }
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
  structure_index: {
    paragraphs: [
      {
        id: "p_0",
        text: "Hello",
        role: "body",
        run_ids: ["p_0_r_0"],
        in_table: false,
        part_path: "word/document.xml"
      }
    ],
    role_counts: { body: 1 }
  },
  patch_targets: [
    {
      id: "target:block:p_0",
      target_kind: "block",
      part_path: "word/document.xml",
      block_id: "p_0",
      locator: { part_path: "word/document.xml", xml_path: "/document/body/p[0]" }
    },
    {
      id: "target:inline:p_0_r_0",
      target_kind: "inline",
      part_path: "word/document.xml",
      block_id: "p_0",
      node_id: "p_0_r_0",
      locator: { part_path: "word/document.xml", xml_path: "/document/body/p[0]/r[0]/t" },
      style_snapshot: {}
    }
  ],
  nodes: [
    {
      id: "p_0",
      node_type: "paragraph",
      children: [{ id: "p_0_r_0", node_type: "text_run", content: "Hello", style: {} }]
    }
  ]
};

describe("template context builder", () => {
  it("keeps observation, package model, and source docx path in document metadata", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");

    const context = buildTemplateContextFromObservation({
      docxPath: "D:/fixtures/sample.docx",
      observation
    });

    expect(context.document.metadata?.inputDocxPath).toBe("D:/fixtures/sample.docx");
    expect(context.document.metadata?.docxObservation).toBe(observation);
    expect(context.document.metadata?.docxPackageModel).toEqual(observation.package_model);
    expect(context.document.metadata?.structureIndex).toEqual(context.structureIndex);
  });
});
