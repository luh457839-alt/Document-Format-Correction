import { AgentError } from "../core/errors.js";
import type {
  ChatDocumentProjection,
  ChatProjectionDegradationStep,
  ChatProjectionOptions,
  ParsedDocumentBundle
} from "../contracts/document-contracts.js";

const DEFAULT_EMPHASIS_LIMIT = 24;
const DEFAULT_NEIGHBOR_WINDOW = 1;
const DEFAULT_BACKGROUND_PREVIEW = 80;
const DEFAULT_BACKGROUND_PREVIEW_MIN = 16;
const DEFAULT_NODE_PREVIEW = 120;
const DEFAULT_NODE_PREVIEW_MIN = 0;

export function buildChatProjection(
  bundle: ParsedDocumentBundle,
  options: ChatProjectionOptions = {}
): ChatDocumentProjection {
  assertParagraphOrder(bundle, "E_CHAT_PROJECTION_ORDER_MISMATCH");

  const regex = readFocusRegex(options.focusRegexProbe);
  const hitIndexes = findRegexHitIndexes(bundle, regex);
  const paragraphIds = bundle.structure_index.paragraphs.map((paragraph) => paragraph.id);
  const nodeIds = bundle.structure_index.paragraphs.map((paragraph) => paragraph.id);
  if (paragraphIds.length > 0 && nodeIds.length === 0) {
    throw new AgentError({
      code: "E_CHAT_PROJECTION_TRACEABILITY_LOST",
      message: "chat projection lost traceable target ids",
      retryable: false
    });
  }

  let neighborWindow = options.neighborWindow ?? DEFAULT_NEIGHBOR_WINDOW;
  const minNeighborWindow = options.minNeighborWindow ?? 0;
  let emphasisLimit = Math.max(0, options.emphasisLimit ?? DEFAULT_EMPHASIS_LIMIT);
  let backgroundPreviewLength = options.backgroundPreviewLength ?? DEFAULT_BACKGROUND_PREVIEW;
  const minBackgroundPreviewLength = options.minBackgroundPreviewLength ?? DEFAULT_BACKGROUND_PREVIEW_MIN;
  let nodePreviewLength = options.nodePreviewLength ?? DEFAULT_NODE_PREVIEW;
  const minNodePreviewLength = options.minNodePreviewLength ?? DEFAULT_NODE_PREVIEW_MIN;
  const degradationSteps: ChatProjectionDegradationStep[] = [];

  let projection = materializeProjection(
    bundle,
    regex,
    hitIndexes,
    neighborWindow,
    emphasisLimit,
    backgroundPreviewLength,
    nodePreviewLength
  );
  let estimatedChars = estimateChatProjectionChars(projection);

  if (options.textBudget !== undefined) {
    while (estimatedChars > options.textBudget && backgroundPreviewLength > minBackgroundPreviewLength) {
      backgroundPreviewLength = Math.max(minBackgroundPreviewLength, Math.floor(backgroundPreviewLength / 2));
      projection = materializeProjection(bundle, regex, hitIndexes, neighborWindow, emphasisLimit, backgroundPreviewLength, nodePreviewLength);
      estimatedChars = estimateChatProjectionChars(projection);
      if (!degradationSteps.includes("compress_background_text")) {
        degradationSteps.push("compress_background_text");
      }
    }

    while (estimatedChars > options.textBudget && neighborWindow > minNeighborWindow) {
      neighborWindow -= 1;
      projection = materializeProjection(bundle, regex, hitIndexes, neighborWindow, emphasisLimit, backgroundPreviewLength, nodePreviewLength);
      estimatedChars = estimateChatProjectionChars(projection);
      if (!degradationSteps.includes("shrink_neighbor_window")) {
        degradationSteps.push("shrink_neighbor_window");
      }
    }

    while (estimatedChars > options.textBudget && emphasisLimit > 0) {
      emphasisLimit = Math.max(0, Math.floor(emphasisLimit / 2));
      projection = materializeProjection(bundle, regex, hitIndexes, neighborWindow, emphasisLimit, backgroundPreviewLength, nodePreviewLength);
      estimatedChars = estimateChatProjectionChars(projection);
      if (!degradationSteps.includes("truncate_emphasis_runs")) {
        degradationSteps.push("truncate_emphasis_runs");
      }
    }

    while (estimatedChars > options.textBudget && nodePreviewLength > minNodePreviewLength) {
      nodePreviewLength = nodePreviewLength === 0 ? 0 : Math.max(minNodePreviewLength, Math.floor(nodePreviewLength / 2));
      projection = materializeProjection(bundle, regex, hitIndexes, neighborWindow, emphasisLimit, backgroundPreviewLength, nodePreviewLength);
      estimatedChars = estimateChatProjectionChars(projection);
      if (!degradationSteps.includes("shrink_node_text")) {
        degradationSteps.push("shrink_node_text");
      }
      if (nodePreviewLength === minNodePreviewLength) {
        break;
      }
    }
  }

  if (options.textBudget !== undefined && estimatedChars > options.textBudget) {
    throw new AgentError({
      code: "E_CHAT_PROJECTION_BUDGET_EXCEEDED",
      message: `E_CHAT_PROJECTION_BUDGET_EXCEEDED: chat projection could not fit within budget ${options.textBudget}`,
      retryable: false
    });
  }

  return {
    ...projection,
    traceability: {
      paragraphIds,
      nodeIds
    },
    diagnostics: {
      ...(options.focusRegexProbe ? { focusRegexProbe: options.focusRegexProbe } : {}),
      estimatedChars,
      ...(options.textBudget !== undefined ? { textBudget: options.textBudget } : {}),
      budgetStatus: "fit",
      degradationSteps
    }
  };
}

