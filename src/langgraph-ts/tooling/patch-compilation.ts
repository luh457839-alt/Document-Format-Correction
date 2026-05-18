import { AgentError } from "../core/errors.js";
import type { ParsedDocumentBundle } from "../contracts/document-contracts.js";
import type { DocxPatchOperation, DocxPatchSet, DocxPatchTarget } from "../document-core/docx-observation-schema.js";
import type { SelectorTargetAnalysis, WriteToolInput } from "./contracts.js";
import { normalizeWriteToolPayload } from "./payload-normalization.js";
import { buildPatchTargetIndex } from "./target-resolution.js";
import { readDocumentPartPath, readPatchTargets, unique } from "./utils.js";

const paragraphStyleFields = new Set([
  "line_spacing",
  "paragraph_alignment",
  "space_before_pt",
  "space_after_pt",
  "first_line_indent_pt"
]);

interface ResolvedPatchTarget {
  id: string;
  target_kind: DocxPatchTarget["target_kind"];
  part_path: string;
  block_id: string;
  node_id?: string;
  xml_tag?: string;
  parent_target_id?: string;
  locator?: DocxPatchTarget["locator"];
}

export interface PatchCompilationResult {
  patchSet: DocxPatchSet;
  patchTargetIds: string[];
  partPaths: string[];
  targetCount: number;
}

export function compileWriteToolPatchSet(
  bundle: ParsedDocumentBundle,
  input: WriteToolInput,
  analysis: SelectorTargetAnalysis
): PatchCompilationResult {
  const normalizedPayload = normalizeSemanticPayload(input, analysis, normalizeWriteToolPayload(input.operation, input.payload));
  if (input.operation === "merge_paragraph" || input.operation === "split_paragraph") {
    throw patchCompileError(`Operation '${input.operation}' cannot be compiled into a stable XML patch set.`);
  }

  const targets = resolvePatchTargets(bundle, input, analysis, normalizedPayload);
  if (targets.length === 0) {
    throw patchCompileError(`Request '${input.request_id}' did not resolve to any patch targets.`);
  }

  const operations = compilePatchOperations(input, targets, normalizedPayload);
  if (operations.length === 0) {
    throw patchCompileError(`Request '${input.request_id}' compiled to an empty patch set.`);
  }

  return {
    patchSet: { targets: dedupeTargets(targets).map(toPatchTarget), operations },
    patchTargetIds: targets.map((target) => target.id),
    partPaths: unique(targets.map((target) => target.part_path)),
    targetCount: targets.length
  };
}

function resolvePatchTargets(
  bundle: ParsedDocumentBundle,
  input: WriteToolInput,
  analysis: SelectorTargetAnalysis,
  normalizedPayload: Record<string, unknown>
): ResolvedPatchTarget[] {
  const targetIndex = buildResolvedPatchTargetIndex(bundle);
  const requestedTargetIds = readRequestedTargetIds(input, analysis);
  if (requestedTargetIds.length === 0 && input.operation !== "set_page_layout") {
    throw patchCompileError(`Request '${input.request_id}' requires a resolved target.`);
  }

  if (input.operation === "set_page_layout") {
    const documentPartPath = readDocumentPartPath(bundle);
    return [
      {
        id: "target:document:section:0",
        target_kind: "block",
        part_path: documentPartPath,
        block_id: "section:0",
        locator: {
          part_path: documentPartPath,
          xml_path: "/document/body/sectPr[0]"
        }
      }
    ];
  }

  const useBlockTargets = Object.keys(normalizedPayload).some((name) => paragraphStyleFields.has(name));
  const results: ResolvedPatchTarget[] = [];
  for (const requestedTargetId of requestedTargetIds) {
    const directTarget = targetIndex.get(requestedTargetId);
    if (directTarget) {
      results.push(useBlockTargets ? coerceBlockTarget(bundle, directTarget, targetIndex) : directTarget);
      continue;
    }

    const inferredInlineTarget = targetIndex.get(`target:inline:${requestedTargetId}`);
    if (inferredInlineTarget) {
      results.push(useBlockTargets ? coerceBlockTarget(bundle, inferredInlineTarget, targetIndex) : inferredInlineTarget);
      continue;
    }

    const synthesizedTarget = synthesizePatchTarget(bundle, requestedTargetId, input, normalizedPayload);
    if (synthesizedTarget) {
      results.push(useBlockTargets ? coerceBlockTarget(bundle, synthesizedTarget, targetIndex) : synthesizedTarget);
      continue;
    }

    throw patchCompileError(`Could not resolve a stable patch target for '${requestedTargetId}'.`);
  }

  return dedupeTargets(results);
}

