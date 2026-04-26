import { AgentError, asAppError } from "../core/errors.js";
import type { DocumentIR, Operation, OperationType } from "../core/types.js";
import {
  analyzeWriteTargetSpec,
  operationToWriteIntent,
  prepareWriteIntents,
  type WriteTargetSpec
} from "../document-execution/unified-write-pipeline.js";
import { applyTemplateLanguageRunPostprocessing } from "./template-language-run-postprocessor.js";
import type { TemplateValidationIssue } from "./types.js";
import type {
  TemplateAtomicPlanItem,
  TemplatePatchPlanBuildInput,
  TemplatePatchPlanBuildResult,
  TemplatePatchPlanItem,
  TemplateWritePlanBuildInput,
  TemplateWritePlanBuildResult,
  TemplateWritePlanItem
} from "./types.js";
import type { DocxPatchTarget } from "../tools/docx-observation-schema.js";
import type { TemplatePatchOperation, TemplatePatchSelector } from "./template-contract.js";

type LegacyAtomicPlanLike = {
  semantic_key: string;
  paragraph_ids: string[];
  selector?: TemplatePatchSelector;
  operations?: TemplatePatchOperation[];
  text_style?: Record<string, unknown>;
  paragraph_style?: Record<string, unknown>;
  relative_spacing?: Record<string, unknown>;
  placement_rules?: Record<string, unknown>;
  language_font_overrides?: Record<string, unknown>;
};

export function buildTemplatePatchPlan(input: TemplatePatchPlanBuildInput): TemplatePatchPlanBuildResult {
  const issues: TemplateValidationIssue[] = [];
  const writePlan: TemplateWritePlanItem[] = [];
  const patchPlan: TemplatePatchPlanItem[] = [];
  const seenIds = new Set<string>();
  const postprocessed = applyTemplateLanguageRunPostprocessing({
    executionPlan: input.executionPlan,
    document: input.document,
    structureIndex: input.structureIndex
  });

  for (const item of input.executionPlan) {
    addPatchBlockPlanItem({
      item,
      document: postprocessed.document,
      writePlan,
      patchPlan,
      issues,
      seenIds
    });
  }

  for (const operation of postprocessed.operations) {
    addWritePlanItem({
      planItem: {
        id: operation.id,
        semantic_key: operation.id.split(":")[0] ?? "template",
        intent: operationToWriteIntent(operation)
      },
      document: postprocessed.document,
      writePlan,
      patchPlan,
      issues,
      seenIds,
      paragraphIds: []
    });
  }

  return {
    patchPlan: issues.length > 0 ? [] : patchPlan,
    writePlan: issues.length > 0 ? [] : writePlan,
    issues,
    document: postprocessed.document,
    structureIndex: postprocessed.structureIndex
  };
}

export function buildTemplateWritePlan(input: TemplateWritePlanBuildInput): TemplateWritePlanBuildResult {
  return buildTemplatePatchPlan(input);
}

function addPatchBlockPlanItem(input: {
  item: TemplateAtomicPlanItem;
  document: DocumentIR;
  writePlan: TemplateWritePlanItem[];
  patchPlan: TemplatePatchPlanItem[];
  issues: TemplateValidationIssue[];
  seenIds: Set<string>;
}): void {
  const legacyIssues = validateLegacyAtomicPlanItem(input.item as TemplateAtomicPlanItem & LegacyAtomicPlanLike);
  if (legacyIssues.length > 0) {
    input.issues.push(...legacyIssues);
    return;
  }
  const normalizedItem = normalizeAtomicPlanItem(input.item as TemplateAtomicPlanItem & LegacyAtomicPlanLike);
  try {
    const planItems = compileAtomicPlanItemToWritePlanItems(input.document, normalizedItem);
    for (const planItem of planItems) {
      addWritePlanItem({
        planItem,
        document: input.document,
        writePlan: input.writePlan,
        patchPlan: input.patchPlan,
        issues: input.issues,
        seenIds: input.seenIds,
        paragraphIds: normalizedItem.paragraph_ids
      });
    }
  } catch (err) {
    const info = asAppError(err, "E_TEMPLATE_WRITE_PLAN_INVALID");
    if (info.code === "E_UNWRITABLE_TARGET") {
      input.issues.push({
        error_code: "paragraph_has_no_writable_nodes",
        message: info.message,
        semantic_key: normalizedItem.semantic_key,
        paragraph_ids: normalizedItem.paragraph_ids
      });
      return;
    }
    input.issues.push({
      error_code: "patch_compile_failed",
      message: info.message,
      semantic_key: normalizedItem.semantic_key,
      paragraph_ids: normalizedItem.paragraph_ids
    });
  }
}

