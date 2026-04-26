import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { AgentError } from "../core/errors.js";
import type { DocumentIR, Operation, Tool, ToolExecutionInput, ToolExecutionOutput } from "../core/types.js";
import type {
  DocxObservationState,
  DocxPatchOperation,
  DocxPatchSet,
  DocxPatchTarget
} from "./docx-observation-schema.js";
import { isDocxObservationState } from "./docx-observation-schema.js";
import { normalizeWriteOperationPayload } from "./style-operation.js";

const RUN_STYLE_FIELDS = new Set([
  "font_name",
  "font_size_pt",
  "font_color",
  "is_bold",
  "is_italic",
  "is_underline",
  "is_strike",
  "highlight_color",
  "is_all_caps"
]);

const PARAGRAPH_STYLE_FIELDS = new Set([
  "line_spacing",
  "paragraph_alignment",
  "space_before_pt",
  "space_after_pt",
  "first_line_indent_pt"
]);

const PARAGRAPH_PROPERTY_ORDER = createSchemaOrder([
  "pStyle",
  "keepNext",
  "keepLines",
  "pageBreakBefore",
  "framePr",
  "widowControl",
  "numPr",
  "suppressLineNumbers",
  "pBdr",
  "shd",
  "tabs",
  "suppressAutoHyphens",
  "kinsoku",
  "wordWrap",
  "overflowPunct",
  "topLinePunct",
  "autoSpaceDE",
  "autoSpaceDN",
  "bidi",
  "adjustRightInd",
  "snapToGrid",
  "spacing",
  "ind",
  "contextualSpacing",
  "mirrorIndents",
  "suppressOverlap",
  "jc",
  "textDirection",
  "textAlignment",
  "textboxTightWrap",
  "outlineLvl",
  "divId",
  "cnfStyle",
  "rPr",
  "sectPr",
  "pPrChange"
]);

const RUN_PROPERTY_ORDER = createSchemaOrder([
  "rStyle",
  "rFonts",
  "b",
  "bCs",
  "i",
  "iCs",
  "caps",
  "smallCaps",
  "strike",
  "dstrike",
  "outline",
  "shadow",
  "emboss",
  "imprint",
  "noProof",
  "snapToGrid",
  "vanish",
  "webHidden",
  "color",
  "spacing",
  "w",
  "kern",
  "position",
  "sz",
  "szCs",
  "highlight",
  "u",
  "effect",
  "bdr",
  "shd",
  "fitText",
  "vertAlign",
  "rtl",
  "cs",
  "em",
  "lang",
  "eastAsianLayout",
  "specVanish",
  "oMath",
  "rPrChange"
]);

const SECTION_PROPERTY_ORDER = createSchemaOrder([
  "headerReference",
  "footerReference",
  "footnotePr",
  "endnotePr",
  "type",
  "pgSz",
  "pgMar",
  "paperSrc",
  "pgBorders",
  "lnNumType",
  "pgNumType",
  "cols",
  "formProt",
  "vAlign",
  "noEndnote",
  "titlePg",
  "textDirection",
  "bidi",
  "rtlGutter",
  "docGrid",
  "printerSettings",
  "sectPrChange"
]);

export interface PatchCompilationResult {
  patchSet: DocxPatchSet;
  patchTargetIds: string[];
  partPaths: string[];
  targetCount: number;
}

interface ResolvedPatchTarget {
  id: string;
  target_kind: DocxPatchTarget["target_kind"];
  part_path: string;
  block_id: string;
  node_id?: string;
  xml_tag?: string;
  parent_target_id?: string;
  locator?: { part_path: string; xml_path: string };
}

interface MaterializationResult {
  doc: DocumentIR;
  summary: string;
  artifacts?: Record<string, unknown>;
}

export class PatchFirstWriteOperationTool implements Tool {
  readonly name = "write_operation";
  readonly readOnly = false;

  async validate(input: ToolExecutionInput): Promise<void> {
    if (!input.operation) {
      throw invalidOperation("Write operation is required.");
    }
    normalizeWriteOperationPayload(input.operation);
    compileOperationToPatchSet(input.doc, input.operation);
  }

  async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    const operation = input.operation;
    if (!operation) {
      throw invalidOperation("Write operation is required.");
    }
    const compilation = compileOperationToPatchSet(input.doc, operation);
    return applyPatchSetToDocument(input.doc, compilation.patchSet, {
      operation,
      targetCount: compilation.targetCount,
      partPaths: compilation.partPaths,
      patchTargetIds: compilation.patchTargetIds
    });
  }

  async rollback(rollbackToken: string, doc: DocumentIR): Promise<DocumentIR> {
    return decodeRollbackToken(rollbackToken) ?? structuredClone(doc);
  }
}

export class ApplyDocxXmlPatchTool implements Tool {
  readonly name = "apply_docx_xml_patch";
  readonly readOnly = false;

  async validate(input: ToolExecutionInput): Promise<void> {
    const patchSet = readPatchSetPayload(input.operation?.payload);
    if (patchSet.operations.length === 0) {
      throw invalidOperation("apply_docx_xml_patch requires a non-empty patchSet.");
    }
  }

  async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    const patchSet = readPatchSetPayload(input.operation?.payload);
    return applyPatchSetToDocument(input.doc, patchSet);
  }

  async rollback(rollbackToken: string, doc: DocumentIR): Promise<DocumentIR> {
    return decodeRollbackToken(rollbackToken) ?? structuredClone(doc);
  }
}

export function compileOperationToPatchSet(doc: DocumentIR, operation: Operation): PatchCompilationResult {
  if (operation.type === "merge_paragraph" || operation.type === "split_paragraph") {
    throw patchCompileError(`Operation '${operation.type}' cannot be compiled into a stable XML patch set.`);
  }
  const normalizedPayload = normalizeWriteOperationPayload(operation);
  const targets = resolvePatchTargets(doc, operation, normalizedPayload);
  if (targets.length === 0) {
    throw patchCompileError(`Operation '${operation.id}' did not resolve to any patch targets.`);
  }

  const operations = compilePatchOperations(operation, targets, normalizedPayload);

  if (operations.length === 0) {
    throw patchCompileError(`Operation '${operation.id}' produced an empty patch set.`);
  }

  return {
    patchSet: { targets: dedupeTargets(targets).map(toPatchTarget), operations },
    patchTargetIds: targets.map((target) => target.id),
    partPaths: unique(targets.map((target) => target.part_path)),
    targetCount: targets.length
  };
}

