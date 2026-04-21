import { AgentError } from "../core/errors.js";
import type { DocumentIR, NodeSelector, Plan, PlanStep } from "../core/types.js";
import type { DocumentStructureIndex, StructuredParagraph } from "./document-state.js";

export function resolveSelectorTargets(doc: DocumentIR, selector: NodeSelector): string[] {
  if (selector.scope === "all_text") {
    return doc.nodes.map((node) => node.id);
  }

  const structure = readStructureIndex(doc);
  if (!structure) {
    return [];
  }

  let paragraphs: StructuredParagraph[] = [];
  switch (selector.scope) {
    case "body":
      paragraphs = structure.paragraphs.filter((paragraph) => paragraph.role === "body");
      break;
    case "heading":
      paragraphs = structure.paragraphs.filter(
        (paragraph) =>
          paragraph.role === "heading" &&
          (selector.headingLevel === undefined || paragraph.headingLevel === selector.headingLevel)
      );
      break;
    case "list_item":
      paragraphs = structure.paragraphs.filter((paragraph) => paragraph.role === "list_item");
      break;
    case "paragraph_ids": {
      const wanted = new Set(selector.paragraphIds ?? []);
      paragraphs = structure.paragraphs.filter((paragraph) => wanted.has(paragraph.id));
      break;
    }
    default:
      paragraphs = [];
      break;
  }

  const targetIds = new Set(paragraphs.flatMap((paragraph) => paragraph.runNodeIds));
  return doc.nodes.map((node) => node.id).filter((nodeId) => targetIds.has(nodeId));
}

export function expandPlanSelectors(plan: Plan, doc: DocumentIR): Plan {
  const expandedSteps: PlanStep[] = [];

  for (const step of plan.steps) {
    const selector = step.operation?.targetSelector;
    if (!selector || !step.operation) {
      expandedSteps.push(step);
      continue;
    }

    const targetIds = resolveSelectorTargets(doc, selector);
    if (targetIds.length === 0) {
      throw new AgentError({
        code: "E_SELECTOR_TARGETS_EMPTY",
        message: `Selector ${describeSelector(selector)} matched no document nodes.`,
        retryable: false
      });
    }

    if (targetIds.length === 1) {
      expandedSteps.push({
        ...step,
        operation: {
          ...step.operation,
          targetNodeId: targetIds[0],
          targetSelector: undefined
        }
      });
      continue;
    }

    expandedSteps.push(
      ...targetIds.map((targetId, index) => ({
        ...step,
        id: `${step.id}__${index + 1}`,
        idempotencyKey: `${step.idempotencyKey}::${index + 1}`,
        operation: {
          ...step.operation!,
          id: `${step.operation!.id}__${index + 1}`,
          targetNodeId: targetId,
          targetSelector: undefined
        }
      }))
    );
  }

  return {
    ...plan,
    steps: expandedSteps
  };
}

function readStructureIndex(doc: DocumentIR): DocumentStructureIndex | undefined {
  const structureIndex = doc.metadata?.structureIndex;
  if (!structureIndex || typeof structureIndex !== "object") {
    return undefined;
  }
  const candidate = structureIndex as Partial<DocumentStructureIndex>;
  if (!Array.isArray(candidate.paragraphs)) {
    return undefined;
  }
  return candidate as DocumentStructureIndex;
}

function describeSelector(selector: NodeSelector): string {
  if (selector.scope === "heading" && selector.headingLevel !== undefined) {
    return `heading(level=${selector.headingLevel})`;
  }
  if (selector.scope === "paragraph_ids") {
    return `paragraph_ids(${(selector.paragraphIds ?? []).join(",")})`;
  }
  return selector.scope;
}
