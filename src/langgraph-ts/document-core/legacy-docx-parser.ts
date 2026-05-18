import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { AgentError } from "../core/errors.js";
import { getAgentMediaDir } from "../core/project-paths.js";
import type { DocumentIR, LineSpacingValue, Tool, ToolExecutionInput, ToolExecutionOutput } from "../core/types.js";
import type {
  DocxBlockRecord,
  DocxInlineNodeRecord,
  DocxNumberingInstanceProjection,
  DocxNumberingLevelProjection,
  DocxNumberingProjection,
  DocxObservationState as DocumentState,
  DocxPackageMeta,
  DocxPackageModel,
  DocxPartModel,
  DocxPatchTarget,
  DocxRelationshipEdge,
  DocxRelationshipGraph,
  DocxResolvedStyleDefinition,
  DocxStructureIndex,
  DocxStylesProjection,
  ObservationFormulaNode as FormulaNode,
  ObservationImageNode as ImageNode,
  ObservationParagraphNode as ParagraphNode,
  ObservationParagraphRecord,
  ObservationTableNode as TableNode,
  ObservationTextRunNode as TextRunNode,
  TextRunStyle
} from "./docx-observation-schema.js";

export interface ParseDocxOptions {
  docxPath: string;
  mediaDir?: string;
  pythonCommand?: string;
  scriptPath?: string;
  allowFallback?: boolean;
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

interface RawStyleDefinition {
  style_id: string;
  style_name?: string;
  based_on?: string;
  kind: "paragraph" | "character" | "table";
  run: StyleProperties;
  paragraph_alignment?: string;
}

interface StyleContext {
  docDefaults: StyleProperties;
  paragraphStyles: Map<string, DocxResolvedStyleDefinition>;
  characterStyles: Map<string, DocxResolvedStyleDefinition>;
  tableStyles: Map<string, DocxResolvedStyleDefinition>;
  normalParagraphStyle?: DocxResolvedStyleDefinition;
}

interface RelationshipRecord {
  id: string;
  type: string;
  target: string;
  targetMode?: string;
  resolvedTarget: string;
}

interface NumberingContext {
  instances: DocxNumberingProjection["instances"];
}

interface ParseCounters {
  paragraph: number;
  table: number;
  image: number;
  formula: number;
  block: number;
  section: number;
  mainDocumentParagraphs: number;
  mainDocumentTables: number;
}

interface ParseContext {
  zip: JSZip;
  mediaDirAbs: string;
  styles: StyleContext;
  numbering: NumberingContext;
  relationshipGraph: DocxRelationshipGraph;
  relationshipsBySource: Map<string, Map<string, RelationshipRecord>>;
  contentTypes: Map<string, string>;
  counters: ParseCounters;
  blocks: DocxBlockRecord[];
  inlineNodes: DocxInlineNodeRecord[];
  paragraphs: ObservationParagraphRecord[];
  patchTargets: DocxPatchTarget[];
  warnings: string[];
}

const DEFAULT_MEDIA_DIR = getAgentMediaDir();
const BUILTIN_STYLE_DEFAULTS: Required<
  Pick<
    TextRunStyle,
    | "font_name"
    | "font_size_pt"
    | "font_color"
    | "is_bold"
    | "is_italic"
    | "is_underline"
    | "is_strike"
    | "highlight_color"
    | "is_all_caps"
    | "paragraph_alignment"
  >
> = {
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

export type { DocumentState, ParagraphNode, TableNode, TextRunStyle };

export async function parseDocxToState(options: ParseDocxOptions): Promise<DocumentState> {
  const allowFallback = options.allowFallback ?? false;

  try {
    const buf = await readFile(options.docxPath);
    return await parseDocxBuffer(buf, options);
  } catch (err) {
    if (allowFallback) {
      const fallbackMeta: DocxPackageMeta = {
        part_count: 0,
        xml_part_count: 0,
        media_count: 0,
        relationship_count: 0,
        section_count: 0,
        header_count: 0,
        footer_count: 0,
        footnote_count: 0,
        endnote_count: 0,
        custom_xml_count: 0,
        warnings: [`fallback: parse failed (${String(err)})`]
      };
      const packageModel: DocxPackageModel = {
        package_meta: fallbackMeta,
        parts: [],
        relationship_graph: { edges: [], by_source: {} }
      };
      return {
        package_model: packageModel,
        package_meta: fallbackMeta,
        document_meta: {
          total_paragraphs: 0,
          total_tables: 0,
          warning: fallbackMeta.warnings[0],
          warnings: [...fallbackMeta.warnings]
        },
        blocks: [],
        inline_nodes: [],
        styles: {
          defaults: { ...BUILTIN_STYLE_DEFAULTS },
          paragraph_styles: {},
          character_styles: {},
          table_styles: {}
        },
        numbering: {
          instances: []
        },
        structure_index: {
          paragraphs: [],
          role_counts: {}
        },
        patch_targets: [],
        paragraphs: [],
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
      docxObservation: state,
      docxPackageModel: state.package_model
    };
    return {
      doc: nextDoc,
      summary: `Observed docx package: parts=${state.package_meta.part_count}, inline_nodes=${state.inline_nodes.length}`
    };
  }
}

async function parseDocxBuffer(buffer: Buffer, options: ParseDocxOptions): Promise<DocumentState> {
  const zip = await JSZip.loadAsync(buffer);
  const contentTypes = await parseContentTypes(zip);
  const relationshipState = await parseRelationshipState(zip);
  const styles = parseStylesXml(await readXmlFile(zip, "word/styles.xml"));
  const numbering = parseNumberingXml(await readXmlFile(zip, "word/numbering.xml"));
  const mediaDirAbs = path.resolve(options.mediaDir ?? DEFAULT_MEDIA_DIR);
  await mkdir(mediaDirAbs, { recursive: true });

  const context: ParseContext = {
    zip,
    mediaDirAbs,
    styles,
    numbering,
    relationshipGraph: relationshipState.graph,
    relationshipsBySource: relationshipState.bySource,
    contentTypes,
    counters: {
      paragraph: 0,
      table: 0,
      image: 0,
      formula: 0,
      block: 0,
      section: 0,
      mainDocumentParagraphs: 0,
      mainDocumentTables: 0
    },
    blocks: [],
    inlineNodes: [],
    paragraphs: [],
    patchTargets: [],
    warnings: []
  };

  const partPaths = Object.keys(zip.files)
    .filter((filePath) => !zip.files[filePath]?.dir)
    .filter((filePath) => !filePath.endsWith(".rels"))
    .sort(comparePartPaths);
  const parts = await buildPartModels(zip, partPaths, contentTypes, relationshipState.graph);

  const legacyNodes: Array<ParagraphNode | TableNode> = [];
  for (const part of parts.filter((candidate) => isStructuredContentPart(candidate.kind))) {
    const xml = await readXmlFile(zip, part.path);
    if (!xml) {
      continue;
    }
    await parseStructuredPart(part, xml, context, legacyNodes);
  }

  const packageMeta = buildPackageMeta(parts, relationshipState.graph, context, {
    coreXml: await readXmlFile(zip, "docProps/core.xml"),
    documentXml: await readXmlFile(zip, "word/document.xml")
  });
  const packageModel: DocxPackageModel = {
    package_meta: packageMeta,
    parts,
    relationship_graph: relationshipState.graph
  };
  const roleCounts = buildRoleCounts(context.paragraphs);
  const structureIndex: DocxStructureIndex = {
    paragraphs: context.paragraphs,
    role_counts: roleCounts
  };

  return {
    package_model: packageModel,
    package_meta: packageMeta,
    document_meta: {
      total_paragraphs: context.counters.mainDocumentParagraphs,
      total_tables: context.counters.mainDocumentTables,
      total_images: context.counters.image,
      total_formulas: context.counters.formula,
      total_footnotes: packageMeta.footnote_count,
      total_endnotes: packageMeta.endnote_count,
      total_headers: packageMeta.header_count,
      total_footers: packageMeta.footer_count,
      ...(context.warnings.length > 0
        ? {
            warning: context.warnings[0],
            warnings: [...context.warnings]
          }
        : {})
    },
    blocks: context.blocks,
    inline_nodes: context.inlineNodes,
    styles: projectStyles(context.styles),
    numbering: {
      instances: context.numbering.instances
    },
    structure_index: structureIndex,
    patch_targets: context.patchTargets,
    paragraphs: context.paragraphs,
    nodes: legacyNodes
  };
}

async function buildPartModels(
  zip: JSZip,
  partPaths: string[],
  contentTypes: Map<string, string>,
  relationshipGraph: DocxRelationshipGraph
): Promise<DocxPartModel[]> {
  const relationshipCounts = new Map(
    Object.entries(relationshipGraph.by_source).map(([source, edges]) => [source, edges.length])
  );
  const parts: DocxPartModel[] = [];
  for (const partPath of partPaths) {
    const file = zip.file(partPath);
    if (!file) {
      continue;
    }
    const isXml = /\.xml$/i.test(partPath);
    let xmlRoot: string | undefined;
    if (isXml) {
      try {
        const xml = await file.async("string");
        const dom = new DOMParser().parseFromString(xml, "application/xml");
        xmlRoot = findFirstElementByLocalName(dom)?.localName ?? undefined;
      } catch {
        xmlRoot = undefined;
      }
    }
    parts.push({
      path: partPath,
      kind: determinePartKind(partPath, contentTypes.get(partPath)),
      content_type: contentTypes.get(partPath),
      xml_root: xmlRoot,
      relationship_count: relationshipCounts.get(partPath) ?? 0
    });
  }
  return parts;
}

async function parseStructuredPart(
  part: DocxPartModel,
  xml: string,
  context: ParseContext,
  legacyNodes: Array<ParagraphNode | TableNode>
): Promise<void> {
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  const root = findFirstElementByLocalName(dom);
  if (!root) {
    return;
  }

  const legacyCollector = part.kind === "main_document" ? legacyNodes : undefined;
  if (part.kind === "main_document") {
    const body = findChildByLocalName(root, "body");
    if (!body) {
      return;
    }
    await parseBlockChildren(elementChildren(body), part, context, {
      inTable: false,
      legacyCollector,
      xmlPathBase: "/document/body"
    });
    return;
  }

  if (part.kind === "header" || part.kind === "footer") {
    await parseBlockChildren(elementChildren(root), part, context, {
      inTable: false,
      xmlPathBase: `/${root.localName}`
    });
    return;
  }

  if (part.kind === "footnotes" || part.kind === "endnotes") {
    for (const noteNode of elementChildren(root)) {
      const noteName = localName(noteNode);
      if (noteName !== "footnote" && noteName !== "endnote") {
        continue;
      }
      const noteId = attrLocal(noteNode, "id") ?? String(context.counters.section++);
      await parseBlockChildren(elementChildren(noteNode), part, context, {
        inTable: false,
        xmlPathBase: `/${root.localName}/${noteName}[${noteId}]`
      });
    }
  }
}

async function parseBlockChildren(
  children: Element[],
  part: DocxPartModel,
  context: ParseContext,
  options: {
    inTable: boolean;
    legacyCollector?: Array<ParagraphNode | TableNode>;
    xmlPathBase: string;
  }
): Promise<void> {
  let paragraphOrdinal = 0;
  let tableOrdinal = 0;
  let sectionOrdinal = 0;
  for (const child of children) {
    const name = localName(child);
    if (name === "p") {
      const paragraph = await parseParagraphNode(
        child,
        part,
        context,
        options.inTable,
        `${options.xmlPathBase}/p[${paragraphOrdinal}]`
      );
      paragraphOrdinal += 1;
      options.legacyCollector?.push(paragraph);
      continue;
    }
    if (name === "tbl") {
      const table = await parseTableNode(
        child,
        part,
        context,
        `${options.xmlPathBase}/tbl[${tableOrdinal}]`
      );
      tableOrdinal += 1;
      options.legacyCollector?.push(table);
      continue;
    }
    if (name === "sectPr") {
      context.blocks.push({
        id: `blk_${context.counters.block++}`,
        block_id: `sect_${context.counters.section++}`,
        part_path: part.path,
        node_type: "section_break",
        anchor: {
          part_path: part.path,
          xml_path: `${options.xmlPathBase}/sectPr[${sectionOrdinal}]`
        }
      });
      sectionOrdinal += 1;
    }
  }
}

async function parseParagraphNode(
  paragraph: Element,
  part: DocxPartModel,
  context: ParseContext,
  inTable: boolean,
  xmlPath: string
): Promise<ParagraphNode> {
  const paragraphIndex = context.counters.paragraph++;
  const paragraphId = `p_${paragraphIndex}`;
  if (part.kind === "main_document") {
    context.counters.mainDocumentParagraphs += 1;
  }

  const paragraphProps = findChildByLocalName(paragraph, "pPr");
  const paragraphStyleId = readParagraphStyleId(paragraphProps);
  const paragraphAlignment = readParagraphAlignment(paragraphProps);
  const paragraphLineSpacing = readParagraphLineSpacing(paragraphProps);
  const numbering = readParagraphNumbering(paragraphProps);
  const styleDef = paragraphStyleId ? context.styles.paragraphStyles.get(paragraphStyleId) : undefined;
  const styleName = styleDef?.style_name ?? paragraphStyleId;
  const headingLevel = readHeadingLevel(paragraphStyleId, styleName);
  const role = deriveParagraphRole(part.kind, {
    inTable,
    headingLevel,
    numId: numbering.numId
  });

  const children: Array<TextRunNode | ImageNode | FormulaNode> = [];
  const blockId = paragraphId;
  context.blocks.push({
    id: `blk_${context.counters.block++}`,
    block_id: blockId,
    part_path: part.path,
    node_type: "paragraph",
    paragraph_id: paragraphId,
    role,
    anchor: {
      part_path: part.path,
      xml_path: xmlPath
    }
  });
  context.patchTargets.push({
    id: `target:block:${paragraphId}`,
    target_kind: "block",
    part_path: part.path,
    block_id: blockId,
    locator: {
      part_path: part.path,
      xml_path: xmlPath
    }
  });

  let runOrdinal = 0;
  for (const run of elementChildren(paragraph).filter((node) => localName(node) === "r")) {
    const runId = `${paragraphId}_r_${runOrdinal}`;
    const runPath = `${xmlPath}/r[${runOrdinal}]`;
    runOrdinal += 1;

    const text = collectTexts(run).join("");
    if (text) {
      const style = resolveRunStyle(run, paragraphStyleId, paragraphAlignment, paragraphLineSpacing, context.styles);
      children.push({
        id: runId,
        node_type: "text_run",
        content: text,
        style
      });
      context.inlineNodes.push({
        id: runId,
        block_id: blockId,
        part_path: part.path,
        node_type: "text",
        text,
        style,
        anchor: {
          part_path: part.path,
          xml_path: `${runPath}/t`
        }
      });
      context.patchTargets.push({
        id: `target:inline:${runId}`,
        target_kind: "inline",
        part_path: part.path,
        block_id: blockId,
        node_id: runId,
        locator: {
          part_path: part.path,
          xml_path: `${runPath}/t`
        },
        text,
        style_snapshot: style
      });
    }

    for (const drawing of findDescendants(run, (el) => localName(el) === "drawing")) {
      const imageNode = await extractDrawingImageNode(drawing, part.path, blockId, context, `${runPath}/drawing`);
      children.push(imageNode);
    }

    for (const pict of findDescendants(run, (el) => localName(el) === "pict")) {
      const nodes = await extractVmlImageNodes(pict, part.path, blockId, context, `${runPath}/pict`);
      children.push(...nodes);
    }

    for (const formula of findDescendants(run, (el) => {
      const name = localName(el);
      return name === "oMath" || name === "oMathPara";
    })) {
      const formulaNode = extractFormulaNode(formula, part.path, blockId, context, `${runPath}/math`);
      children.push(formulaNode);
    }
  }

  const text = children
    .filter((child): child is TextRunNode => child.node_type === "text_run")
    .map((child) => child.content ?? "")
    .join("")
    .trim();
  const runIds = children
    .filter((child): child is TextRunNode => child.node_type === "text_run" && typeof child.id === "string")
    .map((child) => child.id as string);

  context.paragraphs.push({
    id: paragraphId,
    text,
    role,
    heading_level: headingLevel,
    list_level: numbering.ilvl,
    style_name: styleName,
    run_ids: runIds,
    in_table: inTable,
    part_path: part.path
  });

  return {
    id: paragraphId,
    node_type: "paragraph",
    children
  };
}

async function parseTableNode(
  table: Element,
  part: DocxPartModel,
  context: ParseContext,
  xmlPath: string
): Promise<TableNode> {
  const tableIndex = context.counters.table++;
  const tableId = `tbl_${tableIndex}`;
  if (part.kind === "main_document") {
    context.counters.mainDocumentTables += 1;
  }
  context.blocks.push({
    id: `blk_${context.counters.block++}`,
    block_id: tableId,
    part_path: part.path,
    node_type: "table",
    table_id: tableId,
    anchor: {
      part_path: part.path,
      xml_path: xmlPath
    }
  });
  context.patchTargets.push({
    id: `target:block:${tableId}`,
    target_kind: "block",
    part_path: part.path,
    block_id: tableId,
    locator: {
      part_path: part.path,
      xml_path: xmlPath
    }
  });

  const rows: TableNode["rows"] = [];
  let rowIndex = 0;
  for (const tr of elementChildren(table).filter((node) => localName(node) === "tr")) {
    const cells: TableNode["rows"][number]["cells"] = [];
    let cellIndex = 0;
    for (const tc of elementChildren(tr).filter((node) => localName(node) === "tc")) {
      const paragraphs: TableNode["rows"][number]["cells"][number]["paragraphs"] = [];
      const tables: TableNode[] = [];
      let paragraphOrdinal = 0;
      let nestedTableOrdinal = 0;
      for (const block of elementChildren(tc)) {
        const name = localName(block);
        if (name === "p") {
          const parsed = await parseParagraphNode(
            block,
            part,
            context,
            true,
            `${xmlPath}/tr[${rowIndex}]/tc[${cellIndex}]/p[${paragraphOrdinal}]`
          );
          paragraphs.push({ node_type: "paragraph", children: parsed.children, id: parsed.id });
          paragraphOrdinal += 1;
          continue;
        }
        if (name === "tbl") {
          tables.push(
            await parseTableNode(
              block,
              part,
              context,
              `${xmlPath}/tr[${rowIndex}]/tc[${cellIndex}]/tbl[${nestedTableOrdinal}]`
            )
          );
          nestedTableOrdinal += 1;
        }
      }
      cells.push({ cell_index: cellIndex, paragraphs, tables });
      cellIndex += 1;
    }
    rows.push({ row_index: rowIndex, cells });
    rowIndex += 1;
  }

  return {
    id: tableId,
    node_type: "table",
    rows
  };
}

function resolveRunStyle(
  run: Element,
  paragraphStyleId: string | undefined,
  paragraphAlignment: string | undefined,
  paragraphLineSpacing: LineSpacingValue | undefined,
  styles: StyleContext
): TextRunStyle {
  const runProps = findChildByLocalName(run, "rPr");
  const runStyleId = readRunStyleId(runProps);

  const direct = parseRunProperties(runProps);
  const runStyle = runStyleId ? styles.characterStyles.get(runStyleId)?.resolved_run : undefined;
  const paragraphStyle = paragraphStyleId ? styles.paragraphStyles.get(paragraphStyleId) : undefined;
  const normal = styles.normalParagraphStyle;
  const defaults = styles.docDefaults;

  return {
    font_name: firstDefined(
      direct.font_name,
      runStyle?.font_name,
      paragraphStyle?.resolved_run.font_name,
      normal?.resolved_run.font_name,
      defaults.font_name,
      BUILTIN_STYLE_DEFAULTS.font_name
    ),
    font_size_pt: firstDefined(
      direct.font_size_pt,
      runStyle?.font_size_pt,
      paragraphStyle?.resolved_run.font_size_pt,
      normal?.resolved_run.font_size_pt,
      defaults.font_size_pt,
      BUILTIN_STYLE_DEFAULTS.font_size_pt
    ),
    font_color: firstDefined(
      direct.font_color,
      runStyle?.font_color,
      paragraphStyle?.resolved_run.font_color,
      normal?.resolved_run.font_color,
      defaults.font_color,
      BUILTIN_STYLE_DEFAULTS.font_color
    ),
    is_bold: firstDefined(
      direct.is_bold,
      runStyle?.is_bold,
      paragraphStyle?.resolved_run.is_bold,
      normal?.resolved_run.is_bold,
      defaults.is_bold,
      BUILTIN_STYLE_DEFAULTS.is_bold
    ),
    is_italic: firstDefined(
      direct.is_italic,
      runStyle?.is_italic,
      paragraphStyle?.resolved_run.is_italic,
      normal?.resolved_run.is_italic,
      defaults.is_italic,
      BUILTIN_STYLE_DEFAULTS.is_italic
    ),
    is_underline: firstDefined(
      direct.is_underline,
      runStyle?.is_underline,
      paragraphStyle?.resolved_run.is_underline,
      normal?.resolved_run.is_underline,
      defaults.is_underline,
      BUILTIN_STYLE_DEFAULTS.is_underline
    ),
    is_strike: firstDefined(
      direct.is_strike,
      runStyle?.is_strike,
      paragraphStyle?.resolved_run.is_strike,
      normal?.resolved_run.is_strike,
      defaults.is_strike,
      BUILTIN_STYLE_DEFAULTS.is_strike
    ),
    highlight_color: firstDefined(
      direct.highlight_color,
      runStyle?.highlight_color,
      paragraphStyle?.resolved_run.highlight_color,
      normal?.resolved_run.highlight_color,
      defaults.highlight_color,
      BUILTIN_STYLE_DEFAULTS.highlight_color
    ),
    is_all_caps: firstDefined(
      direct.is_all_caps,
      runStyle?.is_all_caps,
      paragraphStyle?.resolved_run.is_all_caps,
      normal?.resolved_run.is_all_caps,
      defaults.is_all_caps,
      BUILTIN_STYLE_DEFAULTS.is_all_caps
    ),
    ...(paragraphLineSpacing !== undefined ? { line_spacing: paragraphLineSpacing } : {}),
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
  const rawParagraphStyles = new Map<string, RawStyleDefinition>();
  const rawCharacterStyles = new Map<string, RawStyleDefinition>();
  const rawTableStyles = new Map<string, RawStyleDefinition>();
  let normalParagraphStyleId: string | undefined;

  if (!stylesXml) {
    return {
      docDefaults,
      paragraphStyles: new Map(),
      characterStyles: new Map(),
      tableStyles: new Map(),
      normalParagraphStyle: undefined
    };
  }

  const dom = new DOMParser().parseFromString(stylesXml, "application/xml");
  const root = findFirstElementByLocalName(dom, "styles");
  if (!root) {
    return {
      docDefaults,
      paragraphStyles: new Map(),
      characterStyles: new Map(),
      tableStyles: new Map(),
      normalParagraphStyle: undefined
    };
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
    const styleName = attrLocal(findChildByLocalName(styleNode, "name"), "val");
    const basedOn = attrLocal(findChildByLocalName(styleNode, "basedOn"), "val");
    const def: RawStyleDefinition = {
      style_id: styleId,
      style_name: styleName,
      based_on: basedOn,
      kind:
        styleType === "character"
          ? "character"
          : styleType === "table"
            ? "table"
            : "paragraph",
      run: parseRunProperties(findChildByLocalName(styleNode, "rPr")),
      paragraph_alignment: readParagraphAlignment(findChildByLocalName(styleNode, "pPr"))
    };
    if (def.kind === "paragraph") {
      rawParagraphStyles.set(styleId, def);
      if (attrLocal(styleNode, "default") === "1" || styleId === "Normal") {
        normalParagraphStyleId = styleId;
      }
    } else if (def.kind === "character") {
      rawCharacterStyles.set(styleId, def);
    } else {
      rawTableStyles.set(styleId, def);
    }
  }

  const paragraphStyles = resolveStyles(rawParagraphStyles, docDefaults);
  const characterStyles = resolveStyles(rawCharacterStyles, docDefaults);
  const tableStyles = resolveStyles(rawTableStyles, docDefaults);
  const normalParagraphStyle = normalParagraphStyleId ? paragraphStyles.get(normalParagraphStyleId) : undefined;

  return {
    docDefaults,
    paragraphStyles,
    characterStyles,
    tableStyles,
    normalParagraphStyle
  };
}

function resolveStyles(
  rawStyles: Map<string, RawStyleDefinition>,
  docDefaults: StyleProperties
): Map<string, DocxResolvedStyleDefinition> {
  const resolved = new Map<string, DocxResolvedStyleDefinition>();

  const visit = (styleId: string, stack = new Set<string>()): DocxResolvedStyleDefinition | undefined => {
    const cached = resolved.get(styleId);
    if (cached) {
      return cached;
    }
    const raw = rawStyles.get(styleId);
    if (!raw || stack.has(styleId)) {
      return undefined;
    }
    stack.add(styleId);
    const parent = raw.based_on ? visit(raw.based_on, stack) : undefined;
    const next: DocxResolvedStyleDefinition = {
      style_id: raw.style_id,
      style_name: raw.style_name,
      based_on: raw.based_on,
      resolved_run: {
        ...(parent?.resolved_run ?? docDefaults),
        ...raw.run
      },
      paragraph_alignment: raw.paragraph_alignment ?? parent?.paragraph_alignment
    };
    resolved.set(styleId, next);
    stack.delete(styleId);
    return next;
  };

  for (const styleId of rawStyles.keys()) {
    visit(styleId);
  }
  return resolved;
}

function projectStyles(styleContext: StyleContext): DocxStylesProjection {
  return {
    defaults: {
      ...BUILTIN_STYLE_DEFAULTS,
      ...styleContext.docDefaults
    },
    paragraph_styles: Object.fromEntries(styleContext.paragraphStyles.entries()),
    character_styles: Object.fromEntries(styleContext.characterStyles.entries()),
    table_styles: Object.fromEntries(styleContext.tableStyles.entries())
  };
}

function parseNumberingXml(numberingXml: string | null): NumberingContext {
  if (!numberingXml) {
    return { instances: [] };
  }
  const dom = new DOMParser().parseFromString(numberingXml, "application/xml");
  const root = findFirstElementByLocalName(dom, "numbering");
  if (!root) {
    return { instances: [] };
  }

  const abstractNums = new Map<string, DocxNumberingLevelProjection[]>();
  for (const abstractNum of elementChildren(root).filter((el) => localName(el) === "abstractNum")) {
    const abstractNumId = attrLocal(abstractNum, "abstractNumId");
    if (!abstractNumId) {
      continue;
    }
    const levels: DocxNumberingLevelProjection[] = [];
    for (const levelNode of elementChildren(abstractNum).filter((el) => localName(el) === "lvl")) {
      levels.push({
        ilvl: toNumber(attrLocal(levelNode, "ilvl")) ?? 0,
        start: toNumber(attrLocal(findChildByLocalName(levelNode, "start"), "val")),
        num_fmt: attrLocal(findChildByLocalName(levelNode, "numFmt"), "val"),
        lvl_text: attrLocal(findChildByLocalName(levelNode, "lvlText"), "val")
      });
    }
    abstractNums.set(abstractNumId, levels.sort((left, right) => left.ilvl - right.ilvl));
  }

  const instances: DocxNumberingInstanceProjection[] = [];
  for (const numNode of elementChildren(root).filter((el) => localName(el) === "num")) {
    const numId = attrLocal(numNode, "numId");
    if (!numId) {
      continue;
    }
    const abstractNumId = attrLocal(findChildByLocalName(numNode, "abstractNumId"), "val");
    instances.push({
      num_id: numId,
      abstract_num_id: abstractNumId,
      levels: abstractNumId ? [...(abstractNums.get(abstractNumId) ?? [])] : []
    });
  }

  return { instances };
}

async function parseContentTypes(zip: JSZip): Promise<Map<string, string>> {
  const xml = await readXmlFile(zip, "[Content_Types].xml");
  const contentTypes = new Map<string, string>();
  if (!xml) {
    return contentTypes;
  }
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  const root = findFirstElementByLocalName(dom, "Types");
  if (!root) {
    return contentTypes;
  }
  const defaults = new Map<string, string>();
  for (const child of elementChildren(root)) {
    const name = localName(child);
    if (name === "Default") {
      const extension = attrLocal(child, "Extension");
      const contentType = attrLocal(child, "ContentType");
      if (extension && contentType) {
        defaults.set(extension.toLowerCase(), contentType);
      }
      continue;
    }
    if (name === "Override") {
      const partName = attrLocal(child, "PartName");
      const contentType = attrLocal(child, "ContentType");
      if (partName && contentType) {
        contentTypes.set(partName.replace(/^\/+/, ""), contentType);
      }
    }
  }
  for (const partPath of Object.keys(zip.files)) {
    if (zip.files[partPath]?.dir || contentTypes.has(partPath) || partPath.endsWith(".rels")) {
      continue;
    }
    const ext = path.extname(partPath).replace(/^\./, "").toLowerCase();
    const fallback = defaults.get(ext);
    if (fallback) {
      contentTypes.set(partPath, fallback);
    }
  }
  return contentTypes;
}

async function parseRelationshipState(
  zip: JSZip
): Promise<{
  graph: DocxRelationshipGraph;
  bySource: Map<string, Map<string, RelationshipRecord>>;
}> {
  const edges: DocxRelationshipEdge[] = [];
  const bySource = new Map<string, Map<string, RelationshipRecord>>();
  for (const relsPath of Object.keys(zip.files).filter((partPath) => partPath.endsWith(".rels"))) {
    const xml = await readXmlFile(zip, relsPath);
    if (!xml) {
      continue;
    }
    const sourcePart = relsPathToSourcePartPath(relsPath);
    const dom = new DOMParser().parseFromString(xml, "application/xml");
    const relationshipNodes = Array.from(dom.getElementsByTagName("*")).filter((node) => localName(node as Element) === "Relationship") as Element[];
    for (const relationshipNode of relationshipNodes) {
      const id = relationshipNode.getAttribute("Id");
      const target = relationshipNode.getAttribute("Target");
      const type = relationshipNode.getAttribute("Type");
      const targetMode = relationshipNode.getAttribute("TargetMode") ?? undefined;
      if (!id || !target || !type) {
        continue;
      }
      const resolvedTarget = resolveRelationshipTarget(sourcePart, target);
      const record: RelationshipRecord = {
        id,
        type,
        target,
        targetMode,
        resolvedTarget
      };
      if (!bySource.has(sourcePart)) {
        bySource.set(sourcePart, new Map());
      }
      bySource.get(sourcePart)?.set(id, record);
      edges.push({
        source_part: sourcePart,
        id,
        type,
        target: resolvedTarget,
        ...(targetMode ? { target_mode: targetMode } : {})
      });
    }
  }
  return {
    graph: {
      edges,
      by_source: Object.fromEntries(
        Array.from(bySource.entries()).map(([source, map]) => [
          source,
          Array.from(map.values()).map((record) => ({
            source_part: source,
            id: record.id,
            type: record.type,
            target: record.resolvedTarget,
            ...(record.targetMode ? { target_mode: record.targetMode } : {})
          }))
        ])
      )
    },
    bySource
  };
}

function buildPackageMeta(
  parts: DocxPartModel[],
  relationshipGraph: DocxRelationshipGraph,
  context: ParseContext,
  input: {
    coreXml: string | null;
    documentXml: string | null;
  }
): DocxPackageMeta {
  const coreProps = parseCoreProperties(input.coreXml);
  const headerFooterBindings = extractHeaderFooterBindings(input.documentXml, context.relationshipsBySource.get("word/document.xml"));
  return {
    part_count: parts.length,
    xml_part_count: parts.filter((part) => /\.xml$/i.test(part.path)).length,
    media_count: parts.filter((part) => part.kind === "media").length,
    relationship_count: relationshipGraph.edges.length,
    section_count: Math.max(headerFooterBindings.length, 1),
    header_count: parts.filter((part) => part.kind === "header").length,
    footer_count: parts.filter((part) => part.kind === "footer").length,
    footnote_count: parts.filter((part) => part.kind === "footnotes").length,
    endnote_count: parts.filter((part) => part.kind === "endnotes").length,
    custom_xml_count: parts.filter((part) => part.kind === "custom_xml").length,
    ...(coreProps.created_by ? { created_by: coreProps.created_by } : {}),
    ...(coreProps.modified_by ? { modified_by: coreProps.modified_by } : {}),
    ...(coreProps.created_at ? { created_at: coreProps.created_at } : {}),
    ...(coreProps.modified_at ? { modified_at: coreProps.modified_at } : {}),
    ...(coreProps.revision ? { revision: coreProps.revision } : {}),
    warnings: [...context.warnings],
    part_paths: parts.map((part) => part.path),
    header_footer_bindings: headerFooterBindings
  };
}

function parseCoreProperties(coreXml: string | null): {
  created_by?: string;
  modified_by?: string;
  created_at?: string;
  modified_at?: string;
  revision?: string;
} {
  if (!coreXml) {
    return {};
  }
  const dom = new DOMParser().parseFromString(coreXml, "application/xml");
  const allNodes = Array.from(dom.getElementsByTagName("*"));
  return {
    created_by: findNodeTextByLocalName(allNodes, "creator"),
    modified_by: findNodeTextByLocalName(allNodes, "lastModifiedBy"),
    created_at: findNodeTextByLocalName(allNodes, "created"),
    modified_at: findNodeTextByLocalName(allNodes, "modified"),
    revision: findNodeTextByLocalName(allNodes, "revision")
  };
}

function extractHeaderFooterBindings(
  documentXml: string | null,
  relationships: Map<string, RelationshipRecord> | undefined
): Array<{ section_id: string; headers: string[]; footers: string[] }> {
  if (!documentXml) {
    return [];
  }
  const dom = new DOMParser().parseFromString(documentXml, "application/xml");
  const sectPrNodes = Array.from(dom.getElementsByTagName("*")).filter((node) => localName(node as Element) === "sectPr") as Element[];
  return sectPrNodes.map((sectPr, index) => {
    const headers = elementChildren(sectPr)
      .filter((child) => localName(child) === "headerReference")
      .map((child) => {
        const rid = attrLocal(child, "id");
        return rid ? relationships?.get(rid)?.resolvedTarget : undefined;
      })
      .filter((value): value is string => Boolean(value));
    const footers = elementChildren(sectPr)
      .filter((child) => localName(child) === "footerReference")
      .map((child) => {
        const rid = attrLocal(child, "id");
        return rid ? relationships?.get(rid)?.resolvedTarget : undefined;
      })
      .filter((value): value is string => Boolean(value));
    return {
      section_id: `sect_${index}`,
      headers,
      footers
    };
  });
}

async function extractDrawingImageNode(
  drawing: Element,
  partPath: string,
  blockId: string,
  context: ParseContext,
  xmlPath: string
): Promise<ImageNode> {
  const imageId = `img_${context.counters.image++}`;
  const blip = findDescendants(drawing, (el) => localName(el) === "blip")[0];
  const rid = attrLocal(blip, "embed") ?? attrLocal(blip, "link");
  const size = extractDrawingSize(drawing);
  const imageNode: ImageNode = !rid
    ? { id: imageId, node_type: "image", src: "extraction_failed", size }
    : await exportImageByRelationshipId(partPath, rid, imageId, size, context, xmlPath);
  context.inlineNodes.push({
    id: imageId,
    block_id: blockId,
    part_path: partPath,
    node_type: "image",
    src: imageNode.src,
    size: imageNode.size,
    anchor: {
      part_path: partPath,
      xml_path: xmlPath
    }
  });
  context.patchTargets.push({
    id: `target:inline:${imageId}`,
    target_kind: "inline",
    part_path: partPath,
    block_id: blockId,
    node_id: imageId,
    locator: {
      part_path: partPath,
      xml_path: xmlPath
    }
  });
  return imageNode;
}

async function extractVmlImageNodes(
  pict: Element,
  partPath: string,
  blockId: string,
  context: ParseContext,
  xmlPath: string
): Promise<ImageNode[]> {
  const nodes: ImageNode[] = [];
  for (const imageData of findDescendants(pict, (el) => localName(el) === "imagedata")) {
    const imageId = `img_${context.counters.image++}`;
    const rid = attrLocal(imageData, "id");
    const size = extractVmlSize(imageData.parentNode as Element | null);
    const imageNode: ImageNode = !rid
      ? { id: imageId, node_type: "image", src: "extraction_failed", size }
      : await exportImageByRelationshipId(partPath, rid, imageId, size, context, xmlPath);
    context.inlineNodes.push({
      id: imageId,
      block_id: blockId,
      part_path: partPath,
      node_type: "image",
      src: imageNode.src,
      size: imageNode.size,
      anchor: {
        part_path: partPath,
        xml_path: xmlPath
      }
    });
    context.patchTargets.push({
      id: `target:inline:${imageId}`,
      target_kind: "inline",
      part_path: partPath,
      block_id: blockId,
      node_id: imageId,
      locator: {
        part_path: partPath,
        xml_path: xmlPath
      }
    });
    nodes.push(imageNode);
  }
  return nodes;
}

async function exportImageByRelationshipId(
  partPath: string,
  rid: string,
  imageId: string,
  size: { width: number; height: number },
  context: ParseContext,
  xmlPath: string
): Promise<ImageNode> {
  try {
    const target = context.relationshipsBySource.get(partPath)?.get(rid)?.resolvedTarget;
    if (!target) {
      return { id: imageId, node_type: "image", src: "extraction_failed", size };
    }
    const file = context.zip.file(target);
    if (!file) {
      return { id: imageId, node_type: "image", src: "extraction_failed", size };
    }
    const ext = path.extname(target) || ".bin";
    const outputPath = path.resolve(context.mediaDirAbs, `${imageId}${ext}`);
    const blob = await file.async("nodebuffer");
    await writeFile(outputPath, blob);
    return { id: imageId, node_type: "image", src: outputPath, size };
  } catch {
    context.warnings.push(`image export failed at ${partPath}:${xmlPath}`);
    return { id: imageId, node_type: "image", src: "extraction_failed", size };
  }
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

function extractFormulaNode(
  mathElement: Element,
  partPath: string,
  blockId: string,
  context: ParseContext,
  xmlPath: string
): FormulaNode {
  const formulaId = `math_${context.counters.formula++}`;
  let latex = "\\text{unparsed_formula}";
  try {
    const converted = ommlToLatex(mathElement).trim();
    latex = converted || "\\text{unparsed_formula}";
  } catch {
    latex = "\\text{omml_conversion_failed}";
  }
  context.inlineNodes.push({
    id: formulaId,
    block_id: blockId,
    part_path: partPath,
    node_type: "formula",
    format: "latex",
    content: latex,
    anchor: {
      part_path: partPath,
      xml_path: xmlPath
    }
  });
  context.patchTargets.push({
    id: `target:inline:${formulaId}`,
    target_kind: "inline",
    part_path: partPath,
    block_id: blockId,
    node_id: formulaId,
    locator: {
      part_path: partPath,
      xml_path: xmlPath
    }
  });
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
  return attrLocal(findChildByLocalName(paragraphProps, "pStyle"), "val");
}

function readRunStyleId(runProps: Element | null): string | undefined {
  return attrLocal(findChildByLocalName(runProps, "rStyle"), "val");
}

function readParagraphAlignment(paragraphProps: Element | null): string | undefined {
  return attrLocal(findChildByLocalName(paragraphProps, "jc"), "val");
}

function readParagraphLineSpacing(paragraphProps: Element | null): LineSpacingValue | undefined {
  const spacing = findChildByLocalName(paragraphProps, "spacing");
  const lineValue = toNumber(attrLocal(spacing, "line"));
  if (lineValue === undefined || lineValue <= 0) {
    return undefined;
  }
  const lineRule = (attrLocal(spacing, "lineRule") ?? "auto").trim().toLowerCase();
  if (lineRule === "exact") {
    return { mode: "exact", pt: round4(lineValue / 20) };
  }
  if (!lineRule || lineRule === "auto") {
    return round4(lineValue / 240);
  }
  return undefined;
}

function readParagraphNumbering(paragraphProps: Element | null): { numId?: string; ilvl?: number } {
  const numPr = findChildByLocalName(paragraphProps, "numPr");
  return {
    numId: attrLocal(findChildByLocalName(numPr, "numId"), "val"),
    ilvl: toNumber(attrLocal(findChildByLocalName(numPr, "ilvl"), "val"))
  };
}

function readHeadingLevel(paragraphStyleId: string | undefined, styleName: string | undefined): number | undefined {
  const candidate = paragraphStyleId ?? styleName;
  if (!candidate) {
    return undefined;
  }
  const match = candidate.match(/heading\s*([1-9])|Heading([1-9])/i);
  if (!match) {
    return undefined;
  }
  const raw = match[1] ?? match[2];
  return raw ? Number.parseInt(raw, 10) : undefined;
}

function deriveParagraphRole(
  partKind: string,
  input: {
    inTable: boolean;
    headingLevel?: number;
    numId?: string;
  }
): string {
  if (partKind === "header") {
    return "header";
  }
  if (partKind === "footer") {
    return "footer";
  }
  if (partKind === "footnotes") {
    return "footnote";
  }
  if (partKind === "endnotes") {
    return "endnote";
  }
  if (input.inTable) {
    return "table_text";
  }
  if (input.headingLevel) {
    return "heading";
  }
  if (input.numId) {
    return "list_item";
  }
  return "body";
}

function parseCoreLocalName(node: unknown): string {
  if (node && typeof node === "object" && "localName" in node && typeof node.localName === "string" && node.localName) {
    return node.localName;
  }
  const raw = node && typeof node === "object" && "nodeName" in node ? String(node.nodeName ?? "") : "";
  const idx = raw.indexOf(":");
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

function findNodeTextByLocalName(nodes: unknown[], name: string): string | undefined {
  const match = nodes.find((node) => parseCoreLocalName(node) === name);
  const text = typeof (match as { textContent?: unknown } | undefined)?.textContent === "string"
    ? (match as { textContent: string }).textContent.trim()
    : undefined;
  return text || undefined;
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

function findFirstElementByLocalName(root: Document, name?: string): Element | null {
  for (const node of Array.from(root.getElementsByTagName("*"))) {
    if (!name || localName(node) === name) {
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

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function comparePartPaths(left: string, right: string): number {
  return partOrder(left) - partOrder(right) || left.localeCompare(right);
}

function partOrder(partPath: string): number {
  if (partPath === "word/document.xml") {
    return 0;
  }
  if (/^word\/header\d+\.xml$/i.test(partPath)) {
    return 1;
  }
  if (/^word\/footer\d+\.xml$/i.test(partPath)) {
    return 2;
  }
  if (partPath === "word/footnotes.xml") {
    return 3;
  }
  if (partPath === "word/endnotes.xml") {
    return 4;
  }
  return 10;
}

function determinePartKind(partPath: string, contentType?: string): string {
  if (partPath === "word/document.xml") {
    return "main_document";
  }
  if (/^word\/header\d+\.xml$/i.test(partPath)) {
    return "header";
  }
  if (/^word\/footer\d+\.xml$/i.test(partPath)) {
    return "footer";
  }
  if (partPath === "word/footnotes.xml") {
    return "footnotes";
  }
  if (partPath === "word/endnotes.xml") {
    return "endnotes";
  }
  if (partPath === "word/styles.xml") {
    return "styles";
  }
  if (partPath === "word/numbering.xml") {
    return "numbering";
  }
  if (partPath.startsWith("docProps/")) {
    return "docprops";
  }
  if (partPath.startsWith("customXml/")) {
    return "custom_xml";
  }
  if (partPath.startsWith("word/media/")) {
    return "media";
  }
  if (contentType?.includes("relationships")) {
    return "relationships";
  }
  return /\.xml$/i.test(partPath) ? "xml" : "binary";
}

function isStructuredContentPart(kind: string): boolean {
  return kind === "main_document" || kind === "header" || kind === "footer" || kind === "footnotes" || kind === "endnotes";
}

function relsPathToSourcePartPath(relsPath: string): string {
  const normalized = relsPath.replace(/\\/g, "/");
  if (normalized === "_rels/.rels") {
    return "";
  }
  const match = normalized.match(/^(.*)\/_rels\/([^/]+)\.rels$/);
  if (!match) {
    return "";
  }
  return `${match[1]}/${match[2]}`.replace(/^\/+/, "");
}

function resolveRelationshipTarget(sourcePart: string, target: string): string {
  const normalizedTarget = target.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!sourcePart) {
    return path.posix.normalize(normalizedTarget);
  }
  const baseDir = path.posix.dirname(sourcePart);
  return path.posix.normalize(path.posix.join(baseDir, normalizedTarget));
}

function buildRoleCounts(paragraphs: ObservationParagraphRecord[]): Record<string, number> {
  const roleCounts: Record<string, number> = {};
  for (const paragraph of paragraphs) {
    if (!paragraph.role) {
      continue;
    }
    roleCounts[paragraph.role] = (roleCounts[paragraph.role] ?? 0) + 1;
  }
  return roleCounts;
}