function addWritePlanItem(input: {
  planItem: TemplateWritePlanItem;
  document: DocumentIR;
  writePlan: TemplateWritePlanItem[];
  patchPlan: TemplatePatchPlanItem[];
  issues: TemplateValidationIssue[];
  seenIds: Set<string>;
  paragraphIds: string[];
}): void {
  const intent = input.planItem.intent ?? (input.planItem.legacy_operation ? operationToWriteIntent(input.planItem.legacy_operation) : undefined);
  if (!intent) {
    input.issues.push({
      error_code: "missing_write_intent",
      message: `template write item '${input.planItem.id}' is missing intent`,
      semantic_key: input.planItem.semantic_key,
      paragraph_ids: input.paragraphIds
    });
    return;
  }
  if (input.seenIds.has(intent.id)) {
    input.issues.push({
      error_code: "duplicate_operation_id",
      message: `duplicate template write operation '${intent.id}' generated from template execution plan`,
      semantic_key: input.planItem.semantic_key,
      paragraph_ids: input.paragraphIds
    });
    return;
  }

  try {
    const prepared = prepareWriteIntents(input.document, [intent]);
    if (prepared.length === 0) {
      throw new AgentError({
        code: "E_PATCH_COMPILE_FAILED",
        message: `template write intent '${intent.id}' produced 0 executable operations`,
        retryable: false
      });
    }
    if (prepared.length !== 1) {
      throw new AgentError({
        code: "E_TEMPLATE_WRITE_PLAN_INVALID",
        message: `template write intent '${intent.id}' cannot be mirrored as a single legacy operation`,
        retryable: false
      });
    }
    const legacyOperation = structuredClone(prepared[0].operation);
    input.writePlan.push({
      ...input.planItem,
      intent,
      legacy_operation: legacyOperation
    });
    for (const item of prepared) {
      input.patchPlan.push({
        id: item.operation.id,
        semantic_key: input.planItem.semantic_key,
        operation: {
          ...input.planItem,
          intent: item.intent,
          legacy_operation: structuredClone(item.operation)
        },
        patch_set: item.patchSet,
        patch_target_ids: item.patchTargetIds,
        patch_target_count: item.patchTargetCount,
        patch_part_paths: item.patchPartPaths
      });
    }
    input.seenIds.add(intent.id);
  } catch (err) {
    const info = asAppError(err, "E_TEMPLATE_WRITE_PLAN_INVALID");
    if (info.code === "E_SELECTOR_TARGETS_EMPTY" && isParagraphBoundIntent(intent) && info.message.includes("no writable targets after filtering")) {
      return;
    }
    if (info.code === "E_UNWRITABLE_TARGET") {
      input.issues.push({
        error_code: "paragraph_has_no_writable_nodes",
        message: info.message,
        semantic_key: input.planItem.semantic_key,
        paragraph_ids: input.paragraphIds
      });
      return;
    }
    input.issues.push({
      error_code: "patch_compile_failed",
      message: info.message,
      semantic_key: input.planItem.semantic_key,
      paragraph_ids: input.paragraphIds
    });
  }
}

function compileAtomicPlanItemToWritePlanItems(
  document: DocumentIR,
  item: TemplateAtomicPlanItem
): TemplateWritePlanItem[] {
  const filteredItem = filterAtomicPlanItemToWritableParagraphs(document, item);
  if (!filteredItem) {
    return [];
  }
  const selectorTargets = resolveSelectorTargets(document, filteredItem);
  if (selectorTargets.length === 0) {
    if (
      filteredItem.selector.part === "document" &&
      (filteredItem.selector.scope === "paragraph" || filteredItem.selector.scope === "run")
    ) {
      return [];
    }
    throw new Error(`selector matched 0 targets for semantic '${item.semantic_key}'`);
  }

  const operations = filteredItem.operations.flatMap((patchOperation) =>
    compileTemplatePatchOperationToWriteItems(document, filteredItem, patchOperation, selectorTargets)
  );
  if (operations.length === 0) {
    throw new Error(`patch block for semantic '${item.semantic_key}' compiled to 0 operations`);
  }
  return operations;
}

