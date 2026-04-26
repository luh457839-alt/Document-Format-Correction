import type { DocumentNodeStyle } from "../core/types.js";

export interface ObservationDocumentMeta {
  total_paragraphs: number;
  total_tables: number;
  total_images?: number;
  total_formulas?: number;
  total_footnotes?: number;
  total_endnotes?: number;
  total_headers?: number;
  total_footers?: number;
  warning?: string;
  warnings?: string[];
}

export interface DocxPackageMeta {
  part_count: number;
  xml_part_count: number;
  media_count: number;
  relationship_count: number;
  section_count: number;
  header_count: number;
  footer_count: number;
  footnote_count: number;
  endnote_count: number;
  custom_xml_count: number;
  created_by?: string;
  modified_by?: string;
  created_at?: string;
  modified_at?: string;
  revision?: string;
  warnings: string[];
  part_paths?: string[];
  header_footer_bindings?: Array<{
    section_id: string;
    headers: string[];
    footers: string[];
  }>;
}

export interface DocxXmlAnchor {
  part_path: string;
  xml_path: string;
}

export interface TextRunStyle extends DocumentNodeStyle {
  font_name?: string;
  font_size_pt?: number;
  font_color?: string;
  is_bold?: boolean;
  is_italic?: boolean;
  is_underline?: boolean;
  is_strike?: boolean;
  highlight_color?: string;
  is_all_caps?: boolean;
  paragraph_alignment?: string;
}

export interface ObservationTextRunNode {
  id?: string;
  node_type: "text_run";
  content?: string;
  style?: TextRunStyle;
}

export interface ObservationImageNode {
  id?: string;
  node_type: "image";
  src?: string;
  size?: {
    width: number;
    height: number;
  };
}

export interface ObservationFormulaNode {
  id?: string;
  node_type: "formula";
  format?: "latex";
  content?: string;
}

export interface ObservationParagraphNode {
  id?: string;
  node_type: "paragraph";
  children: Array<ObservationTextRunNode | ObservationImageNode | ObservationFormulaNode>;
}

export interface ObservationParagraphRecord {
  id: string;
  text: string;
  role: string;
  heading_level?: number;
  list_level?: number;
  style_name?: string;
  run_ids: string[];
  in_table: boolean;
  part_path?: string;
}

export interface ObservationTableCell {
  cell_index: number;
  paragraphs: ObservationParagraphNode[];
  tables: ObservationTableNode[];
}

export interface ObservationTableRow {
  row_index: number;
  cells: ObservationTableCell[];
}

export interface ObservationTableNode {
  id?: string;
  node_type: "table";
  rows: ObservationTableRow[];
}

export interface DocxRelationshipEdge {
  source_part: string;
  id: string;
  type: string;
  target: string;
  target_mode?: string;
}

export interface DocxRelationshipGraph {
  edges: DocxRelationshipEdge[];
  by_source: Record<string, DocxRelationshipEdge[]>;
}

export interface DocxPartModel {
  path: string;
  kind: string;
  content_type?: string;
  xml_root?: string;
  relationship_count: number;
}

export interface DocxPackageModel {
  package_meta: DocxPackageMeta;
  parts: DocxPartModel[];
  relationship_graph: DocxRelationshipGraph;
}

export interface DocxBlockRecord {
  id: string;
  block_id: string;
  part_path: string;
  node_type: "paragraph" | "table" | "section_break";
  paragraph_id?: string;
  table_id?: string;
  role?: string;
  anchor?: DocxXmlAnchor;
}

export interface DocxInlineNodeRecord {
  id: string;
  block_id: string;
  part_path: string;
  node_type: "text" | "image" | "formula";
  text?: string;
  src?: string;
  size?: {
    width: number;
    height: number;
  };
  format?: "latex";
  content?: string;
  style?: TextRunStyle;
  anchor?: DocxXmlAnchor;
}

