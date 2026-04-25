import type { LayoutSemanticRule, TemplateContract } from "./template-contract.js";
import type {
  TemplateClassificationResult,
  TemplateContext,
  TemplateNumberingRuleSource,
  TemplateRunWarning,
  TemplateUnmatchedParagraphDiagnostic,
  TemplateValidationIssue,
  TemplateValidationResult
} from "./types.js";
import { detectTemplateNumberingPrefix } from "./template-numbering.js";

export function validateTemplateClassification(input: {
  template: TemplateContract;
  context: TemplateContext;
  classification: TemplateClassificationResult;
}): TemplateValidationResult {
  if (input.template.validation_policy.enforce_validation !== true) {
    return {
      passed: true,
      issues: []
    };
  }

  const issues: TemplateValidationIssue[] = [];
  const runtimeWarnings: TemplateRunWarning[] = [];
  const matchMap = new Map(input.classification.matches.map((match) => [match.semantic_key, match]));
  const paragraphIndexMap = new Map(
    input.context.structureIndex.paragraphs.map((paragraph, index) => [paragraph.id, index])
  );
  const paragraphContextMap = new Map(
    input.context.classificationInput.paragraphs.map((paragraph) => [paragraph.paragraph_id, paragraph])
  );
  const conflictMap = new Map(input.classification.conflicts.map((conflict) => [conflict.paragraph_id, conflict] as const));
  const minConfidence = input.template.validation_policy.min_confidence;
  const paragraphSemanticMap = buildParagraphSemanticMap(input.classification.matches);

  if (typeof minConfidence === "number") {
    if (
      typeof input.classification.overall_confidence === "number" &&
      input.classification.overall_confidence < minConfidence
    ) {
      issues.push({
        error_code: "confidence_below_threshold",
        message: `overall_confidence ${input.classification.overall_confidence} is below ${minConfidence}`
      });
    }
    for (const match of input.classification.matches) {
      if (typeof match.confidence === "number" && match.confidence < minConfidence) {
        issues.push({
          error_code: "confidence_below_threshold",
          message: `confidence for semantic '${match.semantic_key}' is below ${minConfidence}`,
          semantic_key: match.semantic_key,
          paragraph_ids: match.paragraph_ids
        });
      }
    }
  }

  if (input.template.validation_policy.require_all_required_semantics !== false) {
    for (const semantic of input.template.semantic_blocks.filter((block) => block.required)) {
      if (!matchMap.has(semantic.key)) {
        issues.push({
          error_code: "required_semantic_missing",
          message: `required semantic '${semantic.key}' is missing`,
          semantic_key: semantic.key
        });
      }
    }
  }

  for (const semantic of input.template.semantic_blocks) {
    const match = matchMap.get(semantic.key);
    const paragraphIds = match?.paragraph_ids ?? [];
    if (semantic.multiple === false && paragraphIds.length > 1) {
      issues.push({
        error_code: "single_semantic_multiple_paragraphs",
        message: `semantic '${semantic.key}' allows a single paragraph but matched ${paragraphIds.length}`,
        semantic_key: semantic.key,
        paragraph_ids: paragraphIds
      });
    }
  }

  for (const semanticRule of input.template.layout_rules.semantic_rules) {
    const match = matchMap.get(semanticRule.semantic_key);
    const paragraphIds = match?.paragraph_ids ?? [];
    const occurrence = semanticRule.occurrence;
    if (!occurrence || typeof occurrence !== "object") {
      continue;
    }
    if (typeof occurrence.min_occurs === "number" && paragraphIds.length < occurrence.min_occurs) {
      issues.push({
        error_code: "occurrence_below_min",
        message: `semantic '${semanticRule.semantic_key}' matched ${paragraphIds.length} paragraph(s), below min_occurs ${occurrence.min_occurs}`,
        semantic_key: semanticRule.semantic_key,
        paragraph_ids: paragraphIds
      });
    }
    if (typeof occurrence.max_occurs === "number" && paragraphIds.length > occurrence.max_occurs) {
      issues.push({
        error_code: "occurrence_above_max",
        message: `semantic '${semanticRule.semantic_key}' matched ${paragraphIds.length} paragraph(s), above max_occurs ${occurrence.max_occurs}`,
        semantic_key: semanticRule.semantic_key,
        paragraph_ids: paragraphIds
      });
    }
  }

  for (const semantic of input.template.semantic_blocks) {
    const negativeExamples = readStringList(semantic.negative_examples);
    if (negativeExamples.length === 0) {
      continue;
    }
    const match = matchMap.get(semantic.key);
    for (const paragraphId of match?.paragraph_ids ?? []) {
      const paragraph = paragraphContextMap.get(paragraphId);
      const matchedExample = paragraph
        ? negativeExamples.find((example) => containsText(paragraph.text, example))
        : undefined;
      if (matchedExample) {
        issues.push({
          error_code: "negative_example_match",
          message: `semantic '${semantic.key}' matched paragraph '${paragraphId}' containing negative example '${matchedExample}'`,
          semantic_key: semantic.key,
          paragraph_ids: [paragraphId]
        });
      }
    }
  }

  for (const semanticRule of input.template.layout_rules.semantic_rules) {
    const match = matchMap.get(semanticRule.semantic_key);
    if (!match) {
      continue;
    }
    const styleHints =
      semanticRule.style_hints && typeof semanticRule.style_hints === "object"
        ? (semanticRule.style_hints as Record<string, unknown>)
        : undefined;
    if (styleHints?.allow_empty_text !== true) {
      const textHints = readStringList(semanticRule.text_hints);
      if (textHints.length > 0 && !match.paragraph_ids.some((paragraphId) => {
        const paragraph = paragraphContextMap.get(paragraphId);
        return paragraph ? textHints.some((hint) => containsText(paragraph.text, hint)) : false;
      })) {
        issues.push({
          error_code: "text_hint_missing",
          message: `semantic '${semanticRule.semantic_key}' does not contain any declared text_hints`,
          semantic_key: semanticRule.semantic_key,
          paragraph_ids: match.paragraph_ids
        });
      }
    }

    for (const violation of findPositionHintViolations(
      semanticRule,
      match.paragraph_ids,
      input.context.classificationInput.paragraphs,
      paragraphIndexMap
    )) {
      issues.push(violation);
    }
  }

  const globalNumberingPatterns = readStringList(input.template.layout_rules.global_rules.numbering_patterns);
  const semanticRuleMap = new Map(
    input.template.layout_rules.semantic_rules.map((semanticRule) => [semanticRule.semantic_key, semanticRule] as const)
  );
  for (const match of input.classification.matches) {
    const semanticRule = semanticRuleMap.get(match.semantic_key);
    const semanticNumberingPatterns = readStringList(semanticRule?.numbering_patterns);
    const numberingPatterns = semanticNumberingPatterns.length > 0 ? semanticNumberingPatterns : globalNumberingPatterns;
    const ruleSource: TemplateNumberingRuleSource =
      semanticNumberingPatterns.length > 0 ? "semantic_rule" : "global_rule";
    if (numberingPatterns.length === 0) {
      continue;
    }
    for (const paragraphId of match.paragraph_ids) {
      const paragraph = paragraphContextMap.get(paragraphId);
      if (!paragraph || shouldSkipNumberingValidation(match.semantic_key, semanticRule, paragraph)) {
        continue;
      }
      const numberingPrefix = paragraph ? detectTemplateNumberingPrefix(paragraph.text) : undefined;
      if (!numberingPrefix) {
        continue;
      }
      if (!numberingPatterns.some((pattern) => safePatternTest(pattern, numberingPrefix))) {
        if (match.semantic_key === "body_paragraph") {
          runtimeWarnings.push({
            code: "body_paragraph_suspicious_numbering_prefix",
            message: `Paragraph matched body_paragraph but still starts with numbering prefix '${numberingPrefix}'; output was generated with a warning.`,
            paragraph_ids: [paragraphId],
            diagnostics: {
              semantic_key: match.semantic_key,
              text_excerpt: truncateText(paragraph.text, 120),
              numbering_prefix: numberingPrefix,
              detected_prefix: numberingPrefix,
              warning_kind: "body_paragraph_numbering_prefix"
            }
          });
          continue;
        }
        issues.push({
          error_code: "numbering_pattern_not_allowed",
          message: `paragraph '${paragraphId}' numbering prefix '${numberingPrefix}' is not allowed by template`,
          semantic_key: match.semantic_key,
          paragraph_ids: [paragraphId],
          diagnostics: {
            semantic_key: match.semantic_key,
            numbering_prefix: numberingPrefix,
            rule_source: ruleSource,
            allowed_patterns: numberingPatterns
          }
        });
      }
    }
  }

  for (const semanticRule of input.template.layout_rules.semantic_rules) {
    const match = matchMap.get(semanticRule.semantic_key);
    if (!match) {
      continue;
    }
    const placementRules =
      semanticRule.placement_rules && typeof semanticRule.placement_rules === "object"
        ? (semanticRule.placement_rules as Record<string, unknown>)
        : undefined;
    if (!placementRules) {
      continue;
    }
    for (const violation of findPlacementRuleViolations(
      semanticRule.semantic_key,
      match.paragraph_ids,
      placementRules,
      matchMap,
      paragraphIndexMap
    )) {
      issues.push(violation);
    }
  }

  if (
    input.template.validation_policy.reject_conflicting_matches !== false &&
    input.classification.conflicts.length > 0
  ) {
    for (const conflict of input.classification.conflicts) {
      issues.push({
        error_code: "classification_conflict",
        message: `paragraph '${conflict.paragraph_id}' has conflicting semantic candidates`,
        paragraph_ids: [conflict.paragraph_id]
      });
    }
  }

  const rejectUnmatched =
    input.template.validation_policy.reject_unmatched_when_required !== false &&
    input.template.layout_rules.global_rules.allow_unclassified_paragraphs !== true;
  if (rejectUnmatched && input.classification.unmatched_paragraph_ids.length > 0) {
    const unmatchedDiagnostics = buildUnmatchedParagraphDiagnostics(
      input.classification,
      paragraphContextMap,
      conflictMap
    );
    issues.push({
      error_code: "unclassified_paragraphs_present",
      message: "unmatched paragraphs are not allowed by template policy",
      paragraph_ids: input.classification.unmatched_paragraph_ids,
      diagnostics: {
        unmatched_paragraphs: unmatchedDiagnostics,
        policy: {
          allow_unclassified_paragraphs: input.template.layout_rules.global_rules.allow_unclassified_paragraphs === true,
          reject_unmatched_when_required: input.template.validation_policy.reject_unmatched_when_required !== false
        }
      }
    });
  }

  if (input.template.validation_policy.reject_order_violations !== false) {
    const ordering = input.template.layout_rules.global_rules.ordering ?? [];
    let previousIndex: number | undefined;
    let previousKey: string | undefined;
    for (const semanticKey of ordering) {
      const match = matchMap.get(semanticKey);
      if (!match) {
        continue;
      }
      const currentIndex = Math.min(
        ...match.paragraph_ids.map((paragraphId) => paragraphIndexMap.get(paragraphId) ?? Number.MAX_SAFE_INTEGER)
      );
      if (previousIndex !== undefined && currentIndex < previousIndex) {
        issues.push({
          error_code: "ordering_violation",
          message: `semantic '${semanticKey}' appears before '${previousKey}'`,
          semantic_key: semanticKey,
          paragraph_ids: match.paragraph_ids
        });
      }
      previousIndex = currentIndex;
      previousKey = semanticKey;
    }
  }

  if (input.template.validation_policy.reject_style_violations !== false) {
    for (const semanticRule of input.template.layout_rules.semantic_rules) {
      const match = matchMap.get(semanticRule.semantic_key);
      if (!match) {
        continue;
      }
      for (const paragraphId of match.paragraph_ids) {
        const paragraph = paragraphContextMap.get(paragraphId);
        if (!paragraph) {
          continue;
        }
        const styleViolation = findStyleViolation(
          semanticRule,
          paragraph,
          paragraphSemanticMap.get(paragraphId) ?? new Set<string>()
        );
        if (styleViolation) {
          issues.push({
            error_code: "style_violation",
            message: styleViolation,
            semantic_key: semanticRule.semantic_key,
            paragraph_ids: [paragraphId]
          });
        }
      }
    }
  }

  if (requiresSealEvidence(input.template) && input.context.observationSummary.evidence_summary.seal_detection.supported !== true) {
    issues.push({
      error_code: "evidence_insufficient",
      message: "template requires seal evidence but current observation cannot verify seal presence or position"
    });
  }

  return {
    passed: issues.length === 0,
    issues,
    ...(runtimeWarnings.length > 0 ? { runtime_warnings: runtimeWarnings } : {})
  };
}

