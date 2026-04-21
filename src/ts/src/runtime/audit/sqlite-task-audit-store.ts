import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getSessionsDir } from "../../core/project-paths.js";
import type {
  AuditStoreConfig,
  DocumentIR,
  ExecutionEvent,
  ExecutionResult,
  PersistentPendingTask,
  PlanStep,
  Plan,
  ReActTraceQuery,
  ReActTurnRecord,
  TaskAuditStore
} from "../../core/types.js";

export interface SqliteTaskAuditStoreOptions extends Partial<AuditStoreConfig> {}

export class SqliteTaskAuditStore implements TaskAuditStore {
  private readonly db: Database.Database;

  constructor(config: SqliteTaskAuditStoreOptions = {}) {
    const dbPath = config.dbPath ?? path.join(getSessionsDir(), "ts_agent_runtime.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${config.busyTimeoutMs ?? 5000}`);
    this.initializeTables();
  }

  async startRun(plan: Plan, initialDoc: DocumentIR): Promise<string> {
    const now = Date.now();
    const runId = `${plan.taskId}_${now}_${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO task_runs(
          run_id, task_id, goal, status, plan_json, initial_doc_json, updated_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        runId,
        plan.taskId,
        plan.goal,
        "running",
        JSON.stringify(plan),
        JSON.stringify(initialDoc),
        now,
        now
      );
    return runId;
  }

  async appendEvent(runId: string, event: ExecutionEvent): Promise<void> {
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM task_events WHERE run_id = ?")
      .get(runId) as { max_seq: number } | undefined;
    const seq = (seqRow?.max_seq ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO task_events(
          run_id, seq, event_type, task_id, step_id, status, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        seq,
        event.type,
        event.taskId,
        event.stepId ?? null,
        event.status ?? null,
        safeJson(event.payload),
        event.createdAt
      );
  }

  async finalizeRun(runId: string, plan: Plan, result: ExecutionResult): Promise<void> {
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE task_runs
           SET status = ?,
               final_doc_json = ?,
               execution_result_json = ?,
               change_set_json = ?,
               pending_confirmation_json = ?,
               updated_at = ?,
               finished_at = ?
           WHERE run_id = ?`
        )
        .run(
          result.status,
          JSON.stringify(result.finalDoc),
          JSON.stringify(result),
          JSON.stringify(result.changeSet),
          safeJson(result.pendingConfirmation),
          now,
          now,
          runId
        );

      this.db.prepare(`DELETE FROM task_react_turns WHERE run_id = ?`).run(runId);
      for (const traceItem of result.reactTrace ?? []) {
        this.db
          .prepare(
            `INSERT INTO task_react_turns(
              run_id, task_id, turn_index, thought, action_json, observation, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            runId,
            plan.taskId,
            traceItem.turnIndex,
            traceItem.thought ?? null,
            safeJson(traceItem.action),
            traceItem.observation,
            traceItem.status,
            now
          );
      }

      if (result.status === "waiting_user" && result.pendingConfirmation) {
        this.db
          .prepare(
            `INSERT INTO task_resume_index(
              task_id, run_id, pending_confirmation_json, doc_json, updated_at, resolved_at
            ) VALUES (?, ?, ?, ?, ?, NULL)
            ON CONFLICT(task_id) DO UPDATE SET
              run_id = excluded.run_id,
              pending_confirmation_json = excluded.pending_confirmation_json,
              doc_json = excluded.doc_json,
              updated_at = excluded.updated_at,
              resolved_at = NULL`
          )
          .run(
            plan.taskId,
            runId,
            JSON.stringify(result.pendingConfirmation),
            JSON.stringify(result.finalDoc),
            now
          );
        return;
      }

      this.db
        .prepare(
          `UPDATE task_resume_index
           SET resolved_at = ?
           WHERE task_id = ? AND resolved_at IS NULL`
        )
        .run(now, plan.taskId);
    })();
  }

  async getPendingTask(taskId: string): Promise<PersistentPendingTask | null> {
    const row = this.db
      .prepare(
        `SELECT task_id, run_id, pending_confirmation_json, doc_json, updated_at
         FROM task_resume_index
         WHERE task_id = ? AND resolved_at IS NULL
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(taskId) as
      | {
          task_id: string;
          run_id: string;
          pending_confirmation_json: string;
          doc_json: string;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      taskId: row.task_id,
      runId: row.run_id,
      pendingConfirmation: JSON.parse(row.pending_confirmation_json),
      docSnapshot: JSON.parse(row.doc_json),
      updatedAt: row.updated_at
    };
  }

  async resolvePendingTask(taskId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE task_resume_index
         SET resolved_at = ?
         WHERE task_id = ? AND resolved_at IS NULL`
      )
      .run(Date.now(), taskId);
  }

  async listReActTurns(query: ReActTraceQuery): Promise<ReActTurnRecord[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (query.runId?.trim()) {
      clauses.push("run_id = ?");
      params.push(query.runId.trim());
    }
    if (query.taskId?.trim()) {
      clauses.push("task_id = ?");
      params.push(query.taskId.trim());
    }
    if (clauses.length === 0) {
      return [];
    }

    const limit = Math.max(1, Math.min(200, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT run_id, task_id, turn_index, thought, action_json, observation, status, created_at
         FROM task_react_turns
         ${where}
         ORDER BY created_at ASC, turn_index ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Array<{
      run_id: string;
      task_id: string;
      turn_index: number;
      thought: string | null;
      action_json: string | null;
      observation: string;
      status: ReActTurnRecord["status"];
      created_at: number;
    }>;

    return rows.map((row) => ({
      runId: row.run_id,
      taskId: row.task_id,
      turnIndex: row.turn_index,
      thought: row.thought ?? undefined,
      action: parseOptionalJson<PlanStep>(row.action_json),
      observation: row.observation,
      status: row.status,
      createdAt: row.created_at
    }));
  }

  close(): void {
    this.db.close();
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        initial_doc_json TEXT NOT NULL,
        final_doc_json TEXT,
        execution_result_json TEXT,
        change_set_json TEXT,
        pending_confirmation_json TEXT,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_task_id_updated ON task_runs(task_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS task_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        task_id TEXT NOT NULL,
        step_id TEXT,
        status TEXT,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_task_id_created ON task_events(task_id, created_at);

      CREATE TABLE IF NOT EXISTS task_resume_index (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        pending_confirmation_json TEXT NOT NULL,
        doc_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS task_react_turns (
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        thought TEXT,
        action_json TEXT,
        observation TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, turn_index)
      );
      CREATE INDEX IF NOT EXISTS idx_task_react_turns_task_created
        ON task_react_turns(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_react_turns_run_turn
        ON task_react_turns(run_id, turn_index);
    `);
  }
}

function safeJson(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function parseOptionalJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  return JSON.parse(value) as T;
}