export function applyPatchSetToDocument(
  doc: DocumentIR,
  patchSet: DocxPatchSet,
  options: {
    operation?: Operation;
    targetCount?: number;
    partPaths?: string[];
    patchTargetIds?: string[];
  } = {}
): ToolExecutionOutput {
  const previousDoc = structuredClone(doc);
  const nextDoc = structuredClone(doc);
  const metadata = ensureMetadata(nextDoc);
  const observation = cloneObservation(metadata.docxObservation);
  const targetIndex = buildPatchTargetIndex(observation, doc, patchSet.targets);
  const partPaths = unique(
    options.partPaths ??
      patchSet.operations
        .map((operation) => targetIndex.get(operation.target_id)?.part_path)
        .filter((value): value is string => typeof value === "string" && value.length > 0)
  );

  for (const operation of patchSet.operations) {
    applyPatchOperation(nextDoc, observation, operation, targetIndex);
  }

  if (observation) {
    metadata.docxObservation = observation;
    metadata.docxPackageModel = observation.package_model;
  }
  const patchHistory = Array.isArray(metadata.docxPatchHistory)
    ? (metadata.docxPatchHistory as DocxPatchSet[])
    : [];
  metadata.docxPatchHistory = [...patchHistory, patchSet];

  const targetCount = options.targetCount ?? unique(patchSet.operations.map((operation) => operation.target_id)).length;
  const summary = `Applied patch set for ${options.operation?.type ?? "docx_write"}: ${patchSet.operations.length} patch(es), ${targetCount} target(s), parts=${partPaths.join(", ")}`;
  return {
    doc: nextDoc,
    summary,
    rollbackToken: encodeRollbackToken(previousDoc),
    artifacts: {
      patchSet,
      targetCount,
      partPaths,
      patchTargetIds: options.patchTargetIds ?? unique(patchSet.operations.map((operation) => operation.target_id))
    }
  };
}

export async function materializeDocxPackage(doc: DocumentIR): Promise<MaterializationResult> {
  const metadata = doc.metadata;
  const inputDocxPath = readMetadataString(metadata, "inputDocxPath");
  const outputDocxPath = readMetadataString(metadata, "outputDocxPath");
  if (!outputDocxPath) {
    throw new AgentError({
      code: "E_OUTPUT_PATH_REQUIRED",
      message: "document.metadata.outputDocxPath is required for materialize_docx_package.",
      retryable: false
    });
  }
  if (!inputDocxPath) {
    throw new AgentError({
      code: "E_INPUT_PATH_REQUIRED",
      message: "document.metadata.inputDocxPath is required for materialize_docx_package.",
      retryable: false
    });
  }

  const patchHistory = Array.isArray(metadata?.docxPatchHistory)
    ? (metadata?.docxPatchHistory as DocxPatchSet[])
    : [];
  if (patchHistory.length === 0) {
    await copyFile(inputDocxPath, outputDocxPath);
    return {
      doc: structuredClone(doc),
      summary: `Materialized docx package without XML changes to ${outputDocxPath}.`,
      artifacts: { outputDocxPath, partPaths: [] }
    };
  }

  const observation = readObservation(doc);
  const syntheticTargets = patchHistory.flatMap((patchSet) => patchSet.targets ?? []);
  const targetIndex = buildPatchTargetIndex(observation, doc, syntheticTargets);
  const zip = await JSZip.loadAsync(await readFile(inputDocxPath));
  const changedPartPaths = new Set<string>();
  const serializer = new XMLSerializer();

  for (const patchSet of patchHistory) {
    const grouped = new Map<string, DocxPatchOperation[]>();
    for (const operation of patchSet.operations) {
      const target = targetIndex.get(operation.target_id);
      if (!target) {
        throw patchCompileError(`Unknown patch target '${operation.target_id}' during materialization.`);
      }
      const items = grouped.get(target.part_path) ?? [];
      items.push(operation);
      grouped.set(target.part_path, items);
    }

    for (const [partPath, operations] of grouped) {
      const file = zip.file(partPath);
      if (!file) {
        throw patchCompileError(`DOCX package is missing target part '${partPath}'.`);
      }
      const xml = await file.async("string");
      const dom = new DOMParser().parseFromString(xml, "application/xml");
      for (const operation of operations) {
        const target = targetIndex.get(operation.target_id);
        if (!target) {
          continue;
        }
        applyPatchOperationToXml(dom, target, operation);
      }
      zip.file(partPath, serializer.serializeToString(dom));
      changedPartPaths.add(partPath);
    }
  }

  await writeFile(
    outputDocxPath,
    await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    })
  );
  return {
    doc: structuredClone(doc),
    summary: `Materialized docx package to ${outputDocxPath}; changed parts=${Array.from(changedPartPaths).join(", ")}`,
    artifacts: {
      outputDocxPath,
      partPaths: Array.from(changedPartPaths)
    }
  };
}

