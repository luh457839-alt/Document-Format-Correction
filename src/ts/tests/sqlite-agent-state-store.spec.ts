import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteAgentStateStore } from "../src/runtime/state/sqlite-agent-state-store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ts-agent-state-"));
  tempDirs.push(dir);
  return dir;
}

describe("SqliteAgentStateStore", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("creates and lists explicit sessions without persisting missing-session reads", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });

    try {
      await store.createSession("chat-zeta");
      await store.createSession("chat-alpha");
      await store.attachDocument("chat-alpha", "D:/docs/sample.docx");
      await store.saveGoal("chat-alpha", "normalize formatting", "inspect", "active");
      await expect(store.getSession("read-only-session")).rejects.toMatchObject({
        info: expect.objectContaining({
          code: "E_SESSION_NOT_FOUND"
        })
      });

      const sessions = await store.listSessions();

      expect(sessions.map((session) => session.sessionId)).toEqual(["chat-alpha", "chat-zeta"]);
      expect(sessions[0]).toMatchObject({
        sessionId: "chat-alpha",
        title: "chat-alpha",
        hasAttachedDocument: true,
        activeGoalSummary: "normalize formatting"
      });
      expect(sessions[1]).toMatchObject({
        sessionId: "chat-zeta",
        title: "chat-zeta",
        hasAttachedDocument: false
      });
      expect(sessions.some((session) => session.sessionId === "read-only-session")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("rejects empty goal before touching sqlite constraints", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });

    try {
      await expect(store.saveGoal("session-1", "   ", "chat", "active")).rejects.toMatchObject({
        info: expect.objectContaining({
          code: "E_AGENT_STATE_INVALID",
          message: expect.stringContaining("goal is required")
        })
      });
    } finally {
      store.close();
    }
  });

  it("rejects invalid mode and status values", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });

    try {
      await expect(store.saveGoal("session-1", "do work", "plan" as never, "active")).rejects.toMatchObject({
        info: expect.objectContaining({
          code: "E_AGENT_STATE_INVALID",
          message: expect.stringContaining("mode")
        })
      });

      await expect(store.saveGoal("session-1", "do work", "chat", "queued" as never)).rejects.toMatchObject({
        info: expect.objectContaining({
          code: "E_AGENT_STATE_INVALID",
          message: expect.stringContaining("status")
        })
      });
    } finally {
      store.close();
    }
  });

  it("defaults runtime state db to root sessions directory", async () => {
    const dir = await makeTempDir();
    const previousCwd = process.cwd();
    const tsRoot = path.join(dir, "src", "ts");
    mkdirSync(tsRoot, { recursive: true });
    process.chdir(tsRoot);

    try {
      const store = new SqliteAgentStateStore();
      store.close();

      expect(existsSync(path.join(dir, "sessions", "ts_agent_runtime.db"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("persists renamed titles and deletes all session state", async () => {
    const dir = await makeTempDir();
    const store = new SqliteAgentStateStore({ dbPath: path.join(dir, "state.db") });

    try {
      await store.createSession("chat-main");
      await store.appendTurn("chat-main", "user", "hello");
      await store.appendTurn("chat-main", "assistant", "world");
      await store.attachDocument("chat-main", "D:/docs/sample.docx");
      await store.saveGoal("chat-main", "normalize formatting", "inspect", "completed");

      const renamed = await store.updateSessionTitle("chat-main", "项目例会纪要");
      expect(renamed.title).toBe("项目例会纪要");

      const listed = await store.listSessions();
      expect(listed[0]).toMatchObject({
        sessionId: "chat-main",
        title: "项目例会纪要"
      });

      await store.deleteSession("chat-main");
      await expect(store.getSession("chat-main")).rejects.toMatchObject({
        info: expect.objectContaining({
          code: "E_SESSION_NOT_FOUND"
        })
      });
      await expect(store.deleteSession("chat-main")).rejects.toMatchObject({
        info: expect.objectContaining({
          code: "E_SESSION_NOT_FOUND"
        })
      });
      await expect(store.updateSessionTitle("chat-main", "another")).rejects.toMatchObject({
        info: expect.objectContaining({
          code: "E_SESSION_NOT_FOUND"
        })
      });
      expect(await store.listSessions()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
