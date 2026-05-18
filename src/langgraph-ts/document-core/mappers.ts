import type {
  DocxBlockRecord,
  DocxInlineNodeRecord,
  DocxObservationState,
  DocxPackageMeta,
  DocxPackageModel,
  DocxPartModel,
  DocxRelationshipEdge,
  DocxRelationshipGraph,
  DocxResolvedStyleDefinition,
  DocxStructureIndex,
  DocxStylesProjection,
  ObservationParagraphNode,
  ObservationTableNode,
  ObservationTextRunNode,
  ObservationImageNode,
  ObservationFormulaNode,
  ObservationParagraphRecord,
  TextRunStyle as LegacyTextRunStyle
} from "./legacy-observation-schema.js";
import type {
  DocumentAst,
  DocumentAstParagraphRecord,
  DocumentBlockRecord,
  DocumentInlineRecord,
  DocumentPackageMeta,
  DocumentPackageModel,
  DocumentPartModel,
  DocumentStructureIndex,
  FormulaNode,
  ImageNode,
  ParagraphNode,
  ParsedDocumentBundle,
  RelationshipEdge,
  RelationshipGraph,
  ResolvedStyleDefinition,
  StylesProjection,
  TableNode,
  TextRunNode,
  TextRunStyle
} from "../contracts/document-contracts.js";

export function mapLegacyStateToBundle(state: DocxObservationState, docxPath: string): ParsedDocumentBundle {
  const relationshipGraph = mapRelationshipGraph(state.package_model.relationship_graph);
  return {
    source: { docxPath },
    document_ast: {
      documentMeta: {
        totalParagraphs: state.document_meta.total_paragraphs,
        totalTables: state.document_meta.total_tables,
        totalImages: state.document_meta.total_images,
        totalFormulas: state.document_meta.total_formulas,
        totalFootnotes: state.document_meta.total_footnotes,
        totalEndnotes: state.document_meta.total_endnotes,
        totalHeaders: state.document_meta.total_headers,
        totalFooters: state.document_meta.total_footers,
        warning: state.document_meta.warning,
        warnings: state.document_meta.warnings
      },
      nodes: state.nodes.map(mapNode),
      blocks: state.blocks.map(mapBlock),
      inlineNodes: state.inline_nodes.map(mapInlineNode),
      styles: mapStyles(state.styles),
      numbering: {
        instances: state.numbering.instances.map((instance) => ({
          numId: instance.num_id,
          abstractNumId: instance.abstract_num_id,
          levels: instance.levels.map((level) => ({
            ilvl: level.ilvl,
            start: level.start,
            numFmt: level.num_fmt,
            lvlText: level.lvl_text
          }))
        }))
      },
      patchTargets: structuredClone(state.patch_targets)
    },
    document_package: mapPackageModel(state.package_model),
    package_snapshot: {
      parts: {}
    },
    structure_index: mapStructureIndex(state.structure_index),
    relationship_graph: relationshipGraph
  };
}

export function mapStructureIndex(input: DocxStructureIndex): DocumentStructureIndex {
  const paragraphs = input.paragraphs.map(mapParagraphRecord);
  return {
    paragraphs,
    paragraphMap: Object.fromEntries(paragraphs.map((paragraph) => [paragraph.id, paragraph])),
    roleCounts: { ...input.role_counts }
  };
}

function mapParagraphRecord(input: ObservationParagraphRecord): DocumentAstParagraphRecord {
  return {
    id: input.id,
    text: input.text,
    role: input.role,
    headingLevel: input.heading_level,
    listLevel: input.list_level,
    styleName: input.style_name,
    runIds: [...input.run_ids],
    inTable: input.in_table,
    partPath: input.part_path
  };
}

function mapPackageModel(input: DocxPackageModel): DocumentPackageModel {
  return {
    packageMeta: mapPackageMeta(input.package_meta),
    parts: input.parts.map(mapPartModel)
  };
}

function mapPackageMeta(input: DocxPackageMeta): DocumentPackageMeta {
  return {
    partCount: input.part_count,
    xmlPartCount: input.xml_part_count,
    mediaCount: input.media_count,
    relationshipCount: input.relationship_count,
    sectionCount: input.section_count,
    headerCount: input.header_count,
    footerCount: input.footer_count,
    footnoteCount: input.footnote_count,
    endnoteCount: input.endnote_count,
    customXmlCount: input.custom_xml_count,
    createdBy: input.created_by,
    modifiedBy: input.modified_by,
    createdAt: input.created_at,
    modifiedAt: input.modified_at,
    revision: input.revision,
    warnings: [...input.warnings],
    partPaths: [...(input.part_paths ?? [])],
    headerFooterBindings: (input.header_footer_bindings ?? []).map((binding) => ({
      sectionId: binding.section_id,
      headers: [...binding.headers],
      footers: [...binding.footers]
    }))
  };
}

