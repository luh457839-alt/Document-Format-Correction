import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { AgentError } from "../../core/errors.js";
import { getSessionsDir } from "../../core/project-paths.js";
import { isAgentTurnMode, type AgentTurnMode } from "../model-gateway.js";

export interface AgentSessionDocument {
  path: string;
  importedAt: number;
}

export interface AgentTurnRecord {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface AgentGoalRecord {
  goal: string;
  mode: AgentTurnMode;
  status: "active" | "completed" | "failed";
  updatedAt: number;
}

export interface AgentSessionSnapshot {
  sessionId: string;
  title: string;
  updatedAt: number;
  attachedDocument?: AgentSessionDocument;
  turns: AgentTurnRecord[];
  activeGoal?: AgentGoalRecord;
}

export interface AgentSessionListItem {
  sessionId: string;
  title: string;
  updatedAt: number;
  hasAttachedDocument: boolean;
  activeGoalSummary?: string;
}

export interface SqliteAgentStateStoreOptions {
  dbPath?: string;
  busyTimeoutMs?: number;
}

const AGENT_GOAL_STATUSES = ["active", "completed", "failed"] as const;

export class SqliteAgentStateStore {
  private readonly db: Database.Database;

  constructor(options: SqliteAgentStateStoreOptions = {}) {
    const dbPath = options.dbPath ?? path.join(getSessionsDir(), "ts_agent_runtime.db");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    this.initializeTables();
  }

  async createSession(sessionId: string): Promise<AgentSessionSnapshot> {
    const normalizedSessionId = normalizeStateRequired(sessionId, "sessionId");
    await this.ensureSession(normalizedSessionId);
    return await this.getSession(normalizedSessionId);
  }

