import { asAppError } from "../core/errors.js";
import type { Operation, OperationType } from "../core/types.js";
import { resolveSelectorTargets } from "../runtime/selector-expander.js";
import { normalizeWriteOperationPayload } from "../tools/style-operation.js";
import { applyTemplateLanguageRunPostprocessing } from "./template-language-run-postprocessor.js";
import type { TemplateValidationIssue } from "./types.js";
import type { TemplateWritePlanBuildInput, TemplateWritePlanBuildResult, TemplateWritePlanItem } from "./types.js";

type StyleMapping = {
  source: "text_style" | "paragraph_style";
  field: string;
  operationType: OperationType;
  payloadField: string;
};

const TEXT_STYLE_MAPPINGS: readonly StyleMapping[] = [
  { source: "text_style", field: "font_name", operationType: "set_font", payloadField: "font_name" },
  { source: "text_style", field: "font_size_pt", operationType: "set_size", payloadField: "font_size_pt" },
  { source: "text_style", field: "font_color", operationType: "set_font_color", payloadField: "font_color" },
  { source: "text_style", field: "is_bold", operationType: "set_bold", payloadField: "is_bold" },
  { source: "text_style", field: "is_italic", operationType: "set_italic", payloadField: "is_italic" },
  { source: "text_style", field: "is_underline", operationType: "set_underline", payloadField: "is_underline" },
  { source: "text_style", field: "is_strike", operationType: "set_strike", payloadField: "is_strike" },
  { source: "text_style", field: "highlight_color", operationType: "set_highlight_color", payloadField: "highlight_color" },
  { source: "text_style", field: "is_all_caps", operationType: "set_all_caps", payloadField: "is_all_caps" }
] as const;

const PARAGRAPH_STYLE_MAPPINGS: readonly StyleMapping[] = [
  { source: "paragraph_style", field: "line_spacing", operationType: "set_line_spacing", payloadField: "line_spacing" },
  {
    source: "paragraph_style",
    field: "paragraph_alignment",
    operationType: "set_alignment",
    payloadField: "paragraph_alignment"
  }
] as const;

const WRITE_PLAN_ORDER: readonly StyleMapping[] = [
  TEXT_STYLE_MAPPINGS[0],
  TEXT_STYLE_MAPPINGS[1],
  PARAGRAPH_STYLE_MAPPINGS[0],
  PARAGRAPH_STYLE_MAPPINGS[1],
  TEXT_STYLE_MAPPINGS[2],
  TEXT_STYLE_MAPPINGS[3],
  TEXT_STYLE_MAPPINGS[4],
  TEXT_STYLE_MAPPINGS[5],
  TEXT_STYLE_MAPPINGS[6],
  TEXT_STYLE_MAPPINGS[7],
  TEXT_STYLE_MAPPINGS[8]
] as const;

const SUPPORTED_PARAGRAPH_STYLE_FIELDS = new Set([
  ...PARAGRAPH_STYLE_MAPPINGS.map((mapping) => mapping.field),
  "first_line_indent_chars",
  "first_line_indent_pt"
]);
const SUPPORTED_TEXT_STYLE_FIELDS = new Set(TEXT_STYLE_MAPPINGS.map((mapping) => mapping.field));
const SUPPORTED_RELATIVE_SPACING_FIELDS = new Set(["before_pt", "after_pt"]);