function resolvePatchTargets(
  doc: DocumentIR,
  operation: Operation,
  normalizedPayload: Record<string, unknown>
): ResolvedPatchTarget[] {
  const observation = readObservation(doc);
  const targetIndex = buildPatchTargetIndex(observation, doc);
  const targetIds = readRequestedTargetIds(operation);
  if (targetIds.length === 0 && operation.type !== "set_page_layout") {
    throw patchCompileError(`Operation '${operation.id}' requires targetNodeId, targetNodeIds, or patchTargetIds.`);
  }

  if (operation.type === "set_page_layout") {
    const firstPartPath =
      observation?.package_meta.part_paths?.find((partPath) => partPath === "word/document.xml") ?? "word/document.xml";
    return [
      {
        id: "target:document:section:0",
        target_kind: "block",
        part_path: firstPartPath,
        block_id: "section:0",
        locator: { part_path: firstPartPath, xml_path: "/document/body/sectPr[0]" }
      }
    ];
  }

  const useBlockTargets = Object.keys(normalizedPayload).some((name) => PARAGRAPH_STYLE_FIELDS.has(name));
  const results: ResolvedPatchTarget[] = [];
  for (const requested of targetIds) {
    const directTarget = targetIndex.get(requested);
    if (directTarget) {
      results.push(useBlockTargets ? coerceBlockTarget(directTarget, observation, targetIndex) : directTarget);
      continue;
    }

    const inferredId = `target:inline:${requested}`;
    const inlineTarget = targetIndex.get(inferredId);
    if (inlineTarget) {
      results.push(useBlockTargets ? coerceBlockTarget(inlineTarget, observation, targetIndex) : inlineTarget);
      continue;
    }

    const synthesizedTarget = synthesizePatchTarget(requested, operation, normalizedPayload, observation);
    if (synthesizedTarget) {
      results.push(useBlockTargets ? coerceBlockTarget(synthesizedTarget, observation, targetIndex) : synthesizedTarget);
      continue;
    }

    throw patchCompileError(`Operation '${operation.id}' could not resolve stable patch target for '${requested}'.`);
  }

  return dedupeTargets(results);
}

function compilePatchOperations(
  operation: Operation,
  targets: ResolvedPatchTarget[],
  normalizedPayload: Record<string, unknown>
): DocxPatchOperation[] {
  const operations: DocxPatchOperation[] = [];
  const pushOperation = (value: Omit<DocxPatchOperation, "id">): void => {
    operations.push({
      id: `${operation.id}:patch:${operations.length}`,
      ...value
    });
  };

  if (operation.type === "set_style_definition") {
    for (const target of targets) {
      for (const [name, value] of Object.entries(readNestedRecord(normalizedPayload, "style_definition"))) {
        pushOperation({
          type: "set_attr",
          target_id: target.id,
          name: ensureWordAttrName(name),
          value
        });
      }
    }
    return operations;
  }

  if (operation.type === "set_numbering_level") {
    for (const target of targets) {
      for (const [name, value] of Object.entries(readNestedRecord(normalizedPayload, "numbering_level"))) {
        pushOperation({
          type: "set_attr",
          target_id: target.id,
          name: ensureWordAttrName(name),
          value
        });
      }
    }
    return operations;
  }

  if (operation.type === "set_settings_flag") {
    for (const target of targets) {
      for (const [name, value] of Object.entries(readNestedRecord(normalizedPayload, "settings"))) {
        pushOperation({
          type: "set_attr",
          target_id: target.id,
          name: ensureWordAttrName(name),
          value
        });
      }
    }
    return operations;
  }

  if (
    operation.type === "set_attr" ||
    operation.type === "remove_attr" ||
    operation.type === "set_text" ||
    operation.type === "remove_node" ||
    operation.type === "ensure_node" ||
    operation.type === "replace_node_xml"
  ) {
    for (const target of targets) {
      pushOperation({
        type: operation.type,
        target_id: target.id,
        ...(typeof normalizedPayload.path === "string" ? { path: normalizedPayload.path } : {}),
        ...(typeof normalizedPayload.name === "string" ? { name: normalizedPayload.name } : {}),
        ...(normalizedPayload.value !== undefined ? { value: normalizedPayload.value } : {}),
        ...(typeof normalizedPayload.xml_tag === "string" ? { xml_tag: normalizedPayload.xml_tag } : {}),
        ...(isStringRecord(normalizedPayload.attrs) ? { attrs: normalizedPayload.attrs } : {}),
        ...(typeof normalizedPayload.node_xml === "string" ? { node_xml: normalizedPayload.node_xml } : {})
      });
    }
    return operations;
  }

  for (const target of targets) {
    for (const [name, value] of Object.entries(normalizedPayload)) {
      pushOperation({
        type: "set_attribute",
        target_id: target.id,
        name,
        value
      });
    }
  }
  return operations;
}

function synthesizePatchTarget(
  requested: string,
  operation: Operation,
  normalizedPayload: Record<string, unknown>,
  observation: DocxObservationState | undefined
): ResolvedPatchTarget | undefined {
  const partPath = resolveSyntheticPartPath(requested, operation, observation);
  if (!partPath) {
    return undefined;
  }

  if (requested.startsWith("target:styles:style:")) {
    const styleId = requested.slice("target:styles:style:".length);
    return {
      id: requested,
      target_kind: "style",
      part_path: partPath,
      block_id: styleId,
      locator: {
        part_path: partPath,
        xml_path: readSyntheticXmlPath(normalizedPayload, `/styles/style[${styleId}]`) ?? `/styles/style[${styleId}]`
      }
    };
  }

  if (requested.startsWith("target:styles:docDefaults")) {
    const suffix = requested.slice("target:styles:".length);
    return {
      id: requested,
      target_kind: "style_defaults",
      part_path: partPath,
      block_id: suffix,
      locator: {
        part_path: partPath,
        xml_path: readSyntheticXmlPath(normalizedPayload, `/styles/${suffix.replace(/:/g, "/")}`) ?? `/styles/${suffix.replace(/:/g, "/")}`
      }
    };
  }

  if (requested.startsWith("target:numbering:")) {
    const match = requested.match(/^target:numbering:([^:]+):(\d+)$/);
    if (!match) {
      return undefined;
    }
    const [, numId, ilvl] = match;
    return {
      id: requested,
      target_kind: "numbering_level",
      part_path: partPath,
      block_id: `${numId}:${ilvl}`,
      locator: {
        part_path: partPath,
        xml_path:
          readSyntheticXmlPath(normalizedPayload, `/numbering/abstractNum[${numId}]/lvl[${ilvl}]`) ??
          `/numbering/abstractNum[${numId}]/lvl[${ilvl}]`
      }
    };
  }

  if (requested.startsWith("target:settings:")) {
    const suffix = requested.slice("target:settings:".length);
    return {
      id: requested,
      target_kind: "settings_node",
      part_path: partPath,
      block_id: "settings",
      locator: {
        part_path: partPath,
        xml_path:
          readSyntheticXmlPath(normalizedPayload, suffix === "settings" ? "/settings" : `/settings/${suffix}`) ??
          (suffix === "settings" ? "/settings" : `/settings/${suffix}`)
      }
    };
  }

  const xmlPath = readSyntheticXmlPath(normalizedPayload);
  if (!xmlPath) {
    return undefined;
  }
  return {
    id: requested,
    target_kind: inferSyntheticTargetKind(requested, partPath),
    part_path: partPath,
    block_id: sanitizeTargetSuffix(xmlPath),
    locator: {
      part_path: partPath,
      xml_path: xmlPath
    }
  };
}

