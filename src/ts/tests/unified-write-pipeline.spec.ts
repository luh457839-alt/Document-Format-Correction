import { describe, expect, it } from "vitest";
import { AgentError } from "../src/core/errors.js";
import type { DocumentIR, Operation, WriteIntent } from "../src/index.js";
import {
  analyzeWriteTargetSpec,
  operationToWriteIntent,
  prepareWriteIntents
} from "../src/document-execution/unified-write-pipeline.js";

const doc: DocumentIR = {
  id: "doc1",
  version: "v1",
  nodes: [
    { id: "p_0_r_0", text: "标题" },
    { id: "p_1_r_0", text: "第一段" },
    { id: "p_1_r_1", text: "正文" },
    { id: "p_2_r_0", text: "第二段正文" }
  ],
  metadata: {
    structureIndex: {
      paragraphs: [
        { id: "p_0", role: "heading", headingLevel: 1, runNodeIds: ["p_0_r_0"] },
        { id: "p_1", role: "body", runNodeIds: ["p_1_r_0", "p_1_r_1"] },
        { id: "p_2", role: "body", runNodeIds: ["p_2_r_0"] }
      ],
      roleCounts: { heading: 1, body: 2 },
      paragraphMap: {}
    }
  }
};

describe("unified write pipeline", () => {
  it("binds paragraph_ids intents to real writable run nodes", () => {
    const intent: WriteIntent = {
      id: "body-font",
      type: "set_font",
      target: {
        kind: "paragraph_ids",
        paragraphIds: ["p_1", "p_2"]
      },
      payload: {
        font_name: "KaiTi"
      }
    };

    const prepared = prepareWriteIntents(doc, [intent]);

    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.operation.targetNodeIds).toEqual(["p_1_r_0", "p_1_r_1", "p_2_r_0"]);
    expect(prepared[0]?.patchTargetIds).toEqual([
      "target:inline:p_1_r_0",
      "target:inline:p_1_r_1",
      "target:inline:p_2_r_0"
    ]);
  });

  it("skips unwritable paragraph_ids targets when other writable runs remain", () => {
    const intent: WriteIntent = {
      id: "broken-body",
      type: "set_alignment",
      target: {
        kind: "paragraph_ids",
        paragraphIds: ["p_1", "p_2"]
      },
      payload: {
        paragraph_alignment: "justify"
      }
    };

    const brokenDoc: DocumentIR = {
      ...doc,
      nodes: doc.nodes.filter((node) => node.id !== "p_2_r_0")
    };

    const analysis = analyzeWriteTargetSpec(brokenDoc, intent.target);
    expect(analysis.targetNodeIds).toEqual(["p_1_r_0", "p_1_r_1"]);
    expect(analysis.unwritableParagraphIds).toEqual(["p_2"]);
    expect(analysis.skippedParagraphIds).toEqual(["p_2"]);

    const prepared = prepareWriteIntents(brokenDoc, [intent]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.operation.targetNodeIds).toEqual(["p_1_r_0", "p_1_r_1"]);
    expect(prepared[0]?.targetAnalysis.skippedParagraphIds).toEqual(["p_2"]);
  });

  it("skips unwritable semantic selector matches when other writable runs remain", () => {
    const intent: WriteIntent = {
      id: "body-font",
      type: "set_font",
      target: {
        kind: "selector",
        selector: {
          scope: "body"
        }
      },
      payload: {
        font_name: "KaiTi"
      }
    };

    const brokenDoc: DocumentIR = {
      ...doc,
      nodes: doc.nodes.filter((node) => node.id !== "p_2_r_0")
    };

    const prepared = prepareWriteIntents(brokenDoc, [intent]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.operation.targetNodeIds).toEqual(["p_1_r_0", "p_1_r_1"]);
    expect(prepared[0]?.targetAnalysis.skippedParagraphIds).toEqual(["p_2"]);
  });

  it("treats all-unwritable paragraph matches as empty targets after filtering", () => {
    const intent: WriteIntent = {
      id: "broken-body",
      type: "set_alignment",
      target: {
        kind: "paragraph_ids",
        paragraphIds: ["p_2"]
      },
      payload: {
        paragraph_alignment: "justify"
      }
    };

    const brokenDoc: DocumentIR = {
      ...doc,
      nodes: doc.nodes.filter((node) => node.id !== "p_2_r_0")
    };

    expect(() => prepareWriteIntents(brokenDoc, [intent])).toThrowError(
      expect.objectContaining({
        info: expect.objectContaining({
          code: "E_SELECTOR_TARGETS_EMPTY",
          message: expect.stringContaining("no writable targets after filtering")
        })
      })
    );
  });

  it("rejects semantic selectors that match no writable nodes", () => {
    const intent: WriteIntent = {
      id: "list-color",
      type: "set_font_color",
      target: {
        kind: "selector",
        selector: {
          scope: "list_item"
        }
      },
      payload: {
        font_color: "112233"
      }
    };

    expect(() => prepareWriteIntents(doc, [intent])).toThrowError(
      expect.objectContaining({
        info: expect.objectContaining({
          code: "E_SELECTOR_TARGETS_EMPTY"
        })
      })
    );
  });

  it("passes patch target intents through without paragraph binding", () => {
    const intent: WriteIntent = {
      id: "styles-body",
      type: "set_style_definition",
      target: {
        kind: "patch_targets",
        patchTargetIds: ["target:styles:style:BodyText"],
        patchPartPaths: ["word/styles.xml"]
      },
      payload: {
        style_definition: {
          "w:name": "BodyText"
        }
      }
    };

    const prepared = prepareWriteIntents(doc, [intent]);

    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.operation.targetNodeIds).toBeUndefined();
    expect(prepared[0]?.operation.patchTargetIds).toEqual(["target:styles:style:BodyText"]);
    expect(prepared[0]?.patchPartPaths).toEqual(["word/styles.xml"]);
  });

  it("prefers explicit patch targets over node ids when converting legacy operations", () => {
    const operation: Operation = {
      id: "styles-body",
      type: "set_style_definition",
      targetNodeIds: ["p_1_r_0", "p_1_r_1"],
      patchTargetIds: ["target:styles:style:BodyText"],
      patchPartPaths: ["word/styles.xml"],
      payload: {
        style_definition: {
          "w:name": "BodyText"
        }
      }
    };

    expect(operationToWriteIntent(operation)).toEqual({
      id: "styles-body",
      type: "set_style_definition",
      payload: {
        style_definition: {
          "w:name": "BodyText"
        }
      },
      target: {
        kind: "patch_targets",
        patchTargetIds: ["target:styles:style:BodyText"],
        patchPartPaths: ["word/styles.xml"]
      }
    });
  });

  it("preserves patch part paths for legacy patch-target operations", () => {
    const operations: Operation[] = [
      {
        id: "styles-body",
        type: "set_style_definition",
        patchTargetIds: ["target:styles:style:BodyText"],
        patchPartPaths: ["word/styles.xml"],
        payload: {
          style_definition: {
            "w:name": "BodyText"
          }
        }
      },
      {
        id: "numbering-body",
        type: "set_numbering_level",
        patchTargetIds: ["target:numbering:1:0"],
        patchPartPaths: ["word/numbering.xml"],
        payload: {
          numbering_level: {
            "w:start": 1
          }
        }
      },
      {
        id: "settings-compat",
        type: "set_settings_flag",
        patchTargetIds: ["target:settings:trackRevisions"],
        patchPartPaths: ["word/settings.xml"],
        payload: {
          settings: {
            trackRevisions: true
          }
        }
      }
    ];

    expect(operations.map((operation) => operationToWriteIntent(operation).target)).toEqual([
      {
        kind: "patch_targets",
        patchTargetIds: ["target:styles:style:BodyText"],
        patchPartPaths: ["word/styles.xml"]
      },
      {
        kind: "patch_targets",
        patchTargetIds: ["target:numbering:1:0"],
        patchPartPaths: ["word/numbering.xml"]
      },
      {
        kind: "patch_targets",
        patchTargetIds: ["target:settings:trackRevisions"],
        patchPartPaths: ["word/settings.xml"]
      }
    ]);
  });
});
