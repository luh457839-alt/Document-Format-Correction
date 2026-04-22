import { asAppError } from "../core/errors.js";
import { JsonConsoleLogger, type Logger } from "../core/logger.js";
import type {
  AppliedChange,
  ChangeSet,
  ConfirmationDecision,
  DocumentIR,
  ExecutionEvent,
  ExecutionResult,
  Executor,
  ExecutorOptions,
  PendingConfirmation,
  Plan,
  PlanStep,
  StepResult,
  Tool,
  ToolExecutionOutput,
  ToolRegistry
} from "../core/types.js";
import type { RiskPolicy } from "../core/types.js";
import type { IdempotencyStore } from "./idempotency.js";
import { InMemoryIdempotencyStore } from "./idempotency.js";

interface ExecutorDeps {
  toolRegistry: ToolRegistry;
  riskPolicy?: RiskPolicy;
  logger?: Logger;
  idempotencyStore?: IdempotencyStore;
}

export class DefaultExecutor implements Executor {
  private readonly toolRegistry: ToolRegistry;
  private readonly riskPolicy?: RiskPolicy;
  private readonly logger: Logger;
  private readonly idempotencyStore: IdempotencyStore;
  private readonly rollbackTools = new Map<string, Tool>();

  constructor(deps: ExecutorDeps) {
    this.toolRegistry = deps.toolRegistry;
    this.riskPolicy = deps.riskPolicy;
    this.logger = deps.logger ?? new JsonConsoleLogger();
    this.idempotencyStore = deps.idempotencyStore ?? new InMemoryIdempotencyStore();
  }

  async execute(plan: Plan, initialDoc: DocumentIR, opts: ExecutorOptions = {}): Promise<ExecutionResult> {
    const options: NormalizedExecutorOptions = {
      dryRun: opts.dryRun ?? false,
      maxConcurrentReadOnly: opts.maxConcurrentReadOnly ?? 4,
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 60000,
      budgetDeadlineMs: opts.budgetDeadlineMs,
      defaultRetryLimit: opts.defaultRetryLimit ?? 1,
      retryBackoffMs: opts.retryBackoffMs ?? 50,
      confirmStep: opts.confirmStep,
      onExecutionEvent: opts.onExecutionEvent
    };
    const stepResults: StepResult[] = [];
    const changes: AppliedChange[] = [];
    let doc = structuredClone(initialDoc);

    await this.emitEvent(options, {
      type: "run_started",
      taskId: plan.taskId,
      status: "running",
      payload: { goal: plan.goal, stepCount: plan.steps.length },
      createdAt: Date.now()
    });

    try {
      for (let i = 0; i < plan.steps.length; ) {
        const step = plan.steps[i];
        if (step.readOnly) {
          const batch: PlanStep[] = [];
          while (i < plan.steps.length && plan.steps[i].readOnly) {
            batch.push(plan.steps[i]);
            i += 1;
          }
          const readResults = await this.runReadOnlyBatch(
            batch,
            plan.taskId,
            doc,
            options,
            stepResults
          );
          if (readResults.pendingConfirmation) {
            const changeSet: ChangeSet = { taskId: plan.taskId, changes, rolledBack: false };
            await this.emitEvent(options, {
              type: "run_waiting_user",
              taskId: plan.taskId,
              status: "waiting_user",
              payload: { pendingConfirmation: readResults.pendingConfirmation },
              createdAt: Date.now()
            });
            return {
              status: "waiting_user",
              finalDoc: doc,
              changeSet,
              steps: stepResults,
              summary: `Waiting user confirmation for step ${readResults.pendingConfirmation.step.id}`,
              pendingConfirmation: readResults.pendingConfirmation
            };
          }
          for (const out of readResults.outputs) {
            doc = out.doc;
          }
          continue;
        }

        i += 1;
        const execution = await this.executeOneStep(step, plan.taskId, doc, options);
        stepResults.push(execution.stepResult);
        if (execution.stepResult.status === "failed") throw execution.stepResult.error;
        if (execution.stepResult.status === "waiting_user") {
          const changeSet: ChangeSet = { taskId: plan.taskId, changes, rolledBack: false };
          await this.emitEvent(options, {
            type: "run_waiting_user",
            taskId: plan.taskId,
            status: "waiting_user",
            payload: { pendingConfirmation: execution.pendingConfirmation },
            createdAt: Date.now()
          });
          return {
            status: "waiting_user",
            finalDoc: doc,
            changeSet,
            steps: stepResults,
            summary: `Waiting user confirmation for step ${step.id}`,
            pendingConfirmation: execution.pendingConfirmation
          };
        }
        if (execution.stepResult.status === "skipped") continue;
        doc = execution.output!.doc;
        changes.push({
          stepId: step.id,
          operation: step.operation,
          summary: execution.output!.summary,
          rollbackToken: execution.output!.rollbackToken
        });
      }

      const changeSet: ChangeSet = { taskId: plan.taskId, changes, rolledBack: false };
      await this.emitEvent(options, {
        type: "run_completed",
        taskId: plan.taskId,
        status: "completed",
        payload: { changeCount: changes.length },
        createdAt: Date.now()
      });
      return {
        status: "completed",
        finalDoc: doc,
        changeSet,
        steps: stepResults,
        summary: `${changes.length} change(s) applied`
      };
    } catch (err) {
      const failedError = asAppError(err, "E_EXECUTION_FAILED");
      if (changes.length > 0 && !options.dryRun) {
        const changeSet: ChangeSet = { taskId: plan.taskId, changes, rolledBack: false };
        doc = await this.rollback(changeSet, doc);
        changeSet.rolledBack = true;
        await this.emitEvent(options, {
          type: "run_rolled_back",
          taskId: plan.taskId,
          status: "rolled_back",
          payload: { error: failedError, changeCount: changes.length },
          createdAt: Date.now()
        });
        return {
          status: "rolled_back",
          finalDoc: doc,
          changeSet,
          steps: stepResults,
          summary: `Execution failed: ${failedError.message}; rollback completed`
        };
      }
      await this.emitEvent(options, {
        type: "run_failed",
        taskId: plan.taskId,
        status: "failed",
        payload: { error: failedError },
        createdAt: Date.now()
      });
      return {
        status: "failed",
        finalDoc: doc,
        changeSet: { taskId: plan.taskId, changes, rolledBack: false },
        steps: stepResults,
        summary: `Execution failed: ${failedError.message}`
      };
    }
  }

