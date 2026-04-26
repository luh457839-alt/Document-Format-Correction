import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import type { DocxObservationState, DocxPatchSet, DocxPatchTarget } from "../src/tools/docx-observation-schema.js";
import { compileOperationToPatchSet } from "../src/tools/docx-patching.js";
import { createDocumentToolingFacade } from "../src/document-tooling/facade.js";
import { buildTemplateContextFromObservation } from "../src/templates/template-context-builder.js";
import { executeTemplateWritePlan } from "../src/templates/template-executor.js";
import { buildTemplateWritePlan } from "../src/templates/template-write-planner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("docx patch parity", () => {
  it("keeps template first-line indent compilation aligned with write_operation", async () => {
    const dir = await makeTempDir();
    const inputDocxPath = path.join(dir, "indent-input.docx");
    await writeMinimalDocx(inputDocxPath);
    const context = buildTemplateContextFromObservation({
      docxPath: inputDocxPath,
      observation: createObservation()
    });

    const chatPatchSet = compileOperationToPatchSet(context.document, {
      id: "chat-indent",
      type: "set_paragraph_indent",
      targetNodeId: "p_0_r_0",
      payload: { first_line_indent_pt: 32 }
    }).patchSet;

    const templatePlan = buildTemplateWritePlan({
      executionPlan: [
        {
          semantic_key: "body",
          paragraph_ids: ["p_0"],
          selector: {
            part: "document",
            scope: "paragraph",
            match: { paragraph_ids: ["p_0"] }
          },
          operations: [
            {
              type: "set_paragraph_style",
              paragraph_style: { first_line_indent_pt: 32 }
            }
          ]
        }
      ],
      document: context.document,
      structureIndex: context.structureIndex
    });

    expect(templatePlan.issues).toEqual([]);
    expect(normalizePatchSet(templatePlan.patchPlan[0]?.patch_set)).toEqual(normalizePatchSet(chatPatchSet));
  });

  it("keeps template page-layout compilation aligned with write_operation", async () => {
    const dir = await makeTempDir();
    const inputDocxPath = path.join(dir, "layout-input.docx");
    await writeMinimalDocx(inputDocxPath);
    const context = buildTemplateContextFromObservation({
      docxPath: inputDocxPath,
      observation: createObservation()
    });

    const chatPatchSet = compileOperationToPatchSet(context.document, {
      id: "chat-layout",
      type: "set_page_layout",
      patchTargetIds: ["target:document:section:0"],
      patchPartPaths: ["word/document.xml"],
      payload: {
        paper_size: "A4",
        margin_top_cm: 3.7,
        margin_bottom_cm: 3.5,
        margin_left_cm: 2.8,
        margin_right_cm: 2.6
      }
    }).patchSet;

    const templatePlan = buildTemplateWritePlan({
      executionPlan: [
        {
          semantic_key: "page",
          paragraph_ids: [],
          selector: {
            part: "document",
            scope: "section",
            match: { section_index: 0 }
          },
          operations: [
            {
              type: "set_section_layout",
              section_layout: {
                paper_size: "A4",
                margin_top_cm: 3.7,
                margin_bottom_cm: 3.5,
                margin_left_cm: 2.8,
                margin_right_cm: 2.6
              }
            }
          ]
        }
      ],
      document: context.document,
      structureIndex: context.structureIndex
    });

    expect(templatePlan.issues).toEqual([]);
    expect(normalizePatchSet(templatePlan.patchPlan[0]?.patch_set)).toEqual(normalizePatchSet(chatPatchSet));
  });

  it("keeps template bold execution history and document.xml aligned with write_operation", async () => {
    const dir = await makeTempDir();
    const inputDocxPath = path.join(dir, "bold-input.docx");
    const chatOutputDocxPath = path.join(dir, "bold-chat-output.docx");
    const templateOutputDocxPath = path.join(dir, "bold-template-output.docx");
    await writeMinimalDocx(inputDocxPath);
    const observation = createObservation();
    const context = buildTemplateContextFromObservation({
      docxPath: inputDocxPath,
      observation
    });
    const facade = createDocumentToolingFacade();

    const chatExecuted = await facade.createWriteOperationTool().execute({
      doc: {
        ...context.document,
        metadata: {
          ...(context.document.metadata ?? {}),
          inputDocxPath,
          outputDocxPath: chatOutputDocxPath
        }
      },
      operation: {
        id: "chat-bold",
        type: "set_bold",
        targetNodeId: "p_0_r_0",
        payload: { is_bold: true }
      },
      context: { taskId: "chat", stepId: "bold", dryRun: false }
    });
    await facade.materializeDocument(chatExecuted.doc);

    const templatePlan = buildTemplateWritePlan({
      executionPlan: [
        {
          semantic_key: "body",
          paragraph_ids: ["p_0"],
          text_style: { is_bold: true },
          paragraph_style: {}
        } as any
      ],
      document: context.document,
      structureIndex: context.structureIndex
    });

    expect(templatePlan.issues).toEqual([]);
    const templateExecuted = await executeTemplateWritePlan({
      context,
      patchPlan: templatePlan.patchPlan,
      writePlan: templatePlan.writePlan,
      outputDocxPath: templateOutputDocxPath,
      debug: true
    });
    await facade.materializeDocument(templateExecuted.finalDoc);

    const chatHistory = readPatchHistory(chatExecuted.doc)[0];
    const templateHistory = readPatchHistory(templateExecuted.finalDoc)[0];
    expect(normalizePatchSet(templateHistory)).toEqual(normalizePatchSet(chatHistory));

    const chatXml = await readDocxPart(chatOutputDocxPath, "word/document.xml");
    const templateXml = await readDocxPart(templateOutputDocxPath, "word/document.xml");
    expect(templateXml).toBe(chatXml);
  });

  it("compiles template-style extended write operations into patch sets without apply_docx_xml_patch", async () => {
    const dir = await makeTempDir();
    const inputDocxPath = path.join(dir, "extended-input.docx");
    await writeExtendedDocx(inputDocxPath);
    const context = buildTemplateContextFromObservation({
      docxPath: inputDocxPath,
      observation: createObservation()
    });

    const stylePatch = compileOperationToPatchSet(context.document, {
      id: "style-def",
      type: "set_style_definition",
      patchTargetIds: ["target:styles:style:BodyText"],
      patchPartPaths: ["word/styles.xml"],
      payload: {
        style_definition: {
          customStyle: "1"
        }
      }
    }).patchSet;
    expect(normalizePatchSet(stylePatch)).toEqual({
      targets: [
        {
          id: "target:styles:style:BodyText",
          target_kind: "style",
          part_path: "word/styles.xml",
          block_id: "BodyText",
          locator: { part_path: "word/styles.xml", xml_path: "/styles/style[BodyText]" }
        }
      ],
      operations: [
        {
          type: "set_attr",
          target_id: "target:styles:style:BodyText",
          name: "w:customStyle",
          value: "1"
        }
      ]
    });

    const ensurePatch = compileOperationToPatchSet(context.document, {
      id: "style-ensure",
      type: "ensure_node",
      patchTargetIds: ["target:styles:style:BodyText"],
      patchPartPaths: ["word/styles.xml"],
      payload: {
        path: "w:pPr/w:jc",
        xml_tag: "w:jc",
        attrs: { "w:val": "both" }
      }
    }).patchSet;
    expect(normalizePatchSet(ensurePatch)).toEqual({
      targets: [
        {
          id: "target:styles:style:BodyText",
          target_kind: "style",
          part_path: "word/styles.xml",
          block_id: "BodyText",
          locator: { part_path: "word/styles.xml", xml_path: "/styles/style[BodyText]" }
        }
      ],
      operations: [
        {
          type: "ensure_node",
          target_id: "target:styles:style:BodyText",
          path: "w:pPr/w:jc",
          xml_tag: "w:jc",
          attrs: { "w:val": "both" }
        }
      ]
    });
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "docx-patch-parity-"));
  tempDirs.push(dir);
  return dir;
}

