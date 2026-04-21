import type { PlanStep, RiskPolicy } from "../core/types.js";

export class DefaultRiskPolicy implements RiskPolicy {
  requiresConfirmation(step: PlanStep): boolean {
    return !step.readOnly && !!step.operation && ["merge_paragraph", "split_paragraph"].includes(step.operation.type);
  }
}
