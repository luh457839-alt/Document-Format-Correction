import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writePhaseOneFixtureDocx } from "./test-fixtures.js";
import { parseDocumentBundle } from "../document-core/parse-document-bundle.js";
import type { ParsedDocumentBundle } from "../contracts/document-contracts.js";
import type { DocxPatchTarget } from "../document-core/docx-observation-schema.js";
import { parseWriteToolInput } from "../tooling/schema.js";
import { analyzeWriteTarget } from "../tooling/target-resolution.js";
import { compileWriteToolPatchSet } from "../tooling/patch-compilation.js";
import { executeWriteTool } from "../tooling/write-tool.js";
import {
  createAmbiguousSemanticBundle,
  createLowConfidenceSemanticBundle,
  createSemanticHeadingBundle,
  createSemanticProjectionBundle,
  createUnderdeterminedBaselineBundle
} from "./semantic-fixtures.js";

let tempDir = "";
let bundle: ParsedDocumentBundle;

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "langgraph-phase2-"));
  const docxPath = path.join(tempDir, "sample.docx");
  await writePhaseOneFixtureDocx(docxPath);
  bundle = await parseDocumentBundle({ docxPath, mediaDir: path.join(tempDir, "media") });
});

afterAll(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("phase 2 write tool schema", () => {
  it("rejects shallow-invalid input and mixed target shapes", () => {
    const missingRequestId = parseWriteToolInput({
      operation: "set_font",
      target: { kind: "selector", selector: { scope: "body" } },
      payload: { font_name: "Arial" }
    });
    expect(missingRequestId.ok).toBe(false);
    if (missingRequestId.ok) {
      throw new Error("expected validation failure");
    }
    expect(missingRequestId.stage).toBe("target");
    expect(missingRequestId.error_code).toBe("E_TOOL_INPUT_INVALID");

    const mixedTarget = parseWriteToolInput({
      request_id: "req-mixed",
      operation: "set_font",
      target: {
        kind: "selector",
        selector: { scope: "body" },
        node_ids: ["p_1_r_0"]
      },
      payload: { font_name: "Arial" }
    });
    expect(mixedTarget.ok).toBe(false);
    if (mixedTarget.ok) {
      throw new Error("expected validation failure");
    }
    expect(mixedTarget.error_code).toBe("E_TOOL_INPUT_INVALID");
  });
});

describe("phase 2 write target resolution", () => {
  it("analyzes selector scopes against the parsed bundle", () => {
    const headingParagraphs = bundle.structure_index.paragraphs.filter((paragraph) => paragraph.role === "heading");
    const bodyParagraphs = bundle.structure_index.paragraphs.filter((paragraph) => paragraph.role === "body");
    const listParagraphs = bundle.structure_index.paragraphs.filter((paragraph) => paragraph.role === "list_item");
    const allRunIds = unique(bundle.structure_index.paragraphs.flatMap((paragraph) => paragraph.runIds));

    const headingAnalysis = analyzeWriteTarget(bundle, {
      kind: "selector",
      selector: { scope: "heading" }
    });
    expect(headingAnalysis.matched_paragraph_ids).toEqual(headingParagraphs.map((paragraph) => paragraph.id));
    expect(headingAnalysis.target_node_ids).toEqual(headingParagraphs.flatMap((paragraph) => paragraph.runIds));

    const bodyAnalysis = analyzeWriteTarget(bundle, {
      kind: "selector",
      selector: { scope: "body" }
    });
    expect(bodyAnalysis.matched_paragraph_ids).toEqual(bodyParagraphs.map((paragraph) => paragraph.id));
    expect(bodyAnalysis.patch_part_paths).toEqual(unique(bodyParagraphs.map((paragraph) => paragraph.partPath ?? "word/document.xml")));

    const listAnalysis = analyzeWriteTarget(bundle, {
      kind: "selector",
      selector: { scope: "list_item" }
    });
    expect(listAnalysis.matched_paragraph_ids).toEqual(listParagraphs.map((paragraph) => paragraph.id));

    const paragraphIds = bundle.structure_index.paragraphs.slice(0, 2).map((paragraph) => paragraph.id);
    const paragraphIdAnalysis = analyzeWriteTarget(bundle, {
      kind: "selector",
      selector: { scope: "paragraph_ids", paragraphIds }
    });
    expect(paragraphIdAnalysis.matched_paragraph_ids).toEqual(paragraphIds);
    expect(paragraphIdAnalysis.patch_target_ids).toEqual(
      bundle.structure_index.paragraphs
        .filter((paragraph) => paragraphIds.includes(paragraph.id))
        .flatMap((paragraph) => paragraph.runIds.map((runId) => `target:inline:${runId}`))
    );

    const allTextAnalysis = analyzeWriteTarget(bundle, {
      kind: "selector",
      selector: { scope: "all_text" }
    });
    expect(allTextAnalysis.target_node_ids).toEqual(allRunIds);
    expect(allTextAnalysis.patch_target_ids).toEqual(allRunIds.map((runId) => `target:inline:${runId}`));
  });
});

describe("phase 2 patch compilation", () => {
  it("compiles stable patch targets with correct part paths and target counts", () => {
    const firstParagraph = bundle.structure_index.paragraphs.find((paragraph) => paragraph.runIds.length > 0);
    expect(firstParagraph).toBeDefined();
    if (!firstParagraph) {
      throw new Error("expected a paragraph with writable runs");
    }

    const compilation = compileWriteToolPatchSet(
      bundle,
      {
        request_id: "compile-1",
        operation: "set_font",
        target: { kind: "node_ids", node_ids: firstParagraph.runIds },
        payload: { font_name: "Arial" }
      },
      analyzeWriteTarget(bundle, { kind: "node_ids", node_ids: firstParagraph.runIds })
    );

    expect(compilation.patchTargetIds).toEqual(firstParagraph.runIds.map((runId) => `target:inline:${runId}`));
    expect(compilation.partPaths).toEqual([firstParagraph.partPath ?? "word/document.xml"]);
    expect(compilation.targetCount).toBe(firstParagraph.runIds.length);
    expect(compilation.patchSet.operations).toHaveLength(firstParagraph.runIds.length);
  });
});

describe("phase 2 write tool execution", () => {
  it("returns structured validation failures for deep validation", () => {
    const firstWritableParagraph = bundle.structure_index.paragraphs.find((paragraph) => paragraph.runIds.length > 0);
    expect(firstWritableParagraph).toBeDefined();
    if (!firstWritableParagraph) {
      throw new Error("expected writable paragraph");
    }

    const missingNodeResult = executeWriteTool(bundle, {
      request_id: "missing-node",
      operation: "set_font",
      target: { kind: "node_ids", node_ids: ["missing_run"] },
      payload: { font_name: "Arial" }
    });
    expect(missingNodeResult.ok).toBe(false);
    if (missingNodeResult.ok) {
      throw new Error("expected validation failure");
    }
    expect(missingNodeResult.stage).toBe("target");

    const missingPatchTargetResult = executeWriteTool(bundle, {
      request_id: "missing-patch-target",
      operation: "set_text",
      target: {
        kind: "patch_targets",
        patch_target_ids: ["target:inline:missing_run"],
        patch_part_paths: ["word/document.xml"]
      },
      payload: { value: "updated text" }
    });
    expect(missingPatchTargetResult.ok).toBe(false);
    if (missingPatchTargetResult.ok) {
      throw new Error("expected validation failure");
    }
    expect(missingPatchTargetResult.stage).toBe("target");
    expect(missingPatchTargetResult.error_code).toBe("E_PATCH_TARGET_NOT_FOUND");

    const emptyPayloadResult = executeWriteTool(bundle, {
      request_id: "empty-payload",
      operation: "set_font",
      target: { kind: "node_ids", node_ids: [firstWritableParagraph.runIds[0]] },
      payload: {}
    });
    expect(emptyPayloadResult.ok).toBe(false);
    if (emptyPayloadResult.ok) {
      throw new Error("expected validation failure");
    }
    expect(emptyPayloadResult.stage).toBe("payload");

    const incompatibleTargetResult = executeWriteTool(bundle, {
      request_id: "incompatible-target",
      operation: "set_style_definition",
      target: { kind: "node_ids", node_ids: [firstWritableParagraph.runIds[0]] },
      payload: { style_definition: { color: "FF0000" } }
    });
    expect(incompatibleTargetResult.ok).toBe(false);
    if (incompatibleTargetResult.ok) {
      throw new Error("expected validation failure");
    }
    expect(incompatibleTargetResult.stage).toBe("compatibility");

    const compileFailureResult = executeWriteTool(bundle, {
      request_id: "compile-failure",
      operation: "merge_paragraph",
      target: { kind: "node_ids", node_ids: [firstWritableParagraph.runIds[0]] },
      payload: {}
    });
    expect(compileFailureResult.ok).toBe(false);
    if (compileFailureResult.ok) {
      throw new Error("expected validation failure");
    }
    expect(compileFailureResult.stage).toBe("compile");

  });

  it("returns structured execution results and idempotent skips", () => {
    const patchTarget = (bundle.document_ast.patchTargets as DocxPatchTarget[]).find(
      (target) => target.id.startsWith("target:inline:")
    );
    expect(patchTarget).toBeDefined();
    if (!patchTarget) {
      throw new Error("expected inline patch target");
    }

    const firstResult = executeWriteTool(bundle, {
      request_id: "exec-1",
      operation: "set_text",
      target: {
        kind: "patch_targets",
        patch_target_ids: [patchTarget.id],
        patch_part_paths: [patchTarget.part_path]
      },
      payload: { value: "updated text" }
    });

    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) {
      throw new Error("expected successful execution");
    }
    expect(firstResult.executed).toBe(true);
    expect(firstResult.patch_target_ids).toEqual([patchTarget.id]);
    expect(firstResult.patch_part_paths).toEqual([patchTarget.part_path]);
    expect(firstResult.target_count).toBe(1);
    expect(firstResult.idempotency_key).toBeTruthy();

    const skippedResult = executeWriteTool(
      bundle,
      {
        request_id: "exec-1",
        operation: "set_text",
        target: {
          kind: "patch_targets",
          patch_target_ids: [patchTarget.id],
          patch_part_paths: [patchTarget.part_path]
        },
        payload: { value: "updated text" }
      },
      { executed_patch_keys: [firstResult.idempotency_key ?? ""] }
    );

    expect(skippedResult.ok).toBe(true);
    if (!skippedResult.ok) {
      throw new Error("expected idempotent skip");
    }
    expect(skippedResult.executed).toBe(false);
    expect(skippedResult.summary).toContain("Skipped");
    expect(skippedResult.skip_reason).toBe("idempotency_hit");

    const replayedResult = executeWriteTool(
      bundle,
      {
        request_id: "exec-1",
        operation: "set_text",
        target: {
          kind: "patch_targets",
          patch_target_ids: [patchTarget.id],
          patch_part_paths: [patchTarget.part_path]
        },
        payload: { value: "updated text" },
        idempotency_key: "manual-replay"
      },
      { executed_patch_keys: [firstResult.idempotency_key ?? ""] }
    );

    expect(replayedResult.ok).toBe(true);
    if (!replayedResult.ok) {
      throw new Error("expected successful replay");
    }
    expect(replayedResult.executed).toBe(true);
    expect(replayedResult.idempotency_key).toBe("manual-replay");
  });

  it("accepts stable synthetic static patch targets for phase 4 config writes", () => {
    const result = executeWriteTool(bundle, {
      request_id: "settings-static",
      operation: "set_settings_flag",
      target: {
        kind: "patch_targets",
        patch_target_ids: ["target:settings:settings"],
        patch_part_paths: ["word/settings.xml"]
      },
      payload: { settings: { zoom: "bestFit" } }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected synthetic static target to pass validation");
    }
    expect(result.executed).toBe(true);
    expect(result.patch_target_ids).toEqual(["target:settings:settings"]);
    expect(result.patch_part_paths).toEqual(["word/settings.xml"]);
    expect(result.target_count).toBe(1);
  });

  it("identifies title-like paragraphs even when heading structure and body style are identical", () => {
    const semanticBundle = createSemanticProjectionBundle();
    const result = executeWriteTool(semanticBundle, {
      request_id: "semantic-title-baseline",
      operation: "set_font",
      target: { kind: "semantic_selector", semantic: "title_like_paragraphs" },
      payload: {
        baseline_from_semantic: "body_like_paragraphs",
        sync_fields: ["font_name", "font_size_pt", "is_bold", "is_italic"]
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected semantic title alignment success");
    }
    expect(result.executed).toBe(true);
    expect(result.patch_target_ids).toEqual(["target:inline:r_title_same_style"]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semantic_selector: "title_like_paragraphs",
          semantic_target_paragraph_ids: ["p_title_same_style"],
          body_baseline_source_paragraph_ids: expect.arrayContaining(["p_body_1", "p_body_2"]),
          applied_fields: ["font_name", "font_size_pt", "is_bold", "is_italic"]
        })
      ])
    );
  });

  it("accepts semantic_heading as a constrained merged semantic selector", () => {
    const semanticBundle = createSemanticHeadingBundle();
    const result = executeWriteTool(semanticBundle, {
      request_id: "semantic-heading-baseline",
      operation: "set_font",
      target: { kind: "semantic_selector", semantic: "semantic_heading" },
      payload: {
        baseline_from_semantic: "body_like_paragraphs",
        sync_fields: ["font_name", "font_size_pt", "paragraph_alignment"]
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected semantic heading success");
    }
    expect(result.executed).toBe(true);
    expect(result.patch_target_ids).toEqual(["target:block:p_heading_structural"]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semantic_selector: "semantic_heading",
          semantic_target_paragraph_ids: ["p_heading_structural"],
          applied_fields: ["font_name", "font_size_pt", "paragraph_alignment"]
        })
      ])
    );
  });

  it("compiles semantic baseline alignment into font-only patch operations", () => {
    const semanticBundle = createSemanticProjectionBundle();
    const input = {
      request_id: "semantic-compile-font-only",
      operation: "set_font",
      target: { kind: "semantic_selector", semantic: "title_like_paragraphs" } as const,
      payload: {
        baseline_from_semantic: "body_like_paragraphs",
        sync_fields: ["font_name", "font_size_pt", "is_bold", "is_italic"]
      }
    };

    const analysis = analyzeWriteTarget(semanticBundle, input.target);
    const compilation = compileWriteToolPatchSet(semanticBundle, input, analysis);

    expect(compilation.patchTargetIds).toEqual(["target:inline:r_title_same_style"]);
    expect(compilation.patchSet.operations.map((operation) => operation.name)).toEqual(
      expect.arrayContaining(["font_name", "font_size_pt", "is_bold"])
    );
    expect(compilation.patchSet.operations.map((operation) => operation.name)).not.toEqual(
      expect.arrayContaining(["paragraph_alignment", "line_spacing", "space_before_pt", "first_line_indent_pt"])
    );
  });

  it("compiles explicitly requested constrained semantic paragraph fields without leaking structure fields", () => {
    const semanticBundle = createSemanticHeadingBundle();
    const input = {
      request_id: "semantic-compile-constrained-fields",
      operation: "set_alignment",
      target: { kind: "semantic_selector", semantic: "semantic_heading" } as const,
      payload: {
        baseline_from_semantic: "body_like_paragraphs",
        sync_fields: ["paragraph_alignment", "line_spacing", "font_name"]
      }
    };

    const analysis = analyzeWriteTarget(semanticBundle, input.target, input.payload);
    const compilation = compileWriteToolPatchSet(semanticBundle, input, analysis);

    expect(compilation.patchTargetIds).toEqual(["target:block:p_heading_structural"]);
    expect(compilation.patchSet.operations.map((operation) => operation.name)).toEqual(
      expect.arrayContaining(["paragraph_alignment", "line_spacing", "font_name"])
    );
    expect(compilation.patchSet.operations.map((operation) => operation.name)).not.toEqual(
      expect.arrayContaining(["space_before_pt", "space_after_pt", "first_line_indent_pt"])
    );
  });

  it("returns low-confidence, ambiguous, and baseline-underdetermined semantic failures", () => {
    const lowConfidenceResult = executeWriteTool(createLowConfidenceSemanticBundle(), {
      request_id: "semantic-low-confidence",
      operation: "set_font",
      target: { kind: "semantic_selector", semantic: "title_like_paragraphs" },
      payload: {
        baseline_from_semantic: "body_like_paragraphs",
        sync_fields: ["font_name"]
      }
    });
    expect(lowConfidenceResult.ok).toBe(false);
    if (lowConfidenceResult.ok) {
      throw new Error("expected low-confidence semantic failure");
    }
    expect(lowConfidenceResult.error_code).toBe("E_SEMANTIC_TARGET_LOW_CONFIDENCE");

    const ambiguousResult = executeWriteTool(createAmbiguousSemanticBundle(), {
      request_id: "semantic-ambiguous",
      operation: "set_font",
      target: { kind: "semantic_selector", semantic: "title_like_paragraphs" },
      payload: {
        baseline_from_semantic: "body_like_paragraphs",
        sync_fields: ["font_name"]
      }
    });
    expect(ambiguousResult.ok).toBe(false);
    if (ambiguousResult.ok) {
      throw new Error("expected ambiguous semantic failure");
    }
    expect(ambiguousResult.error_code).toBe("E_SEMANTIC_TARGET_AMBIGUOUS");

    const baselineResult = executeWriteTool(createUnderdeterminedBaselineBundle(), {
      request_id: "semantic-baseline-underdetermined",
      operation: "set_font",
      target: { kind: "semantic_selector", semantic: "title_like_paragraphs" },
      payload: {
        baseline_from_semantic: "body_like_paragraphs",
        sync_fields: ["font_name"]
      }
    });
    expect(baselineResult.ok).toBe(false);
    if (baselineResult.ok) {
      throw new Error("expected baseline-underdetermined failure");
    }
    expect(baselineResult.error_code).toBe("E_BODY_BASELINE_UNDERDETERMINED");
  });

  it("preserves deep-validation semantic equivalence for target existence, writability, empty payload, compatibility, and compile safety", () => {
    const semanticBundle = createSemanticProjectionBundle();

    const emptySemanticPayload = executeWriteTool(semanticBundle, {
      request_id: "semantic-empty-payload",
      operation: "set_font",
      target: { kind: "semantic_selector", semantic: "title_like_paragraphs" },
      payload: {}
    });
    expect(emptySemanticPayload.ok).toBe(false);
    if (emptySemanticPayload.ok) {
      throw new Error("expected payload validation failure");
    }
    expect(emptySemanticPayload.stage).toBe("payload");

    const incompatibleSemanticTarget = executeWriteTool(semanticBundle, {
      request_id: "semantic-incompatible-target",
      operation: "set_style_definition",
      target: { kind: "semantic_selector", semantic: "title_like_paragraphs" },
      payload: {
        baseline_from_semantic: "body_like_paragraphs",
        sync_fields: ["font_name"],
        style_definition: { color: "FF0000" }
      }
    });
    expect(incompatibleSemanticTarget.ok).toBe(false);
    if (incompatibleSemanticTarget.ok) {
      throw new Error("expected compatibility validation failure");
    }
    expect(incompatibleSemanticTarget.stage).toBe("compatibility");

    const unwriteableSemanticBundle = createSemanticProjectionBundle();
    unwriteableSemanticBundle.structure_index.paragraphMap.p_title_same_style.runIds = [];
    unwriteableSemanticBundle.structure_index.paragraphs = unwriteableSemanticBundle.structure_index.paragraphs.map((paragraph) =>
      paragraph.id === "p_title_same_style" ? { ...paragraph, runIds: [] } : paragraph
    );
    const unwritableResult = executeWriteTool(unwriteableSemanticBundle, {
      request_id: "semantic-unwritable",
      operation: "set_font",
      target: { kind: "semantic_selector", semantic: "title_like_paragraphs" },
      payload: {
        baseline_from_semantic: "body_like_paragraphs",
        sync_fields: ["font_name"]
      }
    });
    expect(unwritableResult.ok).toBe(false);
    if (unwritableResult.ok) {
      throw new Error("expected unwritable failure");
    }
    expect(unwritableResult.error_code).toBe("E_TARGET_NOT_WRITABLE");

    const compileUnsafe = executeWriteTool(semanticBundle, {
      request_id: "semantic-compile-unsafe",
      operation: "merge_paragraph",
      target: { kind: "semantic_selector", semantic: "title_like_paragraphs" },
      payload: {
        baseline_from_semantic: "body_like_paragraphs",
        sync_fields: ["font_name"]
      }
    });
    expect(compileUnsafe.ok).toBe(false);
    if (compileUnsafe.ok) {
      throw new Error("expected compile safety failure");
    }
    expect(compileUnsafe.stage).toBe("compile");
  });
});
