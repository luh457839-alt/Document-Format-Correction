import { describe, expect, it } from "vitest";
import { AgentError } from "../src/core/errors.js";
import { normalizeWriteOperationPayload } from "../src/tools/style-operation.js";
import type { Operation } from "../src/core/types.js";

function createOperation(type: Operation["type"], payload: Record<string, unknown>): Operation {
  return {
    id: "op1",
    type,
    targetNodeId: "n1",
    payload
  };
}

describe("normalizeWriteOperationPayload", () => {
  it("normalizes new style operation payloads", () => {
    expect(normalizeWriteOperationPayload(createOperation("set_font_color", { font_color: "#112233" }))).toEqual({
      font_color: "112233"
    });
    expect(
      normalizeWriteOperationPayload(createOperation("set_line_spacing", { line_spacing: { mode: "exact", pt: 20 } }))
    ).toEqual({
      line_spacing: { mode: "exact", pt: 20 }
    });
    expect(normalizeWriteOperationPayload(createOperation("set_bold", { is_bold: true }))).toEqual({
      is_bold: true
    });
    expect(normalizeWriteOperationPayload(createOperation("set_highlight_color", { highlight_color: "#FFFF00" }))).toEqual({
      highlight_color: "yellow"
    });
    expect(normalizeWriteOperationPayload(createOperation("set_all_caps", { is_all_caps: true }))).toEqual({
      is_all_caps: true
    });
  });

  it("accepts merge_paragraph with empty payload", () => {
    expect(normalizeWriteOperationPayload(createOperation("merge_paragraph", {}))).toEqual({});
  });

  it("requires split_offset for split_paragraph", () => {
    expect(normalizeWriteOperationPayload(createOperation("split_paragraph", { split_offset: 3 }))).toEqual({
      split_offset: 3
    });

    expect(() => normalizeWriteOperationPayload(createOperation("split_paragraph", {}))).toThrowError(AgentError);
    expect(() =>
      normalizeWriteOperationPayload(createOperation("split_paragraph", { split_offset: 0 }))
    ).toThrowError(/split_offset/);
  });

  it("rejects invalid line_spacing payloads", () => {
    expect(() =>
      normalizeWriteOperationPayload(createOperation("set_line_spacing", { line_spacing: { mode: "exact" } }))
    ).toThrowError(/line_spacing/);
    expect(() =>
      normalizeWriteOperationPayload(createOperation("set_line_spacing", { line_spacing: 0 }))
    ).toThrowError(/line_spacing/);
  });
});
