import type { ParsedDocumentBundle } from "../contracts/document-contracts.js";
import type { DocxPatchTarget } from "../document-core/docx-observation-schema.js";
import type { SelectorTargetAnalysis, WriteTargetSpec } from "./contracts.js";
import { buildTemplateProjection } from "../projections/build-template-projection.js";
import { resolveSemanticSelector } from "./semantic-targeting.js";
import { readPatchTargets, unique } from "./utils.js";

export function analyzeWriteTarget(
  bundle: ParsedDocumentBundle,
  target: WriteTargetSpec,
  payload: Record<string, unknown> = {}
): SelectorTargetAnalysis {
  switch (target.kind) {
    case "selector":
      return analyzeSelectorTarget(bundle, target.selector);
    case "semantic_selector":
      return analyzeSemanticTarget(bundle, target.semantic, payload);
    case "node_ids":
      return analyzeNodeTargets(bundle, target.node_ids);
    case "patch_targets":
      return analyzePatchTargets(bundle, target.patch_target_ids, target.patch_part_paths);
  }
}

function analyzeSemanticTarget(
  bundle: ParsedDocumentBundle,
  semantic: Extract<WriteTargetSpec, { kind: "semantic_selector" }>["semantic"],
  payload: Record<string, unknown>
): SelectorTargetAnalysis {
  const projection = buildTemplateProjection(bundle, { localContextWindow: 2, includeSemanticFeatures: true });
  const resolution = resolveSemanticSelector(bundle, projection, semantic, payload);
  const paragraphs = resolution.semantic_target_paragraph_ids
    .map((paragraphId) => bundle.structure_index.paragraphMap[paragraphId])
    .filter((paragraph): paragraph is ParsedDocumentBundle["structure_index"]["paragraphs"][number] => Boolean(paragraph));
  const paragraphAnalysis = buildParagraphAnalysis(paragraphs, []);
  return {
    ...paragraphAnalysis,
    semantic_selector: semantic,
    semantic_target_paragraph_ids: resolution.semantic_target_paragraph_ids,
    semantic_scores: resolution.semantic_scores,
    semantic_low_confidence_reasons: resolution.low_confidence_reasons,
    semantic_ambiguity_reasons: resolution.ambiguity_reasons,
    body_baseline_source_paragraph_ids: resolution.body_baseline?.source_paragraph_ids,
    body_baseline_fields: resolution.body_baseline?.fields as Record<string, unknown> | undefined,
    body_baseline_unstable_fields: resolution.body_baseline?.unstable_fields,
    body_baseline_underdetermined: resolution.low_confidence_reasons?.some((reason) => /baseline/i.test(reason)) ?? false,
    applied_fields: resolution.alignment_plan?.applied_fields,
    ...(resolution.alignment_plan
      ? {
          patch_target_ids: resolution.alignment_plan.target_paragraph_ids.flatMap((paragraphId) => {
            const paragraph = bundle.structure_index.paragraphMap[paragraphId];
            return (paragraph?.runIds ?? []).map((runId) => `target:inline:${runId}`);
          }),
          target_node_ids: resolution.alignment_plan.target_paragraph_ids.flatMap((paragraphId) => {
            const paragraph = bundle.structure_index.paragraphMap[paragraphId];
            return paragraph?.runIds ?? [];
          }),
          patch_part_paths: unique(
            resolution.alignment_plan.target_paragraph_ids.map(
              (paragraphId) => bundle.structure_index.paragraphMap[paragraphId]?.partPath ?? "word/document.xml"
            )
          )
        }
      : {})
  };
}

function analyzeSelectorTarget(
  bundle: ParsedDocumentBundle,
  selector: NonNullable<Extract<WriteTargetSpec, { kind: "selector" }>["selector"]>
): SelectorTargetAnalysis {
  if (selector.scope === "all_text") {
    const targetNodeIds = unique(bundle.structure_index.paragraphs.flatMap((paragraph) => paragraph.runIds));
    return {
      ...emptyTargetAnalysis(),
      target_node_ids: targetNodeIds,
      patch_target_ids: targetNodeIds.map((targetNodeId) => `target:inline:${targetNodeId}`),
      patch_part_paths: unique(
        bundle.structure_index.paragraphs
          .filter((paragraph) => paragraph.runIds.some((runId) => targetNodeIds.includes(runId)))
          .map((paragraph) => paragraph.partPath ?? "word/document.xml")
      )
    };
  }

  const paragraphById = bundle.structure_index.paragraphMap;
  let paragraphs = bundle.structure_index.paragraphs.filter(() => false);
  let missingParagraphIds: string[] = [];

  switch (selector.scope) {
    case "body":
      paragraphs = bundle.structure_index.paragraphs.filter((paragraph) => paragraph.role === "body");
      break;
    case "heading":
      paragraphs = bundle.structure_index.paragraphs.filter(
        (paragraph) =>
          paragraph.role === "heading" &&
          (selector.headingLevel === undefined || paragraph.headingLevel === selector.headingLevel)
      );
      break;
    case "list_item":
      paragraphs = bundle.structure_index.paragraphs.filter((paragraph) => paragraph.role === "list_item");
      break;
    case "paragraph_ids": {
      const paragraphIds = unique(selector.paragraphIds ?? []);
      paragraphs = paragraphIds
        .map((paragraphId) => paragraphById[paragraphId])
        .filter((paragraph): paragraph is ParsedDocumentBundle["structure_index"]["paragraphs"][number] => Boolean(paragraph));
      missingParagraphIds = paragraphIds.filter((paragraphId) => !paragraphById[paragraphId]);
      break;
    }
    default:
      break;
  }

  return buildParagraphAnalysis(paragraphs, missingParagraphIds);
}

