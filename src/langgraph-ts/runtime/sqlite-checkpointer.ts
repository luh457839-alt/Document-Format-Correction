import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { Phase3AgentState, Phase3Checkpointer } from "./contracts.js";

export class Phase3SqliteCheckpointer implements Phase3Checkpointer {
  private readonly saver: SqliteSaver;
  private readonly db: Database.Database;

  constructor(sqlitePath: string) {
    this.db = new Database(sqlitePath);
    this.saver = new SqliteSaver(this.db);
  }

  async load(threadId: string): Promise<Phase3AgentState | undefined> {
    const tuple = await this.saver.getTuple({
      configurable: {
        thread_id: threadId
      }
    });
    const value = tuple?.checkpoint?.channel_values?.state;
    return value as Phase3AgentState | undefined;
  }

  async save(threadId: string, state: Phase3AgentState): Promise<void> {
    await this.saver.put(
      {
        configurable: {
          thread_id: threadId
        }
      },
      {
        v: 1,
        id: `${Date.now()}`,
        ts: new Date().toISOString(),
        channel_values: {
          state
        },
        channel_versions: {
          state: Date.now()
        },
        versions_seen: {}
      },
      {
        source: "update",
        step: -1,
        parents: {}
      }
    );
  }

  close(): void {
    this.db.close();
  }
}