  async rollback(changeSet: ChangeSet, doc: DocumentIR): Promise<DocumentIR> {
    let current = structuredClone(doc);
    for (const change of [...changeSet.changes].reverse()) {
      const tool = this.rollbackTools.get(change.stepId);
      if (!tool || !tool.rollback || !change.rollbackToken) continue;
      current = await tool.rollback(change.rollbackToken, current);
    }
    return current;
  }

  private async runReadOnlyBatch(
    steps: PlanStep[],
    taskId: string,
    doc: DocumentIR,
    options: NormalizedExecutorOptions,
    stepResults: StepResult[]
  ): Promise<{ outputs: ToolExecutionOutput[]; pendingConfirmation?: PendingConfirmation }> {
    const outputs: ToolExecutionOutput[] = [];
    let pendingConfirmation: PendingConfirmation | undefined;
    let index = 0;
    while (index < steps.length) {
      const chunk = steps.slice(index, index + options.maxConcurrentReadOnly);
      index += options.maxConcurrentReadOnly;

      const results = await Promise.all(
        chunk.map((step) => this.executeOneStep(step, taskId, doc, options))
      );
      for (const res of results) {
        stepResults.push(res.stepResult);
        if (res.stepResult.status === "failed") throw res.stepResult.error;
        if (res.stepResult.status === "waiting_user") {
          pendingConfirmation = res.pendingConfirmation;
          break;
        }
        if (res.stepResult.status !== "skipped" && res.output) outputs.push(res.output);
      }
      if (pendingConfirmation) break;
    }
    return { outputs, pendingConfirmation };
  }

