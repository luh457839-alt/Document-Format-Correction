import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import type { DocumentIR } from "../src/core/types.js";
import type { DocxObservationState } from "../src/tools/docx-observation-schema.js";
import { createDocumentToolingFacade } from "../src/document-tooling/facade.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "docx-patch-exec-"));
  tempDirs.push(dir);
  return dir;
}

async function writeDocx(parts: Record<string, string>, target: string): Promise<void> {
  const zip = new JSZip();
  for (const [partPath, content] of Object.entries(parts)) {
    zip.file(partPath, content);
  }
  await writeFile(target, await zip.generateAsync({ type: "nodebuffer" }));
}

async function readDocxPart(docxPath: string, partPath: string): Promise<string> {
  const raw = await readFile(docxPath);
  const zip = await JSZip.loadAsync(raw);
  return (await zip.file(partPath)?.async("string")) ?? "";
}

async function writeDocxFromDirectory(sourceDir: string, target: string): Promise<void> {
  const zip = new JSZip();
  await addDirectoryToZip(zip, sourceDir, sourceDir);
  await writeFile(
    target,
    await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    })
  );
}

async function addDirectoryToZip(zip: JSZip, rootDir: string, currentDir: string): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, rootDir, absolutePath);
      continue;
    }
    const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");
    zip.file(relativePath, await readFile(absolutePath));
  }
}

function fixturePath(name: "ok" | "error"): string {
  return fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url));
}

