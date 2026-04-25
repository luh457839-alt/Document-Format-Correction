import type { DocumentIR } from "../core/types.js";
import { AgentError } from "../core/errors.js";
import { createDocumentToolingFacade } from "../document-tooling/facade.js";
import type { PythonDocxObservationState } from "../tools/python-tool-client.js";

export interface StructuredParagraph {
  id: string;
  text: string;
  role: string;
  headingLevel?: number;
  listLevel?: number;
  styleName?: string;
  runNodeIds: string[];
  inTable: boolean;
}

export interface DocumentStructureIndex {
  paragraphs: StructuredParagraph[];
  paragraphMap: Record<string, StructuredParagraph>;
  roleCounts: Record<string, number>;
}

export interface EmphasisFlags {
  isBold: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  highlightColor?: string;
}

export interface EmphasisRunIndexItem {
  runId: string;
  text: string;
  paragraphId: string;
  paragraphTextPreview: string;
  emphasisFlags: EmphasisFlags;
}

export async function hydrateDocumentFromInputDocx(document: DocumentIR): Promise<DocumentIR> {
  const metadata = document.metadata;
  if (!metadata || typeof metadata !== "object") {
    return document;
  }
  const inputDocxPath = (metadata as Record<string, unknown>).inputDocxPath;
  if (typeof inputDocxPath !== "string" || !inputDocxPath.trim()) {
    return document;
  }

  const state = await createDocumentToolingFacade().observeDocument(inputDocxPath.trim());
  const nodes = documentStateToNodes(state);
  if (nodes.length === 0) {
    throw new AgentError({
      code: "E_DOCX_EMPTY",
      message: "Loaded input DOCX has no text nodes to edit.",
      retryable: false
    });
  }

  return {
    ...document,
    nodes,
    metadata: {
      ...(document.metadata ?? {}),
      sourceDocumentMeta: state.document_meta,
      structureIndex: buildStructureIndex(state)
    }
  };
}

export function documentStateToNodes(state: PythonDocxObservationState): DocumentIR["nodes"] {
  const nodes: DocumentIR["nodes"] = [];

  const visitParagraph = (
    paragraph: {
      children: Array<{
        id?: string;
        node_type: string;
        content?: string;
        style?: unknown;
      }>;
    }
  ): void => {
    for (const child of paragraph.children) {
      if (child.node_type !== "text_run") {
        continue;
      }
      const text = String(child.content ?? "").trim();
      const id = typeof child.id === "string" ? child.id.trim() : "";
      if (!text || !id) {
        continue;
      }
      nodes.push({
        id,
        text,
        style:
          child.style && typeof child.style === "object"
            ? { ...(child.style as Record<string, unknown>) }
            : undefined
      });
    }
  };

  const visitTable = (table: any): void => {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        for (const paragraph of cell.paragraphs) {
          visitParagraph(paragraph);
        }
        for (const nested of cell.tables) {
          visitTable(nested);
        }
      }
    }
  };

  for (const item of state.nodes) {
    if (item.node_type === "paragraph") {
      visitParagraph(item);
      continue;
    }
    if (item.node_type === "table") {
      visitTable(item);
    }
  }

  return nodes;
}