function containsText(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase());
}

function findPositionHintViolations(
  semanticRule: LayoutSemanticRule,
  paragraphIds: string[],
  paragraphs: TemplateContext["classificationInput"]["paragraphs"],
  paragraphIndexMap: Map<string, number>
): TemplateValidationIssue[] {
  const hints = readStringList(semanticRule.position_hints);
  if (hints.length === 0 || paragraphIds.length === 0) {
    return [];
  }
  const issues: TemplateValidationIssue[] = [];
  const indices = paragraphIds
    .map((paragraphId) => paragraphIndexMap.get(paragraphId))
    .filter((index): index is number => typeof index === "number");
  if (indices.length === 0) {
    return [];
  }
  if (hints.includes("first_non_blank")) {
    const firstNonBlank = paragraphs.find((paragraph) => paragraph.text.trim().length > 0);
    if (firstNonBlank && !paragraphIds.includes(firstNonBlank.paragraph_id)) {
      issues.push({
        error_code: "position_hint_violation",
        message: `semantic '${semanticRule.semantic_key}' must match the first non-blank paragraph`,
        semantic_key: semanticRule.semantic_key,
        paragraph_ids: paragraphIds
      });
    }
  }
  if (hints.includes("near_top")) {
    const nearTopLimit = Math.max(2, Math.floor(paragraphs.length * 0.2));
    if (Math.min(...indices) >= nearTopLimit) {
      issues.push({
        error_code: "position_hint_violation",
        message: `semantic '${semanticRule.semantic_key}' must appear near the top of the document`,
        semantic_key: semanticRule.semantic_key,
        paragraph_ids: paragraphIds
      });
    }
  }
  if (hints.includes("first_paragraph")) {
    const firstParagraph = paragraphs[0];
    if (firstParagraph && !paragraphIds.includes(firstParagraph.paragraph_id)) {
      issues.push({
        error_code: "position_hint_violation",
        message: `semantic '${semanticRule.semantic_key}' must match the first paragraph`,
        semantic_key: semanticRule.semantic_key,
        paragraph_ids: paragraphIds
      });
    }
  }
  return issues;
}

function safePatternTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return pattern === value;
  }
}

function shouldSkipNumberingValidation(
  semanticKey: string,
  semanticRule: LayoutSemanticRule | undefined,
  paragraph: TemplateContext["classificationInput"]["paragraphs"][number]
): boolean {
  if (!/^heading_level_\d+$/.test(semanticKey) || paragraph.role !== "heading") {
    return false;
  }
  const styleHints =
    semanticRule?.style_hints && typeof semanticRule.style_hints === "object"
      ? (semanticRule.style_hints as Record<string, unknown>)
      : undefined;
  return styleHints?.role === "heading" && typeof styleHints.heading_level === "number";
}

function findPlacementRuleViolations(
  semanticKey: string,
  paragraphIds: string[],
  placementRules: Record<string, unknown>,
  matchMap: Map<string, TemplateClassificationResult["matches"][number]>,
  paragraphIndexMap: Map<string, number>
): TemplateValidationIssue[] {
  const current = paragraphIds
    .map((paragraphId) => paragraphIndexMap.get(paragraphId))
    .filter((index): index is number => typeof index === "number");
  if (current.length === 0) {
    return [];
  }
  const currentFirst = Math.min(...current);
  const currentLast = Math.max(...current);
  const checks = [
    ["before_semantic", (otherFirst: number) => currentLast < otherFirst],
    ["after_semantic", (_otherFirst: number, otherLast: number) => currentFirst > otherLast],
    ["immediately_before_semantic", (otherFirst: number) => currentLast + 1 === otherFirst],
    ["immediately_after_semantic", (_otherFirst: number, otherLast: number) => currentFirst - 1 === otherLast]
  ] as const;
  const issues: TemplateValidationIssue[] = [];
  for (const [field, predicate] of checks) {
    for (const otherSemanticKey of readStringList(placementRules[field])) {
      const otherMatch = matchMap.get(otherSemanticKey);
      if (!otherMatch) {
        continue;
      }
      const otherIndices = otherMatch.paragraph_ids
        .map((paragraphId) => paragraphIndexMap.get(paragraphId))
        .filter((index): index is number => typeof index === "number");
      if (otherIndices.length === 0) {
        continue;
      }
      const otherFirst = Math.min(...otherIndices);
      const otherLast = Math.max(...otherIndices);
      if (!predicate(otherFirst, otherLast)) {
        issues.push({
          error_code: "placement_rule_violation",
          message: `semantic '${semanticKey}' violates placement rule '${field}' relative to '${otherSemanticKey}'`,
          semantic_key: semanticKey,
          paragraph_ids: paragraphIds
        });
      }
    }
  }
  return issues;
}

