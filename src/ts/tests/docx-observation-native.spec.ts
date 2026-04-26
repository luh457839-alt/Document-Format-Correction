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
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdOffice" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rIdApp" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>标题段</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr>
        <w:pStyle w:val="BodyText"/>
        <w:jc w:val="center"/>
        <w:spacing w:line="360"/>
        <w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr>
      </w:pPr>
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
      <w:r><w:footnoteReference w:id="2"/></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>R1C1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>R1C2</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rIdHeader1"/>
      <w:footerReference w:type="default" r:id="rIdFooter1"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  <Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
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
    <w:basedOn w:val="Normal"/>
    <w:rPr>
      <w:rFonts w:ascii="Cambria"/>
      <w:sz w:val="20"/>
      <w:color w:val="00AA00"/>
      <w:i/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="Heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr>
      <w:rFonts w:ascii="Calibri"/>
      <w:sz w:val="32"/>
      <w:b/>
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
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="4">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1."/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="7">
    <w:abstractNumId w:val="4"/>
  </w:num>
</w:numbering>`;
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>页眉文本</w:t></w:r></w:p>
</w:hdr>`;
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t>页脚文本</w:t></w:r></w:p>
</w:ftr>`;
  const footnotes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="2"><w:p><w:r><w:t>脚注文本</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;
  const endnotes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:id="2"><w:p><w:r><w:t>尾注文本</w:t></w:r></w:p></w:endnote>
</w:endnotes>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Parser Test</dc:creator>
  <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
  <cp:revision>9</cp:revision>
  <dcterms:created xsi:type="dcterms:W3CDTF">2026-04-25T10:00:00Z</dcterms:created>
</cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Pages>2</Pages>
</Properties>`;
  const png1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2fQAAAAASUVORK5CYII=",
    "base64"
  );

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rootRels);
  zip.file("word/document.xml", xml);
  zip.file("word/_rels/document.xml.rels", rels);
  zip.file("word/styles.xml", styles);
  zip.file("word/numbering.xml", numbering);
  zip.file("word/header1.xml", header);
  zip.file("word/footer1.xml", footer);
  zip.file("word/footnotes.xml", footnotes);
  zip.file("word/endnotes.xml", endnotes);
  zip.file("docProps/core.xml", core);
  zip.file("docProps/app.xml", app);
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
    expect(state.document_meta.total_paragraphs).toBe(4);
    expect(state.document_meta.total_tables).toBe(1);
    expect(state.package_meta.part_count).toBeGreaterThanOrEqual(11);
    expect(state.package_meta.section_count).toBe(1);
    expect(state.package_meta.header_count).toBe(1);
    expect(state.package_meta.footer_count).toBe(1);
    expect(state.package_meta.footnote_count).toBe(1);
    expect(state.package_meta.endnote_count).toBe(1);
    expect(state.package_meta.media_count).toBe(1);
    expect(state.package_meta.created_by).toBe("Parser Test");
    expect(state.package_meta.modified_by).toBe("Codex");
    expect(state.package_meta.revision).toBe("9");
    expect(state.blocks.some((block) => block.part_path === "word/header1.xml")).toBe(true);
    expect(state.blocks.some((block) => block.part_path === "word/footer1.xml")).toBe(true);
    expect(state.inline_nodes.some((node) => node.part_path === "word/footnotes.xml" && node.text === "脚注文本")).toBe(true);
    expect(state.inline_nodes.some((node) => node.part_path === "word/endnotes.xml" && node.text === "尾注文本")).toBe(true);
    expect(state.structure_index.paragraphs.some((paragraph) => paragraph.role === "heading")).toBe(true);
    expect(state.numbering.instances).toEqual([
      expect.objectContaining({
        num_id: "7",
        abstract_num_id: "4"
      })
    ]);
    expect(state.styles.paragraph_styles.BodyText?.resolved_run.font_name).toBe("Cambria");
    expect(state.styles.paragraph_styles.BodyText?.based_on).toBe("Normal");
    expect(state.patch_targets.some((target) => target.part_path === "word/document.xml")).toBe(true);
    expect(state.nodes[0].node_type).toBe("paragraph");
    expect(state.nodes[2].node_type).toBe("table");

    const paragraphChildren = (state.nodes[1].children as Array<Record<string, unknown>>) ?? [];
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
    expect(style.line_spacing).toBe(1.5);
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
