import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AgentError, asAppError } from "../core/errors.js";
import type { DocumentIR, ExecutionResult, ReActTraceQuery, ReActTurnRecord } from "../core/types.js";
import { createMvpRuntime } from "./engine.js";
import { FixedPlanner } from "../planner/fixed-planner.js";
import { resolvePlannerRuntimeMode } from "../planner/llm-planner.js";
import { SqliteTaskAuditStore } from "./audit/sqlite-task-audit-store.js";
import type { RuntimeMode, RuntimeRunOptions } from "./engine.js";
import { hydrateDocumentFromInputDocx } from "./document-state.js";
import { AgentSessionService } from "./session-service.js";
import { SqliteAgentStateStore } from "./state/sqlite-agent-state-store.js";

interface CliArgs {
  inputJsonPath: string;
  outputJsonPath: string;
}

interface CliInput {
  taskId?: string;
  goal: string;
  document: DocumentIR;
  runtimeOptions?: {
    dryRun?: boolean;
    maxConcurrentReadOnly?: number;
    defaultTimeoutMs?: number;
    defaultRetryLimit?: number;
    taskTimeoutMs?: number | null;
    useLlmPlanner?: boolean;
    runtimeMode?: RuntimeMode;
    maxTurns?: number;
    confirmationDecision?: "approved" | "rejected" | "pending";
    auditDbPath?: string;
  };
}

interface CliTraceQueryInput {
  query: {
    type: "react_trace";
    taskId?: string;
    runId?: string;
    limit?: number;
    offset?: number;
  };
  runtimeOptions?: {
    auditDbPath?: string;
  };
}

export const SESSION_COMMAND_TYPES = [
  "create_session",
  "list_sessions",
  "submit_turn",
  "attach_document",
  "get_session",
  "get_turn_run_status",
  "update_session",
  "delete_session"
] as const;

type SessionCommandType = (typeof SESSION_COMMAND_TYPES)[number];

interface CliCommandInput {
  command: {
    type: SessionCommandType;
    sessionId?: string;
    userInput?: string;
    docxPath?: string;
    title?: string;
    turnRunId?: string;
    forceMode?: "chat" | "inspect" | "execute";
  };
  runtimeOptions?: {
    auditDbPath?: string;
    stateDbPath?: string;
  };
}

interface CliOutput {
  taskId: string;
  goal: string;
  status: ExecutionResult["status"];
  summary: string;
  changeSet: ExecutionResult["changeSet"];
  steps: ExecutionResult["steps"];
  pendingConfirmation?: ExecutionResult["pendingConfirmation"];
  finalDoc: ExecutionResult["finalDoc"];
  reactTrace?: ExecutionResult["reactTrace"];
  turnCount?: number;
}

interface CliTraceQueryOutput {
  query: {
    type: "react_trace";
    taskId?: string;
    runId?: string;
    limit: number;
    offset: number;
  };
  turns: ReActTurnRecord[];
}