function findStyleViolation(
  semanticRule: LayoutSemanticRule,
  paragraph: TemplateContext["classificationInput"]["paragraphs"][number],
  matchedSemanticKeys: Set<string>
): string | undefined {
  const styleHints =
    semanticRule.style_hints && typeof semanticRule.style_hints === "object"
      ? (semanticRule.style_hints as Record<string, unknown>)
      : undefined;
  if (!styleHints) {
    return undefined;
  }
  const textIsEmpty = paragraph.text.trim().length === 0;

  if (
    styleHints.allow_empty_text === true &&
    styleHints.require_image !== true &&
    styleHints.image_dominant !== true &&
    (textIsEmpty || paragraph.bucket_type === "unknown")
  ) {
    return undefined;
  }

  if (typeof styleHints.style_name === "string" && paragraph.style_name !== styleHints.style_name) {
    return `paragraph '${paragraph.paragraph_id}' style_name must be '${styleHints.style_name}'`;
  }

  if (styleHints.require_image === true && paragraph.has_image_evidence !== true) {
    return `paragraph '${paragraph.paragraph_id}' must contain image evidence`;
  }

  if (styleHints.image_dominant === true && paragraph.is_image_dominant !== true) {
    return `paragraph '${paragraph.paragraph_id}' must be image-dominant`;
  }

  if (styleHints.allow_empty_text === false && textIsEmpty) {
    return `paragraph '${paragraph.paragraph_id}' must not be empty`;
  }

  if (styleHints.allow_empty_text !== true && textIsEmpty && styleHints.require_image !== true) {
    return `paragraph '${paragraph.paragraph_id}' must not be empty`;
  }

  const roleViolation = findAllowedValueViolation(styleHints.role, paragraph.role, "role", paragraph.paragraph_id);
  if (roleViolation) {
    return roleViolation;
  }

  const preferredRoleViolation = findAllowedValueViolation(
    styleHints.preferred_role,
    paragraph.role,
    "preferred_role",
    paragraph.paragraph_id
  );
  if (preferredRoleViolation) {
    return preferredRoleViolation;
  }

  if (typeof styleHints.in_table === "boolean" && paragraph.in_table !== styleHints.in_table) {
    return `paragraph '${paragraph.paragraph_id}' in_table must be ${styleHints.in_table}`;
  }

  if (styleHints.must_not_be_in_table === true && paragraph.in_table) {
    return `paragraph '${paragraph.paragraph_id}' must not be in table`;
  }

  const bucketViolation = findAllowedValueViolation(
    styleHints.bucket_type,
    paragraph.bucket_type,
    "bucket_type",
    paragraph.paragraph_id
  );
  if (bucketViolation) {
    return bucketViolation;
  }

  const preferredBucketViolation = findAllowedValueViolation(
    styleHints.preferred_bucket_type,
    paragraph.bucket_type,
    "preferred_bucket_type",
    paragraph.paragraph_id
  );
  if (preferredBucketViolation) {
    return preferredBucketViolation;
  }

  if (typeof styleHints.heading_level === "number" && paragraph.heading_level !== styleHints.heading_level) {
    return `paragraph '${paragraph.paragraph_id}' heading_level must be ${styleHints.heading_level}`;
  }

  if (typeof styleHints.list_level === "number" && paragraph.list_level !== styleHints.list_level) {
    return `paragraph '${paragraph.paragraph_id}' list_level must be ${styleHints.list_level}`;
  }

  const forbiddenMatches = readStringList(styleHints.must_not_match);
  const matchedForbiddenSemantic = forbiddenMatches.find(
    (semanticKey) => semanticKey !== semanticRule.semantic_key && matchedSemanticKeys.has(semanticKey)
  );
  if (matchedForbiddenSemantic) {
    return `paragraph '${paragraph.paragraph_id}' must not match semantic '${matchedForbiddenSemantic}'`;
  }
  const matchedForbiddenShape = forbiddenMatches.find((item) => paragraphMatchesStructuralToken(paragraph, item));
  if (matchedForbiddenShape) {
    return `paragraph '${paragraph.paragraph_id}' must not match '${matchedForbiddenShape}'`;
  }

  const primaryStyle = paragraph.run_styles[0] ?? {};
  const comparableKeys = ["font_name", "font_size_pt", "paragraph_alignment", "is_bold"] as const;
  for (const key of comparableKeys) {
    if (styleHints[key] === undefined) {
      continue;
    }
    if (primaryStyle[key] !== styleHints[key]) {
      return `paragraph '${paragraph.paragraph_id}' style hint '${key}' does not match`;
    }
  }

  return undefined;
}

