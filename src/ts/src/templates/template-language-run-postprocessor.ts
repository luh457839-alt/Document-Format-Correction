import type { DocumentIR, Operation } from "../core/types.js";
import type { DocumentStructureIndex } from "../runtime/document-state.js";
import type { TemplateAtomicPlanItem } from "./types.js";

type LanguageKind = "zh" | "en" | "unknown";
type BaseCharKind = "zh" | "en" | "punct" | "other";

const HAN_RE = /\p{Script=Han}/u;
const LATIN_OR_DIGIT_RE = /[\p{Script=Latin}\p{Nd}]/u;
const PUNCT_RE = /\p{P}/u;

export function applyTemplateLanguageRunPostprocessing(input: {
  executionPlan: TemplateAtomicPlanItem[];
  document: DocumentIR;
  structureIndex: DocumentStructureIndex;
}): {
  document: DocumentIR;
  structureIndex: DocumentStructureIndex;
  operations: Operation[];
} {
  const structureIndex = cloneStructureIndex(input.structureIndex);
  const document: DocumentIR = {
    ...input.document,
    nodes: input.document.nodes.map((node) => ({
      ...node,
      ...(node.style ? { style: { ...node.style } } : {})
    })),
    metadata: {
      ...(input.document.metadata ?? {}),
      structureIndex
    }
  };

  const nodeMap = new Map(document.nodes.map((node) => [node.id, node] as const));
  const overrideSpecs = input.executionPlan
    .map((item) => ({
      item,
      paragraphIds: normalizeParagraphIds(item.paragraph_ids),
      overrides: readLanguageFontOverrides(item)
    }))
    .filter((item) => item.paragraphIds.length > 0 && item.overrides !== undefined);

  if (overrideSpecs.length === 0) {
    return {
      document,
      structureIndex,
      operations: []
    };
  }

  const processedParagraphIds = new Set<string>();
  for (const spec of overrideSpecs) {
    for (const paragraphId of spec.paragraphIds) {
      if (processedParagraphIds.has(paragraphId)) {
        continue;
      }
      splitParagraphRuns(paragraphId, structureIndex, nodeMap);
      processedParagraphIds.add(paragraphId);
    }
  }

  document.nodes = rebuildNodesInStructureOrder(input.document.nodes, structureIndex, nodeMap);
  const operations = overrideSpecs.flatMap((spec) =>
    buildLanguageFontOverrideOperations(spec.item.semantic_key, spec.paragraphIds, spec.overrides!, structureIndex, nodeMap)
  );

  return {
    document,
    structureIndex,
    operations
  };
}

function splitCharsIntoLanguageSegments(
  chars: string[],
  resolvedKinds: LanguageKind[]
): Array<{ text: string; kind: LanguageKind }> {
  const segments: Array<{ text: string; kind: LanguageKind }> = [];
  chars.forEach((char, index) => {
    const kind = resolvedKinds[index] ?? "unknown";
    const previous = segments[segments.length - 1];
    if (previous && previous.kind === kind) {
      previous.text += char;
      return;
    }
    segments.push({ text: char, kind });
  });
  return segments;
}

function resolveLanguageKinds(baseKinds: BaseCharKind[]): LanguageKind[] {
  const resolved = baseKinds.map<LanguageKind>((kind) => {
    if (kind === "zh" || kind === "en") {
      return kind;
    }
    return "unknown";
  });

  for (let index = 0; index < baseKinds.length; index += 1) {
    if (baseKinds[index] !== "punct") {
      continue;
    }
    let end = index;
    while (end + 1 < baseKinds.length && baseKinds[end + 1] === "punct") {
      end += 1;
    }
    const left = readAdjacentLanguage(baseKinds, index - 1, -1);
    const right = readAdjacentLanguage(baseKinds, end + 1, 1);
    const punctKind = right ?? left ?? "unknown";
    for (let cursor = index; cursor <= end; cursor += 1) {
      resolved[cursor] = punctKind;
    }
    index = end;
  }

  return resolved;
}

function readAdjacentLanguage(baseKinds: BaseCharKind[], start: number, step: -1 | 1): LanguageKind | undefined {
  if (start < 0 || start >= baseKinds.length) {
    return undefined;
  }
  const kind = baseKinds[start];
  if (kind === "zh" || kind === "en") {
    return kind;
  }
  if (kind === "other") {
    return undefined;
  }
  return undefined;
}

function classifyChar(char: string): BaseCharKind {
  if (HAN_RE.test(char)) {
    return "zh";
  }
  if (LATIN_OR_DIGIT_RE.test(char)) {
    return "en";
  }
  if (PUNCT_RE.test(char)) {
    return "punct";
  }
  return "other";
}

function normalizeParagraphIds(paragraphIds: string[]): string[] {
  return Array.from(
    new Set(
      paragraphIds
        .filter((paragraphId): paragraphId is string => typeof paragraphId === "string")
        .map((paragraphId) => paragraphId.trim())
        .filter(Boolean)
    )
  );
}