function filterAtomicPlanItemToWritableParagraphs(
  document: DocumentIR,
  item: TemplateAtomicPlanItem
): TemplateAtomicPlanItem | undefined {
  if (item.selector.part !== "document" || (item.selector.scope !== "paragraph" && item.selector.scope !== "run")) {
    return item;
  }
  const paragraphIds = unique([...(item.selector.match?.paragraph_ids ?? []), ...item.paragraph_ids].filter(Boolean));
  const analysis = analyzeWriteTargetSpec(document, {
    kind: "paragraph_ids",
    paragraphIds
  });
  if (analysis.missingParagraphIds.length > 0) {
    throw new AgentError({
      code: "E_INVALID_TARGET",
      message: `template semantic '${item.semantic_key}' includes unknown paragraph ids: ${analysis.missingParagraphIds.join(", ")}`,
      retryable: false
    });
  }
  const skipped = new Set(analysis.skippedParagraphIds);
  const writableParagraphIds = paragraphIds.filter((paragraphId) => !skipped.has(paragraphId));
  if (writableParagraphIds.length === 0) {
    return undefined;
  }
  return {
    ...item,
    paragraph_ids: item.paragraph_ids.filter((paragraphId) => !skipped.has(paragraphId)),
    selector: {
      ...item.selector,
      match: {
        ...(item.selector.match ?? {}),
        paragraph_ids: writableParagraphIds
      }
    }
  };
}

function resolveSelectorTargets(document: DocumentIR, item: TemplateAtomicPlanItem): DocxPatchTarget[] {
  const selector = item.selector;
  const match = selector.match ?? {};
  const structureIndex = readStructureIndex(document);
  const paragraphIds = unique([...(match.paragraph_ids ?? []), ...item.paragraph_ids].filter(Boolean));
  const observationTargets = readObservationTargets(document);
  const paragraphById = new Map((structureIndex?.paragraphs ?? []).map((paragraph) => [paragraph.id, paragraph] as const));

  if (selector.scope === "run" || selector.scope === "paragraph") {
    if (paragraphIds.length === 0) {
      return [];
    }
    if (selector.scope === "paragraph") {
      return paragraphIds.map((paragraphId) => {
        const paragraph = paragraphById.get(paragraphId);
        const existing = observationTargets.get(`target:block:${paragraphId}`);
        return {
          id: existing?.id ?? `target:block:${paragraphId}`,
          part_kind: mapPartKind(selector.part),
          target_kind: existing?.target_kind ?? "block",
          part_path: paragraph?.partPath ?? existing?.part_path ?? "word/document.xml",
          block_id: paragraphId,
          locator: existing?.locator
        };
      });
    }
    return paragraphIds.flatMap((paragraphId) => {
      const paragraph = paragraphById.get(paragraphId);
        return (paragraph?.runNodeIds ?? []).map((runNodeId) => {
          const existing = observationTargets.get(`target:inline:${runNodeId}`);
          return {
            id: existing?.id ?? `target:inline:${runNodeId}`,
            part_kind: mapPartKind(selector.part),
            target_kind: existing?.target_kind ?? "inline",
            part_path: paragraph?.partPath ?? existing?.part_path ?? "word/document.xml",
            block_id: paragraphId,
            node_id: runNodeId,
            locator: existing?.locator
        };
      });
    });
  }

  if (selector.scope === "section") {
    const sectionIndex = typeof match.section_index === "number" ? match.section_index : 0;
    const partPath = resolvePartPath(document, selector.part, match.part_path, "word/document.xml");
    return [
      {
        id: `target:${selector.part}:section:${sectionIndex}`,
        part_kind: mapPartKind(selector.part),
        target_kind: "section",
        part_path: partPath,
        block_id: `section:${sectionIndex}`,
        locator: {
          part_path: partPath,
          xml_path: match.xml_path ?? `/document/body/sectPr[${sectionIndex}]`
        }
      }
    ];
  }

  if (selector.scope === "style") {
    const partPath = resolvePartPath(document, selector.part, match.part_path, "word/styles.xml");
    const styleId = typeof match.style_id === "string" ? match.style_id : "style";
    return [
      {
        id: `target:styles:style:${styleId}`,
        part_kind: "styles",
        target_kind: "style",
        part_path: partPath,
        block_id: styleId,
        locator: {
          part_path: partPath,
          xml_path: match.xml_path ?? `/styles/style[${styleId}]`
        }
      }
    ];
  }

  if (selector.scope === "settings_node") {
    const partPath = resolvePartPath(document, selector.part, match.part_path, "word/settings.xml");
    return [
      {
        id: `target:settings:${sanitizeTargetSuffix(match.xml_path ?? "settings")}`,
        part_kind: "settings",
        target_kind: "settings_node",
        part_path: partPath,
        block_id: "settings",
        locator: {
          part_path: partPath,
          xml_path: match.xml_path ?? "/settings"
        }
      }
    ];
  }

  if (selector.scope === "numbering_level") {
    const partPath = resolvePartPath(document, selector.part, match.part_path, "word/numbering.xml");
    const numId = typeof match.num_id === "string" ? match.num_id : "0";
    const ilvl = typeof match.ilvl === "number" ? match.ilvl : 0;
    return [
      {
        id: `target:numbering:${numId}:${ilvl}`,
        part_kind: "numbering",
        target_kind: "numbering_level",
        part_path: partPath,
        block_id: `${numId}:${ilvl}`,
        locator: {
          part_path: partPath,
          xml_path: match.xml_path ?? `/numbering/abstractNum[${numId}]/lvl[${ilvl}]`
        }
      }
    ];
  }

  if (match.xml_path) {
    const partPath = resolvePartPath(document, selector.part, match.part_path, "word/document.xml");
    return [
      {
        id: `target:${selector.part}:${sanitizeTargetSuffix(match.xml_path)}`,
        part_kind: mapPartKind(selector.part),
        target_kind: selector.scope,
        part_path: partPath,
        block_id: sanitizeTargetSuffix(match.xml_path),
        locator: {
          part_path: partPath,
          xml_path: match.xml_path
        }
      }
    ];
  }

  return [];
}

