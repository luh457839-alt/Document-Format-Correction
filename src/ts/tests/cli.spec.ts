import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { SESSION_COMMAND_TYPES, runCli, runCliWithDeps } from "../src/runtime/cli.js";
import { SqliteTaskAuditStore } from "../src/runtime/audit/sqlite-task-audit-store.js";
import type { DocumentIR, ExecutionResult, Plan } from "../src/core/types.js";
import { AgentSessionService } from "../src/runtime/session-service.js";
import { SqliteAgentStateStore } from "../src/runtime/state/sqlite-agent-state-store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ts-agent-cli-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSimpleDocx(target: string, text: string): Promise<void> {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const zip = new JSZip();
  zip.file("word/document.xml", xml);
  const data = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(target, data);
}

async function writeStyledRunDocx(
  target: string,
  text: string,
  options: { fontName: string; halfPointSize: number }
): Promise<void> {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="${options.fontName}" w:hAnsi="${options.fontName}"/>
          <w:sz w:val="${options.halfPointSize}"/>
        </w:rPr>
        <w:t>${text}</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`;
  const zip = new JSZip();
  zip.file("word/document.xml", xml);
  const data = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(target, data);
}

describe("runtime cli", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes successful execution output json", async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "in.json");
    const outputPath = path.join(dir, "out.json");
    const auditDbPath = path.join(dir, "audit.db");

    await writeFile(
      inputPath,
      JSON.stringify(
        {
          goal: "normalize font",
          document: {
            id: "doc1",
            version: "v1",
            nodes: [{ id: "n1", text: "hello" }]
          },
          runtimeOptions: {
            auditDbPath,
            dryRun: true
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const code = await runCli(["--input-json", inputPath, "--output-json", outputPath]);
    expect(code).toBe(0);

    const output = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
    expect(output.status).toBe("completed");
    expect(output.summary).toBeTypeOf("string");
    expect(output.changeSet).toBeTypeOf("object");
  });

  it("writes structured error output on invalid input", async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "in.json");
    const outputPath = path.join(dir, "out.json");

    await writeFile(inputPath, JSON.stringify({ document: { id: "x", version: "v1", nodes: [] } }), "utf8");
    const code = await runCli(["--input-json", inputPath, "--output-json", outputPath]);
    expect(code).toBe(1);

    const output = JSON.parse(await readFile(outputPath, "utf8")) as {
      error?: { code?: string; message?: string };
    };
    expect(output.error?.code).toBe("E_CLI_INPUT_INVALID");
    expect(output.error?.message).toContain("goal");
  });

  it("supports react trace query mode", async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "in-query.json");
    const outputPath = path.join(dir, "out-query.json");
    const auditDbPath = path.join(dir, "audit-query.db");

    const store = new SqliteTaskAuditStore({ dbPath: auditDbPath });
    try {
      const taskId = "task-query";
      const runId = await store.startRun(
        { taskId, goal: "q", steps: [] } satisfies Plan,
        {
          id: "doc-q",
          version: "v1",
          nodes: [{ id: "n1", text: "hello" }]
        } satisfies DocumentIR
      );
      await store.finalizeRun(
        runId,
        { taskId, goal: "q", steps: [] },
        {
          status: "completed",
          finalDoc: { id: "doc-q", version: "v1", nodes: [{ id: "n1", text: "hello" }] },
          changeSet: { taskId, changes: [], rolledBack: false },
          steps: [],
          summary: "done",
          reactTrace: [
            {
              turnIndex: 0,
              thought: "inspect",
              observation: "ok",
              status: "completed"
            }
          ],
          turnCount: 1
        } satisfies ExecutionResult
      );
    } finally {
      store.close();
    }

    await writeFile(
      inputPath,
      JSON.stringify(
        {
          query: {
            type: "react_trace",
            taskId: "task-query"
          },
          runtimeOptions: {
            auditDbPath
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const code = await runCli(["--input-json", inputPath, "--output-json", outputPath]);
    expect(code).toBe(0);

    const output = JSON.parse(await readFile(outputPath, "utf8")) as {
      query?: { type?: string };
      turns?: Array<{ thought?: string; observation?: string }>;
    };
    expect(output.query?.type).toBe("react_trace");
    expect(output.turns?.length).toBe(1);
    expect(output.turns?.[0]?.thought).toBe("inspect");
    expect(output.turns?.[0]?.observation).toBe("ok");
  });

  it("supports turn-run status query mode", async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "in-turn-run-query.json");
    const outputPath = path.join(dir, "out-turn-run-query.json");
    const stateDbPath = path.join(dir, "state.db");

    const store = new SqliteAgentStateStore({ dbPath: stateDbPath });
    const service = new AgentSessionService({
      store,
      modelGateway: {
        decideTurn: async () => ({
          mode: "chat",
          goal: "answer the user",
          requiresDocument: false,
          needsClarification: false,
          clarificationKind: "none",
          clarificationReason: ""
        }),
        respondToConversation: async () => "已完成",
        respondToDocumentObservation: async () => "unused",
        respondToClarification: async () => "unused"
      },
      runtimeFactory: () => {
        throw new Error("not used");
      },
      observeDocument: async () => ({
        document_meta: { total_paragraphs: 0, total_tables: 0 },
        nodes: []
      })
    });

    try {
      await service.submitUserTurn({
        sessionId: "chat-main",
        userInput: "查询最新运行状态"
      });
    } finally {
      store.close();
    }

    await writeFile(
      inputPath,
      JSON.stringify(
        {
          command: {
            type: "get_turn_run_status",
            sessionId: "chat-main"
          },
          runtimeOptions: {
            stateDbPath
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const code = await runCli(["--input-json", inputPath, "--output-json", outputPath]);
    expect(code).toBe(0);

    const output = JSON.parse(await readFile(outputPath, "utf8")) as {
      turnRun?: { sessionId?: string; status?: string; mode?: string; steps?: Array<{ id?: string }> };
    };
    expect(output.turnRun?.sessionId).toBe("chat-main");
    expect(output.turnRun?.status).toBe("completed");
    expect(output.turnRun?.mode).toBe("chat");
    expect(output.turnRun?.steps?.map((step) => step.id)).toEqual(["decide_mode", "generate_reply"]);
  });

  it("hydrates document nodes from inputDocxPath before execution", async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "in-hydrate.json");
    const outputPath = path.join(dir, "out-hydrate.json");
    const auditDbPath = path.join(dir, "audit-hydrate.db");
    const sourceDocxPath = path.join(dir, "source.docx");
    await writeSimpleDocx(sourceDocxPath, "from-docx");

    await writeFile(
      inputPath,
      JSON.stringify(
        {
          goal: "hydrate doc",
          document: {
            id: "doc-hydrate",
            version: "v1",
            nodes: [{ id: "placeholder", text: "placeholder" }],
            metadata: { inputDocxPath: sourceDocxPath }
          },
          runtimeOptions: {
            auditDbPath,
            dryRun: true
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const code = await runCli(["--input-json", inputPath, "--output-json", outputPath]);
    expect(code).toBe(0);

    const output = JSON.parse(await readFile(outputPath, "utf8")) as {
      finalDoc?: { nodes?: Array<{ id: string; text: string }> };
    };
    expect(output.finalDoc?.nodes?.some((n) => n.text.includes("from-docx"))).toBe(true);
  });

  it("hydrates run-level node ids and preserves parsed style fields", async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "in-run-hydrate.json");
    const outputPath = path.join(dir, "out-run-hydrate.json");
    const auditDbPath = path.join(dir, "audit-run-hydrate.db");
    const sourceDocxPath = path.join(dir, "styled.docx");
    await writeStyledRunDocx(sourceDocxPath, "styled-text", { fontName: "Consolas", halfPointSize: 22 });

    await writeFile(
      inputPath,
      JSON.stringify(
        {
          goal: "hydrate doc",
          document: {
            id: "doc-hydrate",
            version: "v1",
            nodes: [{ id: "placeholder", text: "placeholder" }],
            metadata: { inputDocxPath: sourceDocxPath }
          },
          runtimeOptions: {
            auditDbPath,
            dryRun: true
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const code = await runCli(["--input-json", inputPath, "--output-json", outputPath]);
    expect(code).toBe(0);

    const output = JSON.parse(await readFile(outputPath, "utf8")) as {
      finalDoc?: {
        nodes?: Array<{ id: string; text: string; style?: Record<string, unknown> }>;
      };
    };
    expect(output.finalDoc?.nodes?.[0]?.id).toBe("p_0_r_0");
    expect(output.finalDoc?.nodes?.[0]?.text).toContain("styled-text");
    expect(output.finalDoc?.nodes?.[0]?.style?.font_size_pt).toBe(11);
    expect(output.finalDoc?.nodes?.[0]?.style?.operation).toBe("set_font");
  });

  it("writes structured turn-decision errors for submit_turn commands", async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "in-command.json");
    const outputPath = path.join(dir, "out-command.json");
    const stateDbPath = path.join(dir, "state.db");

    await writeFile(
      inputPath,
      JSON.stringify(
        {
          command: {
            type: "submit_turn",
            sessionId: "chat-main",
            userInput: "你好"
          },
          runtimeOptions: {
            stateDbPath
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const code = await runCliWithDeps(["--input-json", inputPath, "--output-json", outputPath], {
      createSessionService: (store) =>
        new AgentSessionService({
          store,
          modelGateway: {
            decideTurn: async () => ({ mode: "chat", requiresDocument: false } as never),
            respondToConversation: async () => "unused",
            respondToDocumentObservation: async () => "unused",
            respondToClarification: async () => "unused"
          },
          runtimeFactory: () => ({
            run: async () => {
              throw new Error("runtime should not execute");
            }
          }),
          observeDocument: async () => ({
            document_meta: { total_paragraphs: 0, total_tables: 0 },
            nodes: []
          })
        })
    });

    expect(code).toBe(1);
    const output = JSON.parse(await readFile(outputPath, "utf8")) as {
      error?: { code?: string; message?: string };
    };
    expect(output.error?.code).toBe("E_TURN_DECISION_INVALID");
    expect(output.error?.message).toContain("goal is required");
    expect(output.error?.message).not.toContain("NOT NULL");
  });

  it("supports create_session and list_sessions commands", async () => {
    const dir = await makeTempDir();
    const createInputPath = path.join(dir, "in-create.json");
    const createOutputPath = path.join(dir, "out-create.json");
    const listInputPath = path.join(dir, "in-list.json");
    const listOutputPath = path.join(dir, "out-list.json");
    const stateDbPath = path.join(dir, "state.db");

    await writeFile(
      createInputPath,
      JSON.stringify(
        {
          command: {
            type: "create_session",
            sessionId: "chat-main"
          },
          runtimeOptions: {
            stateDbPath
          }
        },
        null,
        2
      ),
      "utf8"
    );

    expect(await runCli(["--input-json", createInputPath, "--output-json", createOutputPath])).toBe(0);
    const createOutput = JSON.parse(await readFile(createOutputPath, "utf8")) as {
      session?: { sessionId?: string; turns?: unknown[] };
    };
    expect(createOutput.session?.sessionId).toBe("chat-main");
    expect(createOutput.session?.turns).toEqual([]);

    await writeFile(
      listInputPath,
      JSON.stringify(
        {
          command: {
            type: "list_sessions"
          },
          runtimeOptions: {
            stateDbPath
          }
        },
        null,
        2
      ),
      "utf8"
    );

    expect(await runCli(["--input-json", listInputPath, "--output-json", listOutputPath])).toBe(0);
    const listOutput = JSON.parse(await readFile(listOutputPath, "utf8")) as {
      sessions?: Array<{ sessionId?: string; title?: string }>;
    };
    expect(listOutput.sessions).toEqual([
      {
        sessionId: "chat-main",
        title: "chat-main",
        updatedAt: expect.any(Number),
        hasAttachedDocument: false
      }
    ]);
  });

  it("accepts update_session commands and updates persisted session title", async () => {
    const dir = await makeTempDir();
    const createInputPath = path.join(dir, "in-create-update.json");
    const createOutputPath = path.join(dir, "out-create-update.json");
    const updateInputPath = path.join(dir, "in-update.json");
    const updateOutputPath = path.join(dir, "out-update.json");
    const getInputPath = path.join(dir, "in-get-update.json");
    const getOutputPath = path.join(dir, "out-get-update.json");
    const stateDbPath = path.join(dir, "state.db");

    await writeFile(
      createInputPath,
      JSON.stringify(
        {
          command: {
            type: "create_session",
            sessionId: "chat-main"
          },
          runtimeOptions: {
            stateDbPath
          }
        },
        null,
        2
      ),
      "utf8"
    );
    expect(await runCli(["--input-json", createInputPath, "--output-json", createOutputPath])).toBe(0);

    await writeFile(
      updateInputPath,
      JSON.stringify(
        {
          command: {
            type: "update_session",
            sessionId: "chat-main",
            title: "新的标题"
          },
          runtimeOptions: {
            stateDbPath
          }
        },
        null,
        2
      ),
      "utf8"
    );
    expect(await runCli(["--input-json", updateInputPath, "--output-json", updateOutputPath])).toBe(0);

    const updateOutput = JSON.parse(await readFile(updateOutputPath, "utf8")) as {
      session?: { sessionId?: string; title?: string };
    };
    expect(updateOutput.session?.sessionId).toBe("chat-main");
    expect(updateOutput.session?.title).toBe("新的标题");

    await writeFile(
      getInputPath,
      JSON.stringify(
        {
          command: {
            type: "get_session",
            sessionId: "chat-main"
          },
          runtimeOptions: {
            stateDbPath
          }
        },
        null,
        2
      ),
      "utf8"
    );
    expect(await runCli(["--input-json", getInputPath, "--output-json", getOutputPath])).toBe(0);

    const getOutput = JSON.parse(await readFile(getOutputPath, "utf8")) as {
      session?: { title?: string };
    };
    expect(getOutput.session?.title).toBe("新的标题");
  });

  it("accepts delete_session commands and removes persisted sessions", async () => {
    const dir = await makeTempDir();
    const createInputPath = path.join(dir, "in-create-delete.json");
    const createOutputPath = path.join(dir, "out-create-delete.json");
    const deleteInputPath = path.join(dir, "in-delete.json");
    const deleteOutputPath = path.join(dir, "out-delete.json");
    const listInputPath = path.join(dir, "in-list-delete.json");
    const listOutputPath = path.join(dir, "out-list-delete.json");
    const stateDbPath = path.join(dir, "state.db");

    await writeFile(
      createInputPath,
      JSON.stringify(
        {
          command: {
            type: "create_session",
            sessionId: "chat-main"
          },
          runtimeOptions: {
            stateDbPath
          }
        },
        null,
        2
      ),
      "utf8"
    );
    expect(await runCli(["--input-json", createInputPath, "--output-json", createOutputPath])).toBe(0);

    await writeFile(
      deleteInputPath,
      JSON.stringify(
        {
          command: {
            type: "delete_session",
            sessionId: "chat-main"
          },
          runtimeOptions: {
            stateDbPath
          }
        },
        null,
        2
      ),
      "utf8"
    );
    expect(await runCli(["--input-json", deleteInputPath, "--output-json", deleteOutputPath])).toBe(0);

    const deleteOutput = JSON.parse(await readFile(deleteOutputPath, "utf8")) as {
      deletedSessionId?: string;
    };
    expect(deleteOutput.deletedSessionId).toBe("chat-main");

    await writeFile(
      listInputPath,
      JSON.stringify(
        {
          command: {
            type: "list_sessions"
          },
          runtimeOptions: {
            stateDbPath
          }
        },
        null,
        2
      ),
      "utf8"
    );
    expect(await runCli(["--input-json", listInputPath, "--output-json", listOutputPath])).toBe(0);

    const listOutput = JSON.parse(await readFile(listOutputPath, "utf8")) as {
      sessions?: Array<{ sessionId?: string }>;
    };
    expect(listOutput.sessions).toEqual([]);
  });

  it("exports a single shared command set covering rename and delete session commands", () => {
    expect(SESSION_COMMAND_TYPES).toEqual([
      "create_session",
      "list_sessions",
      "submit_turn",
      "attach_document",
      "get_session",
      "get_turn_run_status",
      "update_session",
      "delete_session"
    ]);
  });
});
