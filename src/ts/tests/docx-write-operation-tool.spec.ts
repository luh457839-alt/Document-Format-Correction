import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentError } from "../src/core/errors.js";
import { DocxWriteOperationTool } from "../src/tools/docx-write-operation-tool.js";
import type { ToolExecutionInput } from "../src/core/types.js";

describe("docx write operation tool", () => {
  it("supports dry-run without outputDocxPath", async () => {
    const tool = new DocxWriteOperationTool();
    const input: ToolExecutionInput = {
      doc: {
        id: "doc1",
        version: "v1",
        nodes: [{ id: "n1", text: "hello" }]
      },
      operation: {
        id: "op1",
        type: "set_font",
        targetNodeId: "n1",
        payload: { fontName: "SimSun" }
      },
      context: { taskId: "t1", stepId: "s1", dryRun: true }
    };

    await tool.validate(input);
    const output = await tool.execute(input);
    expect(output.summary).toContain("Dry-run");
    expect(output.doc.nodes[0].style).toMatchObject({ font_name: "SimSun", operation: "set_font" });
  });

  it("supports standardized set_size payload in dry-run", async () => {
    const tool = new DocxWriteOperationTool();
    const input: ToolExecutionInput = {
      doc: {
        id: "doc1",
        version: "v1",
        nodes: [{ id: "n1", text: "hello", style: { font_name: "Calibri" } }]
      },
      operation: {
        id: "op1",
        type: "set_size",
        targetNodeId: "n1",
        payload: { font_size_pt: 22 }
      },
      context: { taskId: "t1", stepId: "s1", dryRun: true }
    };

    await tool.validate(input);
    const output = await tool.execute(input);
    expect(output.doc.nodes[0].style).toMatchObject({
      font_name: "Calibri",
      font_size_pt: 22,
      operation: "set_size"
    });
  });

  it("supports standardized set_line_spacing payload in dry-run", async () => {
    const tool = new DocxWriteOperationTool();
    const input: ToolExecutionInput = {
      doc: {
        id: "doc1",
        version: "v1",
        nodes: [{ id: "n1", text: "hello", style: { font_name: "Calibri" } }]
      },
      operation: {
        id: "op1",
        type: "set_line_spacing",
        targetNodeId: "n1",
        payload: { line_spacing: { mode: "exact", pt: 20 } }
      },
      context: { taskId: "t1", stepId: "s1", dryRun: true }
    };

    await tool.validate(input);
    const output = await tool.execute(input);
    expect(output.doc.nodes[0].style).toMatchObject({
      font_name: "Calibri",
      line_spacing: { mode: "exact", pt: 20 },
      operation: "set_line_spacing"
    });
  });

  it("supports document-level set_page_layout without a target in dry-run", async () => {
    const tool = new DocxWriteOperationTool();
    const input: ToolExecutionInput = {
      doc: {
        id: "doc1",
        version: "v1",
        nodes: [{ id: "n1", text: "hello" }]
      },
      operation: {
        id: "op1",
        type: "set_page_layout",
        payload: {
          paper_size: "A4",
          margin_top_cm: 3.7,
          margin_bottom_cm: 3.5,
          margin_left_cm: 2.8,
          margin_right_cm: 2.6
        }
      },
      context: { taskId: "t1", stepId: "s1", dryRun: true }
    };

    await tool.validate(input);
    const output = await tool.execute(input);
    expect(output.summary).toContain("Dry-run");
    expect(output.doc.metadata?.page_layout).toEqual({
      paper_size: "A4",
      margin_top_cm: 3.7,
      margin_bottom_cm: 3.5,
      margin_left_cm: 2.8,
      margin_right_cm: 2.6
    });
    expect(output.doc.nodes[0].style).toBeUndefined();
  });

  it("supports paragraph spacing and indent payloads in dry-run", async () => {
    const tool = new DocxWriteOperationTool();
    const spacing: ToolExecutionInput = {
      doc: {
        id: "doc1",
        version: "v1",
        nodes: [{ id: "n1", text: "hello", style: { font_name: "Calibri" } }]
      },
      operation: {
        id: "op1",
        type: "set_paragraph_spacing",
        targetNodeId: "n1",
        payload: { before_pt: 6, after_pt: 3 }
      },
      context: { taskId: "t1", stepId: "s1", dryRun: true }
    };
    const indent: ToolExecutionInput = {
      doc: spacing.doc,
      operation: {
        id: "op2",
        type: "set_paragraph_indent",
        targetNodeId: "n1",
        payload: { first_line_indent_chars: 2, font_size_pt: 15 }
      },
      context: { taskId: "t1", stepId: "s2", dryRun: true }
    };

    await tool.validate(spacing);
    await tool.validate(indent);
    await expect(tool.execute(spacing)).resolves.toMatchObject({
      doc: {
        nodes: [
          {
            style: {
              font_name: "Calibri",
              space_before_pt: 6,
              space_after_pt: 3,
              operation: "set_paragraph_spacing"
            }
          }
        ]
      }
    });
    await expect(tool.execute(indent)).resolves.toMatchObject({
      doc: {
        nodes: [
          {
            style: {
              font_name: "Calibri",
              first_line_indent_pt: 30,
              operation: "set_paragraph_indent"
            }
          }
        ]
      }
    });
  });

  it("rejects mismatched payload for set_size", async () => {
    const tool = new DocxWriteOperationTool();
    const input: ToolExecutionInput = {
      doc: {
        id: "doc1",
        version: "v1",
        nodes: [{ id: "n1", text: "hello" }]
      },
      operation: {
        id: "op1",
        type: "set_size",
        targetNodeId: "n1",
        payload: { fontName: "SimSun" }
      },
      context: { taskId: "t1", stepId: "s1", dryRun: true }
    };

    await expect(tool.validate(input)).rejects.toMatchObject({
      info: { code: "E_INVALID_OPERATION_PAYLOAD" }
    });
  });

  it("requires outputDocxPath for non-dry-run", async () => {
    const tool = new DocxWriteOperationTool();
    const input: ToolExecutionInput = {
      doc: {
        id: "doc1",
        version: "v1",
        nodes: [{ id: "n1", text: "hello" }]
      },
      operation: {
        id: "op1",
        type: "set_font",
        targetNodeId: "n1",
        payload: { fontName: "SimSun" }
      },
      context: { taskId: "t1", stepId: "s1", dryRun: false }
    };

    await expect(tool.validate(input)).rejects.toBeInstanceOf(AgentError);
    await expect(tool.validate(input)).rejects.toMatchObject({
      info: { code: "E_OUTPUT_PATH_REQUIRED" }
    });
  });

  it("restores original output file when write execution fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docx-write-fail-"));
    const outputDocxPath = path.join(dir, "result.docx");
    const original = Buffer.from("original-content", "utf8");
    await writeFile(outputDocxPath, original);

    const tool = new DocxWriteOperationTool({
      pythonBin: "python",
      scriptPath: path.join(dir, "missing-writer.py")
    });
    const input: ToolExecutionInput = {
      doc: {
        id: "doc1",
        version: "v1",
        nodes: [{ id: "n1", text: "hello" }],
        metadata: { outputDocxPath }
      },
      operation: {
        id: "op1",
        type: "set_font",
        targetNodeId: "n1",
        payload: { fontName: "SimSun" }
      },
      context: { taskId: "t1", stepId: "s1", dryRun: false }
    };

    await expect(tool.execute(input)).rejects.toBeInstanceOf(AgentError);
    await expect(readFile(outputDocxPath)).resolves.toEqual(original);
    await rm(dir, { recursive: true, force: true });
  });

  it("removes created output when rollback is triggered", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "docx-write-rollback-"));
    const writerScript = path.join(dir, "writer.js");
    const outputDocxPath = path.join(dir, "result.docx");

    await writeFile(
      writerScript,
      [
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "const outIdx = args.indexOf('--output-docx');",
        "if (outIdx < 0) process.exit(2);",
        "const outputPath = args[outIdx + 1];",
        "fs.writeFileSync(outputPath, 'generated-docx');"
      ].join("\n"),
      "utf8"
    );

    const tool = new DocxWriteOperationTool({
      pythonBin: "node",
      scriptPath: writerScript
    });
    const input: ToolExecutionInput = {
      doc: {
        id: "doc1",
        version: "v1",
        nodes: [{ id: "n1", text: "hello" }],
        metadata: { outputDocxPath }
      },
      operation: {
        id: "op1",
        type: "set_font",
        targetNodeId: "n1",
        payload: { fontName: "SimSun" }
      },
      context: { taskId: "t1", stepId: "s1", dryRun: false }
    };

    const out = await tool.execute(input);
    const beforeRollback = await readFile(outputDocxPath, "utf8");
    expect(beforeRollback).toContain("generated-docx");
    expect(out.rollbackToken?.startsWith("rb_file:")).toBe(true);

    await tool.rollback(out.rollbackToken!, out.doc);
    await expect(readFile(outputDocxPath)).rejects.toBeDefined();
    await rm(dir, { recursive: true, force: true });
  });
});
