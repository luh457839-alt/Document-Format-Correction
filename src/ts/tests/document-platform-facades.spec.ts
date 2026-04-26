import { describe, expect, it, vi } from "vitest";
import { AgentError } from "../src/core/errors.js";
import type { DocumentIR, Operation, Plan } from "../src/core/types.js";
import { InMemoryToolRegistry } from "../src/tools/tool-registry.js";
import { WriteOperationTool } from "../src/tools/mock-tools.js";

const baseDoc: DocumentIR = {
  id: "doc-1",
  version: "v1",
  nodes: [{ id: "n1", text: "hello" }]
};

describe("document platform facades", () => {
  it("delegates observe/materialize and tool factories through DocumentToolingFacade", async () => {
    const observation = {
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
          warnings: []
        },
        parts: [],
        relationship_graph: {
          edges: [],
          by_source: {}
        }
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
        warnings: []
      },
      document_meta: { total_paragraphs: 1, total_tables: 0 },
      blocks: [],
      inline_nodes: [],
      styles: {
        defaults: {},
        paragraph_styles: {},
        character_styles: {},
        table_styles: {}
      },
      numbering: { instances: [] },
      structure_index: { paragraphs: [], role_counts: {} },
      patch_targets: [],
      nodes: []
    };
    const materialized = {
      doc: {
        ...baseDoc,
        metadata: { outputDocxPath: "D:/docs/out.docx" }
      },
      summary: "materialized"
    };
    const inspectTool = { name: "inspect_document", readOnly: true, validate: async () => {}, execute: async () => materialized };
    const docxObservationTool = {
      name: "docx_observation",
      readOnly: true,
      validate: async () => {},
      execute: async () => materialized
    };
    const writeTool = new WriteOperationTool();
    const observeDocument = vi.fn(async () => observation);
    const materializeDocument = vi.fn(async () => materialized);

    const { createDocumentToolingFacade } = await import("../src/document-tooling/facade.js");
    const facade = createDocumentToolingFacade({
      observeDocument,
      materializeDocument,
      inspectDocumentToolFactory: () => inspectTool,
      docxObservationToolFactory: () => docxObservationTool,
      writeOperationToolFactory: () => writeTool
    });

    await expect(facade.observeDocument("D:/docs/sample.docx")).resolves.toEqual(observation);
    await expect(facade.materializeDocument(baseDoc)).resolves.toEqual(materialized);
    expect(facade.createInspectDocumentTool()).toBe(inspectTool);
    expect(facade.createDocxObservationTool()).toBe(docxObservationTool);
    expect(facade.createWriteOperationTool()).toBe(writeTool);
    expect(observeDocument).toHaveBeenCalledWith("D:/docs/sample.docx", undefined);
    expect(materializeDocument).toHaveBeenCalledWith(baseDoc, undefined);
  });

  it("uses native observation as the default package parser and keeps tool behavior aligned", async () => {
    const observation = {
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
          warnings: []
        },
        parts: [],
        relationship_graph: {
          edges: [],
          by_source: {}
        }
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
        warnings: []
      },
      document_meta: { total_paragraphs: 1, total_tables: 0 },
      blocks: [],
      inline_nodes: [],
      styles: {
        defaults: {},
        paragraph_styles: {},
        character_styles: {},
        table_styles: {}
      },
      numbering: { instances: [] },
      structure_index: { paragraphs: [], role_counts: {} },
      patch_targets: [],
      nodes: []
    };
    const pythonObserveDocument = vi.fn(async () => observation);
    const nativeObserveDocument = vi.fn(async () => observation);

    const { createDocumentToolingFacade } = await import("../src/document-tooling/facade.js");
    const facade = createDocumentToolingFacade({
      pythonObserveDocument,
      nativeObserveDocument
    });

    await expect(facade.observeDocument("D:/docs/sample.docx")).resolves.toEqual(observation);
    expect(pythonObserveDocument).not.toHaveBeenCalled();
    expect(nativeObserveDocument).toHaveBeenCalledWith("D:/docs/sample.docx");

    const tool = facade.createDocxObservationTool();
    const result = await tool.execute({
      doc: structuredClone(baseDoc),
      operation: {
        id: "observe-docx",
        type: "set_font",
        targetNodeId: "unused",
        payload: {
          docxPath: "D:/docs/sample.docx"
        }
      },
      context: {
        taskId: "task-1",
        stepId: "step-1",
        dryRun: false
      }
    });

    expect(result.doc.metadata?.docxObservation).toEqual(observation);
    expect(nativeObserveDocument).toHaveBeenCalledTimes(2);
  });

  it("preserves explicit observation override failures", async () => {
    const observeDocument = vi.fn(async () => {
      throw new AgentError({
        code: "E_PYTHON_TOOL_START_FAILED",
        message: "Python tool runner environment failed: ModuleNotFoundError: No module named 'src'",
        retryable: false
      });
    });
    const nativeObserveDocument = vi.fn(async () => ({
      document_meta: { total_paragraphs: 1, total_tables: 0 },
      nodes: []
    }));

    const { createDocumentToolingFacade } = await import("../src/document-tooling/facade.js");
    const facade = createDocumentToolingFacade({
      observeDocument,
      nativeObserveDocument
    });

    await expect(facade.observeDocument("D:/docs/sample.docx")).rejects.toMatchObject({
      info: {
        code: "E_PYTHON_TOOL_START_FAILED"
      }
    } satisfies Partial<AgentError>);
    expect(nativeObserveDocument).not.toHaveBeenCalled();
    expect(observeDocument).toHaveBeenCalledWith("D:/docs/sample.docx", undefined);
  });

  it("executes plan and write plan through DocumentExecutionFacade", async () => {
    const { createDocumentExecutionFacade } = await import("../src/document-execution/facade.js");
    const registry = new InMemoryToolRegistry();
    registry.register(new WriteOperationTool());
    const facade = createDocumentExecutionFacade({ toolRegistry: registry });

    const writeOperation: Operation = {
      id: "op-1",
      type: "set_font",
      targetNodeId: "n1",
      payload: { fontName: "KaiTi" }
    };
    const plan: Plan = {
      taskId: "task-1",
      goal: "set font",
      steps: [
        {
          id: "step-1",
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: "step-1",
          operation: writeOperation
        }
      ]
    };

    const result = await facade.executePlan(plan, baseDoc, { dryRun: false });
    expect(result.status).toBe("completed");
    expect(result.finalDoc.nodes[0]?.style?.font_name).toBe("KaiTi");

    const writePlanResult = await facade.executeWritePlan([writeOperation], baseDoc, {
      taskId: "task-2",
      goal: "set font again"
    });
    expect(writePlanResult.status).toBe("completed");
    expect(writePlanResult.finalDoc.nodes[0]?.style?.font_name).toBe("KaiTi");
  });

  it("keeps explicit patch targets stable when executing legacy write plans", async () => {
    const { createDocumentExecutionFacade } = await import("../src/document-execution/facade.js");
    const { createDocumentToolingFacade } = await import("../src/document-tooling/facade.js");
    const registry = new InMemoryToolRegistry();
    registry.register(createDocumentToolingFacade().createWriteOperationTool());
    const facade = createDocumentExecutionFacade({ toolRegistry: registry });

    const legacyPatchOperation: Operation = {
      id: "style-body",
      type: "set_style_definition",
      targetNodeIds: ["n1"],
      patchTargetIds: ["target:styles:style:BodyText"],
      patchPartPaths: ["word/styles.xml"],
      payload: {
        style_definition: {
          "w:name": "BodyText"
        }
      }
    };

    const writePlanResult = await facade.executeWritePlan(
      [legacyPatchOperation],
      {
        ...baseDoc,
        metadata: {
          inputDocxPath: "D:/docs/sample.docx",
          outputDocxPath: "D:/docs/sample.out.docx"
        }
      },
      {
        taskId: "task-3",
        goal: "preserve explicit patch target"
      }
    );

    expect(writePlanResult.status).toBe("completed");
    const patchHistory = writePlanResult.finalDoc.metadata?.docxPatchHistory as
      | Array<{ targets?: Array<{ id: string; part_path: string }> }>
      | undefined;
    expect(patchHistory?.[0]?.targets).toEqual([
      expect.objectContaining({
        id: "target:styles:style:BodyText",
        target_kind: "style",
        part_path: "word/styles.xml",
        block_id: "BodyText"
      })
    ]);
  });
});