export interface DocxResolvedStyleDefinition {
  style_id: string;
  style_name?: string;
  based_on?: string;
  resolved_run: TextRunStyle;
  paragraph_alignment?: string;
}

export interface DocxStylesProjection {
  defaults: TextRunStyle;
  paragraph_styles: Record<string, DocxResolvedStyleDefinition>;
  character_styles: Record<string, DocxResolvedStyleDefinition>;
  table_styles: Record<string, DocxResolvedStyleDefinition>;
}

export interface DocxNumberingLevelProjection {
  ilvl: number;
  start?: number;
  num_fmt?: string;
  lvl_text?: string;
}

export interface DocxNumberingInstanceProjection {
  num_id: string;
  abstract_num_id?: string;
  levels: DocxNumberingLevelProjection[];
}

export interface DocxNumberingProjection {
  instances: DocxNumberingInstanceProjection[];
}

export interface DocxStructureIndex {
  paragraphs: ObservationParagraphRecord[];
  role_counts: Record<string, number>;
}

export interface DocxPatchTarget {
  id: string;
  part_kind?:
    | "document"
    | "header"
    | "footer"
    | "styles"
    | "numbering"
    | "settings"
    | "by_part_path"
    | "main_document";
  target_kind:
    | "block"
    | "inline"
    | "paragraph"
    | "run"
    | "table"
    | "row"
    | "cell"
    | "section"
    | "style"
    | "style_defaults"
    | "numbering_level"
    | "settings_node";
  part_path: string;
  block_id: string;
  node_id?: string;
  xml_tag?: string;
  parent_target_id?: string;
  attributes_snapshot?: Record<string, string>;
  locator?: DocxXmlAnchor;
  text?: string;
  style_snapshot?: TextRunStyle;
}

export interface DocxPatchOperation {
  id: string;
  type:
    | "replace_text"
    | "set_attribute"
    | "remove_attribute"
    | "set_attr"
    | "remove_attr"
    | "set_text"
    | "remove_node"
    | "ensure_node"
    | "replace_node_xml";
  target_id: string;
  value?: unknown;
  name?: string;
  path?: string;
  xml_tag?: string;
  attrs?: Record<string, string>;
  node_xml?: string;
}

export interface DocxPatchSet {
  targets?: DocxPatchTarget[];
  operations: DocxPatchOperation[];
}

export interface DocxMaterializationInput {
  output_docx_path: string;
  patch_set?: DocxPatchSet;
}

export interface DocxObservationState {
  package_model: DocxPackageModel;
  package_meta: DocxPackageMeta;
  document_meta: ObservationDocumentMeta;
  blocks: DocxBlockRecord[];
  inline_nodes: DocxInlineNodeRecord[];
  styles: DocxStylesProjection;
  numbering: DocxNumberingProjection;
  structure_index: DocxStructureIndex;
  patch_targets: DocxPatchTarget[];
  paragraphs?: ObservationParagraphRecord[];
  nodes: Array<ObservationParagraphNode | ObservationTableNode>;
}

export function isDocxObservationState(value: unknown): value is DocxObservationState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    document_meta?: { total_paragraphs?: unknown; total_tables?: unknown };
    package_meta?: { part_count?: unknown };
    nodes?: unknown;
    inline_nodes?: unknown;
    blocks?: unknown;
    structure_index?: { paragraphs?: unknown };
  };
  return (
    !!candidate.document_meta &&
    typeof candidate.document_meta.total_paragraphs === "number" &&
    typeof candidate.document_meta.total_tables === "number" &&
    Array.isArray(candidate.nodes) &&
    (!!candidate.package_meta ? typeof candidate.package_meta.part_count === "number" : true) &&
    (candidate.inline_nodes === undefined || Array.isArray(candidate.inline_nodes)) &&
    (candidate.blocks === undefined || Array.isArray(candidate.blocks)) &&
    (candidate.structure_index === undefined || Array.isArray(candidate.structure_index.paragraphs))
  );
}
