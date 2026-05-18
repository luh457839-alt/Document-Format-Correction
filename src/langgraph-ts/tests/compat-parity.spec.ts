import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocumentBundle } from "../document-core/parse-document-bundle.js";
import { buildTemplateProjection } from "../projections/build-template-projection.js";
import { bundleToLegacyObservation } from "../compat/legacy-observation-adapter.js";
import { writePhaseOneFixtureDocx } from "./test-fixtures.js";
import { createSemanticProjectionBundle } from "./semantic-fixtures.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "langgraph-phase1-parity-"));
  tempDirs.push(dir);
  return dir;
}

describe("phase 1 parity adapters", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("keeps key structure and template-classification fields aligned with legacy-compatible output", async () => {
    const dir = await makeTempDir();
    const docxPath = path.join(dir, "sample.docx");
    await writePhaseOneFixtureDocx(docxPath);

    const bundle = await parseDocumentBundle({ docxPath, mediaDir: path.join(dir, "media") });
    const legacyObservation = bundleToLegacyObservation(bundle);
    const templateProjection = buildTemplateProjection(bundle, { localContextWindow: 1 });

    expect(legacyObservation.package_model.package_meta.part_count).toBe(bundle.document_package.packageMeta.partCount);
    expect(legacyObservation.structure_index.paragraphs).toHaveLength(bundle.structure_index.paragraphs.length);
    expect(legacyObservation.structure_index.role_counts).toEqual(bundle.structure_index.roleCounts);
    expect(legacyObservation.document_meta.total_tables).toBe(bundle.document_ast.documentMeta.totalTables);

    const templateParagraph = templateProjection.paragraphs.find((paragraph) => paragraph.imageCount > 0);
    expect(templateParagraph).toBeDefined();
    expect(templateParagraph?.bucketType).toBe("list_item");
    expect(templateParagraph?.localContext.before[0]?.text).toContain("标题段");
    expect(templateProjection.evidenceSummary.numberingPatterns).toContain("1.");
  });

  it("keeps semantic feature projection aligned with legacy-compatible structure fields", () => {
    const bundle = createSemanticProjectionBundle();
    const legacyObservation = bundleToLegacyObservation(bundle);
    const templateProjection = buildTemplateProjection(bundle, { localContextWindow: 2, includeSemanticFeatures: true });

    const paragraph = templateProjection.paragraphs.find((entry) => entry.paragraphId === "p_title_same_style");
    expect(paragraph).toBeDefined();
    expect(paragraph?.bucketType).toBe("body");
    expect(paragraph?.localContext.before[0]?.paragraphId).toBe(legacyObservation.structure_index.paragraphs[0]?.id);
    expect(paragraph?.numberingPattern).toBe("一、");
    expect(paragraph?.hasImageEvidence).toBe(false);
    expect(templateProjection.evidenceSummary.imageParagraphCount).toBe(
      legacyObservation.inline_nodes.filter((node) => node.node_type === "image").length
    );
  });
});
