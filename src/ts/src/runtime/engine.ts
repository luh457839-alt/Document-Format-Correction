import { AgentError, asAppError } from "../core/errors.js";
import { summarizeChangeSet } from "../diff/summary.js";
import { DefaultExecutor } from "../executor/default-executor.js";
import { LlmPlanner, resolvePlannerRuntimeMode } from "../planner/llm-planner.js";
import { LlmReActPlanner } from "../planner/llm-react-planner.js";
import { WriteOperationTool } from "../tools/mock-tools.js";
import { materializeDocumentWithPython } from "../tools/python-tool-client.js";
import {
  buildDocxObservationTool,
  buildInspectDocumentTool,
  buildWriteOperationTool
} from "../tools/python-tool-proxy.js";
import { InMemoryToolRegistry } from "../tools/tool-registry.js";
import { DefaultValidator } from "../validator/default-validator.js";
import type {
  AppliedChange,
  AuditStoreConfig,
  ConversationMessage,
  ConfirmationDecision,
  DocumentIR,
  ExecutionResult,
  Executor,
  ExecutorOptions,
  PersistentPendingTask,
  Plan,
  PlanStep,
  Planner,
  PlannerModelConfig,
  ReActPlanner,
  ReActTraceQuery,
  ReActTurnRecord,
  ReActTraceItem,
  TaskAuditStore,
  Validator
} from "../core/types.js";
import { SqliteTaskAuditStore } from "./audit/sqlite-task-audit-store.js";
import { DefaultRiskPolicy } from "./policy.js";
import { expandPlanSelectors } from "./selector-expander.js";

export type RuntimeMode = "react_loop" | "plan_once";

export interface RuntimeRunOptions extends ExecutorOptions {
  runtimeMode?: RuntimeMode;
  maxTurns?: number;
  taskId?: string;
  sessionContext?: ConversationMessage[];
}

export interface RuntimeDeps {
  planner?: Planner;
  reactPlanner?: ReActPlanner;
  plannerConfig?: Partial<PlannerModelConfig>;
  executor?: Executor;
  validator?: Validator;
  auditStore?: TaskAuditStore;
  auditConfig?: Partial<AuditStoreConfig>;
  runtimeMode?: RuntimeMode;
  defaultMaxTurns?: number;
  useMockWriteTool?: boolean;
  pythonBin?: string;
  pythonToolRunnerPath?: string;
  pythonToolTimeoutMs?: number;
}

export class AgentRuntime {
  constructor(
    private readonly planner: Planner | undefined,
    private readonly executor: Executor,
    private readonly validator: Validator,
    private readonly auditStore?: TaskAuditStore,
    private readonly reactPlanner?: ReActPlanner,
    private readonly defaultRuntimeMode: RuntimeMode = "plan_once",
    private readonly defaultMaxTurns = 8,
    private readonly materializeDocument?: (doc: DocumentIR) => Promise<{ summary: string }>
  ) {}

  async run(goal: string, doc: DocumentIR, options?: RuntimeRunOptions): Promise<ExecutionResult> {
    const mode = options?.runtimeMode ?? this.defaultRuntimeMode;
    if (mode === "react_loop") {
      return await this.runReActLoop(goal, doc, options);
    }
    return await this.runPlanOnce(goal, doc, options);
  }

  async runSingleStep(
    step: PlanStep,
    doc: DocumentIR,
    options?: ExecutorOptions,
    taskId?: string
  ): Promise<ExecutionResult> {
    const plan: Plan = {
      taskId: taskId ?? `task_${doc.id}_resume_${step.id}`,
      goal: `resume_step:${step.id}`,
      steps: [step]
    };
    return await this.runConcretePlan(plan, doc, options, false);
  }

  async getPendingTask(taskId: string): Promise<PersistentPendingTask | null> {
    if (!this.auditStore) {
      return null;
    }
    return await this.auditStore.getPendingTask(taskId);
  }

