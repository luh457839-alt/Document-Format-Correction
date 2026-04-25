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
  const operations: Operation[] = [];

  for (const item of input.executionPlan) {
    const overrides = item.language_font_overrides;
    if (!overrides?.zh?.font_name && !overrides?.en?.font_name) {
      continue;
    }

    const targetIdsByLanguage: Record<"zh" | "en", string[]> = {
      zh: [],
      en: []
    };

    for (const paragraphId of normalizeParagraphIds(item.paragraph_ids)) {
      const paragraph = structureIndex.paragraphMap[paragraphId];
      if (!paragraph || paragraph.runNodeIds.length === 0) {
        continue;
      }

      const originalRunIds = [...paragraph.runNodeIds];
      const originalNodes = originalRunIds
        .map((runId) => nodeMap.get(runId))
        .filter((node): node is NonNullable<typeof node> => Boolean(node));
      const paragraphKinds = resolveLanguageKinds(
        originalNodes.flatMap((node) => Array.from(String(node.text ?? "")).map((char) => classifyChar(char)))
      );
      const nextRunIds: string[] = [];
      let paragraphOffset = 0;
      for (const node of originalNodes) {
        const chars = Array.from(String(node.text ?? ""));
        const runKinds = paragraphKinds.slice(paragraphOffset, paragraphOffset + chars.length);
        paragraphOffset += chars.length;
        const segments = splitCharsIntoLanguageSegments(chars, runKinds);
        if (segments.length === 1 && segments[0]?.text === node.text) {
          nextRunIds.push(node.id);
          if (segments[0].kind !== "unknown" && overrides[segments[0].kind]?.font_name) {
            targetIdsByLanguage[segments[0].kind].push(node.id);
          }
          continue;
        }

        const sourceRunId = node.sourceRunId ?? node.id;
        segments.forEach((segment, segmentIndex) => {
          const nextId = `${sourceRunId}__seg_${segmentIndex}`;
          const nextNode = {
            ...node,
            id: nextId,
            text: segment.text,
            sourceRunId
          };
          nodeMap.set(nextId, nextNode);
          nextRunIds.push(nextId);
          if (segment.kind !== "unknown" && overrides[segment.kind]?.font_name) {
            targetIdsByLanguage[segment.kind].push(nextId);
          }
        });
        nodeMap.delete(node.id);
      }

      paragraph.runNodeIds = nextRunIds;
      paragraph.text = nextRunIds.map((runId) => nodeMap.get(runId)?.text ?? "").join("");
    }

    if (overrides.zh?.font_name && targetIdsByLanguage.zh.length > 0) {
      operations.push({
        id: `${item.semantic_key}:language_font:zh`,
        type: "set_font",
        targetNodeIds: [...targetIdsByLanguage.zh],
        payload: {
          font_name: overrides.zh.font_name
        }
      });
    }
    if (overrides.en?.font_name && targetIdsByLanguage.en.length > 0) {
      operations.push({
        id: `${item.semantic_key}:language_font:en`,
        type: "set_font",
        targetNodeIds: [...targetIdsByLanguage.en],
        payload: {
          font_name: overrides.en.font_name
        }
      });
    }
  }

  document.nodes = rebuildNodesInStructureOrder(document.nodes, structureIndex, nodeMap);
  document.metadata = {
    ...(document.metadata ?? {}),
    structureIndex
  };
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