function resolveSyntheticPartPath(
  requested: string,
  operation: Operation,
  observation: DocxObservationState | undefined
): string | undefined {
  if (Array.isArray(operation.patchPartPaths) && operation.patchPartPaths.length > 0) {
    return operation.patchPartPaths[0];
  }
  if (requested.startsWith("target:styles:")) {
    return observation?.package_model.parts.find((part) => part.path === "word/styles.xml")?.path ?? "word/styles.xml";
  }
  if (requested.startsWith("target:numbering:")) {
    return observation?.package_model.parts.find((part) => part.path === "word/numbering.xml")?.path ?? "word/numbering.xml";
  }
  if (requested.startsWith("target:settings:")) {
    return observation?.package_model.parts.find((part) => part.path === "word/settings.xml")?.path ?? "word/settings.xml";
  }
  return observation?.package_model.parts.find((part) => part.path === "word/document.xml")?.path ?? "word/document.xml";
}

function readSyntheticXmlPath(normalizedPayload: Record<string, unknown>, fallback?: string): string | undefined {
  const xmlPath = normalizedPayload.xml_path;
  return typeof xmlPath === "string" && xmlPath.trim() ? xmlPath.trim() : fallback;
}

function inferSyntheticTargetKind(
  requested: string,
  partPath: string
): ResolvedPatchTarget["target_kind"] {
  if (requested.startsWith("target:styles:")) {
    return "style";
  }
  if (requested.startsWith("target:numbering:")) {
    return "numbering_level";
  }
  if (requested.startsWith("target:settings:")) {
    return "settings_node";
  }
  if (partPath.endsWith("styles.xml")) {
    return "style";
  }
  if (partPath.endsWith("numbering.xml")) {
    return "numbering_level";
  }
  if (partPath.endsWith("settings.xml")) {
    return "settings_node";
  }
  return "block";
}

function readRequestedTargetIds(operation: Operation): string[] {
  if (Array.isArray(operation.patchTargetIds) && operation.patchTargetIds.length > 0) {
    return unique(
      operation.patchTargetIds
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    );
  }
  if (Array.isArray(operation.targetNodeIds) && operation.targetNodeIds.length > 0) {
    return unique(
      operation.targetNodeIds
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    );
  }
  if (operation.targetNodeId?.trim()) {
    return [operation.targetNodeId.trim()];
  }
  return [];
}

function coerceBlockTarget(
  target: ResolvedPatchTarget,
  observation: DocxObservationState | undefined,
  index: Map<string, ResolvedPatchTarget>
): ResolvedPatchTarget {
  if (target.target_kind === "block") {
    return target;
  }
  const blockTargetId = `target:block:${target.block_id}`;
  const blockTarget = index.get(blockTargetId);
  if (blockTarget) {
    return blockTarget;
  }
  const inlineSource = observation?.patch_targets.find((candidate) => candidate.id === target.id);
  return {
    id: blockTargetId,
    target_kind: "block",
    part_path: target.part_path,
    block_id: target.block_id,
    locator: inlineSource?.locator
  };
}

function dedupeTargets(targets: ResolvedPatchTarget[]): ResolvedPatchTarget[] {
  const map = new Map<string, ResolvedPatchTarget>();
  for (const target of targets) {
    map.set(target.id, target);
  }
  return Array.from(map.values());
}

function toPatchTarget(target: ResolvedPatchTarget): DocxPatchTarget {
  return {
    id: target.id,
    target_kind: target.target_kind,
    part_path: target.part_path,
    block_id: target.block_id,
    ...(target.node_id ? { node_id: target.node_id } : {}),
    ...(target.xml_tag ? { xml_tag: target.xml_tag } : {}),
    ...(target.parent_target_id ? { parent_target_id: target.parent_target_id } : {}),
    ...(target.locator ? { locator: target.locator } : {})
  };
}

function readObservation(doc: DocumentIR): DocxObservationState | undefined {
  const candidate = doc.metadata?.docxObservation;
  return isDocxObservationState(candidate) ? candidate : undefined;
}

function cloneObservation(value: unknown): DocxObservationState | undefined {
  return isDocxObservationState(value) ? structuredClone(value) : undefined;
}

function buildPatchTargetIndex(
  observation: DocxObservationState | undefined,
  doc?: DocumentIR,
  extraTargets: DocxPatchTarget[] = []
): Map<string, ResolvedPatchTarget> {
  const index = new Map<string, ResolvedPatchTarget>();
  for (const target of [...(observation?.patch_targets ?? []), ...extraTargets]) {
    index.set(target.id, {
      id: target.id,
      target_kind: target.target_kind,
      part_path: target.part_path,
      block_id: target.block_id,
      node_id: target.node_id,
      xml_tag: target.xml_tag,
      parent_target_id: target.parent_target_id,
      locator: target.locator
    });
  }
  if (observation) {
    const documentPartPath =
      observation.package_meta?.part_paths?.find((partPath) => partPath === "word/document.xml") ?? "word/document.xml";
    index.set("target:document:section:0", {
      id: "target:document:section:0",
      target_kind: "block",
      part_path: documentPartPath,
      block_id: "section:0",
      locator: { part_path: documentPartPath, xml_path: "/document/body/sectPr[0]" }
    });
  }
  if (doc) {
    addSyntheticTargetsFromDocument(index, doc);
  }
  return index;
}

