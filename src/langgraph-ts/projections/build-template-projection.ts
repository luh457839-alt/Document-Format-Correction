import { AgentError } from "../core/errors.js";
import type {
  ParsedDocumentBundle,
  TemplateDocumentProjection,
  TemplateParagraphBucketType,
  TemplateProjectionBatch,
  TemplateProjectionDegradationStep,
  TemplateProjectionOptions,
  TemplateProjectionParagraph
} from "../contracts/document-contracts.js";

const DEFAULT_LOCAL_CONTEXT_WINDOW = 1;
const DEFAULT_BACKGROUND_PREVIEW = 64;
const DEFAULT_BACKGROUND_PREVIEW_MIN = 24;

export function buildTemplateProjection(
  bundle: ParsedDocumentBundle,
  options: TemplateProjectionOptions = {}
): TemplateDocumentProjection {
  assertParagraphOrder(bundle, "E_TEMPLATE_PROJECTION_ORDER_MISMATCH");

  const includeSemanticFeatures = options.includeSemanticFeatures ?? true;
  let localContextWindow = options.localContextWindow ?? DEFAULT_LOCAL_CONTEXT_WINDOW;
  const minLocalContextWindow = options.minLocalContextWindow ?? 0;
  let backgroundPreviewLength = options.backgroundPreviewLength ?? DEFAULT_BACKGROUND_PREVIEW;
  const minBackgroundPreviewLength = options.minBackgroundPreviewLength ?? DEFAULT_BACKGROUND_PREVIEW_MIN;
  const degradationSteps: TemplateProjectionDegradationStep[] = [];

  const imageEvidence = buildParagraphImageEvidence(bundle.document_ast.nodes);
  const paragraphStyleSummary = new Map(
    bundle.structure_index.paragraphs.map((paragraph) => [paragraph.id, summarizeParagraphStyle(bundle, paragraph.id)] as const)
  );
  const dominantFontSize = resolveDominantFontSize(Array.from(paragraphStyleSummary.values()));

  let paragraphs = materializeParagraphs(
    bundle,
    imageEvidence,
    paragraphStyleSummary,
    dominantFontSize,
    localContextWindow,
    backgroundPreviewLength,
    includeSemanticFeatures
  );
  let batches = buildBatches(paragraphs, options.maxBatchBudget);
  let estimatedChars = estimateTemplateProjectionChars(paragraphs, batches);

  if (options.textBudget !== undefined || options.maxBatchBudget !== undefined) {
    while (shouldShrinkLocalContext(estimatedChars, batches, options) && localContextWindow > minLocalContextWindow) {
      localContextWindow -= 1;
      paragraphs = materializeParagraphs(
        bundle,
        imageEvidence,
        paragraphStyleSummary,
        dominantFontSize,
        localContextWindow,
        backgroundPreviewLength,
        includeSemanticFeatures
      );
      batches = buildBatches(paragraphs, options.maxBatchBudget);
      estimatedChars = estimateTemplateProjectionChars(paragraphs, batches);
      if (!degradationSteps.includes("shrink_local_context_window")) {
        degradationSteps.push("shrink_local_context_window");
      }
    }

    while (shouldMergeBackground(estimatedChars, batches, options) && backgroundPreviewLength > minBackgroundPreviewLength) {
      backgroundPreviewLength = Math.max(minBackgroundPreviewLength, Math.floor(backgroundPreviewLength / 2));
      paragraphs = materializeParagraphs(
        bundle,
        imageEvidence,
        paragraphStyleSummary,
        dominantFontSize,
        localContextWindow,
        backgroundPreviewLength,
        includeSemanticFeatures
      );
      batches = buildBatches(paragraphs, options.maxBatchBudget);
      estimatedChars = estimateTemplateProjectionChars(paragraphs, batches);
      if (!degradationSteps.includes("merge_background_paragraphs")) {
        degradationSteps.push("merge_background_paragraphs");
      }
    }

    if (options.maxBatchBudget !== undefined && batches.length > 1 && !degradationSteps.includes("split_batches")) {
      degradationSteps.push("split_batches");
    }
  }

  validateTemplateProjectionBudgets(paragraphs, batches, options);

  const styleNameCounts: Record<string, number> = {};
  for (const paragraph of bundle.structure_index.paragraphs) {
    if (!paragraph.styleName) {
      continue;
    }
    styleNameCounts[paragraph.styleName] = (styleNameCounts[paragraph.styleName] ?? 0) + 1;
  }

  return {
    kind: "template",
    paragraphs,
    batches,
    evidenceSummary: {
      tableCount: bundle.document_ast.documentMeta.totalTables,
      imageCount: countImages(bundle.document_ast.nodes),
      imageParagraphCount: paragraphs.filter((item) => item.hasImageEvidence).length,
      imageDominantParagraphCount: paragraphs.filter((item) => item.isImageDominant).length,
      numberingPatterns: Array.from(
        new Set(
          [
            ...bundle.structure_index.paragraphs
              .map((paragraph) => detectNumberingPattern(paragraph.text))
              .filter((value): value is string => Boolean(value)),
            ...bundle.document_ast.numbering.instances.flatMap((instance) =>
              instance.levels
                .map((level) => normalizeLevelTextPattern(level.lvlText))
                .filter((value): value is string => Boolean(value))
            )
          ]
        )
      ),
      styleNameCounts
    },
    diagnostics: {
      kind: "template",
      estimatedChars,
      ...(options.textBudget !== undefined ? { textBudget: options.textBudget } : {}),
      ...(options.maxBatchBudget !== undefined ? { maxBatchBudget: options.maxBatchBudget } : {}),
      budgetStatus: "fit",
      degradationSteps,
      batchCount: batches.length,
      localContextWindow,
      paragraphCount: paragraphs.length
    }
  };
}

