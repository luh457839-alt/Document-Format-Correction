import type { ParsedDocumentBundle, TemplateDocumentProjection } from "../contracts/document-contracts.js";

export type SupportedSemanticSelector = "semantic_heading" | "title_like_paragraphs" | "body_like_paragraphs";
export type SemanticConfidence = "high" | "medium" | "low";

export interface SemanticParagraphScore {
  paragraph_id: string;
  title_score: number;
  body_score?: number;
  matched_signals: string[];
  confidence: SemanticConfidence;
}

export interface TitleLikeCandidateResult {
  high_confidence: SemanticParagraphScore[];
  gray_zone: SemanticParagraphScore[];
  low_confidence: SemanticParagraphScore[];
  diagnostics_summary: {
    total_candidates: number;
    top_signal_counts: Record<string, number>;
  };
}

export interface BodyStyleBaseline {
  source_paragraph_ids: string[];
  fields: Partial<{
    font_name: string;
    font_size_pt: number;
    is_bold: boolean;
    is_italic: boolean;
    paragraph_alignment: string;
    line_spacing: number | { mode: "exact"; pt: number };
  }>;
  unstable_fields?: string[];
}

export interface SemanticStyleAlignmentPlan {
  target_paragraph_ids: string[];
  baseline: BodyStyleBaseline;
  applied_fields: string[];
}

export interface SemanticResolutionResult {
  selector: SupportedSemanticSelector;
  semantic_target_paragraph_ids: string[];
  semantic_scores: SemanticParagraphScore[];
  low_confidence_reasons?: string[];
  ambiguity_reasons?: string[];
  body_baseline?: BodyStyleBaseline;
  alignment_plan?: SemanticStyleAlignmentPlan;
}

interface SemanticPayloadConstraints {
  baseline_from_semantic?: SupportedSemanticSelector;
  sync_fields?: string[];
}

const CONSTRAINED_SYNC_FIELDS = [
  "font_name",
  "font_size_pt",
  "is_bold",
  "is_italic",
  "paragraph_alignment",
  "line_spacing"
] as const;
const BASELINE_FIELDS = ["font_name", "font_size_pt", "is_bold", "is_italic", "paragraph_alignment", "line_spacing"] as const;

export function resolveSemanticSelector(
  bundle: ParsedDocumentBundle,
  projection: TemplateDocumentProjection,
  selector: SupportedSemanticSelector,
  payload: Record<string, unknown>
): SemanticResolutionResult {
  if (selector === "body_like_paragraphs") {
    const baselineCandidates = readBodyLikeParagraphIds(projection, []);
    return {
      selector,
      semantic_target_paragraph_ids: baselineCandidates,
      semantic_scores: baselineCandidates.map((paragraphId) => ({
        paragraph_id: paragraphId,
        title_score: 0,
        body_score: 1,
        matched_signals: ["body_baseline_candidate"],
        confidence: "high"
      }))
    };
  }

  if (selector === "semantic_heading") {
    const headingParagraphIds = projection.paragraphs
      .filter((paragraph) => paragraph.role === "heading" || paragraph.headingLevel !== undefined)
      .map((paragraph) => paragraph.paragraphId);
    if (headingParagraphIds.length > 0) {
      return resolveSemanticAlignmentFromTargetIds(projection, selector, headingParagraphIds, payload, {
        high_confidence: headingParagraphIds.map((paragraphId) => ({
          paragraph_id: paragraphId,
          title_score: 10,
          body_score: 0,
          matched_signals: ["explicit_heading_level", "structural_heading"],
          confidence: "high" as const
        })),
        gray_zone: [],
        low_confidence: [],
        diagnostics_summary: {
          total_candidates: headingParagraphIds.length,
          top_signal_counts: {
            explicit_heading_level: headingParagraphIds.length,
            structural_heading: headingParagraphIds.length
          }
        }
      });
    }
  }

  const candidates = identifyTitleLikeCandidates(projection);
  return resolveSemanticAlignmentFromCandidates(projection, selector, candidates, payload);
}