function addSyntheticTargetsFromDocument(index: Map<string, ResolvedPatchTarget>, doc: DocumentIR): void {
  const paragraphByRunId = new Map<string, { paragraphId: string; partPath: string }>();
  const structureIndex = readStructureIndex(doc);
  for (const paragraph of structureIndex?.paragraphs ?? []) {
    const paragraphId = typeof paragraph.id === "string" && paragraph.id.trim() ? paragraph.id.trim() : "";
    const partPath =
      typeof paragraph.partPath === "string" && paragraph.partPath.trim() ? paragraph.partPath.trim() : "word/document.xml";
    if (paragraphId && !index.has(`target:block:${paragraphId}`)) {
      index.set(`target:block:${paragraphId}`, {
        id: `target:block:${paragraphId}`,
        target_kind: "block",
        part_path: partPath,
        block_id: paragraphId
      });
    }
    for (const runNodeId of Array.isArray(paragraph.runNodeIds) ? paragraph.runNodeIds : []) {
      if (typeof runNodeId === "string" && runNodeId.trim()) {
        paragraphByRunId.set(runNodeId.trim(), { paragraphId, partPath });
      }
    }
  }

  for (const node of doc.nodes) {
    const targetId = `target:inline:${node.id}`;
    if (index.has(targetId)) {
      continue;
    }
    const paragraph = paragraphByRunId.get(node.id);
    index.set(targetId, {
      id: targetId,
      target_kind: "inline",
      part_path: paragraph?.partPath ?? "word/document.xml",
      block_id: paragraph?.paragraphId ?? `p:${node.id}`,
      node_id: node.id
    });
  }
}

function applyPatchOperation(
  doc: DocumentIR,
  observation: DocxObservationState | undefined,
  operation: DocxPatchOperation,
  targetIndex: Map<string, ResolvedPatchTarget>
): void {
  const target = targetIndex.get(operation.target_id);
  if (!target) {
    throw patchCompileError(`Unknown patch target '${operation.target_id}'.`);
  }
  if ((operation.type !== "set_attribute" && operation.type !== "set_attr") || !operation.name) {
    return;
  }
  if (target.id === "target:document:section:0") {
    const pageLayout = ensureNestedRecord(ensureMetadata(doc), "page_layout");
    pageLayout[operation.name] = operation.value;
    return;
  }

  const affectedNodeIds =
    target.target_kind === "inline" || target.target_kind === "run"
      ? [target.node_id].filter((value): value is string => typeof value === "string")
      : (observation?.inline_nodes ?? [])
          .filter((node) => node.block_id === target.block_id && node.node_type === "text")
          .map((node) => node.id);

  for (const nodeId of affectedNodeIds) {
    const node = doc.nodes.find((candidate) => candidate.id === nodeId);
    if (node) {
      node.style = { ...(node.style ?? {}), [operation.name]: operation.value, operation: inferOperationName(operation.name) };
    }
    const observationNode = observation?.inline_nodes.find((candidate) => candidate.id === nodeId && candidate.node_type === "text");
    if (observationNode) {
      observationNode.style = { ...(observationNode.style ?? {}), [operation.name]: operation.value };
      if (operation.name === "font_name" || operation.name === "font_color" || operation.name === "highlight_color") {
        observationNode.style.operation = inferOperationName(operation.name);
      }
    }
  }
}

function applyPatchOperationToXml(documentDom: Document, target: ResolvedPatchTarget, operation: DocxPatchOperation): void {
  if (target.id === "target:document:section:0") {
    if ((operation.type === "set_attribute" || operation.type === "set_attr") && operation.name) {
      applyDocumentLevelPatch(documentDom, operation.name, operation.value);
    }
    return;
  }
  if (!target.locator?.xml_path) {
    throw patchCompileError(`Patch target '${target.id}' is missing an XML locator.`);
  }
  const element = locateElementByXmlPath(documentDom, target.locator.xml_path);
  if (!element) {
    throw patchCompileError(`Failed to locate XML anchor '${target.locator.xml_path}' for target '${target.id}'.`);
  }
  if ((operation.type === "set_attribute" || operation.type === "set_attr") && operation.name && RUN_STYLE_FIELDS.has(operation.name)) {
    const run = localName(element) === "t" ? (element.parentNode as Element | null) : localName(element) === "r" ? element : null;
    if (!run) {
      throw patchCompileError(`Run-level patch '${operation.name}' resolved outside a run element.`);
    }
    applyRunStylePatch(run, operation.name, operation.value);
    return;
  }
  if ((operation.type === "set_attribute" || operation.type === "set_attr") && operation.name && PARAGRAPH_STYLE_FIELDS.has(operation.name)) {
    const paragraph = localName(element) === "p" ? element : findClosestAncestor(element, "p");
    if (!paragraph) {
      throw patchCompileError(`Paragraph-level patch '${operation.name}' resolved outside a paragraph element.`);
    }
    applyParagraphStylePatch(paragraph, operation.name, operation.value);
    return;
  }

  if (operation.type === "ensure_node") {
    if (!operation.path || !operation.xml_tag) {
      throw patchCompileError(`ensure_node requires path and xml_tag for target '${target.id}'.`);
    }
    const ensured = ensureRelativePath(element, operation.path);
    if (operation.attrs) {
      for (const [name, value] of Object.entries(operation.attrs)) {
        ensured.setAttribute(name, value);
      }
    }
    return;
  }

  if (operation.type === "set_text") {
    const candidate = resolveOperationElement(element, operation);
    if (!candidate) {
      throw patchCompileError(`stale xml locator for target '${target.id}'.`);
    }
    while (candidate.firstChild) {
      candidate.removeChild(candidate.firstChild);
    }
    candidate.appendChild(documentDom.createTextNode(String(operation.value ?? "")));
    return;
  }

  if (operation.type === "remove_node") {
    const candidate = resolveOperationElement(element, operation);
    if (!candidate?.parentNode) {
      throw patchCompileError(`remove_node could not resolve target '${target.id}'.`);
    }
    candidate.parentNode.removeChild(candidate);
    return;
  }

  if (operation.type === "replace_node_xml") {
    const candidate = resolveOperationElement(element, operation);
    if (!candidate?.parentNode || !operation.node_xml) {
      throw patchCompileError(`replace_node_xml could not resolve target '${target.id}'.`);
    }
    const wrapper = new DOMParser().parseFromString(`<root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${operation.node_xml}</root>`, "application/xml");
    const replacement = elementChildren(wrapper.documentElement)[0];
    if (!replacement) {
      throw patchCompileError(`replace_node_xml produced invalid XML for target '${target.id}'.`);
    }
    candidate.parentNode.replaceChild(replacement.cloneNode(true), candidate);
    return;
  }

  if ((operation.type === "set_attribute" || operation.type === "set_attr") && operation.name) {
    const candidate = operation.path ? ensureRelativePath(element, operation.path) : resolveOperationElement(element, operation);
    if (!candidate) {
      throw patchCompileError(`stale xml locator for target '${target.id}'.`);
    }
    candidate.setAttribute(operation.name, String(operation.value ?? ""));
    return;
  }

  if ((operation.type === "remove_attribute" || operation.type === "remove_attr") && operation.name) {
    const candidate = resolveOperationElement(element, operation);
    if (!candidate) {
      throw patchCompileError(`stale xml locator for target '${target.id}'.`);
    }
    candidate.removeAttribute(operation.name);
    return;
  }
}

