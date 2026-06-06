import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { AgentState, RuntimeCheckpointer } from "./contracts.js";

export class SqliteCheckpointer implements RuntimeCheckpointer {
  private readonly saver: SqliteSaver;
  private readonly db: Database.Database;

  constructor(sqlitePath: string) {
    this.db = new Database(sqlitePath);
    this.saver = new SqliteSaver(this.db);
  }

  async load(threadId: string): Promise<AgentState | undefined> {
    const tuple = await this.saver.getTuple({
      configurable: {
        thread_id: threadId
      }
    });
    const value = tuple?.checkpoint?.channel_values?.state;
    return value as AgentState | undefined;
  }

  async save(threadId: string, state: AgentState): Promise<void> {
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