async function writeMinimalDocx(target: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`
  );
  await writeFile(target, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writeExtendedDocx(target: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/></w:style></w:styles>`
  );
  await writeFile(target, await zip.generateAsync({ type: "nodebuffer" }));
}

async function readDocxPart(docxPath: string, partPath: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(docxPath));
  return (await zip.file(partPath)?.async("string")) ?? "";
}

function createObservation(): DocxObservationState {
  return {
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
    document_meta: { total_paragraphs: 1, total_tables: 0 },
    paragraphs: [
      {
        id: "p_0",
        text: "Hello",
        role: "body",
        style_name: "BodyText",
        run_ids: ["p_0_r_0"],
        in_table: false,
        part_path: "word/document.xml"
      }
    ],
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
        style: {
          font_name: "FangSong_GB2312",
          font_size_pt: 16
        },
        anchor: { part_path: "word/document.xml", xml_path: "/document/body/p[0]/r[0]/t" }
      }
    ],
    styles: {
      defaults: {},
      paragraph_styles: {},
      character_styles: {},
      table_styles: {}
    },
    numbering: { instances: [] },
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
        text: "Hello",
        locator: { part_path: "word/document.xml", xml_path: "/document/body/p[0]/r[0]/t" },
        style_snapshot: {
          font_name: "FangSong_GB2312",
          font_size_pt: 16
        }
      }
    ],
    nodes: [
      {
        id: "p_0",
        node_type: "paragraph",
        children: [
          {
            id: "p_0_r_0",
            node_type: "text_run",
            content: "Hello",
            style: {
              font_name: "FangSong_GB2312",
              font_size_pt: 16
            }
          }
        ]
      }
    ]
  };
}

function normalizePatchSet(patchSet: DocxPatchSet | undefined): {
  targets: Array<{
    id: string;
    target_kind: DocxPatchTarget["target_kind"];
    part_path: string;
    block_id: string;
    node_id?: string;
    locator?: { part_path: string; xml_path: string };
  }>;
  operations: Array<{
    type: string;
    target_id: string;
    name?: string;
    value?: unknown;
    path?: string;
    xml_tag?: string;
    attrs?: Record<string, string>;
    node_xml?: string;
  }>;
} {
  return {
    targets: [...(patchSet?.targets ?? [])]
      .map((target) => ({
        id: target.id,
        target_kind: target.target_kind,
        part_path: target.part_path,
        block_id: target.block_id,
        ...(target.node_id ? { node_id: target.node_id } : {}),
        ...(target.locator ? { locator: target.locator } : {})
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    operations: (patchSet?.operations ?? []).map((operation) => ({
      type: operation.type,
      target_id: operation.target_id,
      ...(operation.name ? { name: operation.name } : {}),
      ...(operation.value !== undefined ? { value: operation.value } : {}),
      ...(operation.path ? { path: operation.path } : {}),
      ...(operation.xml_tag ? { xml_tag: operation.xml_tag } : {}),
      ...(operation.attrs ? { attrs: operation.attrs } : {}),
      ...(operation.node_xml ? { node_xml: operation.node_xml } : {})
    }))
  };
}

function readPatchHistory(doc: { metadata?: unknown }): DocxPatchSet[] {
  const metadata =
    doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata)
      ? (doc.metadata as Record<string, unknown>)
      : undefined;
  return Array.isArray(metadata?.docxPatchHistory) ? (metadata.docxPatchHistory as DocxPatchSet[]) : [];
}