function buildParagraphSemanticMap(
  matches: Array<{
    semantic_key: string;
    paragraph_ids: string[];
  }>
): Map<string, Set<string>> {
  const paragraphSemanticMap = new Map<string, Set<string>>();
  for (const match of matches) {
    for (const paragraphId of match.paragraph_ids) {
      const semanticKeys = paragraphSemanticMap.get(paragraphId) ?? new Set<string>();
      semanticKeys.add(match.semantic_key);
      paragraphSemanticMap.set(paragraphId, semanticKeys);
    }
  }
  return paragraphSemanticMap;
}

function findAllowedValueViolation(
  expected: unknown,
  actual: string | undefined,
  fieldName: string,
  paragraphId: string
): string | undefined {
  if (expected === undefined) {
    return undefined;
  }
  const allowed = readStringList(expected);
  if (allowed.length === 0) {
    return undefined;
  }
  if (!actual || !allowed.includes(actual)) {
    return `paragraph '${paragraphId}' style hint '${fieldName}' must be ${formatAllowedValues(allowed)}`;
  }
  return undefined;
}

function readStringList(input: unknown): string[] {
  if (typeof input === "string" && input.trim()) {
    return [input];
  }
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function formatAllowedValues(values: string[]): string {
  return values.length === 1 ? `'${values[0]}'` : `one of ${values.map((value) => `'${value}'`).join(", ")}`;
}

function paragraphMatchesStructuralToken(
  paragraph: TemplateContext["classificationInput"]["paragraphs"][number],
  token: string
): boolean {
  const headingLevel = token.match(/^heading_level_(\d+)$/);
  if (headingLevel) {
    return paragraph.role === "heading" && paragraph.heading_level === Number(headingLevel[1]);
  }
  const listItemLevel = token.match(/^list_item_level_(\d+)$/);
  if (listItemLevel) {
    return paragraph.role === "list_item" && paragraph.list_level === Number(listItemLevel[1]);
  }
  return token === paragraph.role || token === paragraph.bucket_type;
}

function requiresSealEvidence(template: TemplateContract): boolean {
  return /seal|stamp|印章/i.test(
    JSON.stringify({
      layout_rules: template.layout_rules,
      operation_blocks: template.operation_blocks
    })
  );
}

function buildUnmatchedParagraphDiagnostics(
  classification: TemplateClassificationResult,
  paragraphContextMap: Map<string, TemplateContext["classificationInput"]["paragraphs"][number]>,
  conflictMap: Map<string, TemplateClassificationResult["conflicts"][number]>
): TemplateUnmatchedParagraphDiagnostic[] {
  const storedDiagnostics = new Map(
    (classification.diagnostics?.unmatched_paragraphs ?? []).map((item) => [item.paragraph_id, item] as const)
  );
  return classification.unmatched_paragraph_ids.map((paragraphId) => {
    const existing = storedDiagnostics.get(paragraphId);
    if (existing) {
      return existing;
    }
    const paragraph = paragraphContextMap.get(paragraphId);
    const conflict = conflictMap.get(paragraphId);
    return {
      paragraph_id: paragraphId,
      text_excerpt: truncateText(paragraph?.text ?? "", 120),
      role: paragraph?.role ?? "unknown",
      bucket_type: paragraph?.bucket_type ?? "unknown",
      paragraph_index: paragraph?.paragraph_index ?? -1,
      reason: conflict ? "conflict_excluded" : "no_candidate",
      ...(conflict?.candidate_semantic_keys?.length ? { candidate_semantic_keys: conflict.candidate_semantic_keys } : {}),
      ...(conflict?.reason ? { conflict_reason: conflict.reason } : {}),
      model_reported_unmatched: false
    };
  });
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}
