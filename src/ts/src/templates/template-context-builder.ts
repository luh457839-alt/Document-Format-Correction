import { buildStructureIndex, documentStateToNodes } from "../runtime/document-state.js";
import type { PythonDocxObservationState } from "../tools/python-tool-client.js";
import type {
  TemplateContext,
  TemplateEvidenceSummary,
  TemplateObservationSummary,
  TemplateParagraphBucketType,
  TemplateParagraphContext
} from "./types.js";

export function buildTemplateContextFromObservation(input: {
  docxPath: string;
  observation: PythonDocxObservationState;
}): TemplateContext {
  const paragraphImageEvidence = buildParagraphImageEvidence(input.observation.nodes);
  const document = {
    id: `template:${input.docxPath}`,
    version: "v1",
    nodes: documentStateToNodes(input.observation),
    metadata: {
      inputDocxPath: input.docxPath,
      sourceDocxPath: input.docxPath,
      docxObservation: input.observation,
      docxPackageModel: input.observation.package_model,
      sourceDocumentMeta: input.observation.document_meta,
      structureIndex: buildStructureIndex(input.observation)
    }
  };
  const structureIndex = buildStructureIndex(input.observation);
  const paragraphContexts = structureIndex.paragraphs.map((paragraph, paragraphIndex) => {
    const runStyles = paragraph.runNodeIds
      .map((runId) => document.nodes.find((node) => node.id === runId)?.style)
      .filter((style): style is Record<string, unknown> => Boolean(style && typeof style === "object"));
    const bucketType = resolveParagraphBucketType(paragraph.role, paragraph.inTable);
    const imageEvidence = paragraphImageEvidence.get(paragraph.id) ?? {
      image_count: 0,
      has_image_evidence: false,
      is_image_dominant: false
    };

    return {
      paragraph_id: paragraph.id,
      text: paragraph.text,
      role: paragraph.role,
      heading_level: paragraph.headingLevel,
      list_level: paragraph.listLevel,
      style_name: paragraph.styleName,
      in_table: paragraph.inTable,
      paragraph_index: paragraphIndex,
      is_first_paragraph: paragraphIndex === 0,
      is_last_paragraph: paragraphIndex === structureIndex.paragraphs.length - 1,
      bucket_type: bucketType,
      has_image_evidence: imageEvidence.has_image_evidence,
      image_count: imageEvidence.image_count,
      is_image_dominant: imageEvidence.is_image_dominant,
      run_node_ids: [...paragraph.runNodeIds],
      run_styles: runStyles
    } satisfies TemplateParagraphContext;
  });

  const observationSummary: TemplateObservationSummary = {
    document_meta: input.observation.document_meta,
    paragraph_count: structureIndex.paragraphs.length,
    classifiable_paragraphs: paragraphContexts.map((paragraph) => ({
      paragraph_id: paragraph.paragraph_id,
      text_excerpt: truncateText(paragraph.text, 120),
      role: paragraph.role,
      heading_level: paragraph.heading_level,
      list_level: paragraph.list_level,
      style_name: paragraph.style_name,
      in_table: paragraph.in_table,
      paragraph_index: paragraph.paragraph_index,
      is_first_paragraph: paragraph.is_first_paragraph,
      is_last_paragraph: paragraph.is_last_paragraph,
      bucket_type: paragraph.bucket_type,
      has_image_evidence: paragraph.has_image_evidence,
      image_count: paragraph.image_count,
      is_image_dominant: paragraph.is_image_dominant
    })),
    evidence_summary: buildEvidenceSummary(input.observation, structureIndex.paragraphs, paragraphImageEvidence)
  };

  return {
    docxPath: input.docxPath,
    observation: input.observation,
    document,
    structureIndex,
    observationSummary,
    classificationInput: {
      template_id: "",
      paragraphs: paragraphContexts,
      evidence_summary: observationSummary.evidence_summary,
      document_meta: input.observation.document_meta
    }
  };
}

