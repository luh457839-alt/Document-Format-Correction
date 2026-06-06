import type { ParsedDocumentBundle } from "../contracts/document-contracts.js";
import type { DocxPatchOperation, DocxPatchTarget } from "../document-core/docx-observation-schema.js";
import { AgentError } from "../core/errors.js";
import {
  ensureChildElement,
  ensureXmlPart,
  findAncestor,
  findDirectChild,
  findElementByXmlPath,
  localNameOf,
  parseXmlDocument,
  readQualifiedAttribute,
  removeQualifiedAttribute,
  replaceElementWithXml,
  serializeXmlDocument,
  setQualifiedAttribute
} from "./xml-mutation-helpers.js";

export interface BundleMutationResult {
  bundle: ParsedDocumentBundle;
  changed: boolean;
}

export function applyPatchOperationsToBundle(
  bundle: ParsedDocumentBundle,
  patchTargets: DocxPatchTarget[],
  operations: DocxPatchOperation[]
): BundleMutationResult {
  const nextBundle = structuredClone(bundle);
  const targets = new Map(patchTargets.map((target) => [target.id, target] as const));
  let changed = false;

  for (const operation of operations) {
    const target = targets.get(operation.target_id);
    if (!target?.locator) {
      throw new AgentError({
        code: "E_PATCH_TARGET_NOT_FOUND",
        message: `Patch target '${operation.target_id}' is not materializable.`,
        retryable: false
      });
    }
    let part = nextBundle.package_snapshot.parts[target.part_path];
    if (!part && isCreatableXmlTarget(target)) {
      part = {
        path: target.part_path,
        kind: "xml",
        text: ensureXmlPart(target.part_path)
      };
      nextBundle.package_snapshot.parts[target.part_path] = part;
      changed = true;
    }
    if (!part || part.kind !== "xml" || typeof part.text !== "string") {
      throw new AgentError({
        code: "E_UNSUPPORTED_PATCH_TARGET",
        message: `Part '${target.part_path}' is not a writable XML target.`,
        retryable: false
      });
    }

    const before = part.text;
    switch (operation.type) {
      case "set_text": {
        part.text = updateXmlText(part.text, operation.path ?? target.locator.xml_path, String(operation.value ?? ""));
        updateInlineTextTruth(nextBundle, target, String(operation.value ?? ""));
        break;
      }
      case "set_attribute": {
        part.text = applyStructuredAttributeMutation(nextBundle, part.text, target, operation, false);
        break;
      }
      case "set_attr": {
        part.text = applyGenericAttributeMutation(nextBundle, part.text, target, operation, false);
        break;
      }
      case "remove_attr": {
        part.text = applyGenericAttributeMutation(nextBundle, part.text, target, operation, true);
        break;
      }
      case "ensure_node": {
        part.text = ensureXmlNode(part.text, target, operation);
        break;
      }
      case "remove_node": {
        part.text = removeXmlNode(part.text, target, operation);
        break;
      }
      case "replace_node_xml": {
        part.text = replaceXmlNode(part.text, target, operation);
        break;
      }
      default:
        throw new AgentError({
          code: "E_UNSUPPORTED_PATCH_TYPE",
          message: `Patch operation '${operation.type}' is not supported in Phase 3 materialization.`,
          retryable: false
        });
    }

    if (part.text !== before) {
      changed = true;
    }
  }

  syncParagraphNodes(nextBundle);
  return { bundle: nextBundle, changed };
}

function updateXmlText(xml: string, xmlPath: string, nextText: string): string {
  const dom = parseXmlDocument(xml);
  const target = findElementByXmlPath(dom, xmlPath);
  if (!target) {
    throw new AgentError({
      code: "E_PATCH_TARGET_NOT_FOUND",
      message: `Could not resolve XML path '${xmlPath}'.`,
      retryable: false
    });
  }
  if (localNameOf(target) === "p") {
    for (const child of Array.from(target.childNodes)) {
      if (child.nodeType === child.ELEMENT_NODE && localNameOf(child as Element) === "pPr") {
        continue;
      }
      target.removeChild(child);
    }
    const run = ensureChildElement(target, "w:r");
    const textNode = ensureChildElement(run, "w:t");
    textNode.textContent = nextText;
    return serializeXmlDocument(dom);
  }
  target.textContent = nextText;
  return serializeXmlDocument(dom);
}