function compileTemplatePatchOperationToWriteItems(
  document: DocumentIR,
  item: TemplateAtomicPlanItem,
  patchOperation: TemplatePatchOperation,
  selectorTargets: DocxPatchTarget[]
): TemplateWritePlanItem[] {
  const fontSizeHint = readFontSizeHint(item.operations);
  const directTargetIds = selectorTargets.map((target) => target.id);
  const directPartPaths = unique(selectorTargets.map((target) => target.part_path));
  const paragraphIds = unique([...(item.selector.match?.paragraph_ids ?? []), ...item.paragraph_ids].filter(Boolean));
  const createItem = (
    idSuffix: string,
    operationType: OperationType,
    payload: Record<string, unknown>,
    options: {
      target?: WriteTargetSpec;
      operations?: TemplatePatchOperation[];
    } = {}
  ): TemplateWritePlanItem => ({
    id: `${item.semantic_key}:${item.selector.part}:${item.selector.scope}:${idSuffix}`,
    semantic_key: item.semantic_key,
    selector: item.selector,
    operations: options.operations ?? [patchOperation],
    intent: {
      id: `${item.semantic_key}:${item.selector.part}:${item.selector.scope}:${idSuffix}`,
      type: operationType,
      target:
        options.target ??
        {
          kind: "patch_targets",
          patchTargetIds: directTargetIds,
          patchPartPaths: directPartPaths
        },
      payload
    }
  });

  switch (patchOperation.type) {
    case "set_run_style":
      return compileRunStyleWriteItems(createItem, patchOperation, {
        kind: "paragraph_ids",
        paragraphIds
      });
    case "set_paragraph_style":
      return compileParagraphStyleWriteItems(
        createItem,
        patchOperation,
        {
          kind: "paragraph_ids",
          paragraphIds
        },
        {
          kind: "patch_targets",
          patchTargetIds: directTargetIds,
          patchPartPaths: directPartPaths
        },
        fontSizeHint
      );
    case "set_section_layout":
      return [
        createItem("set_page_layout", "set_page_layout", patchOperation.section_layout ?? {}, {
          target: {
            kind: "patch_targets",
            patchTargetIds: directTargetIds,
            patchPartPaths: directPartPaths
          }
        })
      ];
    case "set_style_definition":
      return [
        createItem("set_style_definition", "set_style_definition", { style_definition: patchOperation.style_definition ?? {} }, {
          target: {
            kind: "patch_targets",
            patchTargetIds: directTargetIds,
            patchPartPaths: directPartPaths
          }
        })
      ];
    case "set_numbering_level":
      return [
        createItem("set_numbering_level", "set_numbering_level", { numbering_level: patchOperation.numbering_level ?? {} }, {
          target: {
            kind: "patch_targets",
            patchTargetIds: directTargetIds,
            patchPartPaths: directPartPaths
          }
        })
      ];
    case "set_settings_flag":
      return [
        createItem("set_settings_flag", "set_settings_flag", { settings: patchOperation.settings ?? {} }, {
          target: {
            kind: "patch_targets",
            patchTargetIds: directTargetIds,
            patchPartPaths: directPartPaths
          }
        })
      ];
    case "set_attr":
    case "remove_attr":
    case "set_text":
    case "remove_node":
    case "ensure_node":
    case "replace_node_xml":
      return [
        createItem(patchOperation.type, patchOperation.type, {
          ...(patchOperation.path ? { path: patchOperation.path } : {}),
          ...(patchOperation.name ? { name: patchOperation.name } : {}),
          ...(patchOperation.value !== undefined ? { value: patchOperation.value } : {}),
          ...(patchOperation.xml_tag ? { xml_tag: patchOperation.xml_tag } : {}),
          ...(patchOperation.attrs ? { attrs: patchOperation.attrs } : {}),
          ...(patchOperation.node_xml ? { node_xml: patchOperation.node_xml } : {}),
          ...(item.selector.match?.xml_path ? { xml_path: item.selector.match.xml_path } : {})
        }, {
          target: {
            kind: "patch_targets",
            patchTargetIds: directTargetIds,
            patchPartPaths: directPartPaths
          }
        })
      ];
    default:
      return [];
  }
}

