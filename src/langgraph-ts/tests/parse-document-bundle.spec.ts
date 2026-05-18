import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writePhaseOneFixtureDocx } from "./test-fixtures.js";
import { parseDocumentBundle } from "../document-core/parse-document-bundle.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "langgraph-phase1-"));
  tempDirs.push(dir);
  return dir;
}

describe("parseDocumentBundle", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns the full parsed document bundle for a docx sample", async () => {
    const dir = await makeTempDir();
    const docxPath = path.join(dir, "sample.docx");
    const mediaDir = path.join(dir, "media");
    await writePhaseOneFixtureDocx(docxPath);

    const bundle = await parseDocumentBundle({ docxPath, mediaDir });

    expect(bundle.document_ast.nodes).toHaveLength(3);
    expect(bundle.document_ast.documentMeta.totalParagraphs).toBe(4);
    expect(bundle.document_ast.documentMeta.totalTables).toBe(1);
    expect(bundle.document_package.packageMeta.partCount).toBeGreaterThanOrEqual(11);
    expect(bundle.document_package.packageMeta.headerCount).toBe(1);
    expect(bundle.document_package.packageMeta.footerCount).toBe(1);
    expect(bundle.document_package.packageMeta.footnoteCount).toBe(1);
    expect(bundle.document_package.packageMeta.endnoteCount).toBe(1);
    expect(bundle.document_package.packageMeta.createdBy).toBe("Parser Test");
    expect(bundle.relationship_graph.edges.length).toBeGreaterThanOrEqual(3);
    expect(bundle.structure_index.paragraphs.some((paragraph) => paragraph.role === "heading")).toBe(true);
    expect(bundle.structure_index.roleCounts.heading).toBe(1);
    expect(bundle.document_ast.styles.paragraphStyles.BodyText?.resolvedRun.fontName).toBe("Cambria");
    expect(bundle.document_ast.numbering.instances).toEqual([
      expect.objectContaining({
        numId: "7",
        abstractNumId: "4"
      })
    ]);
    expect(bundle.document_ast.blocks.some((block) => block.partPath === "word/header1.xml")).toBe(true);
    expect(bundle.document_ast.inlineNodes.some((node) => node.partPath === "word/footnotes.xml")).toBe(true);

    const mainParagraph = bundle.document_ast.nodes[1];
    expect(mainParagraph.nodeType).toBe("paragraph");
    if (mainParagraph.nodeType !== "paragraph") {
      throw new Error("expected paragraph");
    }

    const textRun = mainParagraph.children.find((child) => child.nodeType === "text_run");
    expect(textRun).toBeDefined();
    if (!textRun || textRun.nodeType !== "text_run") {
      throw new Error("expected text run");
    }
    expect(textRun.style?.fontName).toBe("Consolas");
    expect(textRun.style?.fontSizePt).toBe(13);
    expect(textRun.style?.fontColor).toBe("FF0000");
    expect(textRun.style?.isBold).toBe(true);
    expect(textRun.style?.isItalic).toBe(true);
    expect(textRun.style?.isUnderline).toBe(true);
    expect(textRun.style?.isStrike).toBe(true);
    expect(textRun.style?.highlightColor).toBe("yellow");
    expect(textRun.style?.isAllCaps).toBe(true);
    expect(textRun.style?.paragraphAlignment).toBe("center");
    expect(textRun.style?.lineSpacing).toBe(1.5);

    const imageNode = mainParagraph.children.find((child) => child.nodeType === "image");
    expect(imageNode).toBeDefined();
    if (!imageNode || imageNode.nodeType !== "image") {
      throw new Error("expected image");
    }
    expect(path.isAbsolute(imageNode.src)).toBe(true);
    await expect(access(imageNode.src, fsConstants.R_OK)).resolves.toBeUndefined();
    expect(imageNode.size.width).toBe(100);
    expect(imageNode.size.height).toBe(200);

    const formulas = mainParagraph.children.filter((child) => child.nodeType === "formula");
    expect(formulas).toHaveLength(2);
    expect(formulas.map((item) => item.content).join(" ")).toContain("\\frac{1}{2}");
    expect(formulas.map((item) => item.content).join(" ")).toContain("x^{2}");
  });
});
