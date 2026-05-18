export interface RelationshipEdge {
  sourcePart: string;
  id: string;
  type: string;
  target: string;
  targetMode?: string;
}

export interface RelationshipGraph {
  edges: RelationshipEdge[];
  bySource: Record<string, RelationshipEdge[]>;
}

export interface XmlAnchor {
  partPath: string;
  xmlPath: string;
}

export interface TextRunStyle {
  fontName?: string;
  fontSizePt?: number;
  lineSpacing?: number | { mode: "exact"; pt: number };
  fontColor?: string;
  isBold?: boolean;
  isItalic?: boolean;
  isUnderline?: boolean;
  isStrike?: boolean;
  highlightColor?: string;
  isAllCaps?: boolean;
  paragraphAlignment?: string;
}

export interface TextRunNode {
  id: string;
  nodeType: "text_run";
  content: string;
  style?: TextRunStyle;
}

export interface ImageNode {
  id: string;
  nodeType: "image";
  src: string;
  size: {
    width: number;
    height: number;
  };
}

export interface FormulaNode {
  id: string;
  nodeType: "formula";
  format: "latex";
  content: string;
}

export interface ParagraphNode {
  id: string;
  nodeType: "paragraph";
  children: Array<TextRunNode | ImageNode | FormulaNode>;
}

export interface TableCellNode {
  cellIndex: number;
  paragraphs: ParagraphNode[];
  tables: TableNode[];
}

export interface TableRowNode {
  rowIndex: number;
  cells: TableCellNode[];
}

export interface TableNode {
  id: string;
  nodeType: "table";
  rows: TableRowNode[];
}

export interface DocumentBlockRecord {
  id: string;
  blockId: string;
  partPath: string;
  nodeType: "paragraph" | "table" | "section_break";
  paragraphId?: string;
  tableId?: string;
  role?: string;
  anchor?: XmlAnchor;
}

export interface DocumentInlineRecord {
  id: string;
  blockId: string;
  partPath: string;
  nodeType: "text" | "image" | "formula";
  text?: string;
  src?: string;
  size?: {
    width: number;
    height: number;
  };
  format?: "latex";
  content?: string;
  style?: TextRunStyle;
  anchor?: XmlAnchor;
}

export interface NumberingLevelProjection {
  ilvl: number;
  start?: number;
  numFmt?: string;
  lvlText?: string;
}

export interface NumberingInstanceProjection {
  numId: string;
  abstractNumId?: string;
  levels: NumberingLevelProjection[];
}

export interface NumberingProjection {
  instances: NumberingInstanceProjection[];
}

export interface ResolvedStyleDefinition {
  styleId: string;
  styleName?: string;
  basedOn?: string;
  resolvedRun: TextRunStyle;
  paragraphAlignment?: string;
}

export interface StylesProjection {
  defaults: TextRunStyle;
  paragraphStyles: Record<string, ResolvedStyleDefinition>;
  characterStyles: Record<string, ResolvedStyleDefinition>;
  tableStyles: Record<string, ResolvedStyleDefinition>;
}

export interface DocumentAstParagraphRecord {
  id: string;
  text: string;
  role: string;
  headingLevel?: number;
  listLevel?: number;
  styleName?: string;
  runIds: string[];
  inTable: boolean;
  partPath?: string;
}

export interface DocumentStructureIndex {
  paragraphs: DocumentAstParagraphRecord[];
  paragraphMap: Record<string, DocumentAstParagraphRecord>;
  roleCounts: Record<string, number>;
}

export interface DocumentPackageMeta {
  partCount: number;
  xmlPartCount: number;
  mediaCount: number;
  relationshipCount: number;
  sectionCount: number;
  headerCount: number;
  footerCount: number;
  footnoteCount: number;
  endnoteCount: number;
  customXmlCount: number;
  createdBy?: string;
  modifiedBy?: string;
  createdAt?: string;
  modifiedAt?: string;
  revision?: string;
  warnings: string[];
  partPaths: string[];
  headerFooterBindings: Array<{
    sectionId: string;
    headers: string[];
    footers: string[];
  }>;
}

export interface DocumentPartModel {
  path: string;
  kind: string;
  contentType?: string;
  xmlRoot?: string;
  relationshipCount: number;
}

export interface DocumentPackageModel {
  packageMeta: DocumentPackageMeta;
  parts: DocumentPartModel[];
}

export interface PackageSnapshotPart {
  path: string;
  kind: "xml" | "binary";
  text?: string;
  base64?: string;
}

export interface DocumentPackageSnapshot {
  parts: Record<string, PackageSnapshotPart>;
}