function compilePatchOperations(
  input: WriteToolInput,
  targets: ResolvedPatchTarget[],
  normalizedPayload: Record<string, unknown>
): DocxPatchOperation[] {
  const operations: DocxPatchOperation[] = [];
  const pushOperation = (value: Omit<DocxPatchOperation, "id">): void => {
    operations.push({
      id: `${input.request_id}:patch:${operations.length}`,
      ...value
    });
  };

  if (input.operation === "set_style_definition") {
    for (const target of targets) {
      for (const [name, value] of Object.entries(readNestedRecord(normalizedPayload, "style_definition"))) {
        pushOperation({ type: "set_attr", target_id: target.id, name: ensureWordAttrName(name), value });
      }
    }
    return operations;
  }

  if (input.operation === "set_numbering_level") {
    for (const target of targets) {
      for (const [name, value] of Object.entries(readNestedRecord(normalizedPayload, "numbering_level"))) {
        pushOperation({ type: "set_attr", target_id: target.id, name: ensureWordAttrName(name), value });
      }
    }
    return operations;
  }

  if (input.operation === "set_settings_flag") {
    for (const target of targets) {
      for (const [name, value] of Object.entries(readNestedRecord(normalizedPayload, "settings"))) {
        pushOperation({ type: "set_attr", target_id: target.id, name: ensureWordAttrName(name), value });
      }
    }
    return operations;
  }

  if (
    input.operation === "set_attr" ||
    input.operation === "remove_attr" ||
    input.operation === "set_text" ||
    input.operation === "remove_node" ||
    input.operation === "ensure_node" ||
    input.operation === "replace_node_xml"
  ) {
    for (const target of targets) {
      pushOperation({
        type: input.operation,
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

function normalizeSemanticPayload(
  input: WriteToolInput,
  analysis: SelectorTargetAnalysis,
  normalizedPayload: Record<string, unknown>
): Record<string, unknown> {
  if (input.target.kind !== "semantic_selector") {
    return normalizedPayload;
  }
  if (!analysis.body_baseline_fields || !analysis.applied_fields?.length) {
    return normalizedPayload;
  }
  const semanticPayload = Object.fromEntries(
    analysis.applied_fields
      .filter((field) => analysis.body_baseline_fields?.[field] !== undefined)
      .map((field) => [field, analysis.body_baseline_fields?.[field]])
  );
  return Object.keys(semanticPayload).length > 0 ? semanticPayload : normalizedPayload;
}

function buildResolvedPatchTargetIndex(bundle: ParsedDocumentBundle): Map<string, ResolvedPatchTarget> {
  const index = new Map<string, ResolvedPatchTarget>();
  for (const target of readPatchTargets(bundle)) {
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

  const documentPartPath = readDocumentPartPath(bundle);
  index.set("target:document:section:0", {
    id: "target:document:section:0",
    target_kind: "block",
    part_path: documentPartPath,
    block_id: "section:0",
    locator: {
      part_path: documentPartPath,
      xml_path: "/document/body/sectPr[0]"
    }
  });

  for (const paragraph of bundle.structure_index.paragraphs) {
    const partPath = paragraph.partPath ?? "word/document.xml";
    const blockTargetId = `target:block:${paragraph.id}`;
    if (!index.has(blockTargetId)) {
      index.set(blockTargetId, {
        id: blockTargetId,
        target_kind: "block",
        part_path: partPath,
        block_id: paragraph.id
      });
    }
    for (const runId of paragraph.runIds) {
      const inlineTargetId = `target:inline:${runId}`;
      if (!index.has(inlineTargetId)) {
        index.set(inlineTargetId, {
          id: inlineTargetId,
          target_kind: "inline",
          part_path: partPath,
          block_id: paragraph.id,
          node_id: runId
        });
      }
    }
  }

  return index;
}

function readRequestedTargetIds(input: WriteToolInput, analysis: SelectorTargetAnalysis): string[] {
  if (input.target.kind === "patch_targets") {
    return unique(input.target.patch_target_ids.map((targetId) => targetId.trim()).filter(Boolean));
  }
  if (analysis.patch_target_ids.length > 0) {
    return unique(analysis.patch_target_ids);
  }
  return unique(analysis.target_node_ids);
}

function coerceBlockTarget(
  bundle: ParsedDocumentBundle,
  target: ResolvedPatchTarget,
  index: Map<string, ResolvedPatchTarget>
): ResolvedPatchTarget {
  if (target.target_kind === "block") {
    return target;
  }
  const blockTargetId = `target:block:${target.block_id}`;
  const existing = index.get(blockTargetId);
  if (existing) {
    return existing;
  }
  const inlineSource = readPatchTargets(bundle).find((candidate) => candidate.id === target.id);
  return {
    id: blockTargetId,
    target_kind: "block",
    part_path: target.part_path,
    block_id: target.block_id,
    locator: inlineSource?.locator
  };
}

function synthesizePatchTarget(
  bundle: ParsedDocumentBundle,
  requestedTargetId: string,
  input: WriteToolInput,
  normalizedPayload: Record<string, unknown>
): ResolvedPatchTarget | undefined {
  const partPath = resolveSyntheticPartPath(bundle, requestedTargetId, input);
  if (!partPath) {
    return undefined;
  }

  if (requestedTargetId.startsWith("target:styles:style:")) {
    const styleId = requestedTargetId.slice("target:styles:style:".length);
    return {
      id: requestedTargetId,
      target_kind: "style",
      part_path: partPath,
      block_id: styleId,
      locator: {
        part_path: partPath,
        xml_path: readSyntheticXmlPath(normalizedPayload, `/styles/style[${styleId}]`) ?? `/styles/style[${styleId}]`
      }
    };
  }

  if (requestedTargetId.startsWith("target:styles:docDefaults")) {
    const suffix = requestedTargetId.slice("target:styles:".length);
    return {
      id: requestedTargetId,
      target_kind: "style_defaults",
      part_path: partPath,
      block_id: suffix,
      locator: {
        part_path: partPath,
        xml_path: readSyntheticXmlPath(normalizedPayload, `/styles/${suffix.replace(/:/g, "/")}`) ?? `/styles/${suffix.replace(/:/g, "/")}`
      }
    };
  }

  if (requestedTargetId.startsWith("target:numbering:")) {
    const match = requestedTargetId.match(/^target:numbering:([^:]+):(\d+)$/);
    if (!match) {
      return undefined;
    }
    const [, numId, ilvl] = match;
    return {
      id: requestedTargetId,
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

  if (requestedTargetId.startsWith("target:settings:")) {
    const suffix = requestedTargetId.slice("target:settings:".length);
    return {
      id: requestedTargetId,
      target_kind: "settings_node",
      part_path: partPath,
      block_id: "settings",
      locator: {
        part_path: partPath,
        xml_path: readSyntheticXmlPath(normalizedPayload, suffix === "settings" ? "/settings" : `/settings/${suffix}`) ??
          (suffix === "settings" ? "/settings" : `/settings/${suffix}`)
      }
    };
  }

  const xmlPath = readSyntheticXmlPath(normalizedPayload);
  if (!xmlPath) {
    return undefined;
  }

  return {
    id: requestedTargetId,
    target_kind: inferSyntheticTargetKind(partPath),
    part_path: partPath,
    block_id: sanitizeTargetSuffix(xmlPath),
    locator: {
      part_path: partPath,
      xml_path: xmlPath
    }
  };
}

function resolveSyntheticPartPath(bundle: ParsedDocumentBundle, requestedTargetId: string, input: WriteToolInput): string | undefined {
  if (input.target.kind === "patch_targets" && input.target.patch_part_paths?.length) {
    return input.target.patch_part_paths[0];
  }
  if (requestedTargetId.startsWith("target:styles:")) {
    return bundle.document_package.parts.find((part) => part.path === "word/styles.xml")?.path ?? "word/styles.xml";
  }
  if (requestedTargetId.startsWith("target:numbering:")) {
    return bundle.document_package.parts.find((part) => part.path === "word/numbering.xml")?.path ?? "word/numbering.xml";
  }
  if (requestedTargetId.startsWith("target:settings:")) {
    return bundle.document_package.parts.find((part) => part.path === "word/settings.xml")?.path ?? "word/settings.xml";
  }
  return readDocumentPartPath(bundle);
}

function readSyntheticXmlPath(normalizedPayload: Record<string, unknown>, fallback?: string): string | undefined {
  return typeof normalizedPayload.path === "string" && normalizedPayload.path.trim() ? normalizedPayload.path.trim() : fallback;
}

function inferSyntheticTargetKind(partPath: string): DocxPatchTarget["target_kind"] {
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

function dedupeTargets(targets: ResolvedPatchTarget[]): ResolvedPatchTarget[] {
  return Array.from(new Map(targets.map((target) => [target.id, target] as const)).values());
}

function ensureWordAttrName(name: string): string {
  return name.startsWith("w:") ? name : `w:${name}`;
}

function readNestedRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

function patchCompileError(message: string): AgentError {
  return new AgentError({
    code: "E_PATCH_COMPILE_FAILED",
    message,
    retryable: false
  });
}
