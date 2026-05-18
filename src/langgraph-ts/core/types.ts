export type OperationType =
  | "set_font"
  | "set_size"
  | "set_line_spacing"
  | "set_alignment"
  | "set_font_color"
  | "set_bold"
  | "set_italic"
  | "set_underline"
  | "set_strike"
  | "set_highlight_color"
  | "set_all_caps"
  | "set_page_layout"
  | "set_paragraph_spacing"
  | "set_paragraph_indent"
  | "set_style_definition"
  | "set_numbering_level"
  | "set_settings_flag"
  | "set_attr"
  | "remove_attr"
  | "set_text"
  | "remove_node"
  | "ensure_node"
  | "replace_node_xml"
  | "merge_paragraph"
  | "split_paragraph";

export interface ExactLineSpacing {
  mode: "exact";
  pt: number;
}

export type LineSpacingValue = number | ExactLineSpacing;

export interface DocumentNodeStyle extends Record<string, unknown> {
  font_name?: string;
  font_size_pt?: number;
  line_spacing?: LineSpacingValue;
  font_color?: string;
  is_bold?: boolean;
  is_italic?: boolean;
  is_underline?: boolean;
  is_strike?: boolean;
  highlight_color?: string;
  is_all_caps?: boolean;
  space_before_pt?: number;
  space_after_pt?: number;
  first_line_indent_pt?: number;
  paragraph_alignment?: string;
  operation?: OperationType;
}

export interface DocumentNode {
  id: string;
  text: string;
  style?: DocumentNodeStyle;
}

export interface DocumentIR {
  id: string;
  version: string;
  nodes: DocumentNode[];
  metadata?: Record<string, unknown>;
}

export interface Operation {
  id: string;
  type: OperationType;
  payload: Record<string, unknown>;
  targetNodeId?: string;
}

export interface ToolExecutionContext {
  taskId: string;
  stepId: string;
  dryRun: boolean;
}

export interface ToolExecutionInput {
  doc: DocumentIR;
  operation?: Operation;
  context: ToolExecutionContext;
}

export interface ToolExecutionOutput {
  doc: DocumentIR;
  summary: string;
  rollbackToken?: string;
  artifacts?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  readOnly: boolean;
  validate(input: ToolExecutionInput): Promise<void> | void;
  execute(input: ToolExecutionInput): Promise<ToolExecutionOutput>;
  rollback?(rollbackToken: string, doc: DocumentIR): Promise<DocumentIR>;
}