function analyzeNodeTargets(bundle: ParsedDocumentBundle, nodeIds: string[]): SelectorTargetAnalysis {
  const normalizedNodeIds = unique(nodeIds.map((nodeId) => nodeId.trim()).filter(Boolean));
  const paragraphsByNodeId = buildParagraphByNodeIdIndex(bundle);
  const targetNodeIds = normalizedNodeIds.filter((nodeId) => paragraphsByNodeId.has(nodeId));
  const matchedParagraphIds = unique(
    targetNodeIds.map((targetNodeId) => paragraphsByNodeId.get(targetNodeId)?.id).filter((value): value is string => Boolean(value))
  );

  return {
    ...emptyTargetAnalysis(),
    matched_paragraph_ids: matchedParagraphIds,
    target_node_ids: targetNodeIds,
    patch_target_ids: targetNodeIds.map((targetNodeId) => `target:inline:${targetNodeId}`),
    patch_part_paths: unique(
      targetNodeIds.map((targetNodeId) => paragraphsByNodeId.get(targetNodeId)?.partPath ?? "word/document.xml")
    ),
    missing_node_ids: normalizedNodeIds.filter((nodeId) => !paragraphsByNodeId.has(nodeId))
  };
}

function analyzePatchTargets(
  bundle: ParsedDocumentBundle,
  patchTargetIds: string[],
  patchPartPaths?: string[]
): SelectorTargetAnalysis {
  const normalizedTargetIds = unique(patchTargetIds.map((targetId) => targetId.trim()).filter(Boolean));
  const patchTargetIndex = new Map(readPatchTargets(bundle).map((target) => [target.id, target] as const));
  return {
    ...emptyTargetAnalysis(),
    patch_target_ids: normalizedTargetIds,
    patch_part_paths: unique([
      ...(patchPartPaths ?? []).map((partPath) => partPath.trim()).filter(Boolean),
      ...normalizedTargetIds
        .map((targetId) => patchTargetIndex.get(targetId)?.part_path ?? inferSyntheticPatchPartPath(bundle, targetId))
        .filter((value): value is string => typeof value === "string" && value.length > 0)
    ]),
    missing_patch_target_ids: normalizedTargetIds.filter(
      (targetId) => !patchTargetIndex.has(targetId) && !isSyntheticStablePatchTarget(targetId)
    )
  };
}

function buildParagraphAnalysis(
  paragraphs: ParsedDocumentBundle["structure_index"]["paragraphs"],
  missingParagraphIds: string[]
): SelectorTargetAnalysis {
  const targetNodeIds = unique(paragraphs.flatMap((paragraph) => paragraph.runIds));
  const unwritableParagraphIds = paragraphs.filter((paragraph) => paragraph.runIds.length === 0).map((paragraph) => paragraph.id);
  return {
    ...emptyTargetAnalysis(),
    matched_paragraph_ids: paragraphs.map((paragraph) => paragraph.id),
    missing_paragraph_ids: missingParagraphIds,
    unwritable_paragraph_ids: unwritableParagraphIds,
    skipped_paragraph_ids: [...unwritableParagraphIds],
    ...(unwritableParagraphIds.length > 0 ? { skip_reason: "no_writable_runs" as const } : {}),
    target_node_ids: targetNodeIds,
    patch_target_ids: targetNodeIds.map((targetNodeId) => `target:inline:${targetNodeId}`),
    patch_part_paths: unique(paragraphs.map((paragraph) => paragraph.partPath ?? "word/document.xml"))
  };
}

function buildParagraphByNodeIdIndex(
  bundle: ParsedDocumentBundle
): Map<string, ParsedDocumentBundle["structure_index"]["paragraphs"][number]> {
  const index = new Map<string, ParsedDocumentBundle["structure_index"]["paragraphs"][number]>();
  for (const paragraph of bundle.structure_index.paragraphs) {
    for (const runId of paragraph.runIds) {
      index.set(runId, paragraph);
    }
  }
  return index;
}

function emptyTargetAnalysis(): SelectorTargetAnalysis {
  return {
    matched_paragraph_ids: [],
    missing_paragraph_ids: [],
    unwritable_paragraph_ids: [],
    skipped_paragraph_ids: [],
    target_node_ids: [],
    patch_target_ids: [],
    patch_part_paths: [],
    missing_node_ids: [],
    missing_patch_target_ids: []
  };
}

export function buildPatchTargetIndex(bundle: ParsedDocumentBundle): Map<string, DocxPatchTarget> {
  const index = new Map<string, DocxPatchTarget>();
  for (const target of readPatchTargets(bundle)) {
    index.set(target.id, target);
  }
  return index;
}

function isSyntheticStablePatchTarget(targetId: string): boolean {
  return (
    targetId === "target:document:section:0" ||
    targetId.startsWith("target:styles:") ||
    targetId.startsWith("target:numbering:") ||
    targetId.startsWith("target:settings:")
  );
}

function inferSyntheticPatchPartPath(bundle: ParsedDocumentBundle, targetId: string): string | undefined {
  if (targetId === "target:document:section:0") {
    return "word/document.xml";
  }
  if (targetId.startsWith("target:styles:")) {
    return bundle.document_package.parts.find((part) => part.path === "word/styles.xml")?.path ?? "word/styles.xml";
  }
  if (targetId.startsWith("target:numbering:")) {
    return bundle.document_package.parts.find((part) => part.path === "word/numbering.xml")?.path ?? "word/numbering.xml";
  }
  if (targetId.startsWith("target:settings:")) {
    return bundle.document_package.parts.find((part) => part.path === "word/settings.xml")?.path ?? "word/settings.xml";
  }
  return undefined;
}
