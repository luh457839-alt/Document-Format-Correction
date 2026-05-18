import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AIMessage } from "@langchain/core/messages";
import { Phase3SqliteCheckpointer } from "../runtime/sqlite-checkpointer.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "langgraph-phase3-sqlite-"));
  tempDirs.push(dir);
  return dir;
}

describe("phase 3 sqlite checkpointer", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("round-trips agent state with message restoration and executed patch keys", async () => {
    const dir = await makeTempDir();
    const sqlitePath = path.join(dir, "phase3-checkpoint.db");
    const checkpointer = new Phase3SqliteCheckpointer(sqlitePath);

    await checkpointer.save("thread-1", {
      messages: [
        new AIMessage({
          content: "checkpoint reply"
        })
      ] as never,
      mode: "chat",
      document_path: "input.docx",
      output_path: "output.docx",
      document_bundle: undefined,
      chat_projection: undefined,
      template_projection: undefined,
      template_config: undefined,
      semantic_tags: ["tag-a"],
      executed_patch_keys: ["idem-1"],
      diagnostics: [{ stage: "write_tool", executed: true }],
      artifact_refs: [{ kind: "docx", path: "output.docx" }]
    } as never);

    const restored = await checkpointer.load("thread-1");

    expect(restored).toBeDefined();
    const state = restored as {
      messages: AIMessage[];
      executed_patch_keys: string[];
      diagnostics: Array<Record<string, unknown>>;
      artifact_refs: Array<{ kind: string; path: string }>;
    };
    expect(state.executed_patch_keys).toEqual(["idem-1"]);
    expect(state.messages[0]).toBeInstanceOf(AIMessage);
    expect(state.messages[0].content).toBe("checkpoint reply");
    expect(state.diagnostics[0].stage).toBe("write_tool");
    expect(state.artifact_refs[0].path).toBe("output.docx");

    checkpointer.close();
  });
});
