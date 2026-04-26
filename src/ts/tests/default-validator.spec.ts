import { describe, expect, it } from "vitest";
import type { DocumentIR, Plan } from "../src/core/types.js";
import { AgentError } from "../src/core/errors.js";
import { DefaultValidator } from "../src/validator/default-validator.js";

const doc: DocumentIR = {
  id: "demo",
  version: "v1",
  nodes: [{ id: "n1", text: "hello" }],
  metadata: {
    docxObservation: {
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
          part_paths: ["word/document.xml"]
        },
        parts: [],
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
        part_paths: ["word/document.xml"]
      },
      document_meta: { total_paragraphs: 1, total_tables: 0 },
      blocks: [],
      inline_nodes: [
        {
          id: "n1",
          block_id: "p_0",
          part_path: "word/document.xml",
          node_type: "text",
          text: "hello",
          style: {},
          anchor: { part_path: "word/document.xml", xml_path: "/document/body/p[0]/r[0]/t" }
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
        paragraphs: [{ id: "p_0", text: "hello", role: "body", run_ids: ["n1"], in_table: false, part_path: "word/document.xml" }],
        role_counts: { body: 1 }
      },
      patch_targets: [
        {
          id: "target:inline:n1",
          target_kind: "inline",
          part_path: "word/document.xml",
          block_id: "p_0",
          node_id: "n1",
          locator: { part_path: "word/document.xml", xml_path: "/document/body/p[0]/r[0]/t" }
        }
      ],
      nodes: []
    }
  }
};

function createPlan(step: Plan["steps"][number]): Plan {
  return {
    taskId: "task_demo",
    goal: "set color",
    steps: [step]
  };
}

describe("DefaultValidator.preValidate", () => {
  it("rejects write steps without operation", async () => {
    const validator = new DefaultValidator();
    const plan = createPlan({
      id: "s1",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s1"
    });

    await expect(validator.preValidate(plan, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("write_operation")
    );
  });

  it("rejects write steps without payload or target", async () => {
    const validator = new DefaultValidator();
    const missingPayload = createPlan({
      id: "s1",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s1",
      operation: {
        id: "op1",
        type: "set_font_color",
        targetNodeId: "n1",
        payload: undefined as never
      }
    });
    const missingTarget = createPlan({
      id: "s2",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s2",
      operation: {
        id: "op2",
        type: "set_font_color",
        payload: { font_color: "00FF00" }
      }
    });

    await expect(validator.preValidate(missingPayload, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("payload")
    );
    await expect(validator.preValidate(missingTarget, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("targetNodeId")
    );
  });

  it("rejects placeholder targets and empty executable payloads", async () => {
    const validator = new DefaultValidator();
    const placeholderTarget = createPlan({
      id: "s1",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s1",
      operation: {
        id: "op1",
        type: "set_font_color",
        targetNodeId: "placeholder",
        payload: { font_color: "00FF00" }
      }
    });
    const emptyPayload = createPlan({
      id: "s2",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s2",
      operation: {
        id: "op2",
        type: "set_font",
        targetNodeId: "n1",
        payload: {}
      }
    });

    await expect(validator.preValidate(placeholderTarget, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("placeholder")
    );
    await expect(validator.preValidate(emptyPayload, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("empty")
    );
  });

  it("accepts batched targetNodeIds for executable write steps", async () => {
    const validator = new DefaultValidator();
    const batchedPlan = createPlan({
      id: "s3",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s3",
      operation: {
        id: "op3",
        type: "set_font_color",
        targetNodeIds: ["n1"],
        payload: { font_color: "00FF00" }
      }
    });

    await expect(validator.preValidate(batchedPlan, doc)).resolves.toBeUndefined();
  });

  it("rejects write steps that cannot compile to a stable patch target", async () => {
    const validator = new DefaultValidator();
    const incompatible = createPlan({
      id: "s_patch_missing",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s_patch_missing",
      operation: {
        id: "op_patch_missing",
        type: "set_font",
        targetNodeId: "missing-node",
        payload: { font_name: "SimSun" }
      }
    });

    await expect(validator.preValidate(incompatible, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("patch")
    );
  });

  it("rejects structural writes that are not patch-compilable", async () => {
    const validator = new DefaultValidator();
    const structural = createPlan({
      id: "s_merge",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s_merge",
      operation: {
        id: "op_merge",
        type: "merge_paragraph",
        targetNodeId: "n1",
        payload: {}
      }
    });

    await expect(validator.preValidate(structural, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("patch")
    );
  });

  it("accepts document-level page layout without a target", async () => {
    const validator = new DefaultValidator();
    const plan = createPlan({
      id: "s_page",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:page",
      operation: {
        id: "op_page",
        type: "set_page_layout",
        payload: {
          paper_size: "A4",
          margin_top_cm: 3.7,
          margin_bottom_cm: 3.5,
          margin_left_cm: 2.8,
          margin_right_cm: 2.6
        }
      }
    });

    await expect(validator.preValidate(plan, doc)).resolves.toBeUndefined();
  });

  it("rejects invalid line spacing payloads and accepts exact spacing", async () => {
    const validator = new DefaultValidator();
    const invalidPlan = createPlan({
      id: "s4",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s4",
      operation: {
        id: "op4",
        type: "set_line_spacing",
        targetNodeId: "n1",
        payload: { line_spacing: { mode: "exact" } }
      }
    });
    const validPlan = createPlan({
      id: "s5",
      toolName: "write_operation",
      readOnly: false,
      idempotencyKey: "write:s5",
      operation: {
        id: "op5",
        type: "set_line_spacing",
        targetNodeId: "n1",
        payload: { line_spacing: { mode: "exact", pt: 18 } }
      }
    });

    await expect(validator.preValidate(invalidPlan, doc)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_INVALID_PLAN" &&
        err.info.message.includes("line_spacing")
    );
    await expect(validator.preValidate(validPlan, doc)).resolves.toBeUndefined();
  });
});
