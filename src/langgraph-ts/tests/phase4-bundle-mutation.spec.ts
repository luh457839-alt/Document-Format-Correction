import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writePhaseOneFixtureDocx } from "./test-fixtures.js";
import { parseDocumentBundle } from "../document-core/parse-document-bundle.js";
import type { ParsedDocumentBundle } from "../contracts/document-contracts.js";
import type { DocxPatchOperation, DocxPatchTarget } from "../document-core/docx-observation-schema.js";
import { applyPatchOperationsToBundle } from "../runtime/bundle-mutation.js";
import { analyzeWriteTarget } from "../tooling/target-resolution.js";
import { compileWriteToolPatchSet } from "../tooling/patch-compilation.js";
import type { WriteToolInput } from "../tooling/contracts.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "langgraph-phase4-mutation-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("phase 4 bundle mutation", () => {
  it("applies inline and paragraph style writes to xml and document truth", async () => {
    const bundle = await createFixtureBundle();
    const inlineTarget = requirePatchTarget(bundle, "target:inline:p_1_r_0");
    const paragraphTarget = requirePatchTarget(bundle, "target:block:p_1");

    const result = applyPatchOperationsToBundle(bundle, [inlineTarget, paragraphTarget], [
      { id: "font", type: "set_attribute", target_id: inlineTarget.id, name: "font_name", value: "Arial" },
      { id: "size", type: "set_attribute", target_id: inlineTarget.id, name: "font_size_pt", value: 14 },
      { id: "bold", type: "set_attribute", target_id: inlineTarget.id, name: "is_bold", value: false },
      { id: "align", type: "set_attribute", target_id: paragraphTarget.id, name: "paragraph_alignment", value: "right" },
      {
        id: "spacing",
        type: "set_attribute",
        target_id: paragraphTarget.id,
        name: "line_spacing",
        value: { mode: "exact", pt: 20 }
      },
      { id: "text", type: "set_text", target_id: inlineTarget.id, value: "Phase4" }
    ]);

    expect(result.changed).toBe(true);
    const documentXml = result.bundle.package_snapshot.parts["word/document.xml"]?.text ?? "";
    expect(documentXml).toMatch(/w:rFonts[^>]*w:ascii="Arial"/);
    expect(documentXml).toMatch(/w:sz[^>]*w:val="28"/);
    expect(documentXml).toMatch(/w:jc[^>]*w:val="right"/);
    expect(documentXml).toMatch(/w:spacing[^>]*w:line="400"[^>]*w:lineRule="exact"/);

    const inline = result.bundle.document_ast.inlineNodes.find((node) => node.id === "p_1_r_0");
    expect(inline?.text).toBe("Phase4");
    expect(inline?.style).toEqual(
      expect.objectContaining({
        fontName: "Arial",
        fontSizePt: 14,
        isBold: false,
        paragraphAlignment: "right",
        lineSpacing: { mode: "exact", pt: 20 }
      })
    );

    const paragraph = result.bundle.structure_index.paragraphMap.p_1;
    expect(paragraph.text).toBe("Phase4212x");
    const astParagraph = result.bundle.document_ast.nodes[1];
    expect(astParagraph.nodeType).toBe("paragraph");
    if (astParagraph.nodeType !== "paragraph") {
      throw new Error("expected paragraph node");
    }
    const firstRun = astParagraph.children.find((child) => child.nodeType === "text_run" && child.id === "p_1_r_0");
    expect(firstRun?.nodeType).toBe("text_run");
    if (!firstRun || firstRun.nodeType !== "text_run") {
      throw new Error("expected first run");
    }
    expect(firstRun.content).toBe("Phase4");
    expect(firstRun.style).toEqual(
      expect.objectContaining({
        fontName: "Arial",
        fontSizePt: 14,
        isBold: false,
        paragraphAlignment: "right",
        lineSpacing: { mode: "exact", pt: 20 }
      })
    );
  });

  it("materializes style, numbering, and settings writes against static targets", async () => {
    const bundle = await createFixtureBundle();

    const styleCompilation = compileForPatchTarget(bundle, {
      request_id: "style-1",
      operation: "set_style_definition",
      target: {
        kind: "patch_targets",
        patch_target_ids: ["target:styles:style:BodyText"],
        patch_part_paths: ["word/styles.xml"]
      },
      payload: { style_definition: { color: "ABCDEF" } }
    });
    const numberingCompilation = compileForPatchTarget(bundle, {
      request_id: "numbering-1",
      operation: "set_numbering_level",
      target: {
        kind: "patch_targets",
        patch_target_ids: ["target:numbering:4:0"],
        patch_part_paths: ["word/numbering.xml"]
      },
      payload: { numbering_level: { lvlText: "%1)" } }
    });
    const settingsCompilation = compileForPatchTarget(bundle, {
      request_id: "settings-1",
      operation: "set_settings_flag",
      target: {
        kind: "patch_targets",
        patch_target_ids: ["target:settings:settings"],
        patch_part_paths: ["word/settings.xml"]
      },
      payload: { settings: { zoom: "bestFit" } }
    });

    const allTargets = [
      ...(styleCompilation.patchSet.targets ?? []),
      ...(numberingCompilation.patchSet.targets ?? []),
      ...(settingsCompilation.patchSet.targets ?? [])
    ];
    const allOperations = [
      ...styleCompilation.patchSet.operations,
      ...numberingCompilation.patchSet.operations,
      ...settingsCompilation.patchSet.operations
    ];

    const result = applyPatchOperationsToBundle(bundle, allTargets, allOperations);

    expect(result.bundle.package_snapshot.parts["word/styles.xml"]?.text).toMatch(/w:color[^>]*w:val="ABCDEF"/);
    expect(result.bundle.document_ast.styles.paragraphStyles.BodyText?.resolvedRun.fontColor).toBe("ABCDEF");
    expect(result.bundle.package_snapshot.parts["word/numbering.xml"]?.text).toMatch(/w:lvlText[^>]*w:val="%1\)"/);
    expect(result.bundle.document_ast.numbering.instances[0]?.levels[0]?.lvlText).toBe("%1)");
    expect(result.bundle.package_snapshot.parts["word/settings.xml"]?.text).toMatch(/<w:zoom[^>]*w:val="bestFit"/);
  });

  it("rejects unresolved generic xml paths instead of silently skipping", async () => {
    const bundle = await createFixtureBundle();
    const inlineTarget = requirePatchTarget(bundle, "target:inline:p_1_r_0");

    expect(() =>
      applyPatchOperationsToBundle(bundle, [inlineTarget], [
        {
          id: "bad-path",
          type: "set_attr",
          target_id: inlineTarget.id,
          path: "/document/body/p[99]/r[0]/t",
          name: "w:val",
          value: "ignored"
        }
      ])
    ).toThrow(/E_PATCH_TARGET_NOT_FOUND|Could not resolve XML path/);
  });
});

async function createFixtureBundle(): Promise<ParsedDocumentBundle> {
  const dir = await makeTempDir();
  const docxPath = path.join(dir, "sample.docx");
  await writePhaseOneFixtureDocx(docxPath);
  return parseDocumentBundle({ docxPath, mediaDir: path.join(dir, "media") });
}

function requirePatchTarget(bundle: ParsedDocumentBundle, targetId: string): DocxPatchTarget {
  const target = (bundle.document_ast.patchTargets as DocxPatchTarget[]).find((entry) => entry.id === targetId);
  if (!target) {
    throw new Error(`Missing patch target ${targetId}`);
  }
  return target;
}

function compileForPatchTarget(bundle: ParsedDocumentBundle, input: WriteToolInput) {
  const analysis = analyzeWriteTarget(bundle, input.target);
  return compileWriteToolPatchSet(bundle, input, analysis);
}
