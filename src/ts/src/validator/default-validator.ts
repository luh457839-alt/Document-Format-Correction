import { AgentError } from "../core/errors.js";
import type { ChangeSet, DocumentIR, Plan, Validator } from "../core/types.js";
import { compileOperationToPatchSet } from "../tools/docx-patching.js";

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
      if (
        step.operation.type !== "set_page_layout" &&
        !step.operation.targetNodeId &&
        !step.operation.targetNodeIds?.length &&
        !step.operation.targetSelector &&
        !step.operation.patchTargetIds?.length
      ) {
        throw invalidPlan(
          `write_operation step '${step.id}' requires operation.targetNodeId or operation.targetNodeIds or operation.targetSelector or operation.patchTargetIds.`
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
      if (step.operation.type === "set_line_spacing" && !hasValidLineSpacing(step.operation.payload)) {
        throw invalidPlan(
          `write_operation step '${step.id}' requires line_spacing as a positive number or { mode: 'exact', pt: positive number }.`
        );
      }
      if (isPayloadSemanticallyEmpty(step.operation.type, step.operation.payload)) {
        throw invalidPlan(`write_operation step '${step.id}' has an empty or non-executable payload.`);
      }
      try {
        const compiled = compileOperationToPatchSet(doc, step.operation);
        if (compiled.patchSet.operations.length === 0) {
          throw invalidPlan(`write_operation step '${step.id}' compiled to an empty patch set.`);
        }
      } catch (err) {
        if (err instanceof AgentError) {
          throw invalidPlan(`write_operation step '${step.id}' is not patch-compilable: ${err.info.message}`);
        }
        throw err;
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
  if (type === "set_line_spacing") {
    return !hasValidLineSpacing(payload);
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
  if (type === "set_page_layout") {
    return (
      !hasPaperSize(payload, ["paper_size", "paperSize"]) &&
      !hasPositiveNumber(payload, ["margin_top_cm", "marginTopCm"]) &&
      !hasPositiveNumber(payload, ["margin_bottom_cm", "marginBottomCm"]) &&
      !hasPositiveNumber(payload, ["margin_left_cm", "marginLeftCm"]) &&
      !hasPositiveNumber(payload, ["margin_right_cm", "marginRightCm"])
    );
  }
  if (type === "set_paragraph_spacing") {
    return (
      !hasZeroOrPositiveNumber(payload, ["before_pt", "beforePt", "space_before_pt", "spaceBeforePt"]) &&
      !hasZeroOrPositiveNumber(payload, ["after_pt", "afterPt", "space_after_pt", "spaceAfterPt"])
    );
  }
  if (type === "set_paragraph_indent") {
    return (
      !hasZeroOrPositiveNumber(payload, ["first_line_indent_pt", "firstLineIndentPt"]) &&
      !hasPositiveNumber(payload, ["first_line_indent_chars", "firstLineIndentChars"])
    );
  }
  if (type === "set_style_definition") {
    return !hasNonEmptyRecord(payload, ["style_definition", "styleDefinition"]);
  }
  if (type === "set_numbering_level") {
    return !hasNonEmptyRecord(payload, ["numbering_level", "numberingLevel"]);
  }
  if (type === "set_settings_flag") {
    return !hasNonEmptyRecord(payload, ["settings"]);
  }
  if (type === "set_attr" || type === "remove_attr") {
    return !hasNonEmptyString(payload, ["name"]);
  }
  if (type === "set_text") {
    return false;
  }
  if (type === "remove_node") {
    return false;
  }
  if (type === "ensure_node") {
    return !hasNonEmptyString(payload, ["path"]) || !hasNonEmptyString(payload, ["xml_tag", "xmlTag"]);
  }
  if (type === "replace_node_xml") {
    return !hasNonEmptyString(payload, ["node_xml", "nodeXml"]);
  }
  return Object.keys(payload).length === 0;
}

function hasNonEmptyString(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => typeof payload[key] === "string" && payload[key].trim().length > 0);
}

function hasPositiveNumber(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => typeof payload[key] === "number" && Number.isFinite(payload[key]) && payload[key] > 0);
}

function hasZeroOrPositiveNumber(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => typeof payload[key] === "number" && Number.isFinite(payload[key]) && payload[key] >= 0);
}

function hasPaperSize(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => {
    const value = payload[key];
    return typeof value === "string" && ["a4", "letter"].includes(value.trim().toLowerCase());
  });
}

function hasBoolean(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => typeof payload[key] === "boolean");
}

function hasNonEmptyRecord(payload: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => {
    const value = payload[key];
    return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
  });
}

function hasValidLineSpacing(payload: Record<string, unknown>): boolean {
  const lineSpacing = payload.line_spacing;
  if (typeof lineSpacing === "number" && Number.isFinite(lineSpacing) && lineSpacing > 0) {
    return true;
  }
  if (!lineSpacing || typeof lineSpacing !== "object" || Array.isArray(lineSpacing)) {
    return false;
  }
  const mode = (lineSpacing as { mode?: unknown }).mode;
  const pt = (lineSpacing as { pt?: unknown }).pt;
  return mode === "exact" && typeof pt === "number" && Number.isFinite(pt) && pt > 0;
}
