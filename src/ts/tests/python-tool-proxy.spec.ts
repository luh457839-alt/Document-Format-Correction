import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError } from "../src/core/errors.js";
import type { DocumentIR, Plan, Planner, ToolExecutionInput } from "../src/core/types.js";
import { FixedPlanner } from "../src/planner/fixed-planner.js";
import { createMvpRuntime } from "../src/runtime/engine.js";
import { PythonToolProxy } from "../src/tools/python-tool-proxy.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "python-tool-proxy-"));
  tempDirs.push(dir);
  return dir;
}

async function createRunnerScript(mode: "success" | "error"): Promise<{ runnerPath: string; logPath: string }> {
  const dir = await makeTempDir();
  const scriptPath = path.join(dir, "runner.cjs");
  const logPath = path.join(dir, "calls.log");
  const source =
    mode === "error"
      ? [
          "const fs = require('fs');",
          "const args = process.argv.slice(2);",
          "const inputPath = args[args.indexOf('--input-json') + 1];",
          "const outputPath = args[args.indexOf('--output-json') + 1];",
          "fs.writeFileSync(outputPath, JSON.stringify({ ok: false, error: { code: 'E_FAKE', message: 'boom', retryable: true } }, null, 2));",
          "process.exit(1);",
        ].join("\n")
      : [
          "const fs = require('fs');",
          `const logPath = ${JSON.stringify(logPath)};`,
          "const args = process.argv.slice(2);",
          "const inputPath = args[args.indexOf('--input-json') + 1];",
          "const outputPath = args[args.indexOf('--output-json') + 1];",
          "const request = JSON.parse(fs.readFileSync(inputPath, 'utf8'));",
          "fs.appendFileSync(logPath, `${request.action}:${request.toolName}\\n`);",
          "if (request.action === 'rollback') {",
          "  const doc = JSON.parse(JSON.stringify(request.doc));",
          "  doc.metadata = { ...(doc.metadata || {}), lastRollbackToken: request.rollbackToken };",
          "  fs.writeFileSync(outputPath, JSON.stringify({ ok: true, result: doc }, null, 2));",
          "  process.exit(0);",
          "}",
          "  const input = request.input || {};",
          "  const doc = JSON.parse(JSON.stringify(input.doc || {}));",
          "  if (request.toolName === 'write_operation') {",
          "    const target = Array.isArray(doc.nodes) ? doc.nodes.find((item) => item.id === input.operation.targetNodeId) : undefined;",
          "    if (target) target.style = { ...(target.style || {}), font_name: 'SimSun', operation: 'set_font' };",
          "    fs.writeFileSync(outputPath, JSON.stringify({ ok: true, result: { doc, summary: 'Applied set_font to n1.' } }, null, 2));",
          "    process.exit(0);",
          "  }",
          "  if (request.toolName === 'materialize_document') {",
          "    const targetPath = doc.metadata?.outputDocxPath;",
          "    if (targetPath) fs.writeFileSync(targetPath, 'final-docx');",
          "    fs.writeFileSync(outputPath, JSON.stringify({ ok: true, result: { doc, summary: `Materialized document to ${targetPath}.`, artifacts: { outputDocxPath: targetPath } } }, null, 2));",
          "    process.exit(0);",
          "  }",
          "  fs.writeFileSync(outputPath, JSON.stringify({ ok: true, result: { doc, summary: 'Inspected 1 node(s).' } }, null, 2));",
          "  process.exit(0);",
        ].join("\n");
  await writeFile(scriptPath, source, "utf8");
  return { runnerPath: scriptPath, logPath };
}

