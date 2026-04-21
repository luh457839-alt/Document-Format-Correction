import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { AgentError } from "../core/errors.js";
import { getAgentMediaDir } from "../core/project-paths.js";
import type { DocumentIR, Tool, ToolExecutionInput, ToolExecutionOutput } from "../core/types.js";

export interface ParseDocxOptions {
  docxPath: string;
  mediaDir?: string;
  pythonCommand?: string;
  scriptPath?: string;
  allowFallback?: boolean;
}

export interface TextRunStyle {
  font_name: string;
  font_size_pt: number;
  font_color: string;
  is_bold: boolean;
  is_italic: boolean;
  is_underline: boolean;
  is_strike: boolean;
  highlight_color: string;
  is_all_caps: boolean;
  paragraph_alignment: string;
}

interface TextRunNode {
  id: string;
  node_type: "text_run";
  content: string;
  style: TextRunStyle;
}

interface ImageNode {
  id: string;
  node_type: "image";
  src: string;
  size: {
    width: number;
    height: number;
  };
}

interface FormulaNode {
  id: string;
  node_type: "formula";
  format: "latex";
  content: string;
}

interface ParagraphNode {
  id: string;
  node_type: "paragraph";
  children: Array<TextRunNode | ImageNode | FormulaNode>;
}

interface TableNode {
  id: string;
  node_type: "table";
  rows: Array<{
    row_index: number;
    cells: Array<{
      cell_index: number;
      paragraphs: Array<{
        node_type: "paragraph";
        children: Array<TextRunNode | ImageNode | FormulaNode>;
      }>;
      tables: TableNode[];
    }>;
  }>;
}

export interface DocumentState {
  document_meta: {
    total_paragraphs: number;
    total_tables: number;
    warning?: string;
  };
  nodes: Array<ParagraphNode | TableNode>;
}

interface Counters {
  paragraph: number;
  table: number;
  image: number;
  formula: number;
}

interface StyleProperties {
  font_name?: string;
  font_size_pt?: number;
  font_color?: string;
  is_bold?: boolean;
  is_italic?: boolean;
  is_underline?: boolean;
  is_strike?: boolean;
  highlight_color?: string;
  is_all_caps?: boolean;
}

interface StyleDefinition {
  run: StyleProperties;
  paragraph_alignment?: string;
}

interface StyleContext {
  docDefaults: StyleProperties;
  paragraphStyles: Map<string, StyleDefinition>;
  characterStyles: Map<string, StyleDefinition>;
  normalParagraphStyle?: StyleDefinition;
}

interface ParseContext {
  zip: JSZip;
  relationships: Map<string, string>;
  styles: StyleContext;
  mediaDirAbs: string;
  counters: Counters;
}

const DEFAULT_MEDIA_DIR = getAgentMediaDir();
const BUILTIN_STYLE_DEFAULTS: Required<TextRunStyle> = {
  font_name: "Times New Roman",
  font_size_pt: 12,
  font_color: "000000",
  is_bold: false,
  is_italic: false,
  is_underline: false,
  is_strike: false,
  highlight_color: "none",
  is_all_caps: false,
  paragraph_alignment: "left"
};