function materializeProjection(
  bundle: ParsedDocumentBundle,
  regex: RegExp | undefined,
  hitIndexes: Set<number>,
  neighborWindow: number,
  emphasisLimit: number,
  backgroundPreviewLength: number,
  nodePreviewLength: number
): Omit<ChatDocumentProjection, "traceability" | "diagnostics"> {
  const paragraphByRunId = new Map<string, (typeof bundle.structure_index.paragraphs)[number]>();
  for (const paragraph of bundle.structure_index.paragraphs) {
    for (const runId of paragraph.runIds) {
      paragraphByRunId.set(runId, paragraph);
    }
  }

  const paragraphs = bundle.structure_index.paragraphs.map((paragraph, index) => {
    const focusPriority = resolveFocusPriority(index, regex, hitIndexes, neighborWindow);
    return {
      paragraphId: paragraph.id,
      text: focusPriority === "background" ? truncate(paragraph.text, backgroundPreviewLength) : paragraph.text,
      role: paragraph.role,
      headingLevel: paragraph.headingLevel,
      listLevel: paragraph.listLevel,
      inTable: paragraph.inTable,
      ...(focusPriority ? { focusPriority } : {})
    };
  });

  const nodes = bundle.structure_index.paragraphs.map((paragraph) => ({
    id: paragraph.id,
    nodeType: "paragraph" as const,
    text: truncate(paragraph.text, nodePreviewLength),
    role: paragraph.role
  }));

  const emphasisRuns = bundle.document_ast.inlineNodes
    .filter((node) => node.nodeType === "text" && node.text && node.style)
    .map((node) => {
      const parent = paragraphByRunId.get(node.id);
      if (!parent || !node.style) {
        return undefined;
      }
      const highlightColor = node.style.highlightColor;
      const emphasisFlags = {
        isBold: node.style.isBold === true,
        isItalic: node.style.isItalic === true,
        isUnderline: node.style.isUnderline === true,
        highlightColor: highlightColor && highlightColor !== "none" ? highlightColor : undefined
      };
      if (!emphasisFlags.isBold && !emphasisFlags.isItalic && !emphasisFlags.isUnderline && !emphasisFlags.highlightColor) {
        return undefined;
      }
      return {
        runId: node.id,
        text: node.text ?? "",
        paragraphId: parent.id,
        paragraphTextPreview: truncate(parent.text, 80),
        emphasisFlags
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .slice(0, emphasisLimit);

  return {
    kind: "chat",
    paragraphs,
    nodes,
    emphasisRuns
  };
}

function resolveFocusPriority(
  index: number,
  regex: RegExp | undefined,
  hitIndexes: Set<number>,
  neighborWindow: number
): "regex_hit" | "regex_neighbor" | "background" | undefined {
  if (!regex) {
    return undefined;
  }
  if (hitIndexes.has(index)) {
    return "regex_hit";
  }
  for (let offset = 1; offset <= neighborWindow; offset += 1) {
    if (hitIndexes.has(index - offset) || hitIndexes.has(index + offset)) {
      return "regex_neighbor";
    }
  }
  return "background";
}

function estimateChatProjectionChars(projection: Omit<ChatDocumentProjection, "traceability" | "diagnostics">): number {
  return (
    projection.paragraphs.reduce((total, paragraph) => total + Math.ceil(paragraph.text.length / 4) + 8, 0) +
    projection.nodes.reduce((total, node) => total + Math.ceil(node.text.length / 6) + 4, 0) +
    projection.emphasisRuns.reduce((total, run) => total + Math.ceil(run.text.length / 6) + 6, 0)
  );
}

function findRegexHitIndexes(bundle: ParsedDocumentBundle, regex: RegExp | undefined): Set<number> {
  const hitIndexes = new Set<number>();
  if (!regex) {
    return hitIndexes;
  }
  bundle.structure_index.paragraphs.forEach((paragraph, index) => {
    if (regex.test(paragraph.text)) {
      hitIndexes.add(index);
    }
  });
  return hitIndexes;
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

function truncate(value: string, max: number): string {
  const normalized = value.trim();
  if (max <= 0) {
    return "";
  }
  if (normalized.length <= max) {
    return normalized;
  }
  if (max <= 3) {
    return normalized.slice(0, max);
  }
  return `${normalized.slice(0, max - 3)}...`;
}

function readFocusRegex(value: string | undefined): RegExp | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    return new RegExp(value, "u");
  } catch {
    return undefined;
  }
}