function createObservation(partPath = "word/document.xml"): DocxObservationState {
  const rootPath = partPath === "word/header1.xml" ? "/hdr" : "/document/body";
  const partKind = partPath === "word/header1.xml" ? "header" : "main_document";
  const xmlRoot = partPath === "word/header1.xml" ? "hdr" : "document";
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
        part_paths: [partPath]
      },
      parts: [{ path: partPath, kind: partKind, relationship_count: 0, xml_root: xmlRoot }],
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
      part_paths: [partPath]
    },
    document_meta: { total_paragraphs: 1, total_tables: 0 },
    blocks: [
      {
        id: "blk_0",
        block_id: "p_0",
        part_path: partPath,
        node_type: "paragraph",
        paragraph_id: "p_0",
        role: "body",
        anchor: { part_path: partPath, xml_path: `${rootPath}/p[0]` }
      }
    ],
    inline_nodes: [
      {
        id: "p_0_r_0",
        block_id: "p_0",
        part_path: partPath,
        node_type: "text",
        text: "Hello",
        style: {},
        anchor: { part_path: partPath, xml_path: `${rootPath}/p[0]/r[0]/t` }
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
          part_path: partPath
        }
      ],
      role_counts: { body: 1 }
    },
    patch_targets: [
      {
        id: "target:block:p_0",
        target_kind: "block",
        part_path: partPath,
        block_id: "p_0",
        locator: { part_path: partPath, xml_path: `${rootPath}/p[0]` }
      },
      {
        id: "target:inline:p_0_r_0",
        target_kind: "inline",
        part_path: partPath,
        block_id: "p_0",
        node_id: "p_0_r_0",
        text: "Hello",
        locator: { part_path: partPath, xml_path: `${rootPath}/p[0]/r[0]/t` },
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
}

function createDoc(observation: DocxObservationState, inputDocxPath: string, outputDocxPath: string): DocumentIR {
  return {
    id: "doc_patch",
    version: "v1",
    nodes: [{ id: "p_0_r_0", text: "Hello" }],
    metadata: {
      inputDocxPath,
      outputDocxPath,
      docxObservation: observation,
      docxPackageModel: observation.package_model,
      structureIndex: {
        paragraphs: [{ id: "p_0", role: "body", runNodeIds: ["p_0_r_0"], partPath: observation.patch_targets[0]?.part_path }],
        roleCounts: { body: 1 },
        paragraphMap: {}
      }
    }
  };
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

function localName(node: Element): string {
  const name = node.localName || node.nodeName || "";
  return name.includes(":") ? name.split(":").at(-1) ?? name : name;
}

function childElements(parent: Element): Element[] {
  const children: Element[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const child = parent.childNodes[index];
    if (child.nodeType === child.ELEMENT_NODE) {
      children.push(child as Element);
    }
  }
  return children;
}

function findBodyParagraph(documentDom: Document, index: number): Element {
  const body = Array.from(documentDom.getElementsByTagName("*")).find((node) => localName(node as Element) === "body") as Element | undefined;
  if (!body) {
    throw new Error("word/document.xml is missing w:body");
  }
  const paragraphs = childElements(body).filter((child) => localName(child) === "p");
  const paragraph = paragraphs[index];
  if (!paragraph) {
    throw new Error(`word/document.xml is missing paragraph ${index}`);
  }
  return paragraph;
}

function findDirectChild(parent: Element, wantedLocalName: string): Element | undefined {
  return childElements(parent).find((child) => localName(child) === wantedLocalName);
}

function childNames(parent: Element): string[] {
  return childElements(parent).map((child) => localName(child));
}

function expectParagraphPropertiesToKeepSchemaOrder(paragraph: Element): void {
  const pPr = findDirectChild(paragraph, "pPr");
  expect(pPr, "paragraph is missing w:pPr").toBeDefined();
  const names = childNames(pPr!);
  const rPrIndex = names.indexOf("rPr");
  if (rPrIndex === -1) {
    return;
  }
  const trailingNames = names.slice(rPrIndex + 1);
  expect(trailingNames).not.toContain("jc");
  expect(trailingNames).not.toContain("spacing");
  expect(trailingNames).not.toContain("ind");
}

function expectRunPropertiesToKeepSchemaOrder(run: Element): void {
  const rPr = findDirectChild(run, "rPr");
  expect(rPr, "run is missing w:rPr").toBeDefined();
  const names = childNames(rPr!);
  const boldIndex = names.indexOf("b");
  const sizeIndex = names.indexOf("sz");
  const sizeCsIndex = names.indexOf("szCs");
  if (boldIndex !== -1 && sizeIndex !== -1) {
    expect(boldIndex).toBeLessThan(sizeIndex);
  }
  if (boldIndex !== -1 && sizeCsIndex !== -1) {
    expect(boldIndex).toBeLessThan(sizeCsIndex);
  }
}

function firstDescendant(parent: Element, wantedLocalName: string): Element | undefined {
  const all = Array.from(parent.getElementsByTagName("*")) as Element[];
  return all.find((element) => localName(element) === wantedLocalName);
}

function hasAttributeLocal(element: Element, wantedLocalName: string): boolean {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (!attribute) {
      continue;
    }
    const name = attribute.localName || attribute.name || "";
    const resolved = name.includes(":") ? name.split(":").at(-1) ?? name : name;
    if (resolved === wantedLocalName) {
      return true;
    }
  }
  return false;
}

function countMutuallyExclusiveFirstLineIndents(documentDom: Document): number {
  const indents = Array.from(documentDom.getElementsByTagName("*")) as Element[];
  return indents.filter((element) => {
    if (localName(element) !== "ind" || !hasAttributeLocal(element, "firstLine")) {
      return false;
    }
    return ["hanging", "hangingChars", "firstLineChars"].some((name) => hasAttributeLocal(element, name));
  }).length;
}

function countRunsWithOrphanedBCs(documentDom: Document): number {
  const runProperties = Array.from(documentDom.getElementsByTagName("*")) as Element[];
  return runProperties.filter((element) => localName(element) === "rPr").filter((rPr) => {
    const names = childNames(rPr);
    return names.includes("bCs") && !names.includes("b");
  }).length;
}

describe("patch-first docx execution", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("compiles write_operation into patch facts and updates document metadata", async () => {
    const dir = await makeTempDir();
    const inputDocxPath = path.join(dir, "input.docx");
    const outputDocxPath = path.join(dir, "output.docx");
    await writeDocx(
      {
        "[Content_Types].xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
        "word/document.xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`
      },
      inputDocxPath
    );
    const observation = createObservation();
    const doc = createDoc(observation, inputDocxPath, outputDocxPath);
    const facade = createDocumentToolingFacade();

    const output = await facade.createWriteOperationTool().execute({
      doc,
      operation: {
        id: "op_set_font",
        type: "set_font",
        targetNodeId: "p_0_r_0",
        payload: { font_name: "SimSun" }
      },
      context: { taskId: "task-1", stepId: "step-1", dryRun: false }
    });

    expect(output.summary).toContain("patch");
    expect(output.doc.nodes[0]?.style).toMatchObject({ font_name: "SimSun", operation: "set_font" });
    expect(output.artifacts?.patchSet).toMatchObject({
      operations: [
        expect.objectContaining({
          target_id: "target:inline:p_0_r_0",
          type: "set_attribute",
          name: "font_name",
          value: "SimSun"
        })
      ]
    });
    expect(output.artifacts?.partPaths).toEqual(["word/document.xml"]);
  });

  it("materializes only the patched part from accumulated patch history", async () => {
    const dir = await makeTempDir();
    const inputDocxPath = path.join(dir, "input.docx");
    const outputDocxPath = path.join(dir, "output.docx");
    const documentXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`;
    const headerXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>`;
    await writeDocx(
      {
        "[Content_Types].xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
        "word/document.xml": documentXml,
        "word/header1.xml": headerXml
      },
      inputDocxPath
    );
    const observation = createObservation("word/header1.xml");
    const doc = createDoc(observation, inputDocxPath, outputDocxPath);
    const facade = createDocumentToolingFacade();

    const executed = await facade.createWriteOperationTool().execute({
      doc,
      operation: {
        id: "op_set_bold",
        type: "set_bold",
        targetNodeId: "p_0_r_0",
        payload: { is_bold: true }
      },
      context: { taskId: "task-1", stepId: "step-1", dryRun: false }
    });

    const materialized = await facade.materializeDocument(executed.doc);
    expect(materialized.summary).toContain("word/header1.xml");

    const nextDocumentXml = await readDocxPart(outputDocxPath, "word/document.xml");
    const nextHeaderXml = await readDocxPart(outputDocxPath, "word/header1.xml");
    expect(nextDocumentXml).toBe(documentXml);
    expect(nextHeaderXml).toContain("<w:b");
    expect(nextHeaderXml).toContain("Header");
  });

  it("materializes package-level targets carried by the patch set itself", async () => {
    const dir = await makeTempDir();
    const inputDocxPath = path.join(dir, "input.docx");
    const outputDocxPath = path.join(dir, "output.docx");
    await writeDocx(
      {
        "[Content_Types].xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
        "word/document.xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
        "word/styles.xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="en-US"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/></w:style></w:styles>`,
        "word/settings.xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/></w:settings>`
      },
      inputDocxPath
    );
    const observation = createObservation();
    const doc = createDoc(observation, inputDocxPath, outputDocxPath);
    const facade = createDocumentToolingFacade();

    const patched = await facade.createApplyDocxXmlPatchTool().execute({
      doc,
      operation: {
        id: "op_package_patch",
        type: "set_font",
        payload: {
          patchSet: {
            targets: [
              {
                id: "target:styles:docDefaults:rPrDefault",
                part_kind: "styles",
                target_kind: "style_defaults",
                xml_tag: "w:rPrDefault",
                part_path: "word/styles.xml",
                block_id: "docDefaults",
                locator: {
                  part_path: "word/styles.xml",
                  xml_path: "/styles/docDefaults/rPrDefault"
                }
              },
              {
                id: "target:styles:style:BodyText",
                part_kind: "styles",
                target_kind: "style",
                xml_tag: "w:style",
                part_path: "word/styles.xml",
                block_id: "BodyText",
                locator: {
                  part_path: "word/styles.xml",
                  xml_path: "/styles/style[BodyText]"
                }
              },
              {
                id: "target:settings:zoom",
                part_kind: "settings",
                target_kind: "settings_node",
                xml_tag: "w:zoom",
                part_path: "word/settings.xml",
                block_id: "settings",
                locator: {
                  part_path: "word/settings.xml",
                  xml_path: "/settings/zoom"
                }
              }
            ],
            operations: [
              {
                id: "op1",
                type: "set_attr",
                target_id: "target:styles:docDefaults:rPrDefault",
                path: "w:rPr/w:lang",
                name: "w:val",
                value: "zh-CN"
              },
              {
                id: "op2",
                type: "ensure_node",
                target_id: "target:styles:style:BodyText",
                path: "w:pPr/w:jc",
                xml_tag: "w:jc",
                attrs: {
                  "w:val": "both"
                }
              },
              {
                id: "op3",
                type: "set_attr",
                target_id: "target:settings:zoom",
                name: "w:percent",
                value: "125"
              }
            ]
          }
        }
      },
      context: { taskId: "task-1", stepId: "step-2", dryRun: false }
    });

    await facade.materializeDocument(patched.doc);

    const stylesXml = await readDocxPart(outputDocxPath, "word/styles.xml");
    const settingsXml = await readDocxPart(outputDocxPath, "word/settings.xml");
    expect(stylesXml).toContain('w:lang w:val="zh-CN"');
    expect(stylesXml).toContain('<w:jc w:val="both"');
    expect(settingsXml).toContain('w:zoom w:percent="125"');
  });

  it("documents the conflicting indent and orphaned bold markers encoded in the docs/error regression fixture", async () => {
    const errorXml = await readFile(path.join(fixturePath("error"), "word", "document.xml"), "utf8");
    const documentDom = parseXml(errorXml);

    expect(countMutuallyExclusiveFirstLineIndents(documentDom)).toBeGreaterThan(0);
    expect(countRunsWithOrphanedBCs(documentDom)).toBeGreaterThan(0);
  });

  it("normalizes mutually exclusive indentation attributes before writing first-line indent", async () => {
    const dir = await makeTempDir();
    const inputDocxPath = path.join(dir, "indent-input.docx");
    const outputDocxPath = path.join(dir, "indent-output.docx");
    await writeDocx(
      {
        "[Content_Types].xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
        "word/document.xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:ind w:left="10" w:right="53" w:hanging="10" w:hangingChars="200" w:firstLineChars="100"/></w:pPr><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`
      },
      inputDocxPath
    );
    const observation = createObservation();
    const doc = createDoc(observation, inputDocxPath, outputDocxPath);
    const facade = createDocumentToolingFacade();

    const executed = await facade.createWriteOperationTool().execute({
      doc,
      operation: {
        id: "op_set_indent",
        type: "set_paragraph_indent",
        targetNodeId: "p_0_r_0",
        payload: { first_line_indent_pt: 24 }
      },
      context: { taskId: "task-indent", stepId: "step-indent", dryRun: false }
    });

    await facade.materializeDocument(executed.doc);

    const outputXml = await readDocxPart(outputDocxPath, "word/document.xml");
    const documentDom = parseXml(outputXml);
    const paragraph = findBodyParagraph(documentDom, 0);
    const ind = findDirectChild(findDirectChild(paragraph, "pPr")!, "ind");
    expect(ind).toBeDefined();
    expect(hasAttributeLocal(ind!, "left")).toBe(true);
    expect(hasAttributeLocal(ind!, "right")).toBe(true);
    expect(hasAttributeLocal(ind!, "firstLine")).toBe(true);
    expect(hasAttributeLocal(ind!, "hanging")).toBe(false);
    expect(hasAttributeLocal(ind!, "hangingChars")).toBe(false);
    expect(hasAttributeLocal(ind!, "firstLineChars")).toBe(false);
    expect(countMutuallyExclusiveFirstLineIndents(documentDom)).toBe(0);
  });

  it("materializes bold as a paired w:b and w:bCs property", async () => {
    const dir = await makeTempDir();
    const inputDocxPath = path.join(dir, "bold-input.docx");
    const outputDocxPath = path.join(dir, "bold-output.docx");
    await writeDocx(
      {
        "[Content_Types].xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
        "word/document.xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="SimSun"/><w:color w:val="111111"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`
      },
      inputDocxPath
    );
    const observation = createObservation();
    const doc = createDoc(observation, inputDocxPath, outputDocxPath);
    const facade = createDocumentToolingFacade();

    const executed = await facade.createWriteOperationTool().execute({
      doc,
      operation: {
        id: "op_set_bold_pair",
        type: "set_bold",
        targetNodeId: "p_0_r_0",
        payload: { is_bold: true }
      },
      context: { taskId: "task-bold", stepId: "step-bold", dryRun: false }
    });

    await facade.materializeDocument(executed.doc);

    const outputXml = await readDocxPart(outputDocxPath, "word/document.xml");
    const documentDom = parseXml(outputXml);
    const run = firstDescendant(findBodyParagraph(documentDom, 0), "r");
    const rPr = findDirectChild(run!, "rPr");
    expect(rPr, "run is missing w:rPr").toBeDefined();
    expect(childNames(rPr!)).toContain("b");
    expect(childNames(rPr!)).toContain("bCs");
    expectRunPropertiesToKeepSchemaOrder(run!);
    expect(countRunsWithOrphanedBCs(documentDom)).toBe(0);
  });

  it("removes orphaned w:bCs when bold is explicitly disabled", async () => {
    const dir = await makeTempDir();
    const inputDocxPath = path.join(dir, "bold-off-input.docx");
    const outputDocxPath = path.join(dir, "bold-off-output.docx");
    await writeDocx(
      {
        "[Content_Types].xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
        "word/document.xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="SimSun"/><w:bCs/><w:color w:val="111111"/></w:rPr><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`
      },
      inputDocxPath
    );
    const observation = createObservation();
    const doc = createDoc(observation, inputDocxPath, outputDocxPath);
    const facade = createDocumentToolingFacade();

    const executed = await facade.createWriteOperationTool().execute({
      doc,
      operation: {
        id: "op_clear_bold_pair",
        type: "set_bold",
        targetNodeId: "p_0_r_0",
        payload: { is_bold: false }
      },
      context: { taskId: "task-bold-off", stepId: "step-bold-off", dryRun: false }
    });

    await facade.materializeDocument(executed.doc);

    const outputXml = await readDocxPart(outputDocxPath, "word/document.xml");
    const documentDom = parseXml(outputXml);
    const run = firstDescendant(findBodyParagraph(documentDom, 0), "r");
    const rPr = findDirectChild(run!, "rPr");
    expect(rPr, "run is missing w:rPr").toBeDefined();
    expect(childNames(rPr!)).not.toContain("b");
    expect(childNames(rPr!)).not.toContain("bCs");
    expect(countRunsWithOrphanedBCs(documentDom)).toBe(0);
  });

  it("materializes real DOCX fixtures without placing pPr or rPr style nodes after schema boundaries", async () => {
    const dir = await makeTempDir();
    const inputDocxPath = path.join(dir, "input.docx");
    const outputDocxPath = path.join(dir, "output.docx");
    await writeDocxFromDirectory(fixturePath("ok"), inputDocxPath);
    const observation = createObservation();
    const doc = createDoc(observation, inputDocxPath, outputDocxPath);
    doc.nodes = [];
    const facade = createDocumentToolingFacade();

    const patched = await facade.createApplyDocxXmlPatchTool().execute({
      doc,
      operation: {
        id: "op_fixture_patch",
        type: "set_font",
        payload: {
          patchSet: {
            targets: [
              {
                id: "target:fixture:block:title",
                target_kind: "block",
                part_path: "word/document.xml",
                block_id: "title",
                locator: { part_path: "word/document.xml", xml_path: "/document/body/p[0]" }
              },
              {
                id: "target:fixture:block:author",
                target_kind: "block",
                part_path: "word/document.xml",
                block_id: "author",
                locator: { part_path: "word/document.xml", xml_path: "/document/body/p[1]" }
              },
              {
                id: "target:fixture:block:body",
                target_kind: "block",
                part_path: "word/document.xml",
                block_id: "body",
                locator: { part_path: "word/document.xml", xml_path: "/document/body/p[3]" }
              },
              {
                id: "target:fixture:block:pagebreak",
                target_kind: "block",
                part_path: "word/document.xml",
                block_id: "pagebreak",
                locator: { part_path: "word/document.xml", xml_path: "/document/body/p[11]" }
              },
              {
                id: "target:fixture:block:list",
                target_kind: "block",
                part_path: "word/document.xml",
                block_id: "list",
                locator: { part_path: "word/document.xml", xml_path: "/document/body/p[15]" }
              },
              {
                id: "target:fixture:block:hyperlink",
                target_kind: "block",
                part_path: "word/document.xml",
                block_id: "hyperlink",
                locator: { part_path: "word/document.xml", xml_path: "/document/body/p[125]" }
              },
              {
                id: "target:fixture:inline:title",
                target_kind: "inline",
                part_path: "word/document.xml",
                block_id: "title",
                node_id: "run:title",
                locator: { part_path: "word/document.xml", xml_path: "/document/body/p[0]/r[0]/t" }
              },
              {
                id: "target:fixture:inline:hyperlink",
                target_kind: "inline",
                part_path: "word/document.xml",
                block_id: "hyperlink",
                node_id: "run:hyperlink",
                locator: { part_path: "word/document.xml", xml_path: "/document/body/p[125]/hyperlink[0]/r[0]/t" }
              }
            ],
            operations: [
              {
                id: "author-align",
                type: "set_attr",
                target_id: "target:fixture:block:author",
                name: "paragraph_alignment",
                value: "justify"
              },
              {
                id: "author-spacing",
                type: "set_attr",
                target_id: "target:fixture:block:author",
                name: "line_spacing",
                value: { mode: "exact", pt: 22 }
              },
              {
                id: "author-indent",
                type: "set_attr",
                target_id: "target:fixture:block:author",
                name: "first_line_indent_pt",
                value: 24
              },
              {
                id: "body-align",
                type: "set_attr",
                target_id: "target:fixture:block:body",
                name: "paragraph_alignment",
                value: "justify"
              },
              {
                id: "body-spacing",
                type: "set_attr",
                target_id: "target:fixture:block:body",
                name: "line_spacing",
                value: { mode: "exact", pt: 22 }
              },
              {
                id: "body-indent",
                type: "set_attr",
                target_id: "target:fixture:block:body",
                name: "first_line_indent_pt",
                value: 24
              },
              {
                id: "pagebreak-align",
                type: "set_attr",
                target_id: "target:fixture:block:pagebreak",
                name: "paragraph_alignment",
                value: "justify"
              },
              {
                id: "pagebreak-spacing",
                type: "set_attr",
                target_id: "target:fixture:block:pagebreak",
                name: "line_spacing",
                value: { mode: "exact", pt: 22 }
              },
              {
                id: "pagebreak-indent",
                type: "set_attr",
                target_id: "target:fixture:block:pagebreak",
                name: "first_line_indent_pt",
                value: 24
              },
              {
                id: "list-align",
                type: "set_attr",
                target_id: "target:fixture:block:list",
                name: "paragraph_alignment",
                value: "justify"
              },
              {
                id: "list-spacing",
                type: "set_attr",
                target_id: "target:fixture:block:list",
                name: "line_spacing",
                value: { mode: "exact", pt: 22 }
              },
              {
                id: "hyperlink-align",
                type: "set_attr",
                target_id: "target:fixture:block:hyperlink",
                name: "paragraph_alignment",
                value: "justify"
              },
              {
                id: "hyperlink-spacing",
                type: "set_attr",
                target_id: "target:fixture:block:hyperlink",
                name: "line_spacing",
                value: { mode: "exact", pt: 22 }
              },
              {
                id: "title-font",
                type: "set_attr",
                target_id: "target:fixture:inline:title",
                name: "font_name",
                value: "SimSun"
              },
              {
                id: "title-size",
                type: "set_attr",
                target_id: "target:fixture:inline:title",
                name: "font_size_pt",
                value: 14
              },
              {
                id: "title-bold",
                type: "set_attr",
                target_id: "target:fixture:inline:title",
                name: "is_bold",
                value: true
              },
              {
                id: "hyperlink-color",
                type: "set_attr",
                target_id: "target:fixture:inline:hyperlink",
                name: "font_color",
                value: "#0000EE"
              },
              {
                id: "hyperlink-size",
                type: "set_attr",
                target_id: "target:fixture:inline:hyperlink",
                name: "font_size_pt",
                value: 10.5
              },
              {
                id: "hyperlink-bold",
                type: "set_attr",
                target_id: "target:fixture:inline:hyperlink",
                name: "is_bold",
                value: true
              },
              {
                id: "paper-size",
                type: "set_attr",
                target_id: "target:document:section:0",
                name: "paper_size",
                value: "LETTER"
              },
              {
                id: "margin-left",
                type: "set_attr",
                target_id: "target:document:section:0",
                name: "margin_left_cm",
                value: 2.54
              },
              {
                id: "margin-right",
                type: "set_attr",
                target_id: "target:document:section:0",
                name: "margin_right_cm",
                value: 2.54
              }
            ]
          }
        }
      },
      context: { taskId: "task-fixture", stepId: "step-fixture", dryRun: false }
    });

    await facade.materializeDocument(patched.doc);

    const outputXml = await readDocxPart(outputDocxPath, "word/document.xml");
    const zip = await JSZip.loadAsync(await readFile(outputDocxPath));
    expect(zip.file("word/document.xml")).toBeTruthy();

    const documentDom = parseXml(outputXml);
    const authorParagraph = findBodyParagraph(documentDom, 1);
    const bodyParagraph = findBodyParagraph(documentDom, 3);
    const pagebreakParagraph = findBodyParagraph(documentDom, 11);
    const listParagraph = findBodyParagraph(documentDom, 15);
    const hyperlinkParagraph = findBodyParagraph(documentDom, 125);
    const titleRun = firstDescendant(findBodyParagraph(documentDom, 0), "r");
    const hyperlinkRun = firstDescendant(hyperlinkParagraph, "r");

    expectParagraphPropertiesToKeepSchemaOrder(authorParagraph);
    expectParagraphPropertiesToKeepSchemaOrder(bodyParagraph);
    expectParagraphPropertiesToKeepSchemaOrder(pagebreakParagraph);
    expectParagraphPropertiesToKeepSchemaOrder(listParagraph);
    expectParagraphPropertiesToKeepSchemaOrder(hyperlinkParagraph);
    expectRunPropertiesToKeepSchemaOrder(titleRun!);
    expectRunPropertiesToKeepSchemaOrder(hyperlinkRun!);
    expect(countMutuallyExclusiveFirstLineIndents(documentDom)).toBe(0);
    expect(countRunsWithOrphanedBCs(documentDom)).toBe(0);
  });

  it("inserts sectPr children in page-layout schema order and keeps output size close to the original package", async () => {
    const dir = await makeTempDir();
    const layoutInputDocxPath = path.join(dir, "layout-input.docx");
    const layoutOutputDocxPath = path.join(dir, "layout-output.docx");
    await writeDocx(
      {
        "[Content_Types].xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`,
        "word/document.xml":
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:sectPr><w:pgNumType w:start="1"/><w:cols w:space="720"/></w:sectPr></w:body></w:document>`
      },
      layoutInputDocxPath
    );
    const layoutObservation = createObservation();
    const layoutDoc = createDoc(layoutObservation, layoutInputDocxPath, layoutOutputDocxPath);
    const facade = createDocumentToolingFacade();

    const layoutPatched = await facade.createWriteOperationTool().execute({
      doc: layoutDoc,
      operation: {
        id: "op_layout_patch",
        type: "set_page_layout",
        payload: {
          paper_size: "A4",
          margin_left_cm: 3.17
        }
      },
      context: { taskId: "task-layout", stepId: "step-layout", dryRun: false }
    });

    await facade.materializeDocument(layoutPatched.doc);

    const layoutXml = await readDocxPart(layoutOutputDocxPath, "word/document.xml");
    const layoutDom = parseXml(layoutXml);
    const sectPr = Array.from(layoutDom.getElementsByTagName("*")).find((node) => localName(node as Element) === "sectPr") as Element | undefined;
    expect(sectPr).toBeDefined();
    expect(childNames(sectPr!)).toEqual(["pgSz", "pgMar", "pgNumType", "cols"]);

    const inputDocxPath = path.join(dir, "size-input.docx");
    const outputDocxPath = path.join(dir, "size-output.docx");
    await writeDocxFromDirectory(fixturePath("ok"), inputDocxPath);
    const beforeSize = (await stat(inputDocxPath)).size;
    const observation = createObservation();
    const doc = createDoc(observation, inputDocxPath, outputDocxPath);
    doc.nodes = [];

    const patched = await facade.createApplyDocxXmlPatchTool().execute({
      doc,
      operation: {
        id: "op_size_patch",
        type: "set_font",
        payload: {
          patchSet: {
            targets: [
              {
                id: "target:fixture:inline:title",
                target_kind: "inline",
                part_path: "word/document.xml",
                block_id: "title",
                node_id: "run:title",
                locator: { part_path: "word/document.xml", xml_path: "/document/body/p[0]/r[0]/t" }
              }
            ],
            operations: [
              {
                id: "size-bold",
                type: "set_attr",
                target_id: "target:fixture:inline:title",
                name: "is_bold",
                value: true
              }
            ]
          }
        }
      },
      context: { taskId: "task-size", stepId: "step-size", dryRun: false }
    });

    await facade.materializeDocument(patched.doc);

    const afterSize = (await stat(outputDocxPath)).size;
    expect(afterSize).toBeLessThanOrEqual(Math.round(beforeSize * 1.2));
  });
});
