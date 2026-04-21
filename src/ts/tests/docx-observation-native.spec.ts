import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { DocxObservationTool, parseDocxToState } from "../src/tools/docx-observation-tool.js";
import type { DocumentIR, ToolExecutionInput } from "../src/core/types.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "docx-native-"));
  tempDirs.push(dir);
  return dir;
}

async function writeFixtureDocx(target: string): Promise<void> {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="BodyText"/><w:jc w:val="center"/></w:pPr>
      <w:r>
        <w:rPr>
          <w:rStyle w:val="StrongStyle"/>
          <w:b/>
          <w:color w:val="FF0000"/>
          <w:highlight w:val="yellow"/>
          <w:strike/>
        </w:rPr>
        <w:t>Hello</w:t>
      </w:r>
      <w:r>
        <w:drawing>
          <wp:inline>
            <wp:extent cx="952500" cy="1905000"/>
            <a:graphic>
              <a:graphicData>
                <a:blip r:embed="rId1"/>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
      <w:r>
        <m:oMath>
          <m:f>
            <m:num><m:r><m:t>1</m:t></m:r></m:num>
            <m:den><m:r><m:t>2</m:t></m:r></m:den>
          </m:f>
        </m:oMath>
      </w:r>
      <w:r>
        <m:oMath>
          <m:sSup>
            <m:e><m:r><m:t>x</m:t></m:r></m:e>
            <m:sup><m:r><m:t>2</m:t></m:r></m:sup>
          </m:sSup>
        </m:oMath>
      </w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>R1C1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>R1C2</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri"/>
        <w:sz w:val="24"/>
        <w:color w:val="0000FF"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr>
      <w:rFonts w:ascii="Times New Roman"/>
      <w:sz w:val="22"/>
      <w:color w:val="111111"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="BodyText">
    <w:name w:val="Body Text"/>
    <w:rPr>
      <w:rFonts w:ascii="Cambria"/>
      <w:sz w:val="20"/>
      <w:color w:val="00AA00"/>
      <w:i/>
    </w:rPr>
  </w:style>
  <w:style w:type="character" w:styleId="StrongStyle">
    <w:name w:val="Strong"/>
    <w:rPr>
      <w:rFonts w:ascii="Consolas"/>
      <w:sz w:val="26"/>
      <w:caps/>
      <w:u w:val="single"/>
    </w:rPr>
  </w:style>
</w:styles>`;
  const png1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2fQAAAAASUVORK5CYII=",
    "base64"
  );

  const zip = new JSZip();
  zip.file("word/document.xml", xml);
  zip.file("word/_rels/document.xml.rels", rels);
  zip.file("word/styles.xml", styles);
  zip.file("word/media/image1.png", png1x1);
  const data = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(target, data);
}

describe("native docx observation parser", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("parses images to exported files, formulas to latex, and richer style fields", async () => {
    const dir = await makeTempDir();
    const docxPath = path.join(dir, "sample.docx");
    const mediaDir = path.join(dir, "media-out");
    await writeFixtureDocx(docxPath);

    const state = await parseDocxToState({ docxPath, mediaDir, allowFallback: false });
    expect(state.document_meta.total_paragraphs).toBe(3);
    expect(state.document_meta.total_tables).toBe(1);
    expect(state.nodes[0].node_type).toBe("paragraph");
    expect(state.nodes[1].node_type).toBe("table");

    const paragraphChildren = (state.nodes[0].children as Array<Record<string, unknown>>) ?? [];
    const textRun = paragraphChildren.find((item) => item.node_type === "text_run");
    expect(textRun).toBeDefined();
    const style = (textRun?.style ?? {}) as Record<string, unknown>;
    expect(style.font_name).toBe("Consolas");
    expect(style.font_size_pt).toBe(13);
    expect(style.font_color).toBe("FF0000");
    expect(style.is_bold).toBe(true);
    expect(style.is_italic).toBe(true);
    expect(style.is_underline).toBe(true);
    expect(style.is_strike).toBe(true);
    expect(style.highlight_color).toBe("yellow");
    expect(style.is_all_caps).toBe(true);
    expect(style.paragraph_alignment).toBe("center");

    const imageNode = paragraphChildren.find((item) => item.node_type === "image");
    expect(imageNode).toBeDefined();
    const src = String(imageNode?.src ?? "");
    expect(path.isAbsolute(src)).toBe(true);
    await expect(access(src, fsConstants.R_OK)).resolves.toBeUndefined();
    expect((imageNode?.size as Record<string, unknown>).width).toBe(100);
    expect((imageNode?.size as Record<string, unknown>).height).toBe(200);

    const formulaNodes = paragraphChildren.filter((item) => item.node_type === "formula");
    expect(formulaNodes).toHaveLength(2);
    const latex = formulaNodes.map((item) => String(item.content ?? "")).join(" ");
    expect(formulaNodes.every((item) => item.format === "latex")).toBe(true);
    expect(latex).toContain("\\frac{1}{2}");
    expect(latex).toContain("x^{2}");
  });

  it("docx tool falls back by default when source missing", async () => {
    const tool = new DocxObservationTool();
    const input: ToolExecutionInput = {
      doc: {
        id: "doc",
        version: "v1",
        nodes: []
      } as DocumentIR,
      operation: {
        id: "op",
        type: "set_font",
        targetNodeId: "n1",
        payload: { docxPath: "missing.docx" }
      },
      context: {
        taskId: "t1",
        stepId: "s1",
        dryRun: false
      }
    };

    const output = await tool.execute(input);
    const observation = output.doc.metadata?.docxObservation as Record<string, unknown>;
    const meta = observation.document_meta as Record<string, unknown>;
    expect(String(meta.warning ?? "")).toContain("fallback");
  });
});