  async resumePendingTask(
    taskId: string,
    decision: Exclude<ConfirmationDecision, "pending">,
    options?: ExecutorOptions
  ): Promise<ExecutionResult> {
    if (!this.auditStore) {
      throw new AgentError({
        code: "E_AUDIT_STORE_REQUIRED",
        message: "Audit store is required for resumePendingTask.",
        retryable: false
      });
    }

    const pending = await this.auditStore.getPendingTask(taskId);
    if (!pending) {
      throw new AgentError({
        code: "E_PENDING_TASK_NOT_FOUND",
        message: `No unresolved pending task found for taskId=${taskId}.`,
        retryable: false
      });
    }

    if (decision === "rejected") {
      const rejectedResult = buildRejectedResult(taskId, pending.docSnapshot, pending.pendingConfirmation.step.id);
      const runId = await this.auditStore.startRun(
        {
          taskId,
          goal: `resume_rejected:${pending.pendingConfirmation.step.id}`,
          steps: [pending.pendingConfirmation.step]
        },
        pending.docSnapshot
      );
      await this.auditStore.finalizeRun(
        runId,
        {
          taskId,
          goal: `resume_rejected:${pending.pendingConfirmation.step.id}`,
          steps: [pending.pendingConfirmation.step]
        },
        rejectedResult
      );
      await this.auditStore.resolvePendingTask(taskId);
      return rejectedResult;
    }

    const mergedOptions: ExecutorOptions = {
      ...options,
      confirmStep: async () => "approved"
    };
    const result = await this.runSingleStep(
      pending.pendingConfirmation.step,
      pending.docSnapshot,
      mergedOptions,
      taskId
    );
    await this.auditStore.resolvePendingTask(taskId);
    return result;
  }

  async queryReActTrace(query: ReActTraceQuery): Promise<ReActTurnRecord[]> {
    if (!this.auditStore) {
      throw new AgentError({
        code: "E_AUDIT_STORE_REQUIRED",
        message: "Audit store is required for queryReActTrace.",
        retryable: false
      });
    }
    return await this.auditStore.listReActTurns(query);
  }

  private async runPlanOnce(
    goal: string,
    doc: DocumentIR,
    options?: RuntimeRunOptions
  ): Promise<ExecutionResult> {
    if (!this.planner) {
      throw new AgentError({
        code: "E_PLANNER_REQUIRED",
        message: "Planner is required for plan_once mode.",
        retryable: false
      });
    }
    const plan = expandPlanSelectors(await this.planner.createPlan(goal, doc), doc);
    return await this.runConcretePlan(plan, doc, options);
  }

  private async runConcretePlan(
    plan: Plan,
    doc: DocumentIR,
    options?: ExecutorOptions,
    materializeOnCompletion = true
  ): Promise<ExecutionResult> {
    const concretePlan = expandPlanSelectors(plan, doc);
    const runId = this.auditStore ? await this.auditStore.startRun(concretePlan, doc) : undefined;
    let latestDoc = structuredClone(doc);
    const mergedOptions: ExecutorOptions = {
      ...options,
      onExecutionEvent: async (event) => {
        if (options?.onExecutionEvent) {
          await options.onExecutionEvent(event);
        }
        if (runId && this.auditStore) {
          await this.auditStore.appendEvent(runId, event);
        }
      }
    };

    try {
      await this.validator.preValidate(concretePlan, doc);
      const result = await this.executor.execute(concretePlan, doc, mergedOptions);
      latestDoc = result.finalDoc;
      await this.validator.postValidate(result.changeSet, result.finalDoc);
      const materializeSummary = materializeOnCompletion
        ? await this.materializeFinalDocumentIfNeeded(result.finalDoc, mergedOptions)
        : undefined;
      result.summary = `${result.summary}\n${summarizeChangeSet(result.changeSet)}${
        materializeSummary ? `\n${materializeSummary}` : ""
      }`;
      if (runId && this.auditStore) {
        await this.auditStore.finalizeRun(runId, concretePlan, result);
      }
      return result;
    } catch (err) {
      if (runId && this.auditStore) {
        const failedResult = buildRuntimeFailedResult(concretePlan, latestDoc, err);
        await this.auditStore.finalizeRun(runId, concretePlan, failedResult);
      }
      throw err;
    }
  }

