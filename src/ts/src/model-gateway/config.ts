import { AgentError } from "../core/errors.js";
import type { ChatModelConfig, PlannerCompatMode, PlannerModelConfig } from "../core/types.js";

const DEFAULT_REMOTE_TIMEOUT_MS = 30000;
const DEFAULT_LOCAL_TIMEOUT_MS = 90000;

export function resolveChatModelConfig(
  override: Partial<ChatModelConfig> = {},
  env: NodeJS.ProcessEnv = process.env
): ChatModelConfig {
  const apiKey = pickString(override.apiKey, env.TS_AGENT_CHAT_API_KEY, env.OPENAI_API_KEY);
  const baseUrl = pickString(
    override.baseUrl,
    env.TS_AGENT_CHAT_BASE_URL,
    env.OPENAI_BASE_URL,
    "http://localhost:8080/v1"
  );
  const model = pickString(override.model, env.TS_AGENT_CHAT_MODEL, env.OPENAI_MODEL, "gpt-4o-mini");
  const preferLocalCompat = isLikelyLocalModelBackend(baseUrl, model);
  const timeoutMs = pickNumber(
    override.timeoutMs,
    env.TS_AGENT_CHAT_TIMEOUT_MS,
    preferLocalCompat ? DEFAULT_LOCAL_TIMEOUT_MS : DEFAULT_REMOTE_TIMEOUT_MS
  );
  const maxRetries = pickNumber(override.maxRetries, env.TS_AGENT_CHAT_MAX_RETRIES, 0);
  const temperature = pickNumber(override.temperature, env.TS_AGENT_CHAT_TEMPERATURE, 0);

  if (!apiKey) {
    throw new AgentError({
      code: "E_CHAT_CONFIG_MISSING",
      message: "LLM chat apiKey is missing. Set TS_AGENT_CHAT_API_KEY or OPENAI_API_KEY.",
      retryable: false
    });
  }
  if (!baseUrl) {
    throw new AgentError({
      code: "E_CHAT_CONFIG_MISSING",
      message: "LLM chat baseUrl is missing.",
      retryable: false
    });
  }
  if (!model) {
    throw new AgentError({
      code: "E_CHAT_CONFIG_MISSING",
      message: "LLM chat model is missing.",
      retryable: false
    });
  }

  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs,
    maxRetries,
    temperature
  };
}

export function resolvePlannerModelConfig(
  override: Partial<PlannerModelConfig> = {},
  env: NodeJS.ProcessEnv = process.env
): PlannerModelConfig {
  const apiKey = pickString(override.apiKey, env.TS_AGENT_PLANNER_API_KEY, env.OPENAI_API_KEY);
  const baseUrl = pickString(
    override.baseUrl,
    env.TS_AGENT_PLANNER_BASE_URL,
    env.OPENAI_BASE_URL,
    "http://localhost:8080/v1"
  );
  const model = pickString(override.model, env.TS_AGENT_PLANNER_MODEL, env.OPENAI_MODEL, "gpt-4o-mini");
  const compatMode = resolvePlannerCompatMode(override, env);
  const runtimeMode = resolvePlannerRuntimeMode({ ...override, baseUrl, model, compatMode }, env);
  const preferLocalCompat = compatMode !== "strict" && isLikelyLocalModelBackend(baseUrl, model);
  const timeoutMs = pickNumber(
    override.timeoutMs,
    env.TS_AGENT_PLANNER_TIMEOUT_MS,
    preferLocalCompat ? DEFAULT_LOCAL_TIMEOUT_MS : DEFAULT_REMOTE_TIMEOUT_MS
  );
  const maxRetries = pickNumber(override.maxRetries, env.TS_AGENT_PLANNER_MAX_RETRIES, 0);
  const temperature = pickNumber(override.temperature, env.TS_AGENT_PLANNER_TEMPERATURE, 0);
  const useJsonSchema = pickBoolean(
    override.useJsonSchema,
    env.TS_AGENT_PLANNER_USE_JSON_SCHEMA,
    preferLocalCompat ? false : true
  );
  const schemaStrict = pickBoolean(
    override.schemaStrict,
    env.TS_AGENT_PLANNER_SCHEMA_STRICT,
    useJsonSchema === false ? false : true
  );

  if (!apiKey) {
    throw new AgentError({
      code: "E_PLANNER_CONFIG_MISSING",
      message: "LLM planner apiKey is missing. Set TS_AGENT_PLANNER_API_KEY or OPENAI_API_KEY.",
      retryable: false
    });
  }
  if (!baseUrl) {
    throw new AgentError({
      code: "E_PLANNER_CONFIG_MISSING",
      message: "LLM planner baseUrl is missing.",
      retryable: false
    });
  }
  if (!model) {
    throw new AgentError({
      code: "E_PLANNER_CONFIG_MISSING",
      message: "LLM planner model is missing.",
      retryable: false
    });
  }

  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs,
    ...resolvePlannerRuntimeTuning(override, env),
    maxRetries,
    temperature,
    useJsonSchema,
    schemaStrict,
    compatMode,
    runtimeMode
  };
}

