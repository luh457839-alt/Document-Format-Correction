import type { TemplateContract, TemplatePatchOperation, TemplatePatchSelector } from "./template-contract.js";
import type { TemplateAtomicPlanItem, TemplateClassificationResult } from "./types.js";

type LegacyOperationBlockLike = {
  semantic_key: string;
  text_style?: Record<string, unknown>;
  paragraph_style?: Record<string, unknown>;
  relative_spacing?: Record<string, unknown>;
  language_font_overrides?: Record<string, unknown>;
};

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

  const patchBlocks =
    Array.isArray(input.template.operation_blocks) && input.template.operation_blocks.length > 0
      ? (input.template.operation_blocks as LegacyOperationBlockLike[]).map((block) => {
          const patchBlock = {
            semantic_key: block.semantic_key,
            selector: {
              part: "document",
              scope: "paragraph"
            } satisfies TemplatePatchSelector,
            operations: buildLegacyBlockOperations(block)
          };
          return {
            block: patchBlock,
            sourceBlock: {
              ...block,
              ...patchBlock,
              ...(block.language_font_overrides ? { language_font_overrides: block.language_font_overrides } : {})
            }
          };
        })
      : (input.template.patch_blocks ?? []).map((block) => ({
          block,
          sourceBlock: block
        }));

  return [
    ...patchBlocks.map(({ block, sourceBlock }) => ({
      semantic_key: block.semantic_key,
      paragraph_ids: paragraphIdsBySemantic.get(block.semantic_key) ?? [],
      selector: resolvePatchSelector(block.selector, paragraphIdsBySemantic.get(block.semantic_key) ?? []),
      operations: block.operations,
      source_block: sourceBlock
    })),
    ...derivedSemantics.map((semantic) => ({
      semantic_key: semantic.key,
      paragraph_ids: paragraphIdsBySemantic.get(semantic.key) ?? [],
      selector: resolvePatchSelector(
        {
          part: "document",
          scope: "paragraph"
        },
        paragraphIdsBySemantic.get(semantic.key) ?? []
      ),
      operations: buildDerivedSemanticPatchOperations(semantic.operation),
      source_block: undefined
    }))
  ].filter((item): item is TemplateAtomicPlanItem => {
    if (item.operations.length === 0) {
      return false;
    }
    const selectorParagraphs = item.selector.match?.paragraph_ids ?? [];
    return item.paragraph_ids.length > 0 || selectorParagraphs.length > 0 || hasNonParagraphSelector(item.selector);
  });
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

function resolvePatchSelector(selector: TemplatePatchSelector, paragraphIds: readonly string[]): TemplatePatchSelector {
  const normalizedParagraphIds = Array.from(new Set(paragraphIds.filter(Boolean)));
  const match = selector.match ? { ...selector.match } : undefined;
  if (!match?.paragraph_ids?.length && normalizedParagraphIds.length > 0 && (selector.scope === "paragraph" || selector.scope === "run")) {
    return {
      ...selector,
      match: {
        ...(match ?? {}),
        paragraph_ids: normalizedParagraphIds
      }
    };
  }
  return {
    ...selector,
    ...(match ? { match } : {})
  };
}

function buildDerivedSemanticPatchOperations(
  operation: NonNullable<TemplateContract["derived_semantics"]>[number]["operation"]
): TemplatePatchOperation[] {
  const operations: TemplatePatchOperation[] = [];
  if (Object.keys(operation.paragraph_style ?? {}).length > 0) {
    operations.push({
      type: "set_paragraph_style",
      paragraph_style: operation.paragraph_style
    });
  }
  if (Object.keys(operation.text_style ?? {}).length > 0) {
    operations.push({
      type: "set_run_style",
      text_style: operation.text_style
    });
  }
  if (Object.keys(operation.relative_spacing ?? {}).length > 0) {
    const spacing = operation.relative_spacing as Record<string, unknown>;
    if (spacing.before_pt !== undefined) {
      operations.push({
        type: "set_paragraph_style",
        paragraph_style: {
          space_before_pt: spacing.before_pt
        }
      });
    }
    if (spacing.after_pt !== undefined) {
      operations.push({
        type: "set_paragraph_style",
        paragraph_style: {
          space_after_pt: spacing.after_pt
        }
      });
    }
  }
  return operations;
}

function hasNonParagraphSelector(selector: TemplatePatchSelector): boolean {
  return selector.scope === "section" || selector.scope === "style" || selector.scope === "numbering_level" || selector.scope === "settings_node";
}

function buildLegacyBlockOperations(block: LegacyOperationBlockLike): TemplatePatchOperation[] {
  const operations: TemplatePatchOperation[] = [];
  if (Object.keys(block.paragraph_style ?? {}).length > 0) {
    operations.push({
      type: "set_paragraph_style",
      paragraph_style: block.paragraph_style
    });
  }
  if (Object.keys(block.text_style ?? {}).length > 0) {
    operations.push({
      type: "set_run_style",
      text_style: block.text_style
    });
  }
  if ((block.relative_spacing ?? {}).before_pt !== undefined) {
    operations.push({
      type: "set_paragraph_style",
      paragraph_style: { space_before_pt: (block.relative_spacing ?? {}).before_pt }
    });
  }
  if ((block.relative_spacing ?? {}).after_pt !== undefined) {
    operations.push({
      type: "set_paragraph_style",
      paragraph_style: { space_after_pt: (block.relative_spacing ?? {}).after_pt }
    });
  }
  return operations;
}