  private async executeOneStep(
    step: PlanStep,
    taskId: string,
    doc: DocumentIR,
    options: NormalizedExecutorOptions
  ): Promise<{ stepResult: StepResult; output?: ToolExecutionOutput; pendingConfirmation?: PendingConfirmation }> {
    const started = Date.now();
    await this.emitEvent(options, {
      type: "step_started",
      taskId,
      stepId: step.id,
      status: "running",
      payload: buildStepEventPayload(step),
      createdAt: started
    });

    const configuredTimeoutMs = step.timeoutMs ?? options.defaultTimeoutMs;
    const remainingBudgetMs =
      typeof options.budgetDeadlineMs === "number" ? Math.max(0, options.budgetDeadlineMs - Date.now()) : undefined;
    if (remainingBudgetMs !== undefined && remainingBudgetMs <= 0) {
      const budgetError = {
        code: "E_TASK_TIMEOUT",
        message: `Task budget exceeded before step ${step.id}.`,
        retryable: false
      };
      const durationMs = Date.now() - started;
      await this.emitEvent(options, {
        type: "step_failed",
        taskId,
        stepId: step.id,
        status: "failed",
        payload: buildStepEventPayload(step, { error: budgetError }),
        createdAt: Date.now()
      });
      return {
        stepResult: {
          stepId: step.id,
          status: "failed",
          retries: 0,
          durationMs,
          error: budgetError
        }
      };
    }
    const timeoutMs =
      remainingBudgetMs !== undefined ? Math.min(configuredTimeoutMs, remainingBudgetMs) : configuredTimeoutMs;
    const timeoutError =
      remainingBudgetMs !== undefined && remainingBudgetMs < configuredTimeoutMs
        ? {
            code: "E_TASK_TIMEOUT",
            message: `Task budget exceeded while executing step ${step.id}.`,
            retryable: false
          }
        : { code: "E_TIMEOUT", message: `Step timed out (${timeoutMs}ms).`, retryable: true };
    const retryLimit = step.retryLimit ?? options.defaultRetryLimit;
    let retries = 0;
    const tool = this.toolRegistry.get(step.toolName);

    if (this.riskPolicy?.requiresConfirmation(step)) {
      const decision = await this.resolveConfirmationDecision(step, options.confirmStep);
      if (decision === "pending") {
        const durationMs = Date.now() - started;
        await this.emitEvent(options, {
          type: "step_waiting_user",
          taskId,
          stepId: step.id,
          status: "waiting_user",
          payload: buildStepEventPayload(step, { reason: "Risk policy requires user confirmation." }),
          createdAt: Date.now()
        });
        return {
          stepResult: {
            stepId: step.id,
            status: "waiting_user",
            retries,
            durationMs,
            summary: "Waiting user confirmation"
          },
          pendingConfirmation: {
            step,
            reason: "Risk policy requires user confirmation.",
            resumeMode: "single_step"
          }
        };
      }
      if (decision === "rejected") {
        const durationMs = Date.now() - started;
        await this.emitEvent(options, {
          type: "step_failed",
          taskId,
          stepId: step.id,
          status: "failed",
          payload: buildStepEventPayload(step, {
            error: { code: "E_POLICY_REJECTED", message: "Risk policy rejected step." }
          }),
          createdAt: Date.now()
        });
        return {
          stepResult: {
            stepId: step.id,
            status: "failed",
            retries,
            durationMs,
            error: { code: "E_POLICY_REJECTED", message: "Risk policy rejected step.", retryable: false }
          }
        };
      }
    }

    if (!step.readOnly && this.idempotencyStore.has(step.idempotencyKey)) {
      const result: StepResult = {
        stepId: step.id,
        status: "skipped",
        retries,
        durationMs: Date.now() - started,
        summary: "Skipped by idempotency key"
      };
      await this.emitEvent(options, {
        type: "step_skipped",
        taskId,
        stepId: step.id,
        status: "skipped",
        payload: buildStepEventPayload(step, { reason: result.summary }),
        createdAt: Date.now()
      });
      this.log(taskId, step.id, result.status, result.durationMs, result.summary);
      return { stepResult: result };
    }

    while (retries <= retryLimit) {
      try {
        const input = {
          doc: structuredClone(doc),
          operation: step.operation,
          context: { taskId, stepId: step.id, dryRun: options.dryRun }
        };
        await tool.validate(input);
        const output = await this.withTimeout(tool.execute(input), timeoutMs, timeoutError);
        const durationMs = Date.now() - started;
        if (!step.readOnly) {
          this.idempotencyStore.add(step.idempotencyKey);
          this.rollbackTools.set(step.id, tool);
        }
        const stepResult: StepResult = {
          stepId: step.id,
          status: "success",
          retries,
          durationMs,
          summary: output.summary,
          rollbackToken: output.rollbackToken
        };
        await this.emitEvent(options, {
          type: "step_succeeded",
          taskId,
          stepId: step.id,
          status: "success",
          payload: buildStepEventPayload(step, {
            summary: output.summary,
            rollbackToken: output.rollbackToken
          }),
          createdAt: Date.now()
        });
        this.log(taskId, step.id, stepResult.status, durationMs, output.summary);
        return { stepResult, output };
      } catch (err) {
        const appErr = asAppError(err, "E_STEP_FAILED");
        const canRetry = appErr.retryable && retries < retryLimit;
        if (canRetry) {
          retries += 1;
          await this.sleep(options.retryBackoffMs);
          continue;
        }
        const durationMs = Date.now() - started;
        const stepResult: StepResult = {
          stepId: step.id,
          status: "failed",
          retries,
          durationMs,
          error: appErr
        };
        await this.emitEvent(options, {
          type: "step_failed",
          taskId,
          stepId: step.id,
          status: "failed",
          payload: buildStepEventPayload(step, { error: appErr }),
          createdAt: Date.now()
        });
        this.log(taskId, step.id, stepResult.status, durationMs, appErr.message);
        return { stepResult };
      }
    }
    const exhaustedResult: StepResult = {
      stepId: step.id,
      status: "failed",
      retries,
      durationMs: Date.now() - started,
      error: { code: "E_RETRY_EXHAUSTED", message: "Retry exhausted", retryable: false }
    };
    await this.emitEvent(options, {
      type: "step_failed",
      taskId,
      stepId: step.id,
      status: "failed",
      payload: buildStepEventPayload(step, { error: exhaustedResult.error }),
      createdAt: Date.now()
    });
    return { stepResult: exhaustedResult };
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutError: { code: string; message: string; retryable: boolean }
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(timeoutError);
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async resolveConfirmationDecision(
    step: PlanStep,
    confirmStep?: (step: PlanStep) => Promise<ConfirmationDecision>
  ): Promise<ConfirmationDecision> {
    if (!confirmStep) {
      return "pending";
    }
    return await confirmStep(step);
  }

  private log(taskId: string, stepId: string, status: string, durationMs: number, message?: string): void {
    this.logger.log({ taskId, stepId, status, durationMs, message });
  }

  private async emitEvent(options: NormalizedExecutorOptions, event: ExecutionEvent): Promise<void> {
    if (!options.onExecutionEvent) return;
    await options.onExecutionEvent(event);
  }
}

interface NormalizedExecutorOptions {
  dryRun: boolean;
  maxConcurrentReadOnly: number;
  defaultTimeoutMs: number;
  budgetDeadlineMs?: number;
  defaultRetryLimit: number;
  retryBackoffMs: number;
  confirmStep?: (step: PlanStep) => Promise<ConfirmationDecision>;
  onExecutionEvent?: (event: ExecutionEvent) => Promise<void> | void;
}

function buildStepEventPayload(step: PlanStep, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const targetNodeIds = step.operation?.targetNodeIds;
  const targetCount = Array.isArray(targetNodeIds) && targetNodeIds.length > 0 ? targetNodeIds.length : step.operation?.targetNodeId ? 1 : undefined;
  return {
    toolName: step.toolName,
    readOnly: step.readOnly,
    operationType: step.operation?.type,
    targetNodeId: step.operation?.targetNodeId,
    targetNodeIds,
    targetCount,
    targetSelector: step.operation?.sourceTargetSelector ?? step.operation?.targetSelector,
    ...extra
  };
}
