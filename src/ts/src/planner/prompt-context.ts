import type { DocumentIR } from "../core/types.js";
import { buildEmphasisRunIndex } from "../runtime/document-state.js";

const MAX_PROMPT_PARAGRAPHS = 20;
const MAX_PROMPT_EMPHASIS_ITEMS = 24;

export function sanitizePromptMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }
  const { structureIndex: _structureIndex, docxObservation: _docxObservation, ...rest } = metadata;
  return rest;
}

export function summarizeStructureForPrompt(doc: DocumentIR): Record<string, unknown> {
  const structure = doc.metadata?.structureIndex;
  if (!structure || typeof structure !== "object") {
    return {
      roleCounts: {},
      paragraphSamples: [],
      emphasisIndex: []
    };
  }
  const candidate = structure as {
    roleCounts?: Record<string, unknown>;
    paragraphs?: Array<Record<string, unknown>>;
  };
  return {
    roleCounts: candidate.roleCounts ?? {},
    paragraphSamples: Array.isArray(candidate.paragraphs)
      ? candidate.paragraphs.slice(0, MAX_PROMPT_PARAGRAPHS).map((paragraph) => ({
          id: paragraph.id,
          text: paragraph.text,
          role: paragraph.role,
          headingLevel: paragraph.headingLevel,
          listLevel: paragraph.listLevel,
          runNodeIds: paragraph.runNodeIds
        }))
      : [],
    emphasisIndex: buildEmphasisRunIndex(doc, { maxItems: MAX_PROMPT_EMPHASIS_ITEMS })
  };
}

export function buildSemanticSelectorGuidance(): {
  selectorRules: string[];
  selectorExamples: string[];
} {
  return {
    selectorRules: [
      "Heading 1/2/3 paragraphs must use targetSelector.scope='heading' with headingLevel 1/2/3.",
      "General body text must use targetSelector.scope='body' only when the user clearly means ordinary body paragraphs.",
      "Bulleted/numbered paragraphs are targetSelector.scope='list_item', not body.",
      "If wording such as 正文 could reasonably include both body and list_item, do not guess one scope from ambiguity alone.",
      "摘要、关键词等语义锚点通常属于正文段落，不是新的 DOCX 结构类型。",
      "For 摘要、关键词 and similar anchors, prefer document.structure.emphasisIndex plus paragraphSamples to locate the owning paragraph ids.",
      "When a semantic anchor is matched, output targetSelector.scope='paragraph_ids' and include the matched paragraphIds instead of inventing a new scope."
    ],
    selectorExamples: [
      "If emphasisIndex contains text='摘要' with paragraphId='p_1', color the whole paragraph via targetSelector={scope:'paragraph_ids', paragraphIds:['p_1']}.",
      "If emphasisIndex contains text='关键词' with paragraphId='p_2', color the whole paragraph via targetSelector={scope:'paragraph_ids', paragraphIds:['p_2']}.",
      "For '摘要及关键词段落改为绿色', combine both paragraph ids under targetSelector.scope='paragraph_ids'."
    ]
  };
}