export async function parseDocxToState(options: ParseDocxOptions): Promise<DocumentState> {
  const allowFallback = options.allowFallback ?? false;

  try {
    const buf = await readFile(options.docxPath);
    return await parseDocxBuffer(buf, options);
  } catch (err) {
    if (allowFallback) {
      return {
        document_meta: {
          total_paragraphs: 0,
          total_tables: 0,
          warning: `fallback: parse failed (${String(err)})`
        },
        nodes: []
      };
    }
    throw new AgentError({
      code: "E_DOCX_PARSE_FAILED",
      message: `Failed to parse docx with native TypeScript parser: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }
}

export class DocxObservationTool implements Tool {
  name = "docx_observation";
  readOnly = true;

  async validate(input: ToolExecutionInput): Promise<void> {
    const docxPath = input.operation?.payload?.docxPath;
    if (typeof docxPath !== "string" || !docxPath.trim()) {
      throw new AgentError({
        code: "E_INVALID_DOCX_PATH",
        message: "docx_observation requires operation.payload.docxPath",
        retryable: false
      });
    }
  }

  async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    const payload = (input.operation?.payload ?? {}) as Record<string, unknown>;
    const state = await parseDocxToState({
      docxPath: String(payload.docxPath ?? ""),
      mediaDir: typeof payload.mediaDir === "string" ? payload.mediaDir : undefined,
      pythonCommand: typeof payload.pythonCommand === "string" ? payload.pythonCommand : undefined,
      scriptPath: typeof payload.scriptPath === "string" ? payload.scriptPath : undefined,
      allowFallback: payload.allowFallback !== false
    });

    const nextDoc: DocumentIR = structuredClone(input.doc);
    nextDoc.metadata = {
      ...(nextDoc.metadata ?? {}),
      docxObservation: state
    };
    return {
      doc: nextDoc,
      summary: `Observed docx: nodes=${state.nodes.length}`
    };
  }
}

async function parseDocxBuffer(buffer: Buffer, options: ParseDocxOptions): Promise<DocumentState> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await readXmlFile(zip, "word/document.xml");
  if (!documentXml) {
    throw new Error("word/document.xml not found");
  }

  const relsXml = await readXmlFile(zip, "word/_rels/document.xml.rels");
  const stylesXml = await readXmlFile(zip, "word/styles.xml");
  const dom = new DOMParser().parseFromString(documentXml, "application/xml");
  const body = findFirstElementByLocalName(dom, "body");
  if (!body) {
    throw new Error("document body not found");
  }

  const mediaDirAbs = path.resolve(options.mediaDir ?? DEFAULT_MEDIA_DIR);
  await mkdir(mediaDirAbs, { recursive: true });

  const context: ParseContext = {
    zip,
    relationships: parseRelationshipsXml(relsXml),
    styles: parseStylesXml(stylesXml),
    mediaDirAbs,
    counters: {
      paragraph: 0,
      table: 0,
      image: 0,
      formula: 0
    }
  };

  const nodes: Array<ParagraphNode | TableNode> = [];
  for (const child of elementChildren(body)) {
    const name = localName(child);
    if (name === "p") {
      nodes.push(await parseParagraphNode(child, context));
      continue;
    }
    if (name === "tbl") {
      nodes.push(await parseTableNode(child, context));
    }
  }

  return {
    document_meta: {
      total_paragraphs: context.counters.paragraph,
      total_tables: context.counters.table
    },
    nodes
  };
}

async function parseParagraphNode(paragraph: Element, context: ParseContext): Promise<ParagraphNode> {
  const paragraphIndex = context.counters.paragraph++;
  const paragraphId = `p_${paragraphIndex}`;
  const children: Array<TextRunNode | ImageNode | FormulaNode> = [];
  const paragraphProps = findChildByLocalName(paragraph, "pPr");
  const paragraphStyleId = readParagraphStyleId(paragraphProps);
  const paragraphAlignment = readParagraphAlignment(paragraphProps);

  let runOrdinal = 0;
  for (const run of elementChildren(paragraph).filter((node) => localName(node) === "r")) {
    const textId = `${paragraphId}_r_${runOrdinal}`;
    runOrdinal += 1;

    const text = collectTexts(run).join("");
    if (text) {
      children.push({
        id: textId,
        node_type: "text_run",
        content: text,
        style: resolveRunStyle(run, paragraphStyleId, paragraphAlignment, context.styles)
      });
    }

    for (const drawing of findDescendants(run, (el) => localName(el) === "drawing")) {
      children.push(await extractDrawingImageNode(drawing, context));
    }

    for (const pict of findDescendants(run, (el) => localName(el) === "pict")) {
      const nodes = await extractVmlImageNodes(pict, context);
      children.push(...nodes);
    }

    for (const formula of findDescendants(run, (el) => {
      const name = localName(el);
      return name === "oMath" || name === "oMathPara";
    })) {
      children.push(extractFormulaNode(formula, context));
    }
  }

  return { id: paragraphId, node_type: "paragraph", children };
}

async function parseTableNode(table: Element, context: ParseContext): Promise<TableNode> {
  const tableIndex = context.counters.table++;
  const rows: TableNode["rows"] = [];

  let rowIndex = 0;
  for (const tr of elementChildren(table).filter((node) => localName(node) === "tr")) {
    const cells: TableNode["rows"][number]["cells"] = [];
    let cellIndex = 0;

    for (const tc of elementChildren(tr).filter((node) => localName(node) === "tc")) {
      const paragraphs: TableNode["rows"][number]["cells"][number]["paragraphs"] = [];
      const tables: TableNode[] = [];

      for (const block of elementChildren(tc)) {
        const name = localName(block);
        if (name === "p") {
          const parsed = await parseParagraphNode(block, context);
          paragraphs.push({ node_type: "paragraph", children: parsed.children });
          continue;
        }
        if (name === "tbl") {
          tables.push(await parseTableNode(block, context));
        }
      }

      cells.push({ cell_index: cellIndex, paragraphs, tables });
      cellIndex += 1;
    }

    rows.push({ row_index: rowIndex, cells });
    rowIndex += 1;
  }

  return {
    id: `tbl_${tableIndex}`,
    node_type: "table",
    rows
  };
}

function resolveRunStyle(
  run: Element,
  paragraphStyleId: string | undefined,
  paragraphAlignment: string | undefined,
  styles: StyleContext
): TextRunStyle {
  const runProps = findChildByLocalName(run, "rPr");
  const runStyleId = readRunStyleId(runProps);

  const direct = parseRunProperties(runProps);
  const runStyle = runStyleId ? styles.characterStyles.get(runStyleId)?.run : undefined;
  const paragraphStyle = paragraphStyleId ? styles.paragraphStyles.get(paragraphStyleId) : undefined;
  const normal = styles.normalParagraphStyle;
  const defaults = styles.docDefaults;

  return {
    font_name: firstDefined(
      direct.font_name,
      runStyle?.font_name,
      paragraphStyle?.run.font_name,
      normal?.run.font_name,
      defaults.font_name,
      BUILTIN_STYLE_DEFAULTS.font_name
    ),
    font_size_pt: firstDefined(
      direct.font_size_pt,
      runStyle?.font_size_pt,
      paragraphStyle?.run.font_size_pt,
      normal?.run.font_size_pt,
      defaults.font_size_pt,
      BUILTIN_STYLE_DEFAULTS.font_size_pt
    ),
    font_color: firstDefined(
      direct.font_color,
      runStyle?.font_color,
      paragraphStyle?.run.font_color,
      normal?.run.font_color,
      defaults.font_color,
      BUILTIN_STYLE_DEFAULTS.font_color
    ),
    is_bold: firstDefined(
      direct.is_bold,
      runStyle?.is_bold,
      paragraphStyle?.run.is_bold,
      normal?.run.is_bold,
      defaults.is_bold,
      BUILTIN_STYLE_DEFAULTS.is_bold
    ),
    is_italic: firstDefined(
      direct.is_italic,
      runStyle?.is_italic,
      paragraphStyle?.run.is_italic,
      normal?.run.is_italic,
      defaults.is_italic,
      BUILTIN_STYLE_DEFAULTS.is_italic
    ),
    is_underline: firstDefined(
      direct.is_underline,
      runStyle?.is_underline,
      paragraphStyle?.run.is_underline,
      normal?.run.is_underline,
      defaults.is_underline,
      BUILTIN_STYLE_DEFAULTS.is_underline
    ),
    is_strike: firstDefined(
      direct.is_strike,
      runStyle?.is_strike,
      paragraphStyle?.run.is_strike,
      normal?.run.is_strike,
      defaults.is_strike,
      BUILTIN_STYLE_DEFAULTS.is_strike
    ),
    highlight_color: firstDefined(
      direct.highlight_color,
      runStyle?.highlight_color,
      paragraphStyle?.run.highlight_color,
      normal?.run.highlight_color,
      defaults.highlight_color,
      BUILTIN_STYLE_DEFAULTS.highlight_color
    ),
    is_all_caps: firstDefined(
      direct.is_all_caps,
      runStyle?.is_all_caps,
      paragraphStyle?.run.is_all_caps,
      normal?.run.is_all_caps,
      defaults.is_all_caps,
      BUILTIN_STYLE_DEFAULTS.is_all_caps
    ),
    paragraph_alignment: firstDefined(
      paragraphAlignment,
      paragraphStyle?.paragraph_alignment,
      normal?.paragraph_alignment,
      BUILTIN_STYLE_DEFAULTS.paragraph_alignment
    )
  };
}

function parseRunProperties(runProps: Element | null): StyleProperties {
  if (!runProps) {
    return {};
  }
  const fonts = findChildByLocalName(runProps, "rFonts");
  const sz = findChildByLocalName(runProps, "sz");
  const color = findChildByLocalName(runProps, "color");
  const highlight = findChildByLocalName(runProps, "highlight");
  const bold = findChildByLocalName(runProps, "b");
  const italic = findChildByLocalName(runProps, "i");
  const underline = findChildByLocalName(runProps, "u");
  const strike = findChildByLocalName(runProps, "strike");
  const caps = findChildByLocalName(runProps, "caps");

  const fontSizeVal = toNumber(attrLocal(sz, "val"));
  const colorVal = normalizeColor(attrLocal(color, "val"));
  const highlightVal = attrLocal(highlight, "val");
  const underlineVal = attrLocal(underline, "val");

  return {
    font_name:
      attrLocal(fonts, "eastAsia") ??
      attrLocal(fonts, "ascii") ??
      attrLocal(fonts, "hAnsi") ??
      attrLocal(fonts, "cs"),
    font_size_pt: typeof fontSizeVal === "number" ? fontSizeVal / 2 : undefined,
    font_color: colorVal === "AUTO" ? undefined : colorVal,
    is_bold: readBooleanFromToggleNode(bold),
    is_italic: readBooleanFromToggleNode(italic),
    is_underline: underline ? underlineVal !== "none" && underlineVal !== "false" : undefined,
    is_strike: readBooleanFromToggleNode(strike),
    highlight_color: highlightVal || undefined,
    is_all_caps: readBooleanFromToggleNode(caps)
  };
}

function parseStylesXml(stylesXml: string | null): StyleContext {
  const docDefaults: StyleProperties = {};
  const paragraphStyles = new Map<string, StyleDefinition>();
  const characterStyles = new Map<string, StyleDefinition>();
  let normalParagraphStyle: StyleDefinition | undefined;

  if (!stylesXml) {
    return { docDefaults, paragraphStyles, characterStyles, normalParagraphStyle };
  }

  const dom = new DOMParser().parseFromString(stylesXml, "application/xml");
  const root = findFirstElementByLocalName(dom, "styles");
  if (!root) {
    return { docDefaults, paragraphStyles, characterStyles, normalParagraphStyle };
  }

  const docDefaultsNode = findChildByLocalName(root, "docDefaults");
  const rPrDefault = findChildByLocalName(findChildByLocalName(docDefaultsNode, "rPrDefault"), "rPr");
  Object.assign(docDefaults, parseRunProperties(rPrDefault));

  for (const styleNode of elementChildren(root).filter((el) => localName(el) === "style")) {
    const styleId = attrLocal(styleNode, "styleId");
    const styleType = attrLocal(styleNode, "type");
    if (!styleId || !styleType) {
      continue;
    }

    const run = parseRunProperties(findChildByLocalName(styleNode, "rPr"));
    const paragraph_alignment = readParagraphAlignment(findChildByLocalName(styleNode, "pPr"));
    const def: StyleDefinition = { run, paragraph_alignment };

    if (styleType === "paragraph") {
      paragraphStyles.set(styleId, def);
      const isDefault = attrLocal(styleNode, "default") === "1";
      if (isDefault || styleId === "Normal") {
        normalParagraphStyle = def;
      }
    } else if (styleType === "character") {
      characterStyles.set(styleId, def);
    }
  }

  return {
    docDefaults,
    paragraphStyles,
    characterStyles,
    normalParagraphStyle
  };
}

function parseRelationshipsXml(relsXml: string | null): Map<string, string> {
  const relationships = new Map<string, string>();
  if (!relsXml) {
    return relationships;
  }
  const dom = new DOMParser().parseFromString(relsXml, "application/xml");
  const relNodes = Array.from(dom.getElementsByTagName("Relationship"));
  for (const rel of relNodes) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) {
      relationships.set(id, target);
    }
  }
  return relationships;
}

async function extractDrawingImageNode(drawing: Element, context: ParseContext): Promise<ImageNode> {
  const imageId = `img_${context.counters.image++}`;
  const blip = findDescendants(drawing, (el) => localName(el) === "blip")[0];
  const rid = attrLocal(blip, "embed") ?? attrLocal(blip, "link");
  const size = extractDrawingSize(drawing);
  if (!rid) {
    return { id: imageId, node_type: "image", src: "extraction_failed", size };
  }
  return exportImageByRelationshipId(rid, imageId, size, context);
}

async function extractVmlImageNodes(pict: Element, context: ParseContext): Promise<ImageNode[]> {
  const nodes: ImageNode[] = [];
  for (const imageData of findDescendants(pict, (el) => localName(el) === "imagedata")) {
    const imageId = `img_${context.counters.image++}`;
    const rid = attrLocal(imageData, "id");
    const size = extractVmlSize(imageData.parentNode as Element | null);
    if (!rid) {
      nodes.push({ id: imageId, node_type: "image", src: "extraction_failed", size });
      continue;
    }
    nodes.push(await exportImageByRelationshipId(rid, imageId, size, context));
  }
  return nodes;
}

async function exportImageByRelationshipId(
  rid: string,
  imageId: string,
  size: { width: number; height: number },
  context: ParseContext
): Promise<ImageNode> {
  try {
    const target = context.relationships.get(rid);
    if (!target) {
      return { id: imageId, node_type: "image", src: "extraction_failed", size };
    }
    const zipPath = relationshipTargetToZipPath(target);
    const file = context.zip.file(zipPath);
    if (!file) {
      return { id: imageId, node_type: "image", src: "extraction_failed", size };
    }
    const ext = path.extname(zipPath) || ".bin";
    const outputPath = path.resolve(context.mediaDirAbs, `${imageId}${ext}`);
    const blob = await file.async("nodebuffer");
    await writeFile(outputPath, blob);
    return { id: imageId, node_type: "image", src: outputPath, size };
  } catch {
    return { id: imageId, node_type: "image", src: "extraction_failed", size };
  }
}

function relationshipTargetToZipPath(target: string): string {
  const raw = target.replace(/\\/g, "/").replace(/^\/+/, "");
  const joined = path.posix.normalize(path.posix.join("word", raw));
  return joined.startsWith("word/") ? joined : `word/${path.posix.basename(joined)}`;
}

function extractDrawingSize(drawing: Element): { width: number; height: number } {
  const extent = findDescendants(drawing, (el) => localName(el) === "extent")[0];
  const cx = toNumber(attrLocal(extent, "cx")) ?? 0;
  const cy = toNumber(attrLocal(extent, "cy")) ?? 0;
  return {
    width: round2(cx / 9525),
    height: round2(cy / 9525)
  };
}

function extractVmlSize(shapeElement: Element | null): { width: number; height: number } {
  const style = shapeElement?.getAttribute("style") ?? "";
  return {
    width: parseVmlDimension(style, "width"),
    height: parseVmlDimension(style, "height")
  };
}

function parseVmlDimension(styleAttr: string, prop: "width" | "height"): number {
  const match = styleAttr.match(new RegExp(`${prop}\\s*:\\s*([0-9.]+)(pt|px)?`, "i"));
  if (!match) {
    return 0;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return 0;
  }
  const unit = (match[2] ?? "px").toLowerCase();
  return unit === "pt" ? round2(value * (96 / 72)) : round2(value);
}

function extractFormulaNode(mathElement: Element, context: ParseContext): FormulaNode {
  const formulaId = `math_${context.counters.formula++}`;
  let latex = "\\text{unparsed_formula}";
  try {
    const converted = ommlToLatex(mathElement).trim();
    latex = converted || "\\text{unparsed_formula}";
  } catch {
    latex = "\\text{omml_conversion_failed}";
  }
  return {
    id: formulaId,
    node_type: "formula",
    format: "latex",
    content: latex
  };
}

function ommlToLatex(node: Element): string {
  const name = localName(node);
  if (name === "oMathPara") {
    return elementChildren(node)
      .filter((child) => localName(child) === "oMath")
      .map((child) => ommlToLatex(child))
      .join("");
  }
  if (name === "oMath") {
    return elementChildren(node).map((child) => ommlToLatex(child)).join("");
  }
  if (name === "r") {
    return elementChildren(node).map((child) => ommlToLatex(child)).join("");
  }
  if (name === "t") {
    return node.textContent ?? "";
  }
  if (name === "f") {
    return `\\frac{${renderMathPart(node, "num")}}{${renderMathPart(node, "den")}}`;
  }
  if (name === "num" || name === "den" || name === "e" || name === "sup" || name === "sub" || name === "deg") {
    return elementChildren(node).map((child) => ommlToLatex(child)).join("");
  }
  if (name === "sSup") {
    return `${renderMathPart(node, "e")}^{${renderMathPart(node, "sup")}}`;
  }
  if (name === "sSub") {
    return `${renderMathPart(node, "e")}_{${renderMathPart(node, "sub")}}`;
  }
  if (name === "sSubSup") {
    return `${renderMathPart(node, "e")}_{${renderMathPart(node, "sub")}}^{${renderMathPart(node, "sup")}}`;
  }
  if (name === "rad") {
    const degree = renderMathPart(node, "deg");
    const expr = renderMathPart(node, "e");
    return degree ? `\\sqrt[${degree}]{${expr}}` : `\\sqrt{${expr}}`;
  }
  if (name === "d") {
    return `\\left(${renderMathPart(node, "e")}\\right)`;
  }
  if (name === "nary") {
    const sub = renderMathPart(node, "sub");
    const sup = renderMathPart(node, "sup");
    const expr = renderMathPart(node, "e");
    const subLatex = sub ? `_{${sub}}` : "";
    const supLatex = sup ? `^{${sup}}` : "";
    return `\\sum${subLatex}${supLatex}${expr}`;
  }
  return elementChildren(node).map((child) => ommlToLatex(child)).join("");
}

function renderMathPart(root: Element, partName: string): string {
  const part = elementChildren(root).find((child) => localName(child) === partName);
  return part ? ommlToLatex(part) : "";
}

async function readXmlFile(zip: JSZip, filePath: string): Promise<string | null> {
  const file = zip.file(filePath);
  if (!file) {
    return null;
  }
  return file.async("string");
}

function readParagraphStyleId(paragraphProps: Element | null): string | undefined {
  const pStyle = findChildByLocalName(paragraphProps, "pStyle");
  return attrLocal(pStyle, "val");
}

function readRunStyleId(runProps: Element | null): string | undefined {
  const rStyle = findChildByLocalName(runProps, "rStyle");
  return attrLocal(rStyle, "val");
}

function readParagraphAlignment(paragraphProps: Element | null): string | undefined {
  const jc = findChildByLocalName(paragraphProps, "jc");
  return attrLocal(jc, "val");
}

function readBooleanFromToggleNode(node: Element | null): boolean | undefined {
  if (!node) {
    return undefined;
  }
  const val = (attrLocal(node, "val") ?? "").toLowerCase();
  if (!val || val === "true" || val === "1" || val === "on") {
    return true;
  }
  if (val === "false" || val === "0" || val === "off" || val === "none") {
    return false;
  }
  return true;
}

function normalizeColor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.toUpperCase().replace("#", "");
}

function collectTexts(node: Element): string[] {
  return findDescendants(node, (el) => localName(el) === "t")
    .map((el) => el.textContent ?? "")
    .filter((text) => text.length > 0);
}

function findFirstElementByLocalName(root: Document, name: string): Element | null {
  for (const node of Array.from(root.getElementsByTagName("*"))) {
    if (localName(node) === name) {
      return node;
    }
  }
  return null;
}

function findChildByLocalName(node: Element | null | undefined, name: string): Element | null {
  if (!node) {
    return null;
  }
  for (const child of elementChildren(node)) {
    if (localName(child) === name) {
      return child;
    }
  }
  return null;
}

function elementChildren(node: Element): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < node.childNodes.length; i += 1) {
    const child = node.childNodes[i];
    if (child.nodeType === child.ELEMENT_NODE) {
      out.push(child as Element);
    }
  }
  return out;
}

function findDescendants(node: Element, match: (el: Element) => boolean): Element[] {
  const out: Element[] = [];
  const stack = [...elementChildren(node)];
  while (stack.length > 0) {
    const current = stack.pop() as Element;
    if (match(current)) {
      out.push(current);
    }
    stack.push(...elementChildren(current));
  }
  return out;
}

function localName(node: Element): string {
  if (node.localName) {
    return node.localName;
  }
  const raw = node.nodeName ?? "";
  const idx = raw.indexOf(":");
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

function attrLocal(node: Element | null | undefined, local: string): string | undefined {
  if (!node) {
    return undefined;
  }
  const direct = node.getAttribute(local);
  if (direct !== null && direct !== "") {
    return direct;
  }
  for (let i = 0; i < node.attributes.length; i += 1) {
    const attr = node.attributes.item(i);
    if (!attr) {
      continue;
    }
    const name = attr.name ?? "";
    const idx = name.indexOf(":");
    const attrLocalName = idx >= 0 ? name.slice(idx + 1) : name;
    if (attrLocalName === local) {
      return attr.value === "" ? undefined : attr.value;
    }
  }
  return undefined;
}

function firstDefined<T>(...values: Array<T | undefined>): T {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  throw new Error("No defined value found");
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
