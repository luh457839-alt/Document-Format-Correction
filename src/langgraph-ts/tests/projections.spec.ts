import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocumentBundle } from "../document-core/parse-document-bundle.js";
import { buildChatProjection } from "../projections/build-chat-projection.js";
import { buildTemplateProjection } from "../projections/build-template-projection.js";
import { writePhaseOneFixtureDocx } from "./test-fixtures.js";
import { createProjectionBudgetStressBundle, createSemanticProjectionBundle } from "./semantic-fixtures.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "langgraph-phase1-proj-"));
  tempDirs.push(dir);
  return dir;
}

describe("phase 1 projections", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("builds separate chat and template projections from the same bundle", async () => {
    const dir = await makeTempDir();
    const docxPath = path.join(dir, "sample.docx");
    await writePhaseOneFixtureDocx(docxPath);

    const bundle = await parseDocumentBundle({ docxPath, mediaDir: path.join(dir, "media") });
    const originalAst = structuredClone(bundle.document_ast);

    const chatProjection = buildChatProjection(bundle);
    const templateProjection = buildTemplateProjection(bundle, { localContextWindow: 1 });

    expect(chatProjection.paragraphs).toHaveLength(bundle.structure_index.paragraphs.length);
    expect(chatProjection.emphasisRuns.some((run) => run.emphasisFlags.isBold)).toBe(true);
    expect(chatProjection.nodes.every((node) => node.nodeType === "paragraph")).toBe(true);

    expect(templateProjection.paragraphs).toHaveLength(bundle.structure_index.paragraphs.length);
    expect(templateProjection.paragraphs[0].bucketType).toBe("heading");
    expect(templateProjection.paragraphs.some((paragraph) => paragraph.imageCount > 0)).toBe(true);
    expect(templateProjection.paragraphs.some((paragraph) => paragraph.localContext.before.length === 1)).toBe(true);
    expect(templateProjection.evidenceSummary.imageCount).toBe(1);
    expect(templateProjection.evidenceSummary.styleNameCounts["Body Text"]).toBe(1);

    expect(bundle.document_ast).toEqual(originalAst);
  });

  it("marks chat focus hits and exports semantic template features without mutating ast", () => {
    const bundle = createSemanticProjectionBundle();
    const originalAst = structuredClone(bundle.document_ast);

    const chatProjection = buildChatProjection(bundle, { focusRegexProbe: "总体要求" });
    const templateProjection = buildTemplateProjection(bundle, {
      localContextWindow: 2,
      includeSemanticFeatures: true
    });

    const focusParagraph = chatProjection.paragraphs.find((paragraph) => paragraph.paragraphId === "p_title_same_style");
    const neighborParagraph = chatProjection.paragraphs.find((paragraph) => paragraph.paragraphId === "p_body_1");
    const backgroundParagraph = chatProjection.paragraphs.find((paragraph) => paragraph.paragraphId === "p_emphasis");

    expect(chatProjection.nodes.every((node) => typeof node.id === "string" && node.id.length > 0)).toBe(true);
    expect(focusParagraph?.focusPriority).toBe("regex_hit");
    expect(neighborParagraph?.focusPriority).toBe("regex_neighbor");
    expect(backgroundParagraph?.focusPriority).toBe("background");

    const titleLike = templateProjection.paragraphs.find((paragraph) => paragraph.paragraphId === "p_title_same_style");
    const imageLike = templateProjection.paragraphs.find((paragraph) => paragraph.paragraphId === "p_image");

    expect(titleLike?.numberingPattern).toBe("一、");
    expect(titleLike?.isShortText).toBe(true);
    expect(titleLike?.visualSignals.isStandaloneLine).toBe(true);
    expect(titleLike?.visualSignals.isCentered).toBe(false);
    expect(titleLike?.runStyleSummary.fontName).toBe("SimSun");
    expect(titleLike?.localContext.before).toHaveLength(2);
    expect(imageLike?.isImageDominant).toBe(true);
    expect(templateProjection.evidenceSummary.numberingPatterns).toContain("一、");

    expect(bundle.document_ast).toEqual(originalAst);
  });

  it("degrades chat projection in a fixed order while preserving focus traceability", () => {
    const bundle = createProjectionBudgetStressBundle();

    const chatProjection = buildChatProjection(bundle, {
      focusRegexProbe: "预算测试",
      textBudget: 160,
      emphasisLimit: 8,
      neighborWindow: 2,
      minNeighborWindow: 0,
      backgroundPreviewLength: 40,
      minBackgroundPreviewLength: 12
    });

    expect(chatProjection.diagnostics.budgetStatus).toBe("fit");
    expect(chatProjection.diagnostics.degradationSteps).toEqual([
      "compress_background_text",
      "shrink_neighbor_window",
      "truncate_emphasis_runs",
      "shrink_node_text"
    ]);
    expect(chatProjection.diagnostics.estimatedChars).toBeLessThanOrEqual(160);
    expect(chatProjection.paragraphs.find((entry) => entry.paragraphId === "p_focus_title")?.focusPriority).toBe("regex_hit");
    expect(chatProjection.traceability.paragraphIds).toContain("p_focus_title");
    expect(chatProjection.nodes.every((node) => typeof node.id === "string" && node.id.length > 0)).toBe(true);
  });

  it("batches template projection under budget without dropping classifier-required fields", () => {
    const bundle = createProjectionBudgetStressBundle();

    const templateProjection = buildTemplateProjection(bundle, {
      localContextWindow: 2,
      includeSemanticFeatures: true,
      textBudget: 220,
      minLocalContextWindow: 0,
      maxBatchBudget: 140
    });

    expect(templateProjection.diagnostics.budgetStatus).toBe("fit");
    expect(templateProjection.diagnostics.degradationSteps).toEqual([
      "shrink_local_context_window",
      "merge_background_paragraphs",
      "split_batches"
    ]);
    expect(templateProjection.batches.length).toBeGreaterThan(1);
    expect(templateProjection.batches.flatMap((batch) => batch.paragraphs.map((paragraph) => paragraph.paragraphId))).toEqual(
      templateProjection.paragraphs.map((paragraph) => paragraph.paragraphId)
    );
    expect(
      templateProjection.batches.every((batch) =>
        batch.paragraphs.every(
          (paragraph) =>
            typeof paragraph.bucketType === "string" &&
            typeof paragraph.paragraphIndex === "number" &&
            typeof paragraph.isImageDominant === "boolean" &&
            Array.isArray(paragraph.localContext.before) &&
            Array.isArray(paragraph.localContext.after)
        )
      )
    ).toBe(true);
  });

  it("fails fast when template projection cannot preserve required fields under impossible budget", () => {
    const bundle = createProjectionBudgetStressBundle();

    expect(() =>
      buildTemplateProjection(bundle, {
        localContextWindow: 1,
        includeSemanticFeatures: true,
        textBudget: 18,
        maxBatchBudget: 18,
        minLocalContextWindow: 0
      })
    ).toThrow(/E_TEMPLATE_PROJECTION_BUDGET_EXCEEDED/);
  });

  it("keeps chat/template projection diagnostics aligned for the same budget intent", () => {
    const bundle = createProjectionBudgetStressBundle();

    const chatProjection = buildChatProjection(bundle, {
      focusRegexProbe: "预算测试",
      textBudget: 160,
      neighborWindow: 2,
      emphasisLimit: 8,
      minNeighborWindow: 0,
      backgroundPreviewLength: 40,
      minBackgroundPreviewLength: 12
    });
    const templateProjection = buildTemplateProjection(bundle, {
      localContextWindow: 2,
      includeSemanticFeatures: true,
      textBudget: 220,
      minLocalContextWindow: 0,
      maxBatchBudget: 140
    });

    expect(chatProjection.diagnostics.budgetStatus).toBe("fit");
    expect(templateProjection.diagnostics.budgetStatus).toBe("fit");
    expect(chatProjection.traceability.paragraphIds).toEqual(bundle.structure_index.paragraphs.map((paragraph) => paragraph.id));
    expect(templateProjection.batches.flatMap((batch) => batch.paragraphIds)).toEqual(
      bundle.structure_index.paragraphs.map((paragraph) => paragraph.id)
    );
    expect(chatProjection.paragraphs.map((paragraph) => paragraph.paragraphId)).toEqual(
      templateProjection.paragraphs.map((paragraph) => paragraph.paragraphId)
    );
  });
});
