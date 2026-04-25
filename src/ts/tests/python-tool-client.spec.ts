import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { AgentError } from "../src/core/errors.js";
import { observeDocxStateWithPython, runPythonTool } from "../src/tools/python-tool-client.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "python-tool-client-"));
  tempDirs.push(dir);
  return dir;
}

async function writeMinimalDocx(target: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Hello fallback</w:t></w:r></w:p>
  </w:body>
</w:document>`
  );
  const data = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(target, data);
}

describe("python tool client", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("surfaces stderr when runner exits before producing output json", async () => {
    const dir = await makeTempDir();
    const runnerPath = path.join(dir, "runner.cjs");
    await writeFile(
      runnerPath,
      [
        "process.stderr.write('boom from stderr');",
        "process.exit(1);"
      ].join("\n"),
      "utf8"
    );

    await expect(
      runPythonTool(
        {
          action: "execute",
          toolName: "inspect_document",
          input: {
            doc: { id: "doc1", version: "v1", nodes: [] },
            context: { taskId: "t1", stepId: "s1", dryRun: false }
          }
        },
        {
          pythonBin: "node",
          runnerPath
        }
      )
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_PYTHON_TOOL_EXIT_NONZERO" &&
        err.info.message.includes("boom from stderr")
    );
  });

  it("classifies src import failures as runner startup errors", async () => {
    const dir = await makeTempDir();
    const runnerPath = path.join(dir, "runner.cjs");
    await writeFile(
      runnerPath,
      [
        "process.stderr.write(\"Traceback (most recent call last):\\n\");",
        "process.stderr.write(\"  File 'python_tool_runner.py', line 14, in <module>\\n\");",
        "process.stderr.write(\"ModuleNotFoundError: No module named 'src'\\n\");",
        "process.exit(1);"
      ].join("\n"),
      "utf8"
    );

    await expect(
      runPythonTool(
        {
          action: "execute",
          toolName: "inspect_document",
          input: {
            doc: { id: "doc1", version: "v1", nodes: [] },
            context: { taskId: "t1", stepId: "s1", dryRun: false }
          }
        },
        {
          pythonBin: "node",
          runnerPath
        }
      )
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_PYTHON_TOOL_START_FAILED" &&
        err.info.message.includes("No module named 'src'")
    );
  });

  it("classifies missing output json when runner exits successfully", async () => {
    const dir = await makeTempDir();
    const runnerPath = path.join(dir, "runner.cjs");
    await writeFile(runnerPath, "process.exit(0);\n", "utf8");

    await expect(
      runPythonTool(
        {
          action: "execute",
          toolName: "inspect_document",
          input: {
            doc: { id: "doc1", version: "v1", nodes: [] },
            context: { taskId: "t1", stepId: "s1", dryRun: false }
          }
        },
        {
          pythonBin: "node",
          runnerPath
        }
      )
    ).rejects.toMatchObject({
      info: {
        code: "E_PYTHON_TOOL_OUTPUT_MISSING"
      }
    } satisfies Partial<AgentError>);
  });

  it("classifies invalid runner json separately", async () => {
    const dir = await makeTempDir();
    const runnerPath = path.join(dir, "runner.cjs");
    await writeFile(
      runnerPath,
      [
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "const outputPath = args[args.indexOf('--output-json') + 1];",
        "fs.writeFileSync(outputPath, '{not-json}', 'utf8');",
        "process.exit(0);"
      ].join("\n"),
      "utf8"
    );

    await expect(
      runPythonTool(
        {
          action: "execute",
          toolName: "inspect_document",
          input: {
            doc: { id: "doc1", version: "v1", nodes: [] },
            context: { taskId: "t1", stepId: "s1", dryRun: false }
          }
        },
        {
          pythonBin: "node",
          runnerPath
        }
      )
    ).rejects.toMatchObject({
      info: {
        code: "E_PYTHON_TOOL_OUTPUT_INVALID_JSON"
      }
    } satisfies Partial<AgentError>);
  });

  it("classifies startup failures separately", async () => {
    await expect(
      runPythonTool(
        {
          action: "execute",
          toolName: "inspect_document",
          input: {
            doc: { id: "doc1", version: "v1", nodes: [] },
            context: { taskId: "t1", stepId: "s1", dryRun: false }
          }
        },
        {
          pythonBin: "__missing_python_binary__",
          runnerPath: "missing-runner.py"
        }
      )
    ).rejects.toMatchObject({
      info: {
        code: "E_PYTHON_TOOL_START_FAILED"
      }
    } satisfies Partial<AgentError>);
  });

  it("falls back to native parser from structured dependency errors", async () => {
    const dir = await makeTempDir();
    const runnerPath = path.join(dir, "runner.cjs");
    const docxPath = path.join(dir, "sample.docx");
    await writeMinimalDocx(docxPath);
    await writeFile(
      runnerPath,
      [
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "const outputPath = args[args.indexOf('--output-json') + 1];",
        "fs.writeFileSync(outputPath, JSON.stringify({",
        "  ok: false,",
        "  error: { code: 'E_PYTHON_DEPENDENCY_MISSING', message: 'python-docx is required', retryable: false }",
        "}, null, 2), 'utf8');",
        "process.exit(1);"
      ].join("\n"),
      "utf8"
    );

    const state = await observeDocxStateWithPython(docxPath, {
      pythonBin: "node",
      runnerPath
    });

    expect(state.document_meta.total_paragraphs).toBe(1);
    expect(state.nodes[0]?.node_type).toBe("paragraph");
  });

  it("falls back to native parser when startup failure indicates docx parse rejection", async () => {
    const dir = await makeTempDir();
    const runnerPath = path.join(dir, "runner.cjs");
    const docxPath = path.join(dir, "sample.docx");
    await writeMinimalDocx(docxPath);
    await writeFile(
      runnerPath,
      [
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "const outputPath = args[args.indexOf('--output-json') + 1];",
        "fs.writeFileSync(outputPath, JSON.stringify({",
        "  ok: false,",
        "  error: {",
        "    code: 'E_PYTHON_TOOL_START_FAILED',",
        "    message: 'python-docx failed to open DOCX package: Package not found at sample.docx',",
        "    retryable: false",
        "  }",
        "}, null, 2), 'utf8');",
        "process.exit(1);"
      ].join("\n"),
      "utf8"
    );

    const state = await observeDocxStateWithPython(docxPath, {
      pythonBin: "node",
      runnerPath
    });

    expect(state.document_meta.total_paragraphs).toBe(1);
    expect(state.nodes[0]?.node_type).toBe("paragraph");
  });

  it("does not fall back for runner environment startup failures", async () => {
    const dir = await makeTempDir();
    const runnerPath = path.join(dir, "runner.cjs");
    const docxPath = path.join(dir, "sample.docx");
    await writeMinimalDocx(docxPath);
    await writeFile(
      runnerPath,
      [
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "const outputPath = args[args.indexOf('--output-json') + 1];",
        "fs.writeFileSync(outputPath, JSON.stringify({",
        "  ok: false,",
        "  error: {",
        "    code: 'E_PYTHON_TOOL_START_FAILED',",
        "    message: \"Python tool runner environment failed: ModuleNotFoundError: No module named 'src'\",",
        "    retryable: false",
        "  }",
        "}, null, 2), 'utf8');",
        "process.exit(1);"
      ].join("\n"),
      "utf8"
    );

    await expect(
      observeDocxStateWithPython(docxPath, {
        pythonBin: "node",
        runnerPath
      })
    ).rejects.toMatchObject({
      info: {
        code: "E_PYTHON_TOOL_START_FAILED"
      }
    } satisfies Partial<AgentError>);
  });

  it("falls back to the native parser when python observation metadata misses the shared schema", async () => {
    const dir = await makeTempDir();
    const runnerPath = path.join(dir, "runner.cjs");
    const docxPath = path.join(dir, "sample.docx");
    await writeMinimalDocx(docxPath);
    await writeFile(
      runnerPath,
      [
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "const outputPath = args[args.indexOf('--output-json') + 1];",
        "fs.writeFileSync(outputPath, JSON.stringify({",
        "  ok: true,",
        "  result: {",
        "    doc: {",
        "      id: 'doc1',",
        "      version: 'v1',",
        "      nodes: [],",
        "      metadata: {",
        "        docxObservation: { document_meta: { total_paragraphs: 1 } }",
        "      }",
        "    },",
        "    summary: 'ok'",
        "  }",
        "}, null, 2), 'utf8');",
        "process.exit(0);"
      ].join("\n"),
      "utf8"
    );

    const state = await observeDocxStateWithPython(docxPath, {
      pythonBin: "node",
      runnerPath
    });

    expect(state.document_meta.total_paragraphs).toBe(1);
    expect(state.nodes[0]?.node_type).toBe("paragraph");
  });
});