describe("python tool proxy", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("executes the external runner and returns tool output", async () => {
    const { runnerPath } = await createRunnerScript("success");
    const tool = new PythonToolProxy({
      name: "inspect_document",
      readOnly: true,
      pythonBin: "node",
      runnerPath
    });
    const input: ToolExecutionInput = {
      doc: { id: "doc1", version: "v1", nodes: [{ id: "n1", text: "hello" }] },
      context: { taskId: "t1", stepId: "s1", dryRun: false }
    };

    const output = await tool.execute(input);
    expect(output.summary).toBe("Inspected 1 node(s).");
    expect(output.doc.nodes[0]?.text).toBe("hello");
  });

  it("maps structured runner errors to AgentError", async () => {
    const { runnerPath } = await createRunnerScript("error");
    const tool = new PythonToolProxy({
      name: "inspect_document",
      readOnly: true,
      pythonBin: "node",
      runnerPath
    });

    await expect(
      tool.execute({
        doc: { id: "doc1", version: "v1", nodes: [] },
        context: { taskId: "t1", stepId: "s1", dryRun: false }
      })
    ).rejects.toMatchObject({
      info: { code: "E_FAKE", message: "boom", retryable: true }
    } satisfies Partial<AgentError>);
  });

  it("delegates rollback to the external runner", async () => {
    const { runnerPath } = await createRunnerScript("success");
    const tool = new PythonToolProxy({
      name: "write_operation",
      readOnly: false,
      pythonBin: "node",
      runnerPath
    });

    const rolledBack = await tool.rollback?.("rb_file:test", {
      id: "doc1",
      version: "v1",
      nodes: [{ id: "n1", text: "hello" }]
    });

    expect(rolledBack?.metadata?.lastRollbackToken).toBe("rb_file:test");
  });

  it("wires createMvpRuntime through python-backed tools", async () => {
    const { runnerPath, logPath } = await createRunnerScript("success");
    const dir = await makeTempDir();
    const outputDocxPath = path.join(dir, "output.docx");
    const runtime = createMvpRuntime({
      planner: new FixedPlanner(),
      pythonBin: "node",
      pythonToolRunnerPath: runnerPath
    });

    const result = await runtime.run(
      "set font",
      {
        id: "doc1",
        version: "v1",
        nodes: [{ id: "n1", text: "hello" }],
        metadata: { outputDocxPath }
      },
      { runtimeMode: "plan_once" }
    );

    expect(result.status).toBe("completed");
    expect(result.finalDoc.nodes[0]?.style).toMatchObject({ font_name: "SimSun", operation: "set_font" });
    expect(result.changeSet.changes).toHaveLength(1);
    expect(result.changeSet.changes[0]?.summary).toBe("Applied set_font to n1.");
    await expect(readFile(outputDocxPath, "utf8")).resolves.toBe("final-docx");
    await expect(readFile(logPath, "utf8")).resolves.toBe(
      "execute:inspect_document\nexecute:write_operation\nexecute:materialize_document\n"
    );
  });

  it("expands selector-based writes into multiple python operations", async () => {
    class SelectorPlanner implements Planner {
      async createPlan(_goal: string, _doc: DocumentIR): Promise<Plan> {
        return {
          taskId: "task_doc1",
          goal: "set body color",
          steps: [
            {
              id: "step_set_body_color",
              toolName: "write_operation",
              readOnly: false,
              idempotencyKey: "write:body",
              operation: {
                id: "op_set_body_color",
                type: "set_font",
                targetSelector: { scope: "body" },
                payload: { font_name: "SimSun" }
              }
            }
          ]
        };
      }
    }

    const { runnerPath, logPath } = await createRunnerScript("success");
    const dir = await makeTempDir();
    const outputDocxPath = path.join(dir, "output.docx");
    const runtime = createMvpRuntime({
      planner: new SelectorPlanner(),
      pythonBin: "node",
      pythonToolRunnerPath: runnerPath
    });

    const result = await runtime.run(
      "set body font",
      {
        id: "doc1",
        version: "v1",
        nodes: [
          { id: "p_0_r_0", text: "标题" },
          { id: "p_1_r_0", text: "第一段" },
          { id: "p_1_r_1", text: "正文" },
          { id: "p_2_r_0", text: "第二段正文" }
        ],
        metadata: {
          outputDocxPath,
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
      },
      { runtimeMode: "plan_once" }
    );

    expect(result.status).toBe("completed");
    expect(result.changeSet.changes).toHaveLength(3);
    await expect(readFile(logPath, "utf8")).resolves.toBe(
      "execute:write_operation\nexecute:write_operation\nexecute:write_operation\nexecute:materialize_document\n"
    );
  });
});