function compileRunStyleWriteItems(
  createItem: (
    idSuffix: string,
    operationType: OperationType,
    payload: Record<string, unknown>,
    options?: {
      target?: WriteTargetSpec;
      operations?: TemplatePatchOperation[];
    }
  ) => TemplateWritePlanItem,
  patchOperation: TemplatePatchOperation,
  target: WriteTargetSpec
): TemplateWritePlanItem[] {
  const items: TemplateWritePlanItem[] = [];
  const style = patchOperation.text_style ?? {};
  const mapping: Array<{ key: string; type: OperationType }> = [
    { key: "font_name", type: "set_font" },
    { key: "font_size_pt", type: "set_size" },
    { key: "font_color", type: "set_font_color" },
    { key: "is_bold", type: "set_bold" },
    { key: "is_italic", type: "set_italic" },
    { key: "is_underline", type: "set_underline" },
    { key: "is_strike", type: "set_strike" },
    { key: "highlight_color", type: "set_highlight_color" },
    { key: "is_all_caps", type: "set_all_caps" }
  ];
  for (const entry of mapping) {
    if (style[entry.key] === undefined) {
      continue;
    }
    items.push(
      createItem(entry.type, entry.type, { [entry.key]: style[entry.key] }, {
        target,
        operations: [{ ...patchOperation, text_style: { [entry.key]: style[entry.key] } }]
      })
    );
  }
  return items;
}