function cloneStructureIndex(structureIndex: DocumentStructureIndex): DocumentStructureIndex {
  const paragraphs = structureIndex.paragraphs.map((paragraph) => ({
    ...paragraph,
    runNodeIds: [...paragraph.runNodeIds]
  }));
  return {
    paragraphs,
    paragraphMap: Object.fromEntries(paragraphs.map((paragraph) => [paragraph.id, paragraph])),
    roleCounts: { ...structureIndex.roleCounts }
  };
}

function rebuildNodesInStructureOrder(
  originalNodes: DocumentIR["nodes"],
  structureIndex: DocumentStructureIndex,
  nodeMap: Map<string, DocumentIR["nodes"][number]>
): DocumentIR["nodes"] {
  const orderedIds = structureIndex.paragraphs.flatMap((paragraph) => paragraph.runNodeIds);
  const used = new Set(orderedIds);
  const rebuilt = orderedIds
    .map((nodeId) => nodeMap.get(nodeId))
    .filter((node): node is DocumentIR["nodes"][number] => Boolean(node));
  const leftovers = originalNodes.filter((node) => !used.has(node.id) && nodeMap.has(node.id));
  return [...rebuilt, ...leftovers];
}

function readLanguageFontOverrides(
  item: TemplateAtomicPlanItem
): { zh?: { font_name?: string }; en?: { font_name?: string } } | undefined {
  const direct = item as TemplateAtomicPlanItem & {
    language_font_overrides?: { zh?: { font_name?: string }; en?: { font_name?: string } };
  };
  if (direct.language_font_overrides) {
    return direct.language_font_overrides;
  }
  const sourceBlock = item.source_block as
    | (TemplateAtomicPlanItem["source_block"] & {
        language_font_overrides?: { zh?: { font_name?: string }; en?: { font_name?: string } };
      })
    | undefined;
  return sourceBlock?.language_font_overrides;
}

function splitParagraphRuns(
  paragraphId: string,
  structureIndex: DocumentStructureIndex,
  nodeMap: Map<string, DocumentIR["nodes"][number]>
): void {
  const paragraph = structureIndex.paragraphMap[paragraphId];
  if (!paragraph) {
    return;
  }

  const nextRunNodeIds: string[] = [];
  for (const runNodeId of paragraph.runNodeIds) {
    const node = nodeMap.get(runNodeId);
    if (!node) {
      continue;
    }
    const segments = splitNodeByLanguage(node);
    nodeMap.delete(runNodeId);
    for (const segment of segments) {
      nodeMap.set(segment.id, segment);
      nextRunNodeIds.push(segment.id);
    }
  }
  paragraph.runNodeIds = nextRunNodeIds;
  structureIndex.paragraphMap[paragraph.id] = paragraph;
}

function splitNodeByLanguage(node: DocumentIR["nodes"][number]): DocumentIR["nodes"] {
  const chars = [...node.text];
  if (chars.length === 0) {
    return [node];
  }

  const resolvedKinds = resolveLanguageKinds(chars.map(classifyChar));
  const segments = splitCharsIntoLanguageSegments(chars, resolvedKinds);
  if (segments.length <= 1) {
    return [node];
  }

  return segments.map((segment, index) => ({
    ...node,
    id: `${node.id}__seg_${index}`,
    text: segment.text,
    sourceRunId: node.id,
    ...(node.style ? { style: { ...node.style } } : {})
  }));
}

function buildLanguageFontOverrideOperations(
  semanticKey: string,
  paragraphIds: string[],
  overrides: { zh?: { font_name?: string }; en?: { font_name?: string } },
  structureIndex: DocumentStructureIndex,
  nodeMap: Map<string, DocumentIR["nodes"][number]>
): Operation[] {
  const operations: Operation[] = [];

  for (const kind of ["zh", "en"] as const) {
    const fontName = overrides[kind]?.font_name?.trim();
    if (!fontName) {
      continue;
    }

    const targetNodeIds: string[] = [];
    for (const paragraphId of paragraphIds) {
      const paragraph = structureIndex.paragraphMap[paragraphId];
      if (!paragraph) {
        continue;
      }
      for (const runNodeId of paragraph.runNodeIds) {
        const node = nodeMap.get(runNodeId);
        if (!node || detectSingleLanguage(node.text) !== kind) {
          continue;
        }
        targetNodeIds.push(runNodeId);
      }
    }

    if (targetNodeIds.length === 0) {
      continue;
    }

    operations.push({
      id: `${semanticKey}:language_font:${kind}`,
      type: "set_font",
      targetNodeIds,
      patchTargetIds: targetNodeIds.map((targetNodeId) => `target:inline:${targetNodeId}`),
      payload: {
        font_name: fontName
      }
    });
  }

  return operations;
}

function detectSingleLanguage(text: string): LanguageKind | undefined {
  const chars = [...text];
  if (chars.length === 0) {
    return undefined;
  }
  const kinds = Array.from(new Set(resolveLanguageKinds(chars.map(classifyChar)).filter((kind) => kind !== "unknown")));
  return kinds.length === 1 ? kinds[0] : undefined;
}
