import { AgentError } from "../core/errors.js";
import type { ChangeSet, DocumentIR, Plan, Validator } from "../core/types.js";

export class DefaultValidator implements Validator {
  async preValidate(plan: Plan, doc: DocumentIR): Promise<void> {
    if (!plan.steps.length) {
      throw new AgentError({
        code: "E_EMPTY_PLAN",
        message: "Plan has no steps.",
        retryable: false
      });
    }
    if (!doc.nodes.length) {
      throw new AgentError({
        code: "E_EMPTY_DOC",
        message: "Document has no nodes.",
        retryable: false
      });
    }

    for (const step of plan.steps) {
      if (step.toolName !== "write_operation") {
        continue;
      }
      if (!step.operation) {
        throw invalidPlan(`write_operation step '${step.id}' requires operation.`);
      }
      if (!step.operation.id || !step.operation.type) {
        throw invalidPlan(`write_operation step '${step.id}' requires operation.id and operation.type.`);
      }
      if (!step.operation.payload || typeof step.operation.payload !== "object") {
        throw invalidPlan(`write_operation step '${step.id}' requires operation.payload.`);
      }
      if (!step.operation.targetNodeId && !step.operation.targetNodeIds?.length && !step.operation.targetSelector) {
        throw invalidPlan(
          `write_operation step '${step.id}' requires operation.targetNodeId or operation.targetNodeIds or operation.targetSelector.`
        );
      }
      if (step.operation.targetNodeId) {
        validateConcreteTarget(step.id, step.operation.targetNodeId, doc);
      }
      if (step.operation.targetNodeIds?.length) {
        for (const targetNodeId of step.operation.targetNodeIds) {
          validateConcreteTarget(step.id, targetNodeId, doc);
        }
      }
      if (isPayloadSemanticallyEmpty(step.operation.type, step.operation.payload)) {
        throw invalidPlan(`write_operation step '${step.id}' has an empty or non-executable payload.`);
      }
    }
  }

  async postValidate(changeSet: ChangeSet, _doc: DocumentIR): Promise<void> {
    if (!changeSet.taskId) {
      throw new AgentError({
        code: "E_INVALID_CHANGESET",
        message: "ChangeSet taskId is required.",
        retryable: false
      });
    }
  }
}

function invalidPlan(message: string): AgentError {
  return new AgentError({
    code: "E_INVALID_PLAN",
    message,
    retryable: false
  });
}

function validateConcreteTarget(stepId: string, targetNodeId: string, doc: DocumentIR): void {
  const normalizedTarget = targetNodeId.trim().toLowerCase();
  if (["placeholder", "unused", "target", "todo", "tbd"].includes(normalizedTarget)) {
    throw invalidPlan(`write_operation step '${stepId}' uses placeholder targetNodeId '${targetNodeId}'.`);
  }
  if (!doc.nodes.some((node) => node.id === targetNodeId)) {
    throw invalidPlan(`write_operation step '${stepId}' targetNodeId '${targetNodeId}' was not found in the document.`);
  }
}

function isPayloadSemanticallyEmpty(type: string, payload: Record<string, unknown>): boolean {
  if (type === "merge_paragraph") {
    return false;
  }
  if (type === "set_font") {
    return !hasNonEmptyString(payload, ["font_name", "fontName"]);
  }
  if (type === "set_size") {
    return !hasPositiveNumber(payload, ["font_size_pt", "fontSizePt", "fontSize"]);
  }
  if (type === "set_alignment") {
    return !hasNonEmptyString(payload, ["paragraph_alignment", "alignment"]);
  }
  if (type === "set_font_color") {
    return !hasNonEmptyString(payload, ["font_color", "fontColor"]);
  }
  if (type === "set_highlight_color") {
    return !hasNonEmptyString(payload, ["highlight_color", "highlightColor"]);
  }
  if (type === "split_paragraph") {
    return !hasPositiveNumber(payload, ["split_offset", "splitOffset"]);
  }
  if (type === "set_bold") {
    return !hasBoolean(payload, ["is_bold", "isBold"]);
  }
  if (type === "set_italic") {
    return !hasBoolean(payload, ["is_italic", "isItalic"]);
  }
  if (type === "set_underline") {
    return !hasBoolean(payload, ["is_underline", "isUnderline"]);
  }
  if (type === "set_strike") {
    return !hasBoolean(payload, ["is_strike", "isStrike"]);
  }
  if (type === "set_all_caps") {
    return !hasBoolean(payload, ["is_all_caps", "isAllCaps"]);
  }
  return Object.keys(payload).length === 0;
}

function hasNonEmptyString(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => typeof payload[key] === "string" && payload[key].trim().length > 0);
}

function hasPositiveNumber(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => typeof payload[key] === "number" && Number.isFinite(payload[key]) && payload[key] > 0);
}

function hasBoolean(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => typeof payload[key] === "boolean");
}