function compileParagraphStyleWriteItems(
  createItem: (
    idSuffix: string,
    operationType: OperationType,
    payload: Record<string, unknown>,
    options?: {
      target?: WriteTargetSpec;
      operations?: TemplatePatchOperation[];
    }
  ) => TemplateWritePlanItem,
  patchOperation: TemplatePatchOperation,
  textTarget: WriteTargetSpec,
  blockTarget: WriteTargetSpec,
  fontSizeHint: number
): TemplateWritePlanItem[] {
  const items: TemplateWritePlanItem[] = [];
  const paragraphStyle = patchOperation.paragraph_style ?? {};
  if (patchOperation.style_id) {
    items.push(
      createItem("set_attr:p_style", "set_attr", { path: "w:pPr/w:pStyle", name: "w:val", value: patchOperation.style_id }, {
        target: blockTarget,
        operations: [{ ...patchOperation, paragraph_style: {} }]
      })
    );
  }
  if (paragraphStyle.line_spacing !== undefined) {
    items.push(
      createItem("set_line_spacing", "set_line_spacing", { line_spacing: paragraphStyle.line_spacing }, {
        target: textTarget,
        operations: [{ ...patchOperation, paragraph_style: { line_spacing: paragraphStyle.line_spacing } }]
      })
    );
  }
  if (paragraphStyle.paragraph_alignment !== undefined) {
    items.push(
      createItem("set_alignment", "set_alignment", { paragraph_alignment: paragraphStyle.paragraph_alignment }, {
        target: textTarget,
        operations: [{ ...patchOperation, paragraph_style: { paragraph_alignment: paragraphStyle.paragraph_alignment } }]
      })
    );
  }
  if (paragraphStyle.first_line_indent_pt !== undefined || paragraphStyle.first_line_indent_chars !== undefined) {
    const normalized =
      paragraphStyle.first_line_indent_chars !== undefined
        ? { first_line_indent_chars: paragraphStyle.first_line_indent_chars }
        : { first_line_indent_pt: paragraphStyle.first_line_indent_pt };
    items.push(
      createItem("set_paragraph_indent", "set_paragraph_indent", normalized, {
        target: textTarget,
        operations: [
          {
            ...patchOperation,
            paragraph_style: {
              ...(paragraphStyle.first_line_indent_pt !== undefined
                ? { first_line_indent_pt: paragraphStyle.first_line_indent_pt }
                : {}),
              ...(paragraphStyle.first_line_indent_chars !== undefined
                ? { first_line_indent_chars: paragraphStyle.first_line_indent_chars }
                : {})
            }
          }
        ]
      })
    );
  }
  const spacingPayload: Record<string, unknown> = {};
  if (paragraphStyle.space_before_pt !== undefined) {
    spacingPayload.before_pt = paragraphStyle.space_before_pt;
  }
  if (paragraphStyle.space_after_pt !== undefined) {
    spacingPayload.after_pt = paragraphStyle.space_after_pt;
  }
  if (Object.keys(spacingPayload).length > 0) {
    const spacingIdSuffix =
      spacingPayload.before_pt !== undefined && spacingPayload.after_pt !== undefined
        ? "set_paragraph_spacing"
        : spacingPayload.before_pt !== undefined
          ? "set_paragraph_spacing:before"
          : "set_paragraph_spacing:after";
    items.push(
      createItem(spacingIdSuffix, "set_paragraph_spacing", spacingPayload, {
        target: textTarget,
        operations: [{ ...patchOperation, paragraph_style: paragraphStyle }]
      })
    );
  }
  for (const [name, value] of Object.entries(paragraphStyle)) {
    if (
      name === "line_spacing" ||
      name === "paragraph_alignment" ||
      name === "first_line_indent_pt" ||
      name === "first_line_indent_chars" ||
      name === "space_before_pt" ||
      name === "space_after_pt"
    ) {
      continue;
    }
    const normalized = normalizeParagraphStyleField(name, value, fontSizeHint);
    items.push(
      createItem(`set_attr:${normalized.name}`, "set_attr", { name: normalized.name, value: normalized.value }, {
        target: blockTarget,
        operations: [{ ...patchOperation, paragraph_style: { [name]: value } }]
      })
    );
  }
  return items;
}

function mapPartKind(part: string): DocxPatchTarget["part_kind"] {
  return part === "document" ? "document" : (part as DocxPatchTarget["part_kind"]);
}

function resolvePartPath(
  document: DocumentIR,
  part: string,
  explicitPartPath: string | undefined,
  fallback: string
): string {
  if (explicitPartPath?.trim()) {
    return explicitPartPath.trim();
  }
  const observation = document.metadata?.docxObservation as { package_model?: { parts?: Array<{ path?: string; kind?: string }> } } | undefined;
  const parts = observation?.package_model?.parts ?? [];
  if (part === "document") {
    return parts.find((item) => item.kind === "main_document")?.path ?? fallback;
  }
  if (part === "header") {
    return parts.find((item) => item.kind === "header")?.path ?? fallback;
  }
  if (part === "footer") {
    return parts.find((item) => item.kind === "footer")?.path ?? fallback;
  }
  if (part === "styles") {
    return parts.find((item) => item.path === "word/styles.xml")?.path ?? fallback;
  }
  if (part === "numbering") {
    return parts.find((item) => item.path === "word/numbering.xml")?.path ?? fallback;
  }
  if (part === "settings") {
    return parts.find((item) => item.path === "word/settings.xml")?.path ?? fallback;
  }
  return fallback;
}