function resolveSemanticAlignmentFromCandidates(
  projection: TemplateDocumentProjection,
  selector: SupportedSemanticSelector,
  candidates: TitleLikeCandidateResult,
  payload: Record<string, unknown>
): SemanticResolutionResult {
  const constraints = normalizeConstraints(payload);
  const highConfidence = candidates.high_confidence;
  const mediumConfidence = candidates.gray_zone;

  if (highConfidence.length === 0) {
    return {
      selector,
      semantic_target_paragraph_ids: [],
      semantic_scores: [...highConfidence, ...mediumConfidence, ...candidates.low_confidence],
      low_confidence_reasons: ["No high-confidence title-like paragraph was found."]
    };
  }

  const structurallyAnchored = highConfidence.filter((candidate) =>
    candidate.matched_signals.includes("numbering_pattern") || candidate.matched_signals.includes("explicit_heading_level")
  );
  if (highConfidence.length > 1 && structurallyAnchored.length === 0) {
    return {
      selector,
      semantic_target_paragraph_ids: highConfidence.map((candidate) => candidate.paragraph_id),
      semantic_scores: [...highConfidence, ...mediumConfidence, ...candidates.low_confidence],
      ambiguity_reasons: ["Multiple high-confidence title-like paragraphs were found."]
    };
  }

  const targetParagraphIds =
    structurallyAnchored.length > 0
      ? structurallyAnchored.map((candidate) => candidate.paragraph_id)
      : [highConfidence[0]?.paragraph_id].filter((value): value is string => Boolean(value));
  return resolveSemanticAlignmentFromTargetIds(
    projection,
    selector,
    targetParagraphIds,
    payload,
    {
      high_confidence: highConfidence,
      gray_zone: mediumConfidence,
      low_confidence: candidates.low_confidence,
      diagnostics_summary: candidates.diagnostics_summary
    }
  );
}

function resolveSemanticAlignmentFromTargetIds(
  projection: TemplateDocumentProjection,
  selector: SupportedSemanticSelector,
  targetParagraphIds: string[],
  payload: Record<string, unknown>,
  candidates: TitleLikeCandidateResult
): SemanticResolutionResult {
  const constraints = normalizeConstraints(payload);
  const baselineSourceParagraphIds = readBodyLikeParagraphIds(projection, targetParagraphIds);
  const baseline = deriveBodyStyleBaseline(projection, baselineSourceParagraphIds);
  if (!baseline) {
    return {
      selector,
      semantic_target_paragraph_ids: targetParagraphIds,
      semantic_scores: [...candidates.high_confidence, ...candidates.gray_zone, ...candidates.low_confidence],
      low_confidence_reasons: ["Body style baseline could not be determined."],
      body_baseline: {
        source_paragraph_ids: baselineSourceParagraphIds,
        fields: {}
      }
    };
  }

  const appliedFields = constrainAppliedFields(constraints.sync_fields);
  const missingAppliedFields = appliedFields.filter((field) => baseline.fields[field as keyof typeof baseline.fields] === undefined);
  return {
    selector,
    semantic_target_paragraph_ids: targetParagraphIds,
    semantic_scores: [...candidates.high_confidence, ...candidates.gray_zone, ...candidates.low_confidence],
    ...(missingAppliedFields.length > 0
      ? {
          low_confidence_reasons: [
            `Body style baseline is missing required fields: ${missingAppliedFields.join(", ")}.`
          ]
        }
      : {}),
    body_baseline: baseline,
    alignment_plan: {
      target_paragraph_ids: targetParagraphIds,
      baseline,
      applied_fields: appliedFields
    }
  };
}

export function identifyTitleLikeCandidates(projection: TemplateDocumentProjection): TitleLikeCandidateResult {
  const scores = projection.paragraphs.map((paragraph, index) => {
    const matchedSignals: string[] = [];
    let titleScore = 0;

    if (paragraph.headingLevel !== undefined) {
      titleScore += 2;
      matchedSignals.push("explicit_heading_level");
    }
    if (paragraph.numberingPattern) {
      titleScore += 2;
      matchedSignals.push("numbering_pattern");
    }
    if (paragraph.isShortText) {
      titleScore += 2;
      matchedSignals.push("short_text");
    }
    if (paragraph.visualSignals.isStandaloneLine) {
      titleScore += 1;
      matchedSignals.push("standalone_line");
    }
    if (paragraph.visualSignals.isCentered) {
      titleScore += 2;
      matchedSignals.push("centered");
    }
    if (paragraph.visualSignals.isBold) {
      titleScore += 1;
      matchedSignals.push("bold");
    }
    if (paragraph.visualSignals.hasLargerFont) {
      titleScore += 2;
      matchedSignals.push("larger_font");
    }
    if (index <= 2) {
      titleScore += 1;
      matchedSignals.push("early_position");
    }
    if (index === 0 && paragraph.visualSignals.isCentered && paragraph.visualSignals.hasLargerFont && !paragraph.numberingPattern) {
      titleScore -= 3;
      matchedSignals.push("cover_style_like");
    }
    const next = projection.paragraphs[index + 1];
    if (next && next.bucketType === "body" && next.text.trim().length >= 10) {
      titleScore += 2;
      matchedSignals.push("followed_by_body_block");
    }
    if (paragraph.text.trim().endsWith("。")) {
      titleScore -= 2;
    }
    if (paragraph.bucketType === "list_item" || paragraph.inTable || paragraph.isImageDominant) {
      titleScore -= 3;
    }

    const confidence: SemanticConfidence =
      titleScore >= 7 ? "high" : titleScore >= 5 ? "medium" : "low";

    return {
      paragraph_id: paragraph.paragraphId,
      title_score: titleScore,
      body_score: paragraph.bucketType === "body" ? 1 : 0,
      matched_signals: matchedSignals,
      confidence
    } satisfies SemanticParagraphScore;
  });

  return {
    high_confidence: scores.filter((score) => score.confidence === "high"),
    gray_zone: scores.filter((score) => score.confidence === "medium"),
    low_confidence: scores.filter((score) => score.confidence === "low"),
    diagnostics_summary: {
      total_candidates: scores.length,
      top_signal_counts: scores.reduce<Record<string, number>>((counts, score) => {
        for (const signal of score.matched_signals) {
          counts[signal] = (counts[signal] ?? 0) + 1;
        }
        return counts;
      }, {})
    }
  };
}