  private async runReActLoop(
    goal: string,
    initialDoc: DocumentIR,
    options?: RuntimeRunOptions
  ): Promise<ExecutionResult> {
    if (!this.reactPlanner) {
      throw new AgentError({
        code: "E_REACT_PLANNER_REQUIRED",
        message: "ReAct planner is required for react_loop mode.",
        retryable: false
      });
    }
    const maxTurns = options?.maxTurns ?? this.defaultMaxTurns;
    const taskId = options?.taskId?.trim() || `task_${initialDoc.id}`;
    const bootstrapPlan: Plan = {
      taskId,
      goal,
      steps: []
    };
    const runId = this.auditStore ? await this.auditStore.startRun(bootstrapPlan, initialDoc) : undefined;
    const mergedOptions: ExecutorOptions = {
      ...options,
      onExecutionEvent: async (event) => {
        if (options?.onExecutionEvent) {
          await options.onExecutionEvent(event);
        }
        if (runId && this.auditStore) {
          await this.auditStore.appendEvent(runId, event);
        }
      }
    };

    const trace: ReActTraceItem[] = [];
    const steps = [];
    const changes: AppliedChange[] = [];
    let doc = structuredClone(initialDoc);

    try {
      for (let turn = 0; turn < maxTurns; turn += 1) {
        const decision = await this.reactPlanner.decideNext({
          taskId,
          goal,
          turnIndex: turn,
          doc,
          history: trace,
          sessionContext: options?.sessionContext
        });

        if (decision.kind === "finish") {
          const materializeSummary = await this.materializeFinalDocumentIfNeeded(doc, mergedOptions);
          const result: ExecutionResult = {
            status: "completed",
            finalDoc: doc,
            changeSet: { taskId, changes, rolledBack: false },
            steps,
            summary: `${decision.summary}\n${summarizeChangeSet({ taskId, changes, rolledBack: false })}${
              materializeSummary ? `\n${materializeSummary}` : ""
            }`,
            reactTrace: trace,
            turnCount: trace.length
          };
          if (runId && this.auditStore) {
            await this.auditStore.finalizeRun(runId, bootstrapPlan, result);
          }
          return result;
        }

        const singleStepPlan: Plan = {
          taskId,
          goal,
          steps: [decision.step]
        };
        const concreteStepPlan = expandPlanSelectors(singleStepPlan, doc);
        await this.validator.preValidate(concreteStepPlan, doc);
        const stepRun = await this.executor.execute(concreteStepPlan, doc, mergedOptions);
        await this.validator.postValidate(stepRun.changeSet, stepRun.finalDoc);

        steps.push(...stepRun.steps);
        const observation = buildObservation(stepRun);
        trace.push({
          turnIndex: turn,
          thought: decision.thought,
          action: decision.step,
          observation,
          status: stepRun.status
        });

        if (stepRun.status === "completed") {
          doc = stepRun.finalDoc;
          changes.push(...stepRun.changeSet.changes);
          continue;
        }

        const earlyResult: ExecutionResult = {
          status: stepRun.status,
          finalDoc: stepRun.finalDoc,
          changeSet: { taskId, changes, rolledBack: stepRun.changeSet.rolledBack },
          steps,
          summary: stepRun.summary,
          pendingConfirmation: stepRun.pendingConfirmation,
          reactTrace: trace,
          turnCount: trace.length
        };
        if (runId && this.auditStore) {
          await this.auditStore.finalizeRun(runId, bootstrapPlan, earlyResult);
        }
        return earlyResult;
      }

      const maxTurnResult: ExecutionResult = {
        status: "failed",
        finalDoc: doc,
        changeSet: { taskId, changes, rolledBack: false },
        steps,
        summary: `ReAct loop exceeded maxTurns=${maxTurns}`,
        reactTrace: trace,
        turnCount: trace.length
      };
      if (runId && this.auditStore) {
        await this.auditStore.finalizeRun(runId, bootstrapPlan, maxTurnResult);
      }
      return maxTurnResult;
    } catch (err) {
      if (runId && this.auditStore) {
        const failedResult = buildRuntimeFailedResult(bootstrapPlan, doc, err, trace, steps, changes);
        await this.auditStore.finalizeRun(runId, bootstrapPlan, failedResult);
      }
      throw err;
    }
  }