function applyStructuredAttributeMutation(
  bundle: ParsedDocumentBundle,
  xml: string,
  target: DocxPatchTarget,
  operation: DocxPatchOperation,
  remove: boolean
): string {
  const name = String(operation.name ?? "");
  if (!name) {
    throw new AgentError({
      code: "E_INVALID_OPERATION_PAYLOAD",
      message: "set_attribute requires a property name.",
      retryable: false
    });
  }
  if (isInlineStyleField(name)) {
    const nextXml = updateInlineStyleXml(xml, target, name, operation.value);
    updateInlineStyleTruth(bundle, target, name, remove ? undefined : operation.value);
    return nextXml;
  }
  if (isParagraphStyleField(name)) {
    const nextXml = updateParagraphStyleXml(xml, target, name, operation.value);
    updateParagraphStyleTruth(bundle, target, name, remove ? undefined : operation.value);
    return nextXml;
  }
  if (isSectionLayoutField(name)) {
    return updateSectionLayoutXml(xml, target, name, operation.value);
  }
  throw new AgentError({
    code: "E_UNSUPPORTED_PATCH_TYPE",
    message: `Structured attribute '${name}' is not supported in Phase 4 materialization.`,
    retryable: false
  });
}

function applyGenericAttributeMutation(
  bundle: ParsedDocumentBundle,
  xml: string,
  target: DocxPatchTarget,
  operation: DocxPatchOperation,
  remove: boolean
): string {
  const name = String(operation.name ?? "");
  if (!name) {
    throw new AgentError({
      code: "E_INVALID_OPERATION_PAYLOAD",
      message: `${remove ? "remove_attr" : "set_attr"} requires name.`,
      retryable: false
    });
  }
  if (target.target_kind === "style") {
    const nextXml = updateStyleDefinitionXml(xml, target, name, operation.value, remove);
    updateStyleProjectionTruth(bundle, target, name, operation.value, remove);
    return nextXml;
  }
  if (target.target_kind === "numbering_level") {
    const nextXml = updateNumberingXml(xml, target, name, operation.value, remove);
    updateNumberingTruth(bundle, target, name, operation.value, remove);
    return nextXml;
  }
  if (target.target_kind === "settings_node") {
    return updateSettingsXml(xml, target, name, operation.value, remove);
  }

  const dom = parseXmlDocument(xml);
  const element = resolveOperationElement(dom, target, operation.path);
  if (remove) {
    removeQualifiedAttribute(element, name);
  } else {
    setQualifiedAttribute(element, name, String(operation.value ?? ""));
  }
  return serializeXmlDocument(dom);
}

function ensureXmlNode(xml: string, target: DocxPatchTarget, operation: DocxPatchOperation): string {
  const dom = parseXmlDocument(xml);
  const parent = resolveOperationElement(dom, target, operation.path);
  const siblings = Array.from(parent.childNodes).filter(
    (node): node is Element => node.nodeType === node.ELEMENT_NODE && node.nodeName === operation.xml_tag
  );
  const attrs = operation.attrs ?? {};
  const existing = siblings.find((candidate) =>
    Object.entries(attrs).every(([name, value]) => readQualifiedAttribute(candidate, name) === value)
  );
  const node = existing ?? ensureChildElement(parent, String(operation.xml_tag ?? ""));
  for (const [name, value] of Object.entries(attrs)) {
    setQualifiedAttribute(node, name, value);
  }
  return serializeXmlDocument(dom);
}

function removeXmlNode(xml: string, target: DocxPatchTarget, operation: DocxPatchOperation): string {
  const dom = parseXmlDocument(xml);
  const element = resolveOperationElement(dom, target, operation.path);
  if (!element.parentNode) {
    throw new AgentError({
      code: "E_PATCH_TARGET_NOT_FOUND",
      message: `Could not remove XML path '${operation.path ?? target.locator?.xml_path ?? ""}'.`,
      retryable: false
    });
  }
  element.parentNode.removeChild(element);
  return serializeXmlDocument(dom);
}

function replaceXmlNode(xml: string, target: DocxPatchTarget, operation: DocxPatchOperation): string {
  const dom = parseXmlDocument(xml);
  const element = resolveOperationElement(dom, target, operation.path);
  replaceElementWithXml(element, String(operation.node_xml ?? ""));
  return serializeXmlDocument(dom);
}