export function deriveBodyStyleBaseline(
  projection: TemplateDocumentProjection,
  paragraphIds: string[]
): BodyStyleBaseline | undefined {
  const paragraphs = projection.paragraphs.filter((paragraph) => paragraphIds.includes(paragraph.paragraphId));
  const eligible = paragraphs.filter((paragraph) => {
    if (paragraph.isImageDominant || paragraph.inTable || paragraph.bucketType === "list_item") {
      return false;
    }
    if (paragraph.visualSignals.isCentered || paragraph.visualSignals.isBold || paragraph.visualSignals.hasLargerFont) {
      return false;
    }
    return paragraph.bucketType === "body" && paragraph.text.trim().length > 0;
  });

  if (eligible.length === 0) {
    return undefined;
  }

  const fields: BodyStyleBaseline["fields"] = {};
  const unstableFields: string[] = [];
  for (const field of BASELINE_FIELDS) {
    const values = eligible
      .map((paragraph) => readProjectedField(paragraph, field))
      .filter((value) => value !== undefined);
    if (values.length === 0) {
      continue;
    }
    const dominant = resolveMode(values);
    if (dominant === undefined) {
      unstableFields.push(field);
      continue;
    }
    fields[field] = dominant as never;
  }

  if (!fields.font_name || !fields.font_size_pt) {
    return undefined;
  }

  if (unstableFields.includes("font_name") || unstableFields.includes("font_size_pt")) {
    return undefined;
  }

  return {
    source_paragraph_ids: eligible.map((paragraph) => paragraph.paragraphId),
    fields,
    ...(unstableFields.length > 0 ? { unstable_fields: unstableFields } : {})
  };
}

function readBodyLikeParagraphIds(projection: TemplateDocumentProjection, excludedParagraphIds: string[]): string[] {
  const excluded = new Set(excludedParagraphIds);
  return projection.paragraphs
    .filter((paragraph) => !excluded.has(paragraph.paragraphId))
    .filter((paragraph) => paragraph.bucketType === "body")
    .map((paragraph) => paragraph.paragraphId);
}

function normalizeConstraints(payload: Record<string, unknown>): SemanticPayloadConstraints {
  const baselineFromSemantic =
    payload.baseline_from_semantic === "body_like_paragraphs" ? "body_like_paragraphs" : undefined;
  const syncFields = Array.isArray(payload.sync_fields)
    ? payload.sync_fields.filter((field): field is string => typeof field === "string")
    : undefined;
  return {
    baseline_from_semantic: baselineFromSemantic,
    sync_fields: syncFields
  };
}

function constrainAppliedFields(syncFields: string[] | undefined): string[] {
  const requested = syncFields?.length ? syncFields : ["font_name", "font_size_pt", "is_bold", "is_italic"];
  return requested.filter(
    (field): field is string => CONSTRAINED_SYNC_FIELDS.includes(field as (typeof CONSTRAINED_SYNC_FIELDS)[number])
  );
}

function readProjectedField(
  paragraph: TemplateDocumentProjection["paragraphs"][number],
  field: (typeof BASELINE_FIELDS)[number]
): unknown {
  switch (field) {
    case "font_name":
      return paragraph.runStyleSummary.fontName;
    case "font_size_pt":
      return paragraph.runStyleSummary.fontSizePt;
    case "is_bold":
      return paragraph.runStyleSummary.isBold;
    case "is_italic":
      return paragraph.runStyleSummary.isItalic;
    case "paragraph_alignment":
      return paragraph.runStyleSummary.paragraphAlignment;
    case "line_spacing":
      return paragraph.runStyleSummary.lineSpacing;
    default:
      return undefined;
  }
}

function resolveMode(values: unknown[]): unknown {
  const counts = new Map<string, { value: unknown; count: number }>();
  for (const value of values) {
    const key = JSON.stringify(value);
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(key, { value, count: 1 });
    }
  }
  const ranked = Array.from(counts.values()).sort((left, right) => right.count - left.count);
  if (ranked.length === 0) {
    return undefined;
  }
  if (ranked.length > 1 && ranked[0].count === ranked[1].count) {
    return undefined;
  }
  return ranked[0].value;
}