  private async materializeFinalDocumentIfNeeded(
    doc: DocumentIR,
    options: ExecutorOptions
  ): Promise<string | undefined> {
    if (options.dryRun || !this.materializeDocument) {
      return undefined;
    }
    const outputDocxPath = readOutputDocxPath(doc);
    if (!outputDocxPath) {
      return undefined;
    }
    const result = await this.materializeDocument(doc);
    return result.summary;
  }
}

export function createMvpRuntime(deps: RuntimeDeps = {}): AgentRuntime {
  const registry = new InMemoryToolRegistry();
  registry.register(
    buildInspectDocumentTool({
      pythonBin: deps.pythonBin,
      runnerPath: deps.pythonToolRunnerPath,
      timeoutMs: deps.pythonToolTimeoutMs
    })
  );
  registry.register(
    buildDocxObservationTool({
      pythonBin: deps.pythonBin,
      runnerPath: deps.pythonToolRunnerPath,
      timeoutMs: deps.pythonToolTimeoutMs
    })
  );
  registry.register(
    deps.useMockWriteTool
      ? new WriteOperationTool()
      : buildWriteOperationTool({
          pythonBin: deps.pythonBin,
          runnerPath: deps.pythonToolRunnerPath,
          timeoutMs: deps.pythonToolTimeoutMs
        })
  );

  const defaultMode: RuntimeMode =
    deps.runtimeMode ??
    (deps.planner ? "plan_once" : deps.reactPlanner ? "react_loop" : resolvePlannerRuntimeMode(deps.plannerConfig));
  const planner =
    deps.planner ?? (defaultMode === "plan_once" ? new LlmPlanner({ config: deps.plannerConfig }) : undefined);
  const reactPlanner =
    deps.reactPlanner ??
    (defaultMode === "react_loop" ? new LlmReActPlanner({ config: deps.plannerConfig }) : undefined);

  const validator = deps.validator ?? new DefaultValidator();
  const executor =
    deps.executor ??
    new DefaultExecutor({
      toolRegistry: registry,
      riskPolicy: new DefaultRiskPolicy()
    });
  const auditStore = deps.auditStore ?? new SqliteTaskAuditStore(deps.auditConfig);
  return new AgentRuntime(
    planner,
    executor,
    validator,
    auditStore,
    reactPlanner,
    defaultMode,
    deps.defaultMaxTurns ?? 8,
    deps.useMockWriteTool
      ? undefined
      : async (doc: DocumentIR) =>
          await materializeDocumentWithPython(doc, {
            pythonBin: deps.pythonBin,
            runnerPath: deps.pythonToolRunnerPath,
            timeoutMs: deps.pythonToolTimeoutMs
          })
  );
}

function readOutputDocxPath(doc: DocumentIR): string | undefined {
  const metadata = doc.metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const outputPath = (metadata as Record<string, unknown>).outputDocxPath;
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    return undefined;
  }
  return outputPath.trim();
}

function buildRuntimeFailedResult(
  plan: Plan,
  initialDoc: DocumentIR,
  err: unknown,
  reactTrace?: ReActTraceItem[],
  steps: ExecutionResult["steps"] = [],
  changes: AppliedChange[] = []
): ExecutionResult {
  const appErr = asAppError(err, "E_RUNTIME_FAILED");
  return {
    status: "failed",
    finalDoc: structuredClone(initialDoc),
    changeSet: { taskId: plan.taskId, changes, rolledBack: false },
    steps,
    summary: `Runtime failed: ${appErr.message}`,
    reactTrace,
    turnCount: reactTrace?.length
  };
}

function buildRejectedResult(taskId: string, doc: DocumentIR, stepId: string): ExecutionResult {
  return {
    status: "failed",
    finalDoc: structuredClone(doc),
    changeSet: { taskId, changes: [], rolledBack: false },
    steps: [
      {
        stepId,
        status: "failed",
        retries: 0,
        durationMs: 0,
        error: {
          code: "E_USER_REJECTED",
          message: "User rejected pending confirmation step.",
          retryable: false
        }
      }
    ],
    summary: `Pending confirmation step ${stepId} rejected by user`
  };
}

function buildObservation(stepRun: ExecutionResult): string {
  const firstStep = stepRun.steps[stepRun.steps.length - 1];
  const stepSummary = firstStep?.summary?.trim();
  if (stepSummary) {
    return stepSummary;
  }
  return stepRun.summary;
}
