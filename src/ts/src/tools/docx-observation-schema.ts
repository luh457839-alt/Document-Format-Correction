import type { DocumentNodeStyle } from "../core/types.js";

export interface ObservationDocumentMeta {
  total_paragraphs: number;
  total_tables: number;
  warning?: string;
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

export interface DocxObservationState {
  document_meta: ObservationDocumentMeta;
  paragraphs?: ObservationParagraphRecord[];
  nodes: Array<ObservationParagraphNode | ObservationTableNode>;
}

export function isDocxObservationState(value: unknown): value is DocxObservationState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    document_meta?: { total_paragraphs?: unknown; total_tables?: unknown };
    nodes?: unknown;
    paragraphs?: unknown;
  };
  return (
    !!candidate.document_meta &&
    typeof candidate.document_meta.total_paragraphs === "number" &&
    typeof candidate.document_meta.total_tables === "number" &&
    Array.isArray(candidate.nodes) &&
    (candidate.paragraphs === undefined || Array.isArray(candidate.paragraphs))
  );
}