interface CliErrorOutput {
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export async function runCli(argv: string[]): Promise<number> {
  return await runCliWithDeps(argv);
}

export interface RuntimeCliDeps {
  createSessionService?: (store: SqliteAgentStateStore, input: CliCommandInput) => AgentSessionService;
}

const COMMAND_HANDLERS: Record<
  SessionCommandType,
  (service: AgentSessionService, input: CliCommandInput) => Promise<unknown>
> = {
  create_session: async (service, input) => await service.createSession(String(input.command.sessionId ?? "")),
  list_sessions: async (service) => await service.listSessions(),
  submit_turn: async (service, input) =>
    await service.submitUserTurn({
      sessionId: String(input.command.sessionId ?? ""),
      userInput: String(input.command.userInput ?? ""),
      forceMode: input.command.forceMode
    }),
  attach_document: async (service, input) =>
    await service.attachDocument(String(input.command.sessionId ?? ""), String(input.command.docxPath ?? "")),
  get_session: async (service, input) => ({
    session: await service.getSessionState(String(input.command.sessionId ?? ""))
  }),
  get_turn_run_status: async (service, input) =>
    await service.getTurnRunStatus({
      sessionId: typeof input.command.sessionId === "string" ? input.command.sessionId : undefined,
      turnRunId: typeof input.command.turnRunId === "string" ? input.command.turnRunId : undefined
    }),
  update_session: async (service, input) =>
    await service.updateSessionTitle(String(input.command.sessionId ?? ""), String(input.command.title ?? "")),
  delete_session: async (service, input) => await service.deleteSession(String(input.command.sessionId ?? ""))
};

export async function runCliWithDeps(argv: string[], deps: RuntimeCliDeps = {}): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    const info = asAppError(err, "E_CLI_ARGS");
    console.error(`${info.code}: ${info.message}`);
    return 1;
  }

  try {
    const inputText = await readFile(args.inputJsonPath, "utf8");
    const input = parseCliInput(inputText);
    const auditStore = new SqliteTaskAuditStore(
      "runtimeOptions" in input && input.runtimeOptions?.auditDbPath
        ? { dbPath: input.runtimeOptions.auditDbPath }
        : undefined
    );

    try {
      if (isCommandInput(input)) {
        const stateStore = new SqliteAgentStateStore({
          dbPath: input.runtimeOptions?.stateDbPath ?? input.runtimeOptions?.auditDbPath
        });
        try {
          const service =
            deps.createSessionService?.(stateStore, input) ?? new AgentSessionService({ store: stateStore });
          const output = await COMMAND_HANDLERS[input.command.type](service, input);
          await writeFile(args.outputJsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
          return 0;
        } finally {
          stateStore.close();
        }
      }

      if (isTraceQueryInput(input)) {
        const query = normalizeReActTraceQuery(input.query);
        const turns = await auditStore.listReActTurns(query);
        const output: CliTraceQueryOutput = {
          query: {
            type: "react_trace",
            taskId: query.taskId,
            runId: query.runId,
            limit: query.limit ?? 50,
            offset: query.offset ?? 0
          },
          turns
        };
        await writeFile(args.outputJsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
        return 0;
      }

      const runtimeMode =
        input.runtimeOptions?.runtimeMode ??
        (input.runtimeOptions?.useLlmPlanner ? resolvePlannerRuntimeMode({}, process.env) : "plan_once");
      const hydratedDoc = await hydrateDocumentFromInputDocx(input.document);
      const runtime = input.runtimeOptions?.useLlmPlanner
        ? createMvpRuntime({
            auditStore,
            runtimeMode
          })
        : createMvpRuntime({
            planner: new FixedPlanner(),
            auditStore,
            runtimeMode
          });

      const options: RuntimeRunOptions = {
        dryRun: input.runtimeOptions?.dryRun,
        maxConcurrentReadOnly: input.runtimeOptions?.maxConcurrentReadOnly,
        defaultTimeoutMs: normalizeNullableInteger(
          input.runtimeOptions?.defaultTimeoutMs,
          undefined,
          0,
          Number.MAX_SAFE_INTEGER
        ),
        defaultRetryLimit: normalizeInteger(input.runtimeOptions?.defaultRetryLimit, 2, 0, 10),
        taskTimeoutMs: normalizeNullableInteger(
          input.runtimeOptions?.taskTimeoutMs,
          null,
          0,
          Number.MAX_SAFE_INTEGER
        ),
        runtimeMode,
        maxTurns: input.runtimeOptions?.maxTurns,
        taskId: input.taskId,
        confirmStep:
          input.runtimeOptions?.confirmationDecision !== undefined
            ? async () => input.runtimeOptions?.confirmationDecision ?? "pending"
            : undefined
      };
      const result = await runtime.run(input.goal, hydratedDoc, options);
      const output: CliOutput = {
        taskId: result.changeSet.taskId,
        goal: input.goal,
        status: result.status,
        summary: result.summary,
        changeSet: result.changeSet,
        steps: result.steps,
        pendingConfirmation: result.pendingConfirmation,
        finalDoc: result.finalDoc,
        reactTrace: result.reactTrace,
        turnCount: result.turnCount
      };

      await writeFile(args.outputJsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
      return 0;
    } finally {
      auditStore.close();
    }
  } catch (err) {
    const info = asAppError(err, "E_TS_AGENT_CLI_FAILED");
    const output: CliErrorOutput = {
      error: {
        code: info.code,
        message: info.message,
        retryable: info.retryable
      }
    };
    try {
      await writeFile(args.outputJsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    } catch {
      // no-op: keep original error signal via exit code
    }
    return 1;
  }
}

function parseArgs(argv: string[]): CliArgs {
  let inputJsonPath = "";
  let outputJsonPath = "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input-json") {
      inputJsonPath = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--output-json") {
      outputJsonPath = argv[i + 1] ?? "";
      i += 1;
    }
  }

  if (!inputJsonPath || !outputJsonPath) {
    throw new AgentError({
      code: "E_CLI_ARGS",
      message: "Usage: --input-json <path> --output-json <path>",
      retryable: false
    });
  }

  return { inputJsonPath, outputJsonPath };
}

function parseCliInput(text: string): CliInput | CliTraceQueryInput | CliCommandInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AgentError({
      code: "E_CLI_INPUT_PARSE",
      message: `Invalid input JSON: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new AgentError({
      code: "E_CLI_INPUT_INVALID",
      message: "CLI input must be a JSON object.",
      retryable: false
    });
  }

  const raw = parsed as {
    taskId?: unknown;
    goal?: unknown;
    document?: unknown;
    query?: unknown;
    command?: unknown;
    runtimeOptions?: unknown;
  };

  if (isObject(raw.query)) {
    const queryType = raw.query.type;
    if (queryType !== "react_trace") {
      throw new AgentError({
        code: "E_CLI_INPUT_INVALID",
        message: "CLI query.type must be react_trace.",
        retryable: false
      });
    }
    return {
      query: raw.query as CliTraceQueryInput["query"],
      runtimeOptions: isObject(raw.runtimeOptions)
        ? (raw.runtimeOptions as CliTraceQueryInput["runtimeOptions"])
        : undefined
    };
  }

  if (isObject(raw.command)) {
    const commandType = raw.command.type;
    if (!isSessionCommandType(commandType)) {
      throw new AgentError({
        code: "E_CLI_INPUT_INVALID",
        message: "CLI command.type is invalid.",
        retryable: false
      });
    }
    return {
      command: raw.command as CliCommandInput["command"],
      runtimeOptions: isObject(raw.runtimeOptions)
        ? (raw.runtimeOptions as CliCommandInput["runtimeOptions"])
        : undefined
    };
  }

  if (typeof raw.goal !== "string" || !raw.goal.trim()) {
    throw new AgentError({
      code: "E_CLI_INPUT_INVALID",
      message: "CLI input requires a non-empty goal.",
      retryable: false
    });
  }
  if (!isDocumentIr(raw.document)) {
    throw new AgentError({
      code: "E_CLI_INPUT_INVALID",
      message: "CLI input requires a valid document object.",
      retryable: false
    });
  }

  return {
    taskId: typeof raw.taskId === "string" && raw.taskId.trim() ? raw.taskId.trim() : undefined,
    goal: raw.goal.trim(),
    document: raw.document,
    runtimeOptions: isObject(raw.runtimeOptions)
      ? (raw.runtimeOptions as CliInput["runtimeOptions"])
      : undefined
  };
}

function isDocumentIr(value: unknown): value is DocumentIR {
  if (!isObject(value)) {
    return false;
  }
  if (typeof value.id !== "string" || typeof value.version !== "string") {
    return false;
  }
  if (!Array.isArray(value.nodes)) {
    return false;
  }
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSessionCommandType(value: unknown): value is SessionCommandType {
  return typeof value === "string" && SESSION_COMMAND_TYPES.includes(value as SessionCommandType);
}

function isTraceQueryInput(input: CliInput | CliTraceQueryInput | CliCommandInput): input is CliTraceQueryInput {
  return isObject(input) && "query" in input;
}

function isCommandInput(input: CliInput | CliTraceQueryInput | CliCommandInput): input is CliCommandInput {
  return isObject(input) && "command" in input;
}

function normalizeReActTraceQuery(query: CliTraceQueryInput["query"]): ReActTraceQuery {
  const taskId = typeof query.taskId === "string" ? query.taskId.trim() : "";
  const runId = typeof query.runId === "string" ? query.runId.trim() : "";
  if (!taskId && !runId) {
    throw new AgentError({
      code: "E_CLI_INPUT_INVALID",
      message: "react_trace query requires taskId or runId.",
      retryable: false
    });
  }
  return {
    taskId: taskId || undefined,
    runId: runId || undefined,
    limit: normalizeInteger(query.limit, 50, 1, 200),
    offset: normalizeInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  };
}

function normalizeInteger(
  value: unknown,
  defaultValue: number,
  minValue: number,
  maxValue: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  const rounded = Math.floor(value);
  if (rounded < minValue) return minValue;
  if (rounded > maxValue) return maxValue;
  return rounded;
}

function normalizeNullableInteger<T extends number | null | undefined>(
  value: unknown,
  defaultValue: T,
  minValue: number,
  maxValue: number
): number | T {
  if (value === null) {
    return null as T;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  const rounded = Math.floor(value);
  if (rounded < minValue) return minValue;
  if (rounded > maxValue) return maxValue;
  return rounded;
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && currentFilePath === process.argv[1]) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const info = asAppError(err, "E_TS_AGENT_CLI_FATAL");
      console.error(`${info.code}: ${info.message}`);
      process.exitCode = 1;
    });
}