function buildEvidenceSummary(
  observation: PythonDocxObservationState,
  paragraphs: Array<{
    id: string;
    text: string;
    styleName?: string;
  }>,
  paragraphImageEvidence: Map<
    string,
    {
      image_count: number;
      has_image_evidence: boolean;
      is_image_dominant: boolean;
    }
  >
): TemplateEvidenceSummary {
  const style_name_counts: Record<string, number> = {};
  for (const paragraph of paragraphs) {
    if (!paragraph.styleName) {
      continue;
    }
    style_name_counts[paragraph.styleName] = (style_name_counts[paragraph.styleName] ?? 0) + 1;
  }

  return {
    table_count: observation.document_meta.total_tables,
    image_count: countImages(observation.nodes),
    image_paragraph_count: paragraphs.filter(
      (paragraph) => paragraphImageEvidence.get(paragraph.id)?.has_image_evidence === true
    ).length,
    image_dominant_paragraph_count: paragraphs.filter(
      (paragraph) => paragraphImageEvidence.get(paragraph.id)?.is_image_dominant === true
    ).length,
    numbering_patterns: Array.from(
      new Set(
        paragraphs
          .map((paragraph) => detectNumberingPattern(paragraph.text))
          .filter((pattern): pattern is string => Boolean(pattern))
      )
    ),
    style_name_counts,
    seal_detection: {
      supported: false,
      detected: false,
      reason: "current observation cannot stably detect seal objects and positions"
    }
  };
}

function countImages(nodes: unknown[]): number {
  let count = 0;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.node_type === "image") {
      count += 1;
    }
    Object.values(record).forEach(visit);
  };

  nodes.forEach(visit);
  return count;
}

function detectNumberingPattern(text: string): string | undefined {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }
  const patterns = [/^[一二三四五六七八九十]+、/, /^（[一二三四五六七八九十]+）/, /^\d+\./, /^\(\d+\)/];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return undefined;
}

function buildParagraphImageEvidence(
  nodes: PythonDocxObservationState["nodes"]
): Map<
  string,
  {
    image_count: number;
    has_image_evidence: boolean;
    is_image_dominant: boolean;
  }
> {
  const evidence = new Map<
    string,
    {
      image_count: number;
      has_image_evidence: boolean;
      is_image_dominant: boolean;
    }
  >();

  const visitParagraph = (
    paragraph: {
      id?: string;
      children?: Array<{
        node_type: string;
      }>;
    }
  ): void => {
    const paragraphId = typeof paragraph.id === "string" ? paragraph.id.trim() : "";
    if (!paragraphId) {
      return;
    }
    const children = Array.isArray(paragraph.children) ? paragraph.children : [];
    const imageCount = children.filter((child) => child?.node_type === "image").length;
    const textRunCount = children.filter((child) => child?.node_type === "text_run").length;
    evidence.set(paragraphId, {
      image_count: imageCount,
      has_image_evidence: imageCount > 0,
      is_image_dominant: imageCount > 0 && textRunCount === 0
    });
  };

  const visitTable = (
    table: {
      rows?: Array<{
        cells?: Array<{
          paragraphs?: Array<{
            id?: string;
            children?: Array<{
              node_type: string;
            }>;
          }>;
          tables?: Array<unknown>;
        }>;
      }>;
    }
  ): void => {
    for (const row of table.rows ?? []) {
      for (const cell of row.cells ?? []) {
        for (const paragraph of cell.paragraphs ?? []) {
          visitParagraph(paragraph);
        }
        for (const nestedTable of cell.tables ?? []) {
          if (nestedTable && typeof nestedTable === "object") {
            visitTable(nestedTable as Parameters<typeof visitTable>[0]);
          }
        }
      }
    }
  };

  for (const node of nodes) {
    if (node.node_type === "paragraph") {
      visitParagraph(node);
      continue;
    }
    if (node.node_type === "table") {
      visitTable(node);
    }
  }

  return evidence;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function resolveParagraphBucketType(role: string | undefined, inTable: boolean): TemplateParagraphBucketType {
  if (inTable) {
    return "table_text";
  }
  switch (role) {
    case "heading":
      return "heading";
    case "title":
      return "title";
    case "list_item":
      return "list_item";
    case "body":
      return "body";
    case "table_text":
      return "table_text";
    default:
      return "unknown";
  }
}
