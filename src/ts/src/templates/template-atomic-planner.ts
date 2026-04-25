import type { TemplateContract } from "./template-contract.js";
import type { TemplateAtomicPlanItem, TemplateClassificationResult } from "./types.js";

export function buildTemplateAtomicPlan(input: {
  template: TemplateContract;
  classification: TemplateClassificationResult;
}): TemplateAtomicPlanItem[] {
  const paragraphIdsBySemantic = new Map(
    input.classification.matches.map((match) => [match.semantic_key, [...match.paragraph_ids]] as const)
  );
  const derivedSemantics = input.template.derived_semantics ?? [];
  const aggregateDerivedSemantics = derivedSemantics.filter((semantic) => readDerivedSemanticMode(semantic) === "aggregate");

  for (const derivedSemantic of derivedSemantics) {
    const derivedParagraphIds = paragraphIdsBySemantic.get(derivedSemantic.key) ?? [];
    if (derivedParagraphIds.length === 0) {
      continue;
    }
    const consumedParagraphIds = new Set(derivedParagraphIds);
    for (const inheritedSemanticKey of derivedSemantic.inherits_from) {
      paragraphIdsBySemantic.set(
        inheritedSemanticKey,
        (paragraphIdsBySemantic.get(inheritedSemanticKey) ?? []).filter(
          (paragraphId) => !consumedParagraphIds.has(paragraphId)
        )
      );
    }
    if (readDerivedSemanticMode(derivedSemantic) !== "refine") {
      continue;
    }
    for (const parentSemantic of aggregateDerivedSemantics) {
      if (parentSemantic.key === derivedSemantic.key || !sharesInheritedAtomicSemantic(parentSemantic, derivedSemantic)) {
        continue;
      }
      paragraphIdsBySemantic.set(
        parentSemantic.key,
        (paragraphIdsBySemantic.get(parentSemantic.key) ?? []).filter(
          (paragraphId) => !consumedParagraphIds.has(paragraphId)
        )
      );
    }
  }

  return [
    ...input.template.operation_blocks.map((block) => ({
      semantic_key: block.semantic_key,
      paragraph_ids: paragraphIdsBySemantic.get(block.semantic_key) ?? [],
      text_style: block.text_style,
      paragraph_style: block.paragraph_style,
      ...(block.language_font_overrides ? { language_font_overrides: block.language_font_overrides } : {}),
      ...(block.relative_spacing ? { relative_spacing: block.relative_spacing } : {}),
      ...(block.placement_rules ? { placement_rules: block.placement_rules } : {})
    })),
    ...derivedSemantics.map((semantic) => ({
      semantic_key: semantic.key,
      paragraph_ids: paragraphIdsBySemantic.get(semantic.key) ?? [],
      text_style: semantic.operation.text_style,
      paragraph_style: semantic.operation.paragraph_style,
      ...(semantic.operation.language_font_overrides
        ? { language_font_overrides: semantic.operation.language_font_overrides }
        : {}),
      ...(semantic.operation.relative_spacing ? { relative_spacing: semantic.operation.relative_spacing } : {}),
      ...(semantic.operation.placement_rules ? { placement_rules: semantic.operation.placement_rules } : {})
    }))
  ]
    .map((block) => {
      const paragraph_ids = block.paragraph_ids;
      if (paragraph_ids.length === 0) {
        return undefined;
      }
      return {
        semantic_key: block.semantic_key,
        paragraph_ids: [...paragraph_ids],
        text_style: block.text_style,
        paragraph_style: block.paragraph_style,
        ...(block.language_font_overrides ? { language_font_overrides: block.language_font_overrides } : {}),
        ...(block.relative_spacing ? { relative_spacing: block.relative_spacing } : {}),
        ...(block.placement_rules ? { placement_rules: block.placement_rules } : {})
      } satisfies TemplateAtomicPlanItem;
    })
    .filter((item): item is TemplateAtomicPlanItem => Boolean(item));
}

function readDerivedSemanticMode(semantic: NonNullable<TemplateContract["derived_semantics"]>[number]): "aggregate" | "refine" {
  return semantic.mode === "refine" ? "refine" : "aggregate";
}

function sharesInheritedAtomicSemantic(
  left: NonNullable<TemplateContract["derived_semantics"]>[number],
  right: NonNullable<TemplateContract["derived_semantics"]>[number]
): boolean {
  const rightParents = new Set(right.inherits_from);
  return left.inherits_from.some((semanticKey) => rightParents.has(semanticKey));
}