function readObservationTargets(document: DocumentIR): Map<string, DocxPatchTarget> {
  const targets = ((document.metadata?.docxObservation as { patch_targets?: DocxPatchTarget[] } | undefined)?.patch_targets ?? []);
  return new Map(targets.map((target) => [target.id, target] as const));
}

function readStructureIndex(document: DocumentIR): {
  paragraphs: Array<{ id: string; runNodeIds: string[]; partPath?: string }>;
} | undefined {
  const candidate = document.metadata?.structureIndex as
    | { paragraphs?: Array<{ id: string; runNodeIds: string[]; partPath?: string }> }
    | undefined;
  if (!Array.isArray(candidate?.paragraphs)) {
    return undefined;
  }
  return {
    paragraphs: candidate.paragraphs
  };
}

function sanitizeTargetSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]+/g, "_");
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function readFontSizeHint(operations: TemplatePatchOperation[]): number {
  for (const operation of operations) {
    const value = operation.text_style?.font_size_pt;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 12;
}

function normalizeParagraphStyleField(name: string, value: unknown, fontSizeHint: number): { name: string; value: unknown } {
  if (name === "first_line_indent_chars" && typeof value === "number" && Number.isFinite(value)) {
    return {
      name: "first_line_indent_pt",
      value: value * fontSizeHint
    };
  }
  return { name, value };
}

function isParagraphBoundIntent(intent: WriteTargetSpec | { target: WriteTargetSpec } | undefined): boolean {
  const target = intent && "target" in intent ? intent.target : intent;
  if (!target) {
    return false;
  }
  if (target.kind === "paragraph_ids") {
    return true;
  }
  return target.kind === "selector" && ["body", "heading", "list_item", "paragraph_ids"].includes(target.selector.scope);
}

function normalizeAtomicPlanItem(item: TemplateAtomicPlanItem & LegacyAtomicPlanLike): TemplateAtomicPlanItem {
  if (item.selector && Array.isArray(item.operations)) {
    return item;
  }
  const operations: TemplatePatchOperation[] = [];
  if (Object.keys(item.paragraph_style ?? {}).length > 0) {
    operations.push({
      type: "set_paragraph_style",
      paragraph_style: item.paragraph_style
    });
  }
  if (Object.keys(item.text_style ?? {}).length > 0) {
    operations.push({
      type: "set_run_style",
      text_style: item.text_style
    });
  }
  if ((item.relative_spacing ?? {}).before_pt !== undefined) {
    operations.push({
      type: "set_paragraph_style",
      paragraph_style: {
        space_before_pt: (item.relative_spacing ?? {}).before_pt
      }
    });
  }
  if ((item.relative_spacing ?? {}).after_pt !== undefined) {
    operations.push({
      type: "set_paragraph_style",
      paragraph_style: {
        space_after_pt: (item.relative_spacing ?? {}).after_pt
      }
    });
  }
  return {
    semantic_key: item.semantic_key,
    paragraph_ids: item.paragraph_ids ?? [],
    selector: {
      part: "document",
      scope: "paragraph",
      match: {
        paragraph_ids: item.paragraph_ids ?? []
      }
    },
    operations
  };
}

function validateLegacyAtomicPlanItem(item: TemplateAtomicPlanItem & LegacyAtomicPlanLike): TemplateValidationIssue[] {
  const candidate =
    item.selector && Array.isArray(item.operations) && item.source_block
      ? (item.source_block as LegacyAtomicPlanLike)
      : item;

  const issues: TemplateValidationIssue[] = [];
  const pushIssue = (fieldPath: string): void => {
    issues.push({
      error_code: "unsupported_style_field",
      message: `legacy template field '${fieldPath}' is not supported by the patch DSL compiler.`,
      semantic_key: item.semantic_key,
      paragraph_ids: item.paragraph_ids ?? []
    });
  };

  const relativeSpacing = candidate.relative_spacing;
  if (relativeSpacing && typeof relativeSpacing === "object") {
    for (const key of Object.keys(relativeSpacing)) {
      if (key !== "before_pt" && key !== "after_pt") {
        pushIssue(`relative_spacing.${key}`);
      }
    }
  }

  if (candidate.placement_rules && Object.keys(candidate.placement_rules).length > 0) {
    pushIssue("placement_rules");
  }

  return issues;
}