function updateInlineTextTruth(bundle: ParsedDocumentBundle, target: DocxPatchTarget, nextText: string): void {
  if (!target.node_id) {
    return;
  }
  const inline = bundle.document_ast.inlineNodes.find((node) => node.id === target.node_id && node.nodeType === "text");
  if (inline) {
    inline.text = nextText;
  }
  const paragraph = bundle.structure_index.paragraphs.find((entry) => entry.runIds.includes(target.node_id ?? ""));
  if (paragraph) {
    const texts = paragraph.runIds.map((runId) => {
      const run = bundle.document_ast.inlineNodes.find((node) => node.id === runId && node.nodeType === "text");
      return run?.text ?? "";
    });
    paragraph.text = texts.join("").trim();
    bundle.structure_index.paragraphMap[paragraph.id] = { ...paragraph };
  }
}

function syncParagraphNodes(bundle: ParsedDocumentBundle): void {
  const paragraphTextById = new Map(bundle.structure_index.paragraphs.map((paragraph) => [paragraph.id, paragraph.text] as const));
  const visitParagraph = (paragraph: Extract<ParsedDocumentBundle["document_ast"]["nodes"][number], { nodeType: "paragraph" }>): void => {
    const matching = paragraphTextById.get(paragraph.id);
    if (matching === undefined) {
      return;
    }
    for (const child of paragraph.children) {
      if (child.nodeType === "text_run" && child.id) {
        const inline = bundle.document_ast.inlineNodes.find((node) => node.id === child.id && node.nodeType === "text");
        child.content = inline?.text ?? child.content;
        child.style = inline?.style ? structuredClone(inline.style) : child.style;
      }
    }
  };
  const walk = (node: ParsedDocumentBundle["document_ast"]["nodes"][number]): void => {
    if (node.nodeType === "paragraph") {
      visitParagraph(node);
      return;
    }
    for (const row of node.rows) {
      for (const cell of row.cells) {
        cell.paragraphs.forEach(walk);
        cell.tables.forEach(walk);
      }
    }
  };
  bundle.document_ast.nodes.forEach(walk);
}

function resolveOperationElement(document: Document, target: DocxPatchTarget, overridePath?: string): Element {
  const xmlPath = overridePath ?? target.locator?.xml_path;
  const element = xmlPath ? findElementByXmlPath(document, xmlPath) : null;
  if (!element) {
    throw new AgentError({
      code: "E_PATCH_TARGET_NOT_FOUND",
      message: `Could not resolve XML path '${xmlPath ?? ""}'.`,
      retryable: false
    });
  }
  return element;
}

function updateInlineStyleXml(xml: string, target: DocxPatchTarget, name: string, value: unknown): string {
  const dom = parseXmlDocument(xml);
  const targetElement = resolveOperationElement(dom, target);
  const run = findAncestor(targetElement, "r");
  if (!run) {
    throw unsupportedTarget(target.part_path, name);
  }
  const runProps = findDirectChild(run, "rPr") ?? ensureChildElement(run, "w:rPr", { prepend: true });
  switch (name) {
    case "font_name": {
      const rFonts = findDirectChild(runProps, "rFonts") ?? ensureChildElement(runProps, "w:rFonts");
      setQualifiedAttribute(rFonts, "w:ascii", String(value ?? ""));
      setQualifiedAttribute(rFonts, "w:hAnsi", String(value ?? ""));
      setQualifiedAttribute(rFonts, "w:cs", String(value ?? ""));
      setQualifiedAttribute(rFonts, "w:eastAsia", String(value ?? ""));
      break;
    }
    case "font_size_pt": {
      const sizeValue = String(Math.round(Number(value ?? 0) * 2));
      const size = findDirectChild(runProps, "sz") ?? ensureChildElement(runProps, "w:sz");
      const sizeCs = findDirectChild(runProps, "szCs") ?? ensureChildElement(runProps, "w:szCs");
      setQualifiedAttribute(size, "w:val", sizeValue);
      setQualifiedAttribute(sizeCs, "w:val", sizeValue);
      break;
    }
    case "font_color": {
      const color = findDirectChild(runProps, "color") ?? ensureChildElement(runProps, "w:color");
      setQualifiedAttribute(color, "w:val", String(value ?? ""));
      break;
    }
    case "highlight_color": {
      const highlight = findDirectChild(runProps, "highlight") ?? ensureChildElement(runProps, "w:highlight");
      setQualifiedAttribute(highlight, "w:val", String(value ?? "none"));
      break;
    }
    case "is_bold":
      updateBooleanProperty(runProps, "b", value);
      break;
    case "is_italic":
      updateBooleanProperty(runProps, "i", value);
      break;
    case "is_underline": {
      const underline = findDirectChild(runProps, "u") ?? ensureChildElement(runProps, "w:u");
      setQualifiedAttribute(underline, "w:val", value ? "single" : "none");
      break;
    }
    case "is_strike":
      updateBooleanProperty(runProps, "strike", value);
      break;
    case "is_all_caps":
      updateBooleanProperty(runProps, "caps", value);
      break;
    default:
      throw unsupportedTarget(target.part_path, name);
  }
  return serializeXmlDocument(dom);
}