function applyRunStylePatch(run: Element, name: string, value: unknown): void {
  const rPr = ensureChildElement(run, "w:rPr");
  if (name === "font_name") {
    const rFonts = ensureRunPropertyElement(rPr, "w:rFonts");
    const fontName = String(value ?? "").trim();
    rFonts.setAttribute("w:ascii", fontName);
    rFonts.setAttribute("w:hAnsi", fontName);
    rFonts.setAttribute("w:eastAsia", fontName);
    return;
  }
  if (name === "font_size_pt") {
    ensureRunPropertyElement(rPr, "w:sz").setAttribute("w:val", String(Math.round(Number(value) * 2)));
    return;
  }
  if (name === "font_color") {
    ensureRunPropertyElement(rPr, "w:color").setAttribute("w:val", String(value ?? "").replace("#", "").toUpperCase());
    return;
  }
  if (name === "highlight_color") {
    ensureRunPropertyElement(rPr, "w:highlight").setAttribute("w:val", String(value ?? "none"));
    return;
  }
  if (name === "is_underline") {
    if (value === true) {
      ensureRunPropertyElement(rPr, "w:u").setAttribute("w:val", "single");
    } else {
      removeChildByLocalName(rPr, "u");
    }
    return;
  }
  if (name === "is_bold") {
    toggleBooleanRunPropertyPair(rPr, ["w:b", "w:bCs"], value);
    return;
  }
  if (name === "is_italic") {
    toggleBooleanRunProperty(rPr, "w:i", value);
    return;
  }
  if (name === "is_strike") {
    toggleBooleanRunProperty(rPr, "w:strike", value);
    return;
  }
  if (name === "is_all_caps") {
    toggleBooleanRunProperty(rPr, "w:caps", value);
  }
}

function applyParagraphStylePatch(paragraph: Element, name: string, value: unknown): void {
  const pPr = ensureChildElement(paragraph, "w:pPr");
  if (name === "paragraph_alignment") {
    ensureParagraphPropertyElement(pPr, "w:jc").setAttribute("w:val", String(value ?? "left"));
    return;
  }
  if (name === "line_spacing") {
    const spacing = ensureParagraphPropertyElement(pPr, "w:spacing");
    if (typeof value === "number") {
      spacing.setAttribute("w:line", String(Math.round(value * 240)));
      spacing.setAttribute("w:lineRule", "auto");
      return;
    }
    if (value && typeof value === "object" && (value as { mode?: unknown }).mode === "exact") {
      spacing.setAttribute("w:line", String(Math.round(Number((value as { pt?: unknown }).pt ?? 0) * 20)));
      spacing.setAttribute("w:lineRule", "exact");
      return;
    }
  }
  if (name === "space_before_pt") {
    ensureParagraphPropertyElement(pPr, "w:spacing").setAttribute("w:before", String(Math.round(Number(value) * 20)));
    return;
  }
  if (name === "space_after_pt") {
    ensureParagraphPropertyElement(pPr, "w:spacing").setAttribute("w:after", String(Math.round(Number(value) * 20)));
    return;
  }
  if (name === "first_line_indent_pt") {
    const ind = ensureParagraphPropertyElement(pPr, "w:ind");
    removeAttributesByLocalName(ind, ["hanging", "hangingChars", "firstLineChars"]);
    ind.setAttribute("w:firstLine", String(Math.round(Number(value) * 20)));
  }
}

function applyDocumentLevelPatch(documentDom: Document, name: string, value: unknown): void {
  const documentElement = findFirstElementByLocalName(documentDom, "document");
  const body = documentElement ? findChildByLocalName(documentElement, "body") : null;
  if (!body) {
    throw patchCompileError("Cannot resolve document body for page layout materialization.");
  }
  const sectPr = ensureChildElement(body, "w:sectPr");
  if (name === "paper_size") {
    const pgSz = ensureSectionPropertyElement(sectPr, "w:pgSz");
    if (String(value).toUpperCase() === "LETTER") {
      pgSz.setAttribute("w:w", "12240");
      pgSz.setAttribute("w:h", "15840");
    } else {
      pgSz.setAttribute("w:w", "11906");
      pgSz.setAttribute("w:h", "16838");
    }
    return;
  }
  const pgMar = ensureSectionPropertyElement(sectPr, "w:pgMar");
  const twips = String(Math.round(Number(value) * 567));
  if (name === "margin_top_cm") {
    pgMar.setAttribute("w:top", twips);
  } else if (name === "margin_bottom_cm") {
    pgMar.setAttribute("w:bottom", twips);
  } else if (name === "margin_left_cm") {
    pgMar.setAttribute("w:left", twips);
  } else if (name === "margin_right_cm") {
    pgMar.setAttribute("w:right", twips);
  }
}

