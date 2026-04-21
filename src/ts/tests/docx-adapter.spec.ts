import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { DocumentIR } from "../src/core/types.js";
import { PythonDocxAdapter } from "../src/adapters/docx/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "docx-adapter-"));
  tempDirs.push(dir);
  return dir;
}

async function createFakeParserScript(dir: string): Promise<string> {
  const scriptPath = path.join(dir, "fake_parse_docx.py");
  const script = [
    "import argparse",
    "import json",
    "import re",
    "import zipfile",
    "",
    "parser = argparse.ArgumentParser()",
    "parser.add_argument('--input', required=True)",
    "parser.add_argument('--media-dir', required=False)",
    "args = parser.parse_args()",
    "",
    "with zipfile.ZipFile(args.input, 'r') as zf:",
    "    xml = zf.read('word/document.xml').decode('utf-8')",
    "lines = re.findall(r'<w:t>(.*?)</w:t>', xml)",
    "nodes = []",
    "for idx, line in enumerate(lines):",
    "    nodes.append({",
    "        'id': f'p_{idx}',",
    "        'node_type': 'paragraph',",
    "        'children': [{'id': f'r_{idx}', 'node_type': 'text_run', 'content': line}]",
    "    })",
    "print(json.dumps({'document_meta': {'source': args.input}, 'nodes': nodes}, ensure_ascii=False))"
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

async function createFakeWriterScript(dir: string): Promise<string> {
  const scriptPath = path.join(dir, "fake_write_docx.py");
  const script = [
    "import argparse",
    "import json",
    "import zipfile",
    "from pathlib import Path",
    "",
    "parser = argparse.ArgumentParser()",
    "parser.add_argument('--input-json', required=True)",
    "parser.add_argument('--output-docx', required=True)",
    "args = parser.parse_args()",
    "",
    "payload = json.loads(Path(args.input_json).read_text(encoding='utf-8'))",
    "runs = []",
    "for node in payload.get('nodes', []):",
    "    text = str(node.get('text', ''))",
    "    runs.append(f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>')",
    "body = ''.join(runs)",
    "xml = ('<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>'",
    "       '<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">'",
    "       '<w:body>' + body + '</w:body></w:document>')",
    "with zipfile.ZipFile(args.output_docx, 'w', compression=zipfile.ZIP_DEFLATED) as zf:",
    "    zf.writestr('word/document.xml', xml)"
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

async function createFakeRunnerScript(dir: string): Promise<string> {
  const scriptPath = path.join(dir, "fake_runner.cjs");
  const script = [
    "const fs = require('fs');",
    "const args = process.argv.slice(2);",
    "const outputPath = args[args.indexOf('--output-json') + 1];",
    "const result = {",
    "  ok: true,",
    "  result: {",
    "    doc: {",
    "      id: 'doc_runner',",
    "      version: 'v1',",
    "      nodes: [],",
    "      metadata: {",
    "        docxObservation: {",
    "          document_meta: { total_paragraphs: 1, total_tables: 0 },",
    "          nodes: [",
    "            {",
    "              id: 'p_0',",
    "              node_type: 'paragraph',",
    "              children: [",
    "                { id: 'p_0_r_0', node_type: 'text_run', content: 'runner text', style: { font_name: 'SimSun' } }",
    "              ]",
    "            }",
    "          ]",
    "        }",
    "      }",
    "    },",
    "    summary: 'Observed docx: nodes=1'",
    "  }",
    "};",
    "fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');",
    "process.exit(0);"
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

describe("python docx adapter", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("saves DocumentIR to a real .docx and can load it back", async () => {
    const dir = await makeTempDir();
    const parseScriptPath = await createFakeParserScript(dir);
    const writerScriptPath = await createFakeWriterScript(dir);
    const adapter = new PythonDocxAdapter({
      allowFallback: false,
      parseScriptPath,
      writerScriptPath
    });
    const target = path.join(dir, "output.docx");

    const doc: DocumentIR = {
      id: "doc-save-load",
      version: "v1",
      nodes: [
        { id: "n1", text: "第一段文本" },
        { id: "n2", text: "Second paragraph" }
      ]
    };

    await adapter.save(doc, target);
    await expect(access(target, fsConstants.R_OK)).resolves.toBeUndefined();

    const loaded = await adapter.load(target);
    const text = loaded.nodes.map((node) => node.text).join("\n");
    expect(text).toContain("第一段文本");
    expect(text).toContain("Second paragraph");
  });

  it("throws for missing source docx when fallback is disabled", async () => {
    const dir = await makeTempDir();
    const parseScriptPath = await createFakeParserScript(dir);
    const adapter = new PythonDocxAdapter({ allowFallback: false, parseScriptPath });
    const missing = path.join(dir, "missing.docx");
    await expect(adapter.load(missing)).rejects.toBeDefined();
  });

  it("uses explicit legacy mode when both legacy and runner paths are present", async () => {
    const dir = await makeTempDir();
    const docxPath = path.join(dir, "sample.docx");
    const parseScriptPath = await createFakeParserScript(dir);
    const writerScriptPath = await createFakeWriterScript(dir);
    const runnerPath = path.join(dir, "unexpected-runner.cjs");
    await writeFile(runnerPath, "process.stderr.write('runner path should not be used'); process.exit(1);\n", "utf8");

    const seed = new PythonDocxAdapter({ parseScriptPath, writerScriptPath });
    await seed.save(
      {
        id: "doc-seed",
        version: "v1",
        nodes: [{ id: "n1", text: "legacy text" }]
      },
      docxPath
    );

    const adapter = new PythonDocxAdapter({
      mode: "legacy",
      allowFallback: false,
      pythonCommand: "python",
      parseScriptPath,
      toolRunnerPath: runnerPath
    });

    const loaded = await adapter.load(docxPath);
    expect(loaded.nodes.map((node) => node.text).join("\n")).toContain("legacy text");
  });

  it("uses explicit runner mode even when parseScriptPath is stale", async () => {
    const dir = await makeTempDir();
    const runnerPath = await createFakeRunnerScript(dir);
    const adapter = new PythonDocxAdapter({
      mode: "runner",
      allowFallback: false,
      pythonCommand: "node",
      parseScriptPath: path.join(dir, "missing-legacy-script.py"),
      toolRunnerPath: runnerPath
    });

    const loaded = await adapter.load(path.join(dir, "ignored.docx"));
    expect(loaded.nodes[0]?.text).toBe("runner text");
    expect(loaded.nodes[0]?.style).toMatchObject({ font_name: "SimSun" });
  });

  it("requires parseScriptPath in explicit legacy mode", async () => {
    const adapter = new PythonDocxAdapter({
      mode: "legacy",
      allowFallback: false
    });

    await expect(adapter.load("missing.docx")).rejects.toMatchObject({
      info: {
        code: "E_DOCX_PARSE_FAILED"
      }
    });
  });
});