function materializeParagraphs(
  bundle: ParsedDocumentBundle,
  imageEvidence: Map<string, { imageCount: number; hasImageEvidence: boolean; isImageDominant: boolean }>,
  paragraphStyleSummary: Map<
    string,
    {
      fontName?: string;
      fontSizePt?: number;
      isBold?: boolean;
      isItalic?: boolean;
      paragraphAlignment?: string;
      lineSpacing?: number | { mode: "exact"; pt: number };
    }
  >,
  dominantFontSize: number | undefined,
  localContextWindow: number,
  backgroundPreviewLength: number,
  includeSemanticFeatures: boolean
): TemplateProjectionParagraph[] {
  return bundle.structure_index.paragraphs.map((paragraph, index, all) => {
    const evidence = imageEvidence.get(paragraph.id) ?? {
      imageCount: 0,
      hasImageEvidence: false,
      isImageDominant: false
    };
    const styleSummary = paragraphStyleSummary.get(paragraph.id) ?? {};
    const bucketType = resolveBucketType(paragraph.role, paragraph.inTable);
    const text = shouldCompactBackgroundParagraph(paragraph, bucketType)
      ? truncate(paragraph.text, backgroundPreviewLength)
      : paragraph.text;
    return {
      paragraphId: paragraph.id,
      text,
      role: paragraph.role,
      headingLevel: paragraph.headingLevel,
      listLevel: paragraph.listLevel,
      styleName: paragraph.styleName,
      inTable: paragraph.inTable,
      paragraphIndex: index,
      bucketType,
      hasImageEvidence: evidence.hasImageEvidence,
      imageCount: evidence.imageCount,
      isImageDominant: evidence.isImageDominant,
      numberingPattern: includeSemanticFeatures ? detectNumberingPattern(paragraph.text) : undefined,
      isShortText: includeSemanticFeatures ? paragraph.text.trim().length > 0 && paragraph.text.trim().length <= 24 : false,
      runStyleSummary: {
        fontName: styleSummary.fontName,
        fontSizePt: styleSummary.fontSizePt,
        isBold: styleSummary.isBold,
        isItalic: styleSummary.isItalic,
        paragraphAlignment: styleSummary.paragraphAlignment,
        lineSpacing: styleSummary.lineSpacing
      },
      visualSignals: {
        isStandaloneLine: paragraph.runIds.length <= 1,
        isCentered: styleSummary.paragraphAlignment === "center",
        isBold: styleSummary.isBold === true,
        hasLargerFont:
          typeof styleSummary.fontSizePt === "number" &&
          typeof dominantFontSize === "number" &&
          styleSummary.fontSizePt > dominantFontSize
      },
      localContext: {
        before: all
          .slice(Math.max(0, index - localContextWindow), index)
          .map((item) => ({
            paragraphId: item.id,
            text: truncate(item.text, backgroundPreviewLength),
            role: item.role,
            bucketType: resolveBucketType(item.role, item.inTable)
          })),
        after: all
          .slice(index + 1, index + 1 + localContextWindow)
          .map((item) => ({
            paragraphId: item.id,
            text: truncate(item.text, backgroundPreviewLength),
            role: item.role,
            bucketType: resolveBucketType(item.role, item.inTable)
          }))
      }
    };
  });
}

