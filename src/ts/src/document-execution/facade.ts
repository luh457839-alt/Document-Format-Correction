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
}

export interface DocumentExecutionFacadeDeps {
  toolRegistry: ToolRegistry;
  executor?: Executor;
  validator?: Validator;
  riskPolicy?: RiskPolicy;
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
      const plan: Plan = {
        taskId: options?.taskId ?? `write:${doc.id}`,
        goal: options?.goal ?? "execute_write_plan",
        steps: writePlan.map((operation) => ({
          id: operation.id,
          toolName: "write_operation",
          readOnly: false,
          idempotencyKey: `write:${operation.id}`,
          operation
        }))
      };
      return await createDocumentExecutionFacadeExecutor(executor, validator, plan, doc, options);
    }
  };
}

async function createDocumentExecutionFacadeExecutor(
  executor: Executor,
  validator: Validator,
  plan: Plan,
  doc: DocumentIR,
  options?: ExecutorOptions
): Promise<ExecutionResult> {
  const concretePlan = expandPlanSelectors(plan, doc);
  await validator.preValidate(concretePlan, doc);
  const result = await executor.execute(concretePlan, doc, options);
  if (result.status === "completed") {
    await validator.postValidate(result.changeSet, result.finalDoc);
  }
  return result;
}