function updateParagraphStyleXml(xml: string, target: DocxPatchTarget, name: string, value: unknown): string {
  const dom = parseXmlDocument(xml);
  const paragraph = findAncestor(resolveOperationElement(dom, target), "p");
  if (!paragraph) {
    throw unsupportedTarget(target.part_path, name);
  }
  const paragraphProps = findDirectChild(paragraph, "pPr") ?? ensureChildElement(paragraph, "w:pPr", { prepend: true });
  const spacing = () => findDirectChild(paragraphProps, "spacing") ?? ensureChildElement(paragraphProps, "w:spacing");
  switch (name) {
    case "paragraph_alignment": {
      const jc = findDirectChild(paragraphProps, "jc") ?? ensureChildElement(paragraphProps, "w:jc");
      setQualifiedAttribute(jc, "w:val", String(value ?? ""));
      break;
    }
    case "line_spacing": {
      const node = spacing();
      if (typeof value === "object" && value && !Array.isArray(value) && (value as { mode?: unknown }).mode === "exact") {
        setQualifiedAttribute(node, "w:line", String(Math.round(Number((value as { pt?: unknown }).pt ?? 0) * 20)));
        setQualifiedAttribute(node, "w:lineRule", "exact");
      } else {
        setQualifiedAttribute(node, "w:line", String(Math.round(Number(value ?? 0) * 240)));
        removeQualifiedAttribute(node, "w:lineRule");
      }
      break;
    }
    case "space_before_pt": {
      setQualifiedAttribute(spacing(), "w:before", String(Math.round(Number(value ?? 0) * 20)));
      break;
    }
    case "space_after_pt": {
      setQualifiedAttribute(spacing(), "w:after", String(Math.round(Number(value ?? 0) * 20)));
      break;
    }
    case "first_line_indent_pt": {
      const indent = findDirectChild(paragraphProps, "ind") ?? ensureChildElement(paragraphProps, "w:ind");
      setQualifiedAttribute(indent, "w:firstLine", String(Math.round(Number(value ?? 0) * 20)));
      break;
    }
    default:
      throw unsupportedTarget(target.part_path, name);
  }
  return serializeXmlDocument(dom);
}

function updateSectionLayoutXml(xml: string, target: DocxPatchTarget, name: string, value: unknown): string {
  const dom = parseXmlDocument(xml);
  const section = resolveOperationElement(dom, target);
  switch (name) {
    case "paper_size": {
      const pgSz = findDirectChild(section, "pgSz") ?? ensureChildElement(section, "w:pgSz");
      const preset = String(value ?? "").toLowerCase() === "letter" ? { width: 12240, height: 15840 } : { width: 11906, height: 16838 };
      setQualifiedAttribute(pgSz, "w:w", String(preset.width));
      setQualifiedAttribute(pgSz, "w:h", String(preset.height));
      break;
    }
    case "margin_top_cm":
    case "margin_bottom_cm":
    case "margin_left_cm":
    case "margin_right_cm": {
      const pgMar = findDirectChild(section, "pgMar") ?? ensureChildElement(section, "w:pgMar");
      const fieldMap: Record<string, string> = {
        margin_top_cm: "w:top",
        margin_bottom_cm: "w:bottom",
        margin_left_cm: "w:left",
        margin_right_cm: "w:right"
      };
      setQualifiedAttribute(pgMar, fieldMap[name], String(Math.round(Number(value ?? 0) * 567)));
      break;
    }
    default:
      throw unsupportedTarget(target.part_path, name);
  }
  return serializeXmlDocument(dom);
}