function buildBatches(paragraphs: TemplateProjectionParagraph[], maxBatchBudget?: number): TemplateProjectionBatch[] {
  if (paragraphs.length === 0) {
    return [];
  }
  if (maxBatchBudget === undefined) {
    return [makeBatch("template-batch-1", paragraphs)];
  }

  const batches: TemplateProjectionBatch[] = [];
  let current: TemplateProjectionParagraph[] = [];
  let batchIndex = 1;
  for (const paragraph of paragraphs) {
    const paragraphCost = estimateTemplateParagraphChars(paragraph);
    if (paragraphCost > maxBatchBudget) {
      throw new AgentError({
        code: "E_TEMPLATE_PROJECTION_BUDGET_EXCEEDED",
        message: `E_TEMPLATE_PROJECTION_BUDGET_EXCEEDED: template projection paragraph ${paragraph.paragraphId} exceeds batch budget ${maxBatchBudget}`,
        retryable: false
      });
    }
    const next = current.concat([paragraph]);
    const nextCost = next.reduce((total, entry) => total + estimateTemplateParagraphChars(entry), 0);
    if (current.length > 0 && nextCost > maxBatchBudget) {
      batches.push(makeBatch(`template-batch-${batchIndex}`, current));
      batchIndex += 1;
      current = [paragraph];
      continue;
    }
    current = next;
  }
  if (current.length > 0) {
    batches.push(makeBatch(`template-batch-${batchIndex}`, current));
  }
  return batches;
}

function makeBatch(batchId: string, paragraphs: TemplateProjectionParagraph[]): TemplateProjectionBatch {
  return {
    batchId,
    paragraphIds: paragraphs.map((paragraph) => paragraph.paragraphId),
    startParagraphIndex: paragraphs[0]?.paragraphIndex ?? 0,
    endParagraphIndex: paragraphs.at(-1)?.paragraphIndex ?? 0,
    estimatedChars: paragraphs.reduce((total, paragraph) => total + estimateTemplateParagraphChars(paragraph), 0),
    paragraphs
  };
}

function validateTemplateProjectionBudgets(
  paragraphs: TemplateProjectionParagraph[],
  batches: TemplateProjectionBatch[],
  options: TemplateProjectionOptions
): void {
  const estimatedChars = estimateTemplateProjectionChars(paragraphs, batches);
  if (options.textBudget !== undefined && estimatedChars > options.textBudget) {
    throw new AgentError({
      code: "E_TEMPLATE_PROJECTION_BUDGET_EXCEEDED",
      message: `E_TEMPLATE_PROJECTION_BUDGET_EXCEEDED: template projection could not fit within budget ${options.textBudget}`,
      retryable: false
    });
  }
  const maxBatchBudget = options.maxBatchBudget;
  if (maxBatchBudget !== undefined && batches.some((batch) => batch.estimatedChars > maxBatchBudget)) {
    throw new AgentError({
      code: "E_TEMPLATE_PROJECTION_BUDGET_EXCEEDED",
      message: `E_TEMPLATE_PROJECTION_BUDGET_EXCEEDED: template projection batch could not fit within batch budget ${maxBatchBudget}`,
      retryable: false
    });
  }
}

function shouldShrinkLocalContext(
  estimatedChars: number,
  batches: TemplateProjectionBatch[],
  options: TemplateProjectionOptions
): boolean {
  const maxBatchBudget = options.maxBatchBudget;
  return Boolean(
    (options.textBudget !== undefined && estimatedChars > options.textBudget) ||
      (maxBatchBudget !== undefined && batches.some((batch) => batch.estimatedChars > maxBatchBudget))
  );
}

function shouldMergeBackground(
  estimatedChars: number,
  batches: TemplateProjectionBatch[],
  options: TemplateProjectionOptions
): boolean {
  return shouldShrinkLocalContext(estimatedChars, batches, options);
}

function estimateTemplateProjectionChars(paragraphs: TemplateProjectionParagraph[], batches: TemplateProjectionBatch[]): number {
  return paragraphs.reduce((total, paragraph) => total + estimateTemplateParagraphChars(paragraph), 0) + batches.length * 12;
}

function estimateTemplateParagraphChars(paragraph: TemplateProjectionParagraph): number {
  return (
    Math.ceil(paragraph.text.length / 4) +
    Math.ceil((paragraph.numberingPattern?.length ?? 0) / 2) +
    paragraph.localContext.before.reduce((total, entry) => total + Math.ceil(entry.text.length / 6) + 3, 0) +
    paragraph.localContext.after.reduce((total, entry) => total + Math.ceil(entry.text.length / 6) + 3, 0) +
    16
  );
}