function mapPartModel(input: DocxPartModel): DocumentPartModel {
  return {
    path: input.path,
    kind: input.kind,
    contentType: input.content_type,
    xmlRoot: input.xml_root,
    relationshipCount: input.relationship_count
  };
}

function mapRelationshipGraph(input: DocxRelationshipGraph): RelationshipGraph {
  return {
    edges: input.edges.map(mapRelationshipEdge),
    bySource: Object.fromEntries(
      Object.entries(input.by_source).map(([source, edges]) => [source, edges.map(mapRelationshipEdge)])
    )
  };
}

function mapRelationshipEdge(input: DocxRelationshipEdge): RelationshipEdge {
  return {
    sourcePart: input.source_part,
    id: input.id,
    type: input.type,
    target: input.target,
    targetMode: input.target_mode
  };
}

function mapNode(input: ObservationParagraphNode | ObservationTableNode): ParagraphNode | TableNode {
  if (input.node_type === "paragraph") {
    return {
      id: input.id ?? "",
      nodeType: "paragraph",
      children: input.children.map(mapParagraphChild)
    };
  }
  return {
    id: input.id ?? "",
    nodeType: "table",
    rows: input.rows.map((row) => ({
      rowIndex: row.row_index,
      cells: row.cells.map((cell) => ({
        cellIndex: cell.cell_index,
        paragraphs: cell.paragraphs.map((paragraph) => mapNode(paragraph) as ParagraphNode),
        tables: cell.tables.map((table) => mapNode(table) as TableNode)
      }))
    }))
  };
}

function mapParagraphChild(input: ObservationTextRunNode | ObservationImageNode | ObservationFormulaNode): TextRunNode | ImageNode | FormulaNode {
  if (input.node_type === "text_run") {
    return {
      id: input.id ?? "",
      nodeType: "text_run",
      content: input.content ?? "",
      style: input.style ? mapTextRunStyle(input.style) : undefined
    };
  }
  if (input.node_type === "image") {
    return {
      id: input.id ?? "",
      nodeType: "image",
      src: input.src ?? "",
      size: input.size ?? { width: 0, height: 0 }
    };
  }
  return {
    id: input.id ?? "",
    nodeType: "formula",
    format: input.format ?? "latex",
    content: input.content ?? ""
  };
}

function mapBlock(input: DocxBlockRecord): DocumentBlockRecord {
  return {
    id: input.id,
    blockId: input.block_id,
    partPath: input.part_path,
    nodeType: input.node_type,
    paragraphId: input.paragraph_id,
    tableId: input.table_id,
    role: input.role,
    anchor: input.anchor
      ? {
          partPath: input.anchor.part_path,
          xmlPath: input.anchor.xml_path
        }
      : undefined
  };
}

function mapInlineNode(input: DocxInlineNodeRecord): DocumentInlineRecord {
  return {
    id: input.id,
    blockId: input.block_id,
    partPath: input.part_path,
    nodeType: input.node_type,
    text: input.text,
    src: input.src,
    size: input.size,
    format: input.format,
    content: input.content,
    style: input.style ? mapTextRunStyle(input.style) : undefined,
    anchor: input.anchor
      ? {
          partPath: input.anchor.part_path,
          xmlPath: input.anchor.xml_path
        }
      : undefined
  };
}

function mapStyles(input: DocxStylesProjection): StylesProjection {
  return {
    defaults: mapTextRunStyle(input.defaults),
    paragraphStyles: mapStyleDictionary(input.paragraph_styles),
    characterStyles: mapStyleDictionary(input.character_styles),
    tableStyles: mapStyleDictionary(input.table_styles)
  };
}

function mapStyleDictionary(input: Record<string, DocxResolvedStyleDefinition>): Record<string, ResolvedStyleDefinition> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, mapResolvedStyle(value)]));
}

function mapResolvedStyle(input: DocxResolvedStyleDefinition): ResolvedStyleDefinition {
  return {
    styleId: input.style_id,
    styleName: input.style_name,
    basedOn: input.based_on,
    resolvedRun: mapTextRunStyle(input.resolved_run),
    paragraphAlignment: input.paragraph_alignment
  };
}

export function mapTextRunStyle(input: LegacyTextRunStyle): TextRunStyle {
  return {
    fontName: input.font_name,
    fontSizePt: input.font_size_pt,
    lineSpacing: input.line_spacing as TextRunStyle["lineSpacing"],
    fontColor: input.font_color,
    isBold: input.is_bold,
    isItalic: input.is_italic,
    isUnderline: input.is_underline,
    isStrike: input.is_strike,
    highlightColor: input.highlight_color,
    isAllCaps: input.is_all_caps,
    paragraphAlignment: input.paragraph_alignment
  };
}