function locateElementByXmlPath(documentDom: Document, xmlPath: string): Element | null {
  const segments = xmlPath.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }
  let current = findFirstElementByLocalName(documentDom, stripQualifiedName(parsePathSegment(segments[0]).name));
  if (!current) {
    return null;
  }
  for (const rawSegment of segments.slice(1)) {
    const segment = parsePathSegment(rawSegment);
    const parent: Element = current;
    const matches: Element[] = elementChildren(parent).filter((child: Element) => localName(child) === stripQualifiedName(segment.name));
    current = resolveSegmentMatch(matches, segment.selector);
    if (!current) {
      return null;
    }
  }
  return current;
}

function parsePathSegment(segment: string): { name: string; selector?: string } {
  const match = segment.match(/^([^\[]+)(?:\[(.+)\])?$/);
  return {
    name: match?.[1] ?? segment,
    selector: match?.[2]
  };
}

function resolveOperationElement(base: Element, operation: DocxPatchOperation): Element | null {
  if (!operation.path) {
    return base;
  }
  return locateRelativeElement(base, operation.path);
}

function locateRelativeElement(base: Element, relativePath: string): Element | null {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  let current: Element | null = base;
  for (const rawSegment of segments) {
    if (!current) {
      return null;
    }
    const segment = parsePathSegment(rawSegment);
    const matches = elementChildren(current).filter((child) => localName(child) === stripQualifiedName(segment.name));
    if (matches.length === 0) {
      return null;
    }
    current = resolveSegmentMatch(matches, segment.selector);
  }
  return current;
}

function ensureRelativePath(base: Element, relativePath: string): Element {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  let current = base;
  for (const rawSegment of segments) {
    const segment = parsePathSegment(rawSegment);
    const matches = elementChildren(current).filter((child) => localName(child) === stripQualifiedName(segment.name));
    const next = resolveSegmentMatch(matches, segment.selector);
    if (next) {
      current = next;
      continue;
    }
    const created = current.ownerDocument.createElement(segment.name);
    if (segment.selector && !/^\d+$/.test(segment.selector)) {
      created.setAttribute("w:val", segment.selector);
    }
    current.appendChild(created);
    current = created;
  }
  return current;
}

function resolveSegmentMatch(matches: Element[], selector: string | undefined): Element | null {
  if (matches.length === 0) {
    return null;
  }
  if (selector === undefined) {
    return matches[0] ?? null;
  }
  const numericSelector = Number(selector);
  if (Number.isInteger(numericSelector) && String(numericSelector) === selector) {
    return matches[numericSelector] ?? null;
  }
  return (
    matches.find((child) => matchesSelector(child, selector)) ??
    null
  );
}

function matchesSelector(node: Element, selector: string): boolean {
  return ["id", "val", "styleId", "numId", "ilvl", "type"].some((attr) => attrLocal(node, attr) === selector);
}

function stripQualifiedName(name: string): string {
  return name.includes(":") ? name.split(":").at(-1) ?? name : name;
}

function ensureChildElement(parent: Element, qualifiedName: string): Element {
  const wantedLocalName = qualifiedName.includes(":") ? qualifiedName.split(":").at(-1) ?? qualifiedName : qualifiedName;
  const existing = elementChildren(parent).find((child) => localName(child) === wantedLocalName);
  if (existing) {
    return existing;
  }
  const next = parent.ownerDocument.createElement(qualifiedName);
  parent.appendChild(next);
  return next;
}

function ensureParagraphPropertyElement(parent: Element, qualifiedName: string): Element {
  return ensureOrderedChildElement(parent, qualifiedName, PARAGRAPH_PROPERTY_ORDER);
}

function ensureRunPropertyElement(parent: Element, qualifiedName: string): Element {
  return ensureOrderedChildElement(parent, qualifiedName, RUN_PROPERTY_ORDER);
}

function ensureSectionPropertyElement(parent: Element, qualifiedName: string): Element {
  return ensureOrderedChildElement(parent, qualifiedName, SECTION_PROPERTY_ORDER);
}

function ensureOrderedChildElement(parent: Element, qualifiedName: string, schemaOrder: Map<string, number>): Element {
  const wantedLocalName = stripQualifiedName(qualifiedName);
  const existing = elementChildren(parent).find((child) => localName(child) === wantedLocalName);
  const next = existing ?? parent.ownerDocument.createElement(qualifiedName);
  const wantedOrder = schemaOrder.get(wantedLocalName) ?? Number.MAX_SAFE_INTEGER;
  const referenceNode =
    elementChildren(parent)
      .filter((child) => child !== next)
      .find((child) => (schemaOrder.get(localName(child)) ?? Number.MAX_SAFE_INTEGER) > wantedOrder) ?? null;
  if (referenceNode) {
    parent.insertBefore(next, referenceNode);
    return next;
  }
  const lastElement = elementChildren(parent).at(-1) ?? null;
  if (next.parentNode !== parent || lastElement !== next) {
    parent.appendChild(next);
  }
  return next;
}

function toggleBooleanRunProperty(parent: Element, qualifiedName: string, value: unknown): void {
  const local = qualifiedName.includes(":") ? qualifiedName.split(":").at(-1) ?? qualifiedName : qualifiedName;
  if (value === true) {
    ensureRunPropertyElement(parent, qualifiedName);
    return;
  }
  removeChildByLocalName(parent, local);
}

function toggleBooleanRunPropertyPair(parent: Element, qualifiedNames: string[], value: unknown): void {
  if (value === true) {
    for (const qualifiedName of qualifiedNames) {
      ensureRunPropertyElement(parent, qualifiedName);
    }
    return;
  }
  for (const qualifiedName of qualifiedNames) {
    const local = qualifiedName.includes(":") ? qualifiedName.split(":").at(-1) ?? qualifiedName : qualifiedName;
    removeChildByLocalName(parent, local);
  }
}

function removeChildByLocalName(parent: Element, wantedLocalName: string): void {
  for (const child of elementChildren(parent)) {
    if (localName(child) === wantedLocalName) {
      parent.removeChild(child);
    }
  }
}

function removeAttributesByLocalName(element: Element, wantedLocalNames: string[]): void {
  const names = new Set(wantedLocalNames);
  const attributesToRemove: string[] = [];
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (!attribute) {
      continue;
    }
    const name = attribute.localName || attribute.name || "";
    const resolved = name.includes(":") ? name.split(":").at(-1) ?? name : name;
    if (names.has(resolved)) {
      attributesToRemove.push(attribute.name);
    }
  }
  for (const attributeName of attributesToRemove) {
    element.removeAttribute(attributeName);
  }
}

