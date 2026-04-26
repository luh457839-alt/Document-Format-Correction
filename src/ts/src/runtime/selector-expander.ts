import type { DocumentIR, NodeSelector, Plan, PlanStep } from "../core/types.js";
import {
  analyzeSelectorTargets as analyzeSelectorTargetsWithPipeline,
  bindWriteIntentToOperations,
  resolveSelectorTargets as resolveSelectorTargetsWithPipeline
} from "../document-execution/unified-write-pipeline.js";

export type { SelectorTargetAnalysis } from "../document-execution/unified-write-pipeline.js";

export function resolveSelectorTargets(doc: DocumentIR, selector: NodeSelector): string[] {
  return resolveSelectorTargetsWithPipeline(doc, selector);
}

export function analyzeSelectorTargets(doc: DocumentIR, selector: NodeSelector) {
  return analyzeSelectorTargetsWithPipeline(doc, selector);
}

export function expandPlanSelectors(plan: Plan, doc: DocumentIR): Plan {
  const expandedSteps: PlanStep[] = [];

  for (const step of plan.steps) {
    const selector = step.operation?.targetSelector;
    if (!selector || !step.operation) {
      expandedSteps.push(step);
      continue;
    }

    const operations = bindWriteIntentToOperations(doc, {
      id: step.operation.id,
      type: step.operation.type,
      payload: step.operation.payload,
      target: {
        kind: "selector",
        selector
      }
    });

    if (operations.length === 1) {
      expandedSteps.push({
        ...step,
        operation: operations[0]
      });
      continue;
    }

    expandedSteps.push(
      ...operations.map((operation, index) => ({
        ...step,
        id: `${step.id}__${index + 1}`,
        idempotencyKey: `${step.idempotencyKey}::${index + 1}`,
        operation
      }))
    );
  }

  return {
    ...plan,
    steps: expandedSteps
  };
}