export interface DocumentAst {
  documentMeta: {
    totalParagraphs: number;
    totalTables: number;
    totalImages?: number;
    totalFormulas?: number;
    totalFootnotes?: number;
    totalEndnotes?: number;
    totalHeaders?: number;
    totalFooters?: number;
    warning?: string;
    warnings?: string[];
  };
  nodes: Array<ParagraphNode | TableNode>;
  blocks: DocumentBlockRecord[];
  inlineNodes: DocumentInlineRecord[];
  styles: StylesProjection;
  numbering: NumberingProjection;
  patchTargets: unknown[];
}

export interface ParsedDocumentBundle {
  source: {
    docxPath: string;
  };
  document_ast: DocumentAst;
  document_package: DocumentPackageModel;
  package_snapshot: DocumentPackageSnapshot;
  structure_index: DocumentStructureIndex;
  relationship_graph: RelationshipGraph;
}

export interface ChatProjectionOptions {
  emphasisLimit?: number;
  focusRegexProbe?: string;
  textBudget?: number;
  neighborWindow?: number;
  minNeighborWindow?: number;
  backgroundPreviewLength?: number;
  minBackgroundPreviewLength?: number;
  nodePreviewLength?: number;
  minNodePreviewLength?: number;
}

export type ChatProjectionDegradationStep =
  | "compress_background_text"
  | "shrink_neighbor_window"
  | "truncate_emphasis_runs"
  | "shrink_node_text";

export interface ChatDocumentProjection {
  kind: "chat";
  paragraphs: Array<{
    paragraphId: string;
    text: string;
    role: string;
    headingLevel?: number;
    listLevel?: number;
    inTable: boolean;
    focusPriority?: "regex_hit" | "regex_neighbor" | "background";
  }>;
  nodes: Array<{
    id: string;
    nodeType: "paragraph";
    text: string;
    role: string;
  }>;
  emphasisRuns: Array<{
    runId: string;
    text: string;
    paragraphId: string;
    paragraphTextPreview: string;
    emphasisFlags: {
      isBold: boolean;
      isItalic: boolean;
      isUnderline: boolean;
      highlightColor?: string;
    };
  }>;
  traceability: {
    paragraphIds: string[];
    nodeIds: string[];
  };
  diagnostics: {
    focusRegexProbe?: string;
    estimatedChars: number;
    textBudget?: number;
    budgetStatus: "fit";
    degradationSteps: ChatProjectionDegradationStep[];
  };
}

export type TemplateParagraphBucketType = "heading" | "title" | "list_item" | "body" | "table_text" | "unknown";

export interface TemplateProjectionOptions {
  localContextWindow?: number;
  includeSemanticFeatures?: boolean;
  textBudget?: number;
  maxBatchBudget?: number;
  minLocalContextWindow?: number;
  backgroundPreviewLength?: number;
  minBackgroundPreviewLength?: number;
}

export interface TemplateProjectionParagraph {
  paragraphId: string;
  text: string;
  role: string;
  headingLevel?: number;
  listLevel?: number;
  styleName?: string;
  inTable: boolean;
  paragraphIndex: number;
  bucketType: TemplateParagraphBucketType;
  hasImageEvidence: boolean;
  imageCount: number;
  isImageDominant: boolean;
  numberingPattern?: string;
  isShortText: boolean;
  runStyleSummary: {
    fontName?: string;
    fontSizePt?: number;
    isBold?: boolean;
    isItalic?: boolean;
    paragraphAlignment?: string;
    lineSpacing?: number | { mode: "exact"; pt: number };
  };
  visualSignals: {
    isStandaloneLine: boolean;
    isCentered: boolean;
    isBold: boolean;
    hasLargerFont: boolean;
  };
  localContext: {
    before: Array<{ paragraphId: string; text: string; role: string; bucketType: TemplateParagraphBucketType }>;
    after: Array<{ paragraphId: string; text: string; role: string; bucketType: TemplateParagraphBucketType }>;
  };
}

export type TemplateProjectionDegradationStep =
  | "shrink_local_context_window"
  | "merge_background_paragraphs"
  | "split_batches";

export interface TemplateProjectionBatch {
  batchId: string;
  paragraphIds: string[];
  startParagraphIndex: number;
  endParagraphIndex: number;
  estimatedChars: number;
  paragraphs: TemplateProjectionParagraph[];
}

export interface TemplateDocumentProjection {
  kind: "template";
  paragraphs: TemplateProjectionParagraph[];
  batches: TemplateProjectionBatch[];
  evidenceSummary: {
    tableCount: number;
    imageCount: number;
    imageParagraphCount: number;
    imageDominantParagraphCount: number;
    numberingPatterns: string[];
    styleNameCounts: Record<string, number>;
  };
  diagnostics: {
    estimatedChars: number;
    textBudget?: number;
    maxBatchBudget?: number;
    budgetStatus: "fit";
    degradationSteps: TemplateProjectionDegradationStep[];
    batchCount: number;
    localContextWindow: number;
  };
}
