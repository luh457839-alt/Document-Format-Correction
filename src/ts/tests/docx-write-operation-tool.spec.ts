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