export function buildTemplateWritePlan(input: TemplateWritePlanBuildInput): TemplateWritePlanBuildResult {
  const issues: TemplateValidationIssue[] = [];
  const writePlan: TemplateWritePlanItem[] = [];
  const seenOperationIds = new Set<string>();
  const languagePostprocessed = applyTemplateLanguageRunPostprocessing({
    executionPlan: input.executionPlan,
    document: input.document,
    structureIndex: input.structureIndex
  });

  const pageLayoutOperation = buildPageLayoutOperation(input.template);
  if (pageLayoutOperation) {
    try {
      writePlan.push({
        ...pageLayoutOperation,
        payload: normalizeWriteOperationPayload(pageLayoutOperation)
      });
      seenOperationIds.add(pageLayoutOperation.id);
    } catch (err) {
      const info = asAppError(err, "E_TEMPLATE_WRITE_PLAN_INVALID");
      issues.push({
        error_code: "invalid_write_payload",
        message: info.message,
        semantic_key: "template",
        paragraph_ids: []
      });
    }
  }

  for (const item of input.executionPlan) {
    const itemIssuesBefore = issues.length;
    const paragraphIds = normalizeParagraphIds(item.paragraph_ids);
    if (paragraphIds.length === 0) {
      issues.push({
        error_code: "invalid_paragraph_ids",
        message: `semantic '${item.semantic_key}' requires at least one paragraph_id`,
        semantic_key: item.semantic_key,
        paragraph_ids: []
      });
      continue;
    }

    const unknownParagraphIds = paragraphIds.filter((paragraphId) => !input.structureIndex.paragraphMap[paragraphId]);
    if (unknownParagraphIds.length > 0) {
      issues.push({
        error_code: "unknown_paragraph_id",
        message: `semantic '${item.semantic_key}' references unknown paragraph_ids: ${unknownParagraphIds.join(", ")}`,
        semantic_key: item.semantic_key,
        paragraph_ids: paragraphIds
      });
      continue;
    }

    for (const field of Object.keys(item.text_style ?? {})) {
      if (!SUPPORTED_TEXT_STYLE_FIELDS.has(field)) {
        issues.push(unsupportedStyleFieldIssue(item.semantic_key, paragraphIds, `text_style.${field}`));
      }
    }
    for (const field of Object.keys(item.paragraph_style ?? {})) {
      if (!SUPPORTED_PARAGRAPH_STYLE_FIELDS.has(field)) {
        issues.push(unsupportedStyleFieldIssue(item.semantic_key, paragraphIds, `paragraph_style.${field}`));
      }
    }
    for (const field of Object.keys(item.relative_spacing ?? {})) {
      if (!SUPPORTED_RELATIVE_SPACING_FIELDS.has(field)) {
        issues.push(unsupportedStyleFieldIssue(item.semantic_key, paragraphIds, `relative_spacing.${field}`));
      }
    }
    if (issues.length > itemIssuesBefore) {
      continue;
    }

    const mappedOperations = mapStyleOperations(
      item.semantic_key,
      paragraphIds,
      item.text_style ?? {},
      item.paragraph_style ?? {},
      WRITE_PLAN_ORDER
    );
    const spacingOperation = mapRelativeSpacingOperation(
      item.semantic_key,
      paragraphIds,
      item.relative_spacing ?? {}
    );
    if (spacingOperation) {
      mappedOperations.push(spacingOperation);
    }
    const indentOperation = mapParagraphIndentOperation(
      item.semantic_key,
      paragraphIds,
      item.text_style ?? {},
      item.paragraph_style ?? {}
    );
    if (indentOperation) {
      mappedOperations.push(indentOperation);
    }

    for (const operation of mappedOperations) {
      const targetNodeIds = resolveOperationTargets(languagePostprocessed.document, operation);
      if (seenOperationIds.has(operation.id)) {
        issues.push({
          error_code: "duplicate_operation_id",
          message: `duplicate write operation id '${operation.id}' generated from template execution plan`,
          semantic_key: item.semantic_key,
          paragraph_ids: paragraphIds
        });
        continue;
      }

      if (targetNodeIds.length === 0) {
        issues.push({
          error_code: "selector_targets_empty",
          message: `semantic '${item.semantic_key}' matched no writable text runs for paragraph_ids: ${paragraphIds.join(", ")}`,
          semantic_key: item.semantic_key,
          paragraph_ids: paragraphIds
        });
        continue;
      }

      try {
        const normalizedPayload = normalizeWriteOperationPayload(operation);
        writePlan.push({
          ...operation,
          payload: normalizedPayload
        });
        seenOperationIds.add(operation.id);
      } catch (err) {
        const info = asAppError(err, "E_TEMPLATE_WRITE_PLAN_INVALID");
        issues.push({
          error_code: "invalid_write_payload",
          message: info.message,
          semantic_key: item.semantic_key,
          paragraph_ids: paragraphIds
        });
      }
    }
  }

  for (const operation of languagePostprocessed.operations) {
    const semanticKey = operation.id.split(":")[0] ?? "template";
    const targetNodeIds = resolveOperationTargets(languagePostprocessed.document, operation);
    if (seenOperationIds.has(operation.id)) {
      issues.push({
        error_code: "duplicate_operation_id",
        message: `duplicate write operation id '${operation.id}' generated from template execution plan`,
        semantic_key: semanticKey,
        paragraph_ids: []
      });
      continue;
    }
    if (targetNodeIds.length === 0) {
      continue;
    }
    try {
      const normalizedPayload = normalizeWriteOperationPayload(operation);
      writePlan.push({
        ...operation,
        payload: normalizedPayload
      });
      seenOperationIds.add(operation.id);
    } catch (err) {
      const info = asAppError(err, "E_TEMPLATE_WRITE_PLAN_INVALID");
      issues.push({
        error_code: "invalid_write_payload",
        message: info.message,
        semantic_key: semanticKey,
        paragraph_ids: []
      });
    }
  }

  return issues.length > 0
    ? { writePlan: [], issues, document: languagePostprocessed.document, structureIndex: languagePostprocessed.structureIndex }
    : { writePlan, issues: [], document: languagePostprocessed.document, structureIndex: languagePostprocessed.structureIndex };
}