function shouldCompactBackgroundParagraph(
  paragraph: ParsedDocumentBundle["structure_index"]["paragraphs"][number],
  bucketType: TemplateParagraphBucketType
): boolean {
  return bucketType === "body" && paragraph.text.trim().length > 32 && !paragraph.inTable;
}

function truncate(value: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length <= max) {
    return normalized;
  }
  if (max <= 3) {
    return normalized.slice(0, max);
  }
  return `${normalized.slice(0, max - 3)}...`;
}

function assertParagraphOrder(bundle: ParsedDocumentBundle, errorCode: string): void {
  const astParagraphIds = bundle.document_ast.blocks
    .filter((block) => block.nodeType === "paragraph" && typeof block.paragraphId === "string")
    .map((block) => block.paragraphId as string);
  const structureParagraphIds = bundle.structure_index.paragraphs.map((paragraph) => paragraph.id);
  if (astParagraphIds.length !== structureParagraphIds.length) {
    throw new AgentError({
      code: errorCode,
      message: "paragraph order does not match document AST",
      retryable: false
    });
  }
  for (let index = 0; index < astParagraphIds.length; index += 1) {
    if (astParagraphIds[index] !== structureParagraphIds[index]) {
      throw new AgentError({
        code: errorCode,
        message: "paragraph order does not match document AST",
        retryable: false
      });
    }
  }
}

function buildParagraphImageEvidence(
  nodes: ParsedDocumentBundle["document_ast"]["nodes"]
): Map<string, { imageCount: number; hasImageEvidence: boolean; isImageDominant: boolean }> {
  const evidence = new Map<string, { imageCount: number; hasImageEvidence: boolean; isImageDominant: boolean }>();
  const visitParagraph = (paragraph: Extract<ParsedDocumentBundle["document_ast"]["nodes"][number], { nodeType: "paragraph" }>): void => {
    const imageCount = paragraph.children.filter((child) => child.nodeType === "image").length;
    const textRunCount = paragraph.children.filter((child) => child.nodeType === "text_run").length;
    evidence.set(paragraph.id, {
      imageCount,
      hasImageEvidence: imageCount > 0,
      isImageDominant: imageCount > 0 && textRunCount === 0
    });
  };
  const visitTable = (table: Extract<ParsedDocumentBundle["document_ast"]["nodes"][number], { nodeType: "table" }>): void => {
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
  for (const node of nodes) {
    if (node.nodeType === "paragraph") {
      visitParagraph(node);
    } else {
      visitTable(node);
    }
  }
  return evidence;
}

function countImages(nodes: ParsedDocumentBundle["document_ast"]["nodes"]): number {
  let count = 0;
  const walk = (node: ParsedDocumentBundle["document_ast"]["nodes"][number]): void => {
    if (node.nodeType === "paragraph") {
      count += node.children.filter((child) => child.nodeType === "image").length;
      return;
    }
    for (const row of node.rows) {
      for (const cell of row.cells) {
        cell.paragraphs.forEach(walk);
        cell.tables.forEach(walk);
      }
    }
  };
  nodes.forEach(walk);
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

function summarizeParagraphStyle(
  bundle: ParsedDocumentBundle,
  paragraphId: string
): {
  fontName?: string;
  fontSizePt?: number;
  isBold?: boolean;
  isItalic?: boolean;
  paragraphAlignment?: string;
  lineSpacing?: number | { mode: "exact"; pt: number };
} {
  const inlineNodes = bundle.document_ast.inlineNodes.filter((node) => node.blockId === paragraphId && node.nodeType === "text");
  const firstStyled = inlineNodes.find((node) => node.style);
  return {
    fontName: firstStyled?.style?.fontName,
    fontSizePt: firstStyled?.style?.fontSizePt,
    isBold: firstStyled?.style?.isBold,
    isItalic: firstStyled?.style?.isItalic,
    paragraphAlignment: firstStyled?.style?.paragraphAlignment,
    lineSpacing: firstStyled?.style?.lineSpacing
  };
}

function resolveDominantFontSize(
  summaries: Array<{
    fontSizePt?: number;
  }>
): number | undefined {
  const counts = new Map<number, number>();
  for (const summary of summaries) {
    if (typeof summary.fontSizePt !== "number") {
      continue;
    }
    counts.set(summary.fontSizePt, (counts.get(summary.fontSizePt) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0];
}

function normalizeLevelTextPattern(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().replace(/%[0-9]+/g, "1");
  return normalized || undefined;
}

function resolveBucketType(role: string | undefined, inTable: boolean): TemplateParagraphBucketType {
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