export function buildStructureIndex(state: PythonDocxObservationState): DocumentStructureIndex {
  const paragraphs = Array.isArray(state.paragraphs) && state.paragraphs.length > 0
    ? state.paragraphs.map((paragraph) => ({
        id: paragraph.id,
        text: paragraph.text,
        role: paragraph.role,
        headingLevel: paragraph.heading_level,
        listLevel: paragraph.list_level,
        styleName: paragraph.style_name,
        runNodeIds: [...paragraph.run_ids],
        inTable: paragraph.in_table
      }))
    : deriveParagraphsFromNodes(state);

  const paragraphMap = Object.fromEntries(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const roleCounts: Record<string, number> = {};
  for (const paragraph of paragraphs) {
    if (!paragraph.role) {
      continue;
    }
    roleCounts[paragraph.role] = (roleCounts[paragraph.role] ?? 0) + 1;
  }

  return {
    paragraphs,
    paragraphMap,
    roleCounts
  };
}

export function buildEmphasisRunIndex(
  doc: DocumentIR,
  options: { maxItems?: number; previewLength?: number } = {}
): EmphasisRunIndexItem[] {
  const structure = readStructureIndex(doc);
  if (!structure) {
    return [];
  }

  const maxItems = options.maxItems ?? 24;
  const previewLength = options.previewLength ?? 80;
  const paragraphByRunId = new Map<string, { paragraph: StructuredParagraph; paragraphIndex: number }>();
  structure.paragraphs.forEach((paragraph, paragraphIndex) => {
    paragraph.runNodeIds.forEach((runId) => {
      paragraphByRunId.set(runId, { paragraph, paragraphIndex });
    });
  });

  const ranked = doc.nodes
    .map((node, nodeIndex) => {
      const emphasisFlags = readEmphasisFlags(node.style);
      if (!emphasisFlags) {
        return undefined;
      }
      const parent = paragraphByRunId.get(node.id);
      const text = node.text.trim();
      if (!parent || !text) {
        return undefined;
      }
      const emphasisStrength =
        (emphasisFlags.isBold ? 2 : 0) +
        (emphasisFlags.isItalic ? 1 : 0) +
        (emphasisFlags.isUnderline ? 1 : 0) +
        (emphasisFlags.highlightColor ? 3 : 0);

      return {
        runId: node.id,
        text,
        paragraphId: parent.paragraph.id,
        paragraphTextPreview: truncateText(parent.paragraph.text || text, previewLength),
        emphasisFlags,
        paragraphIndex: parent.paragraphIndex,
        nodeIndex,
        priority: emphasisStrength * 100 - Math.min(text.length, 60) - parent.paragraphIndex * 2
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return left.nodeIndex - right.nodeIndex;
    })
    .slice(0, maxItems)
    .sort((left, right) => {
      if (left.paragraphIndex !== right.paragraphIndex) {
        return left.paragraphIndex - right.paragraphIndex;
      }
      return left.nodeIndex - right.nodeIndex;
    });

  return ranked.map(({ runId, text, paragraphId, paragraphTextPreview, emphasisFlags }) => ({
    runId,
    text,
    paragraphId,
    paragraphTextPreview,
    emphasisFlags
  }));
}

function deriveParagraphsFromNodes(state: PythonDocxObservationState): StructuredParagraph[] {
  const paragraphs: StructuredParagraph[] = [];

  const visitParagraph = (
    paragraph: {
      id?: string;
      children: Array<{
        id?: string;
        node_type: string;
        content?: string;
      }>;
    },
    inTable: boolean
  ): void => {
    const paragraphId = typeof paragraph.id === "string" && paragraph.id.trim() ? paragraph.id.trim() : "";
    const runNodeIds = paragraph.children
      .filter((child) => child.node_type === "text_run" && typeof child.id === "string" && child.id.trim())
      .map((child) => String(child.id).trim());
    const text = paragraph.children
      .filter((child) => child.node_type === "text_run")
      .map((child) => String(child.content ?? ""))
      .join("")
      .trim();
    if (!paragraphId) {
      return;
    }
    paragraphs.push({
      id: paragraphId,
      text,
      role: inTable ? "table_text" : "body",
      runNodeIds,
      inTable
    });
  };

  const visitTable = (table: any): void => {
    for (const row of table.rows ?? []) {
      for (const cell of row.cells ?? []) {
        for (const paragraph of cell.paragraphs ?? []) {
          visitParagraph(paragraph, true);
        }
        for (const nested of cell.tables ?? []) {
          visitTable(nested);
        }
      }
    }
  };

  for (const item of state.nodes) {
    if (item.node_type === "paragraph") {
      visitParagraph(item, false);
      continue;
    }
    if (item.node_type === "table") {
      visitTable(item);
    }
  }

  return paragraphs;
}

function readStructureIndex(doc: DocumentIR): DocumentStructureIndex | undefined {
  const structureIndex = doc.metadata?.structureIndex;
  if (!structureIndex || typeof structureIndex !== "object") {
    return undefined;
  }
  const candidate = structureIndex as Partial<DocumentStructureIndex>;
  if (!Array.isArray(candidate.paragraphs)) {
    return undefined;
  }
  return candidate as DocumentStructureIndex;
}

function readEmphasisFlags(style: DocumentIR["nodes"][number]["style"]): EmphasisFlags | undefined {
  if (!style || typeof style !== "object") {
    return undefined;
  }
  const candidate = style as Record<string, unknown>;
  const highlightColor = normalizeHighlightColor(candidate.highlight_color);
  const emphasisFlags: EmphasisFlags = {
    isBold: candidate.is_bold === true,
    isItalic: candidate.is_italic === true,
    isUnderline: candidate.is_underline === true,
    highlightColor
  };
  if (!emphasisFlags.isBold && !emphasisFlags.isItalic && !emphasisFlags.isUnderline && !highlightColor) {
    return undefined;
  }
  return emphasisFlags;
}

function normalizeHighlightColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "none") {
    return undefined;
  }
  return normalized;
}

function truncateText(value: string, maxLength: number): string {
  const text = value.trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}