export function resolvePlannerRuntimeTuning(
  override: Partial<PlannerModelConfig> = {},
  env: NodeJS.ProcessEnv = process.env
): Pick<
  PlannerModelConfig,
  "stepTimeoutMs" | "taskTimeoutMs" | "pythonToolTimeoutMs" | "maxTurns" | "syncRequestTimeoutMs"
> {
  return {
    stepTimeoutMs: pickNumber(override.stepTimeoutMs, env.TS_AGENT_STEP_TIMEOUT_MS, 60000),
    taskTimeoutMs: pickOptionalNumber(override.taskTimeoutMs, env.TS_AGENT_TASK_TIMEOUT_MS),
    pythonToolTimeoutMs: pickOptionalNumber(
      override.pythonToolTimeoutMs,
      env.TS_AGENT_PYTHON_TOOL_TIMEOUT_MS
    ),
    maxTurns: pickNumber(override.maxTurns, env.TS_AGENT_MAX_TURNS, 24),
    syncRequestTimeoutMs: pickNumber(
      override.syncRequestTimeoutMs,
      env.TS_AGENT_SYNC_REQUEST_TIMEOUT_MS,
      300000
    )
  };
}

export function resolvePlannerRuntimeMode(
  override: Partial<PlannerModelConfig> = {},
  env: NodeJS.ProcessEnv = process.env
): "plan_once" | "react_loop" {
  const explicitMode = pickRuntimeMode(override.runtimeMode, env.TS_AGENT_PLANNER_RUNTIME_MODE);
  if (explicitMode) {
    return explicitMode;
  }
  const baseUrl = pickString(
    override.baseUrl,
    env.TS_AGENT_PLANNER_BASE_URL,
    env.OPENAI_BASE_URL,
    "http://localhost:8080/v1"
  );
  const model = pickString(override.model, env.TS_AGENT_PLANNER_MODEL, env.OPENAI_MODEL, "gpt-4o-mini");
  const compatMode = resolvePlannerCompatMode(override, env);
  return compatMode !== "strict" && isLikelyLocalModelBackend(baseUrl, model) ? "plan_once" : "react_loop";
}

function pickString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function pickNumber(...values: Array<number | string | undefined>): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function pickOptionalNumber(...values: Array<number | string | null | undefined>): number | undefined {
  for (const value of values) {
    if (value === null) {
      return undefined;
    }
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function pickBoolean(...values: Array<boolean | string | undefined>): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") {
        return true;
      }
      if (normalized === "false" || normalized === "0") {
        return false;
      }
    }
  }
  return undefined;
}

function pickRuntimeMode(...values: Array<"plan_once" | "react_loop" | string | undefined>) {
  for (const value of values) {
    if (value === "plan_once" || value === "react_loop") {
      return value;
    }
  }
  return undefined;
}

function resolvePlannerCompatMode(
  override: Partial<PlannerModelConfig>,
  env: NodeJS.ProcessEnv
): PlannerCompatMode {
  const raw = pickString(
    override.compatMode,
    env.TS_AGENT_PLANNER_COMPAT_MODE
  );
  return raw === "strict" ? "strict" : "auto";
}

function isLikelyLocalModelBackend(baseUrl: string | undefined, model: string | undefined): boolean {
  const normalizedBaseUrl = String(baseUrl ?? "").toLowerCase();
  const normalizedModel = String(model ?? "").toLowerCase();
  return (
    normalizedBaseUrl.includes("localhost") ||
    normalizedBaseUrl.includes("127.0.0.1") ||
    normalizedBaseUrl.includes("0.0.0.0") ||
    normalizedModel.startsWith("qwen") ||
    normalizedModel.startsWith("deepseek") ||
    normalizedModel.startsWith("glm") ||
    normalizedModel.startsWith("local-")
  );
}
