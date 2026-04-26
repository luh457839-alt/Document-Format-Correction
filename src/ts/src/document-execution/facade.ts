import { DefaultExecutor } from "../executor/default-executor.js";
import type {
  DocumentIR,
  ExecutionResult,
  Executor,
  ExecutorOptions,
  Operation,
  Plan,
  RiskPolicy,
  ToolRegistry,
  Validator
} from "../core/types.js";
import { DefaultValidator } from "../validator/default-validator.js";
import { DefaultRiskPolicy } from "../runtime/policy.js";
import {
  operationToWriteIntent,
  runUnifiedWritePipeline,
  type UnifiedWritePipelineInput,
  type UnifiedWritePipelineResult,
  type WriteIntent
} from "./unified-write-pipeline.js";
import { expandPlanSelectors } from "../runtime/selector-expander.js";

export interface ExecuteWritePlanOptions extends ExecutorOptions {
  taskId?: string;
  goal?: string;
}

export interface DocumentExecutionFacade {
  readonly executor: Executor;
  readonly validator: Validator;
  executePlan(plan: Plan, doc: DocumentIR, options?: ExecutorOptions): Promise<ExecutionResult>;
  executeWritePlan(
    writePlan: Operation[],
    doc: DocumentIR,
    options?: ExecuteWritePlanOptions
  ): Promise<ExecutionResult>;
  runUnifiedWritePipeline(input: UnifiedWritePipelineInput): Promise<UnifiedWritePipelineResult>;
}

export interface DocumentExecutionFacadeDeps {
  toolRegistry: ToolRegistry;
  executor?: Executor;
  validator?: Validator;
  riskPolicy?: RiskPolicy;
  materializeDocument?: (
    doc: DocumentIR
  ) => Promise<{ doc: DocumentIR; summary: string; artifacts?: Record<string, unknown> }>;
}

export function createDocumentExecutionFacade(
  deps: DocumentExecutionFacadeDeps
): DocumentExecutionFacade {
  const validator = deps.validator ?? new DefaultValidator();
  const executor =
    deps.executor ??
    new DefaultExecutor({
      toolRegistry: deps.toolRegistry,
      riskPolicy: deps.riskPolicy ?? new DefaultRiskPolicy()
    });

  return {
    executor,
    validator,
    executePlan: async (plan, doc, options) => {
      const concretePlan = expandPlanSelectors(plan, doc);
      await validator.preValidate(concretePlan, doc);
      const result = await executor.execute(concretePlan, doc, options);
      if (result.status === "completed") {
        await validator.postValidate(result.changeSet, result.finalDoc);
      }
      return result;
    },
    executeWritePlan: async (writePlan, doc, options) => {
      const result = await runUnifiedWritePipeline(
        {
          doc,
          intents: writePlan.map((operation) => operationToWriteIntent(operation)),
          taskId: options?.taskId,
          goal: options?.goal,
          dryRun: options?.dryRun,
          maxConcurrentReadOnly: options?.maxConcurrentReadOnly,
          defaultTimeoutMs: options?.defaultTimeoutMs,
          budgetDeadlineMs: options?.budgetDeadlineMs,
          defaultRetryLimit: options?.defaultRetryLimit,
          retryBackoffMs: options?.retryBackoffMs,
          confirmStep: options?.confirmStep,
          onExecutionEvent: options?.onExecutionEvent
        },
        {
          executor,
          validator
        }
      );
      return result.executionResult;
    },
    runUnifiedWritePipeline: async (input) =>
      await runUnifiedWritePipeline(input, {
        executor,
        validator,
        materializeDocument: deps.materializeDocument
      })
  };
}