function buildPageLayoutOperation(template: TemplateWritePlanBuildInput["template"]): Operation | undefined {
  if (!template) {
    return undefined;
  }
  const globalPage = readRecord(template.layout_rules.global_rules.page_layout_reference);
  const styleReference = readRecord(template.style_reference);
  const stylePage = readRecord(styleReference?.page);
  const page = { ...(globalPage ?? {}), ...(stylePage ?? {}) };
  if (Object.keys(page).length === 0) {
    return undefined;
  }
  return {
    id: "template:set_page_layout",
    type: "set_page_layout",
    payload: page
  };
}

function mapStyleOperations(
  semanticKey: string,
  paragraphIds: string[],
  textStyle: Record<string, unknown>,
  paragraphStyle: Record<string, unknown>,
  mappings: readonly StyleMapping[]
): Operation[] {
  const operations: Operation[] = [];
  for (const mapping of mappings) {
    const source = mapping.source === "text_style" ? textStyle : paragraphStyle;
    const value = source[mapping.field];
    if (value === undefined) {
      continue;
    }
    operations.push({
      id: `${semanticKey}:${mapping.operationType}`,
      type: mapping.operationType,
      targetSelector: {
        scope: "paragraph_ids",
        paragraphIds: [...paragraphIds]
      },
      payload: {
        [mapping.payloadField]: value
      }
    });
  }
  return operations;
}

function mapRelativeSpacingOperation(
  semanticKey: string,
  paragraphIds: string[],
  relativeSpacing: Record<string, unknown>
): Operation | undefined {
  const payload: Record<string, unknown> = {};
  if (relativeSpacing.before_pt !== undefined) {
    payload.before_pt = relativeSpacing.before_pt;
  }
  if (relativeSpacing.after_pt !== undefined) {
    payload.after_pt = relativeSpacing.after_pt;
  }
  if (!Object.values(payload).some((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) {
    return undefined;
  }
  return {
    id: `${semanticKey}:set_paragraph_spacing`,
    type: "set_paragraph_spacing",
    targetSelector: {
      scope: "paragraph_ids",
      paragraphIds: [...paragraphIds]
    },
    payload
  };
}

function mapParagraphIndentOperation(
  semanticKey: string,
  paragraphIds: string[],
  textStyle: Record<string, unknown>,
  paragraphStyle: Record<string, unknown>
): Operation | undefined {
  if (paragraphStyle.first_line_indent_pt !== undefined) {
    return {
      id: `${semanticKey}:set_paragraph_indent`,
      type: "set_paragraph_indent",
      targetSelector: {
        scope: "paragraph_ids",
        paragraphIds: [...paragraphIds]
      },
      payload: {
        first_line_indent_pt: paragraphStyle.first_line_indent_pt
      }
    };
  }
  if (paragraphStyle.first_line_indent_chars === undefined) {
    return undefined;
  }
  const fontSize = typeof textStyle.font_size_pt === "number" && Number.isFinite(textStyle.font_size_pt)
    ? textStyle.font_size_pt
    : 12;
  return {
    id: `${semanticKey}:set_paragraph_indent`,
    type: "set_paragraph_indent",
    targetSelector: {
      scope: "paragraph_ids",
      paragraphIds: [...paragraphIds]
    },
    payload: {
      first_line_indent_chars: paragraphStyle.first_line_indent_chars,
      font_size_pt: fontSize
    }
  };
}

function resolveOperationTargets(document: TemplateWritePlanBuildInput["document"], operation: Operation): string[] {
  if (operation.type === "set_page_layout") {
    return ["__document__"];
  }
  if (operation.targetSelector) {
    return resolveSelectorTargets(document, operation.targetSelector);
  }
  if (Array.isArray(operation.targetNodeIds)) {
    return operation.targetNodeIds.filter((targetNodeId) => document.nodes.some((node) => node.id === targetNodeId));
  }
  if (operation.targetNodeId && document.nodes.some((node) => node.id === operation.targetNodeId)) {
    return [operation.targetNodeId];
  }
  return [];
}

function readRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

function normalizeParagraphIds(paragraphIds: string[]): string[] {
  return Array.from(
    new Set(
      paragraphIds
        .filter((paragraphId): paragraphId is string => typeof paragraphId === "string")
        .map((paragraphId) => paragraphId.trim())
        .filter(Boolean)
    )
  );
}

function unsupportedStyleFieldIssue(
  semanticKey: string,
  paragraphIds: string[],
  fieldName: string
): TemplateValidationIssue {
  return {
    error_code: "unsupported_style_field",
    message: `semantic '${semanticKey}' declares unsupported template field '${fieldName}'`,
    semantic_key: semanticKey,
    paragraph_ids: paragraphIds
  };
}