  async ensureSession(sessionId: string): Promise<void> {
    const normalizedSessionId = normalizeStateRequired(sessionId, "sessionId");
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO agent_sessions(session_id, title, attached_document_path, attached_document_imported_at, updated_at)
         VALUES (?, ?, NULL, NULL, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           title = CASE
             WHEN agent_sessions.title IS NULL OR TRIM(agent_sessions.title) = '' THEN excluded.title
             ELSE agent_sessions.title
           END`
      )
      .run(normalizedSessionId, normalizedSessionId, now);
  }

  async attachDocument(sessionId: string, docxPath: string): Promise<AgentSessionSnapshot> {
    const now = Date.now();
    await this.ensureSession(sessionId);
    this.db
      .prepare(
        `UPDATE agent_sessions
         SET attached_document_path = ?, attached_document_imported_at = ?, updated_at = ?
         WHERE session_id = ?`
      )
      .run(docxPath, now, now, sessionId);
    return await this.getSession(sessionId);
  }

  async appendTurn(sessionId: string, role: AgentTurnRecord["role"], content: string): Promise<void> {
    const now = Date.now();
    await this.ensureSession(sessionId);
    this.db
      .prepare(
        `INSERT INTO agent_turns(session_id, role, content, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(sessionId, role, content, now);
    this.db
      .prepare(`UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?`)
      .run(now, sessionId);
  }

  async saveGoal(sessionId: string, goal: string, mode: AgentTurnMode, status: AgentGoalRecord["status"]): Promise<void> {
    const normalizedSessionId = normalizeStateRequired(sessionId, "sessionId");
    const normalizedGoal = normalizeStateRequired(goal, "goal");
    if (!isAgentTurnMode(mode)) {
      throw invalidState("mode must be chat | inspect | execute");
    }
    if (!isGoalStatus(status)) {
      throw invalidState("status must be active | completed | failed");
    }

    const now = Date.now();
    await this.ensureSession(normalizedSessionId);
    this.db
      .prepare(
        `INSERT INTO agent_goals(session_id, goal, mode, status, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           goal = excluded.goal,
           mode = excluded.mode,
           status = excluded.status,
           updated_at = excluded.updated_at`
      )
      .run(normalizedSessionId, normalizedGoal, mode, status, now);
    this.db
      .prepare(`UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?`)
      .run(now, normalizedSessionId);
  }

  async getSession(sessionId: string): Promise<AgentSessionSnapshot> {
    const normalizedSessionId = normalizeStateRequired(sessionId, "sessionId");
    const sessionRow = this.db
      .prepare(
        `SELECT session_id, title, attached_document_path, attached_document_imported_at, updated_at
         FROM agent_sessions
         WHERE session_id = ?`
      )
      .get(normalizedSessionId) as
      | {
          session_id: string;
          title: string | null;
          attached_document_path: string | null;
          attached_document_imported_at: number | null;
          updated_at: number;
        }
      | undefined;

    if (!sessionRow) {
      throw missingSession(normalizedSessionId);
    }

    const turns = this.db
      .prepare(
        `SELECT id, role, content, created_at
         FROM agent_turns
         WHERE session_id = ?
         ORDER BY id ASC`
      )
      .all(normalizedSessionId) as Array<{
      id: number;
      role: AgentTurnRecord["role"];
      content: string;
      created_at: number;
    }>;

    const goalRow = this.db
      .prepare(
        `SELECT goal, mode, status, updated_at
         FROM agent_goals
         WHERE session_id = ?`
      )
      .get(normalizedSessionId) as
      | {
          goal: string;
          mode: AgentTurnMode;
          status: AgentGoalRecord["status"];
          updated_at: number;
        }
      | undefined;

    return {
      sessionId: sessionRow.session_id,
      title: normalizeStoredTitle(sessionRow.title, sessionRow.session_id),
      updatedAt: sessionRow.updated_at,
      attachedDocument:
        sessionRow.attached_document_path && sessionRow.attached_document_imported_at
          ? {
              path: sessionRow.attached_document_path,
              importedAt: sessionRow.attached_document_imported_at
            }
          : undefined,
      turns: turns.map((turn) => ({
        id: turn.id,
        role: turn.role,
        content: turn.content,
        createdAt: turn.created_at
      })),
      activeGoal: goalRow
        ? {
            goal: goalRow.goal,
            mode: goalRow.mode,
            status: goalRow.status,
            updatedAt: goalRow.updated_at
          }
        : undefined
    };
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<AgentSessionSnapshot> {
    const normalizedSessionId = normalizeStateRequired(sessionId, "sessionId");
    const normalizedTitle = normalizeStateRequired(title, "title");
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE agent_sessions
         SET title = ?, updated_at = ?
         WHERE session_id = ?`
      )
      .run(normalizedTitle, now, normalizedSessionId);
    if (result.changes === 0) {
      throw missingSession(normalizedSessionId);
    }
    return await this.getSession(normalizedSessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const normalizedSessionId = normalizeStateRequired(sessionId, "sessionId");
    const deleteTransaction = this.db.transaction((targetSessionId: string) => {
      this.db.prepare(`DELETE FROM agent_turns WHERE session_id = ?`).run(targetSessionId);
      this.db.prepare(`DELETE FROM agent_goals WHERE session_id = ?`).run(targetSessionId);
      const result = this.db.prepare(`DELETE FROM agent_sessions WHERE session_id = ?`).run(targetSessionId);
      if (result.changes === 0) {
        throw missingSession(targetSessionId);
      }
    });
    deleteTransaction(normalizedSessionId);
  }

  async listSessions(): Promise<AgentSessionListItem[]> {
    const rows = this.db
      .prepare(
        `SELECT s.session_id, s.title, s.updated_at, s.attached_document_path, g.goal
         FROM agent_sessions s
         LEFT JOIN agent_goals g ON g.session_id = s.session_id
         ORDER BY s.updated_at DESC, s.session_id ASC`
      )
      .all() as Array<{
      session_id: string;
      title: string | null;
      updated_at: number;
      attached_document_path: string | null;
      goal: string | null;
    }>;

    return rows.map((row) => ({
      sessionId: row.session_id,
      title: normalizeStoredTitle(row.title, row.session_id),
      updatedAt: row.updated_at,
      hasAttachedDocument: Boolean(row.attached_document_path),
      activeGoalSummary: row.goal ?? undefined
    }));
  }

  close(): void {
    this.db.close();
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        title TEXT,
        attached_document_path TEXT,
        attached_document_imported_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_turns_session_id ON agent_turns(session_id, id);

      CREATE TABLE IF NOT EXISTS agent_goals (
        session_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.ensureAgentSessionsTitleColumn();
  }

  private ensureAgentSessionsTitleColumn(): void {
    const columns = this.db.prepare(`PRAGMA table_info(agent_sessions)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "title")) {
      this.db.exec(`ALTER TABLE agent_sessions ADD COLUMN title TEXT`);
    }
    this.db.exec(`UPDATE agent_sessions SET title = session_id WHERE title IS NULL OR TRIM(title) = ''`);
  }
}

function normalizeStateRequired(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw invalidState(`${fieldName} is required`);
  }
  return normalized;
}

function invalidState(message: string): AgentError {
  return new AgentError({
    code: "E_AGENT_STATE_INVALID",
    message,
    retryable: false
  });
}

function missingSession(sessionId: string): AgentError {
  return new AgentError({
    code: "E_SESSION_NOT_FOUND",
    message: `session '${sessionId}' does not exist`,
    retryable: false
  });
}

function normalizeStoredTitle(title: string | null, sessionId: string): string {
  const normalizedTitle = typeof title === "string" ? title.trim() : "";
  return normalizedTitle || sessionId;
}

function isGoalStatus(value: unknown): value is AgentGoalRecord["status"] {
  return typeof value === "string" && AGENT_GOAL_STATUSES.includes(value as AgentGoalRecord["status"]);
}