function findClosestAncestor(element: Element, wantedLocalName: string): Element | null {
  let current: Node | null = element;
  while (current) {
    if (current.nodeType === current.ELEMENT_NODE && localName(current as Element) === wantedLocalName) {
      return current as Element;
    }
    current = current.parentNode;
  }
  return null;
}

function findFirstElementByLocalName(root: Document, name: string): Element | null {
  const nodes = Array.from(root.getElementsByTagName("*"));
  return (nodes.find((node) => localName(node) === name) as Element | undefined) ?? null;
}

function findChildByLocalName(parent: Element, wantedLocalName: string): Element | null {
  return elementChildren(parent).find((child) => localName(child) === wantedLocalName) ?? null;
}

function elementChildren(parent: Element): Element[] {
  const items: Element[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const child = parent.childNodes[index];
    if (child.nodeType === child.ELEMENT_NODE) {
      items.push(child as Element);
    }
  }
  return items;
}

function attrLocal(node: Element | null | undefined, wantedLocalName: string): string | undefined {
  if (!node) {
    return undefined;
  }
  const direct = node.getAttribute(wantedLocalName);
  if (direct) {
    return direct;
  }
  for (let index = 0; index < node.attributes.length; index += 1) {
    const attr = node.attributes.item(index);
    if (!attr) {
      continue;
    }
    if (attr.name === wantedLocalName || attr.name.endsWith(`:${wantedLocalName}`)) {
      return attr.value || undefined;
    }
  }
  return undefined;
}

function localName(node: Element): string {
  const name = node.localName || node.nodeName || "";
  return name.includes(":") ? name.split(":").at(-1) ?? name : name;
}

function readPatchSetPayload(payload: Record<string, unknown> | undefined): DocxPatchSet {
  const candidate = payload?.patchSet ?? payload?.patch_set;
  if (!candidate || typeof candidate !== "object" || !Array.isArray((candidate as { operations?: unknown }).operations)) {
    throw invalidOperation("apply_docx_xml_patch requires payload.patchSet.operations.");
  }
  return candidate as DocxPatchSet;
}

function encodeRollbackToken(doc: DocumentIR): string {
  return `rb_doc:${Buffer.from(JSON.stringify(doc), "utf8").toString("base64url")}`;
}

function decodeRollbackToken(token: string): DocumentIR | undefined {
  if (!token.startsWith("rb_doc:")) {
    return undefined;
  }
  try {
    const raw = Buffer.from(token.slice("rb_doc:".length), "base64url").toString("utf8");
    return JSON.parse(raw) as DocumentIR;
  } catch {
    return undefined;
  }
}

function ensureMetadata(doc: DocumentIR): Record<string, unknown> {
  if (doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata)) {
    return doc.metadata as Record<string, unknown>;
  }
  doc.metadata = {};
  return doc.metadata;
}

function readStructureIndex(doc: DocumentIR): {
  paragraphs: Array<{ id?: unknown; runNodeIds?: unknown; partPath?: unknown }>;
} | undefined {
  const structureIndex = doc.metadata?.structureIndex;
  if (!structureIndex || typeof structureIndex !== "object") {
    return undefined;
  }
  const paragraphs = (structureIndex as { paragraphs?: unknown }).paragraphs;
  if (!Array.isArray(paragraphs)) {
    return undefined;
  }
  return { paragraphs: paragraphs as Array<{ id?: unknown; runNodeIds?: unknown; partPath?: unknown }> };
}

function ensureNestedRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function readNestedRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  return {};
}

function ensureWordAttrName(name: string): string {
  return name.startsWith("w:") ? name : `w:${name}`;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function sanitizeTargetSuffix(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]+/g, "_");
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function createSchemaOrder(localNames: string[]): Map<string, number> {
  return new Map(localNames.map((name, index) => [name, index]));
}

function readMetadataString(metadata: DocumentIR["metadata"], key: string): string | undefined {
  const value = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inferOperationName(name: string): Operation["type"] {
  if (name === "font_name") return "set_font";
  if (name === "font_size_pt") return "set_size";
  if (name === "font_color") return "set_font_color";
  if (name === "is_bold") return "set_bold";
  if (name === "is_italic") return "set_italic";
  if (name === "is_underline") return "set_underline";
  if (name === "is_strike") return "set_strike";
  if (name === "highlight_color") return "set_highlight_color";
  if (name === "is_all_caps") return "set_all_caps";
  if (name === "paragraph_alignment") return "set_alignment";
  if (name === "line_spacing") return "set_line_spacing";
  if (name === "space_before_pt" || name === "space_after_pt") return "set_paragraph_spacing";
  if (name === "first_line_indent_pt") return "set_paragraph_indent";
  return "set_font";
}

function invalidOperation(message: string): AgentError {
  return new AgentError({
    code: "E_INVALID_OPERATION",
    message,
    retryable: false
  });
}

function patchCompileError(message: string): AgentError {
  return new AgentError({
    code: "E_PATCH_COMPILE_FAILED",
    message,
    retryable: false
  });
}