function updateStyleDefinitionXml(
  xml: string,
  target: DocxPatchTarget,
  name: string,
  value: unknown,
  remove: boolean
): string {
  const dom = parseXmlDocument(xml);
  const style = resolveOperationElement(dom, target);
  const localName = name.replace(/^w:/, "");
  const runProps = findDirectChild(style, "rPr") ?? ensureChildElement(style, "w:rPr");
  switch (localName) {
    case "color": {
      const color = findDirectChild(runProps, "color") ?? ensureChildElement(runProps, "w:color");
      if (remove) {
        if (color.parentNode) {
          color.parentNode.removeChild(color);
        }
      } else {
        setQualifiedAttribute(color, "w:val", String(value ?? ""));
      }
      break;
    }
    default:
      if (remove) {
        removeQualifiedAttribute(style, name);
      } else {
        setQualifiedAttribute(style, name, String(value ?? ""));
      }
      break;
  }
  return serializeXmlDocument(dom);
}

function updateNumberingXml(xml: string, target: DocxPatchTarget, name: string, value: unknown, remove: boolean): string {
  const dom = parseXmlDocument(xml);
  const level = resolveOperationElement(dom, target);
  const localName = name.replace(/^w:/, "");
  const child = findDirectChild(level, localName) ?? (!remove ? ensureChildElement(level, `w:${localName}`) : null);
  if (!child) {
    return serializeXmlDocument(dom);
  }
  if (remove) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
  } else {
    setQualifiedAttribute(child, "w:val", String(value ?? ""));
  }
  return serializeXmlDocument(dom);
}

function updateSettingsXml(xml: string, target: DocxPatchTarget, name: string, value: unknown, remove: boolean): string {
  const dom = parseXmlDocument(xml);
  const settings = resolveOperationElement(dom, target);
  const localName = name.replace(/^w:/, "");
  const child = findDirectChild(settings, localName) ?? (!remove ? ensureChildElement(settings, `w:${localName}`) : null);
  if (!child) {
    return serializeXmlDocument(dom);
  }
  if (remove) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
  } else {
    setQualifiedAttribute(child, "w:val", String(value ?? ""));
  }
  return serializeXmlDocument(dom);
}

function updateInlineStyleTruth(bundle: ParsedDocumentBundle, target: DocxPatchTarget, name: string, value: unknown): void {
  if (!target.node_id) {
    return;
  }
  const inline = bundle.document_ast.inlineNodes.find((node) => node.id === target.node_id && node.nodeType === "text");
  if (!inline) {
    return;
  }
  inline.style = { ...(inline.style ?? {}) };
  assignStyleValue(inline.style, name, value);

  const patchTarget = (bundle.document_ast.patchTargets as DocxPatchTarget[]).find((entry) => entry.id === target.id);
  if (patchTarget) {
    patchTarget.style_snapshot = { ...(patchTarget.style_snapshot ?? {}) };
    assignLegacyStyleValue(patchTarget.style_snapshot, name, value);
  }
}

function updateParagraphStyleTruth(bundle: ParsedDocumentBundle, target: DocxPatchTarget, name: string, value: unknown): void {
  const paragraph = bundle.structure_index.paragraphMap[target.block_id];
  if (!paragraph) {
    return;
  }
  for (const runId of paragraph.runIds) {
    const inlineTarget: DocxPatchTarget = {
      id: `target:inline:${runId}`,
      target_kind: "inline",
      part_path: target.part_path,
      block_id: target.block_id,
      node_id: runId
    };
    updateInlineStyleTruth(bundle, inlineTarget, name, value);
  }
}

function updateStyleProjectionTruth(
  bundle: ParsedDocumentBundle,
  target: DocxPatchTarget,
  name: string,
  value: unknown,
  remove: boolean
): void {
  const styleIdMatch = target.id.match(/^target:styles:style:(.+)$/);
  const styleKey = styleIdMatch?.[1];
  const localName = name.replace(/^w:/, "");
  if (styleKey) {
    const projection =
      bundle.document_ast.styles.paragraphStyles[styleKey] ??
      bundle.document_ast.styles.characterStyles[styleKey] ??
      bundle.document_ast.styles.tableStyles[styleKey];
    if (!projection) {
      return;
    }
    if (localName === "color") {
      projection.resolvedRun.fontColor = remove ? undefined : String(value ?? "");
    }
  }
}

function updateNumberingTruth(
  bundle: ParsedDocumentBundle,
  target: DocxPatchTarget,
  name: string,
  value: unknown,
  remove: boolean
): void {
  const match = target.id.match(/^target:numbering:([^:]+):(\d+)$/);
  if (!match) {
    return;
  }
  const [, abstractNumId, ilvlToken] = match;
  const ilvl = Number.parseInt(ilvlToken, 10);
  const localName = name.replace(/^w:/, "");
  for (const instance of bundle.document_ast.numbering.instances) {
    if (instance.abstractNumId !== abstractNumId && instance.numId !== abstractNumId) {
      continue;
    }
    const level = instance.levels.find((entry) => entry.ilvl === ilvl);
    if (!level) {
      continue;
    }
    if (localName === "lvlText") {
      level.lvlText = remove ? undefined : String(value ?? "");
    }
    if (localName === "numFmt") {
      level.numFmt = remove ? undefined : String(value ?? "");
    }
    if (localName === "start") {
      level.start = remove ? undefined : Number(value ?? 0);
    }
  }
}

function updateBooleanProperty(parent: Element, localName: string, value: unknown): void {
  const node = findDirectChild(parent, localName) ?? ensureChildElement(parent, `w:${localName}`);
  setQualifiedAttribute(node, "w:val", normalizeBooleanValue(value) ? "1" : "0");
}

function assignStyleValue(style: NonNullable<ParsedDocumentBundle["document_ast"]["inlineNodes"][number]["style"]>, name: string, value: unknown): void {
  switch (name) {
    case "font_name":
      style.fontName = String(value ?? "");
      break;
    case "font_size_pt":
      style.fontSizePt = Number(value ?? 0);
      break;
    case "font_color":
      style.fontColor = String(value ?? "");
      break;
    case "highlight_color":
      style.highlightColor = String(value ?? "");
      break;
    case "is_bold":
      style.isBold = normalizeBooleanValue(value);
      break;
    case "is_italic":
      style.isItalic = normalizeBooleanValue(value);
      break;
    case "is_underline":
      style.isUnderline = normalizeBooleanValue(value);
      break;
    case "is_strike":
      style.isStrike = normalizeBooleanValue(value);
      break;
    case "is_all_caps":
      style.isAllCaps = normalizeBooleanValue(value);
      break;
    case "paragraph_alignment":
      style.paragraphAlignment = String(value ?? "");
      break;
    case "line_spacing":
      style.lineSpacing = value as NonNullable<typeof style.lineSpacing>;
      break;
    default:
      break;
  }
}

function assignLegacyStyleValue(style: NonNullable<DocxPatchTarget["style_snapshot"]>, name: string, value: unknown): void {
  switch (name) {
    case "font_name":
      style.font_name = String(value ?? "");
      break;
    case "font_size_pt":
      style.font_size_pt = Number(value ?? 0);
      break;
    case "font_color":
      style.font_color = String(value ?? "");
      break;
    case "highlight_color":
      style.highlight_color = String(value ?? "");
      break;
    case "is_bold":
      style.is_bold = normalizeBooleanValue(value);
      break;
    case "is_italic":
      style.is_italic = normalizeBooleanValue(value);
      break;
    case "is_underline":
      style.is_underline = normalizeBooleanValue(value);
      break;
    case "is_strike":
      style.is_strike = normalizeBooleanValue(value);
      break;
    case "is_all_caps":
      style.is_all_caps = normalizeBooleanValue(value);
      break;
    case "paragraph_alignment":
      style.paragraph_alignment = String(value ?? "");
      break;
    case "line_spacing":
      style.line_spacing = value as NonNullable<typeof style.line_spacing>;
      break;
    default:
      break;
  }
}

function normalizeBooleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function isCreatableXmlTarget(target: DocxPatchTarget): boolean {
  return target.part_path === "word/settings.xml";
}

function isInlineStyleField(name: string): boolean {
  return new Set([
    "font_name",
    "font_size_pt",
    "font_color",
    "is_bold",
    "is_italic",
    "is_underline",
    "is_strike",
    "highlight_color",
    "is_all_caps"
  ]).has(name);
}

function isParagraphStyleField(name: string): boolean {
  return new Set([
    "paragraph_alignment",
    "line_spacing",
    "space_before_pt",
    "space_after_pt",
    "first_line_indent_pt"
  ]).has(name);
}

function isSectionLayoutField(name: string): boolean {
  return new Set(["paper_size", "margin_top_cm", "margin_bottom_cm", "margin_left_cm", "margin_right_cm"]).has(name);
}

function unsupportedTarget(partPath: string, operation: string): AgentError {
  return new AgentError({
    code: "E_UNSUPPORTED_PATCH_TARGET",
    message: `Part '${partPath}' does not support operation '${operation}'.`,
    retryable: false
  });
}
