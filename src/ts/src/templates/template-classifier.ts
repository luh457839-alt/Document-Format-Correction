import { AgentError } from "../core/errors.js";
import {
  createStructuredModelGateway,
  type StructuredModelGateway
} from "../model-gateway/structured-model-gateway.js";
import type { TemplateContract } from "./template-contract.js";
import type {
  TemplateClassificationDiagnostics,
  TemplateClassificationRefinedParagraphDiagnostic,
  TemplateClassificationResult,
  TemplateContext,
  TemplateIgnoredUnknownSemanticMatch,
  TemplateLlmConfig,
  TemplateParagraphBucketType,
  TemplateParagraphContext,
  TemplateRefinementOutcome,
  TemplateUnmatchedParagraphDiagnostic
} from "./types.js";

const DEFAULT_MAX_BATCH_PARAGRAPHS = 12;
const DEFAULT_MAX_PROMPT_BYTES = 16_000;
const REFINEMENT_CONTEXT_RADIUS = 1;
const BATCH_BUCKET_ORDER: TemplateParagraphBucketType[] = [
  "heading",
  "title",
  "list_item",
  "body",
  "table_text",
  "unknown"
];

export interface TemplateClassificationBatchingOptions {
  maxParagraphsPerBatch?: number;
  maxPromptBytes?: number;
}

export interface TemplateClassifierDeps {
  llm?: TemplateLlmConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  modelGateway?: StructuredModelGateway;
  batchingOptions?: TemplateClassificationBatchingOptions;
}

export interface TemplateClassificationBatch {
  bucket_type: TemplateParagraphBucketType;
  batch_index: number;
  batch_count: number;
  paragraphs: TemplateParagraphContext[];
  paragraph_id_set: string[];
}

export interface TemplateClassificationBatchResult {
  batch: TemplateClassificationBatch;
  result: TemplateClassificationResult;
}

interface TemplateClassificationParseBatchDiagnostics {
  batchType?: string;
  batchIndex?: number;
  batchCount?: number;
}

interface TemplateClassificationParseDiagnostics extends TemplateClassificationParseBatchDiagnostics {
  topLevelType: string;
  topLevelKeys: string;
  matchesType: string;
  allowedParagraphCount: number;
}

export interface TemplateClassificationModelRequest {
  batch: TemplateClassificationBatch;
  messages: Array<{ role: "system" | "user"; content: string }>;
  schemaName: string;
  schema: Record<string, unknown>;
  diagnosticMetadata: {
    promptBytes: number;
    schemaBytes: number;
    paragraphCount: number;
    semanticBlockCount: number;
    batchType: string;
    batchIndex: number;
    batchCount: number;
    batchParagraphCount: number;
  };
}

interface TemplateClassificationRefinementTarget {
  paragraph_id: string;
  candidate_semantic_keys: string[];
  first_pass: TemplateClassificationRefinedParagraphDiagnostic["first_pass"];
}

interface TemplateClassificationRefinementDecision {
  paragraph_id: string;
  semantic_key?: string;
  candidate_semantic_keys?: string[];
  confidence?: number;
  reason?: string;
  unmatched?: boolean;
}

const COVER_IMAGE_REFINEMENT_ALIASES = new Set(["图片段落", "封面图片", "标题图片"]);

interface TemplateClassificationRefinementModelRequest {
  targetParagraphIds: string[];
  messages: Array<{ role: "system" | "user"; content: string }>;
  schemaName: string;
  schema: Record<string, unknown>;
  diagnosticMetadata: TemplateClassificationModelRequest["diagnosticMetadata"];
}

export async function classifyTemplateParagraphs(
  input: {
    template: TemplateContract;
    context: TemplateContext;
    llm?: TemplateLlmConfig;
    requestTimeoutMs?: number;
  },
  deps: TemplateClassifierDeps = {}
): Promise<TemplateClassificationResult> {
  const modelGateway =
    deps.modelGateway ??
    createStructuredModelGateway({
      plannerConfig: deps.llm,
      env: deps.env,
      fetchImpl: deps.fetchImpl
    });
  const classificationRequests = buildTemplateClassificationModelRequests(
    input.template,
    input.context,
    deps.batchingOptions
  );

  const batchResults: TemplateClassificationBatchResult[] = [];
  for (const classificationRequest of classificationRequests) {
    const result = await modelGateway.requestJson(
      {
        messages: classificationRequest.messages,
        requestCode: "E_TEMPLATE_CLASSIFICATION_REQUEST",
        upstreamCode: "E_TEMPLATE_CLASSIFICATION_UPSTREAM",
        responseCode: "E_TEMPLATE_CLASSIFICATION_RESPONSE",
        requestLabel: "Template classification request",
        payloadLabel: "Template classification payload",
        diagnosticStage: "classification_request",
        schemaUnsupportedCode: "E_TEMPLATE_CLASSIFICATION_SCHEMA_UNSUPPORTED",
        schemaName: classificationRequest.schemaName,
        schema: classificationRequest.schema,
        diagnosticMetadata: classificationRequest.diagnosticMetadata,
        requestTimeoutMs: input.requestTimeoutMs,
        timeoutMessages: {
          requestTimeoutCode: "E_TEMPLATE_CLASSIFICATION_REQUEST",
          requestTimeoutMessage: "Template classification request timed out",
          budgetTimeoutCode: "E_TEMPLATE_CLASSIFICATION_REQUEST",
          budgetTimeoutMessage: (timeoutMs) => `Template classification request timed out after ${timeoutMs}ms.`
        },
        parseContent: (content) =>
          parseTemplateClassificationResult({
            template: input.template,
            context: input.context,
            rawContent: content,
            allowedParagraphIds: classificationRequest.batch.paragraph_id_set,
            batchDiagnostics: {
              batchType: classificationRequest.batch.bucket_type,
              batchIndex: classificationRequest.batch.batch_index,
              batchCount: classificationRequest.batch.batch_count
            }
          })
      },
      input.llm ?? deps.llm
    );
    batchResults.push({
      batch: classificationRequest.batch,
      result
    });
  }

  const aggregated = aggregateTemplateClassificationResults({
    template: input.template,
    context: input.context,
    batchResults
  });
  return await refineTemplateClassification(
    {
      template: input.template,
      context: input.context,
      batchResults,
      classification: aggregated,
      llm: input.llm,
      requestTimeoutMs: input.requestTimeoutMs
    },
    {
      ...deps,
      modelGateway
    }
  );
}

export function buildTemplateClassificationModelRequests(
  template: TemplateContract,
  context: TemplateContext,
  options: TemplateClassificationBatchingOptions = {}
): TemplateClassificationModelRequest[] {
  return buildTemplateClassificationBatches(template, context, options).map((batch) =>
    buildTemplateClassificationModelRequestForBatch(template, context, batch)
  );
}

export function buildTemplateClassificationModelRequest(
  template: TemplateContract,
  context: TemplateContext,
  options: TemplateClassificationBatchingOptions = {}
): TemplateClassificationModelRequest {
  const [firstRequest] = buildTemplateClassificationModelRequests(template, context, options);
  return firstRequest;
}

export function buildTemplateClassificationBatches(
  template: TemplateContract,
  context: TemplateContext,
  options: TemplateClassificationBatchingOptions = {}
): TemplateClassificationBatch[] {
  const paragraphs = context.classificationInput.paragraphs;
  if (paragraphs.length === 0) {
    return [
      {
        bucket_type: "unknown",
        batch_index: 1,
        batch_count: 1,
        paragraphs: [],
        paragraph_id_set: []
      }
    ];
  }

  const normalizedOptions = normalizeBatchingOptions(options);
  const paragraphsByBucket = new Map<TemplateParagraphBucketType, TemplateParagraphContext[]>();
  for (const paragraph of paragraphs) {
    const bucketParagraphs = paragraphsByBucket.get(paragraph.bucket_type) ?? [];
    bucketParagraphs.push(paragraph);
    paragraphsByBucket.set(paragraph.bucket_type, bucketParagraphs);
  }

  const batches: TemplateClassificationBatch[] = [];
  for (const bucketType of BATCH_BUCKET_ORDER) {
    const bucketParagraphs = paragraphsByBucket.get(bucketType) ?? [];
    if (bucketParagraphs.length === 0) {
      continue;
    }
    const bucketSegments = splitBucketParagraphs(template, context, bucketType, bucketParagraphs, normalizedOptions);
    const batchCount = bucketSegments.length;
    bucketSegments.forEach((segment, index) => {
      batches.push({
        bucket_type: bucketType,
        batch_index: index + 1,
        batch_count: batchCount,
        paragraphs: segment,
        paragraph_id_set: segment.map((paragraph) => paragraph.paragraph_id)
      });
    });
  }

  return batches;
}

export function aggregateTemplateClassificationResults(input: {
  template: TemplateContract;
  context: TemplateContext;
  batchResults: TemplateClassificationBatchResult[];
}): TemplateClassificationResult {
  const semanticOrder = new Map(input.template.semantic_blocks.map((block, index) => [block.key, index]));
  const paragraphOrder = new Map(
    input.context.structureIndex.paragraphs.map((paragraph, index) => [paragraph.id, index] as const)
  );
  const modelReportedUnmatchedParagraphIds = new Set<string>();
  const paragraphContextMap = new Map(
    input.context.classificationInput.paragraphs.map((paragraph) => [paragraph.paragraph_id, paragraph] as const)
  );
  const paragraphContributions: Array<{
    paragraph_id: string;
    semantic_key: string;
      confidence?: number;
      reason?: string;
  }> = [];
  const ignoredUnknownSemanticMatches: TemplateIgnoredUnknownSemanticMatch[] = [];
  const normalizationNotes: string[] = [];
  const refinedParagraphs: TemplateClassificationRefinedParagraphDiagnostic[] = [];
  let refinementElapsedMs = 0;
  let hasRefinementTiming = false;
  const conflictAggregates = new Map<
    string,
    {
      candidate_semantic_keys: Set<string>;
      reasons: Set<string>;
    }
  >();

  for (const batchResult of input.batchResults) {
    const result = coerceTemplateClassificationResult({
      template: input.template,
      context: input.context,
      classification: {
        template_id: batchResult.result.template_id,
        scope: "paragraph",
        matches: batchResult.result.matches,
        unmatched_paragraph_ids: batchResult.result.unmatched_paragraph_ids,
        conflicts: batchResult.result.conflicts,
        overall_confidence: batchResult.result.overall_confidence
      },
      allowedParagraphIds: batchResult.batch.paragraph_id_set,
      existingDiagnostics: batchResult.result.diagnostics
    });
    for (const ignoredMatch of result.diagnostics?.ignored_unknown_semantic_matches ?? []) {
      ignoredUnknownSemanticMatches.push(ignoredMatch);
    }
    for (const note of result.diagnostics?.normalization_notes ?? []) {
      normalizationNotes.push(note);
    }
    for (const refinedParagraph of result.diagnostics?.refined_paragraphs ?? []) {
      refinedParagraphs.push(refinedParagraph);
    }
    if (typeof result.diagnostics?.refinement_elapsed_ms === "number") {
      hasRefinementTiming = true;
      refinementElapsedMs += result.diagnostics.refinement_elapsed_ms;
    }
    for (const paragraphId of result.unmatched_paragraph_ids) {
      modelReportedUnmatchedParagraphIds.add(paragraphId);
    }
    for (const conflict of result.conflicts) {
      const aggregate = conflictAggregates.get(conflict.paragraph_id) ?? {
        candidate_semantic_keys: new Set<string>(),
        reasons: new Set<string>()
      };
      conflict.candidate_semantic_keys.forEach((semanticKey) => aggregate.candidate_semantic_keys.add(semanticKey));
      if (conflict.reason) {
        aggregate.reasons.add(conflict.reason);
      }
      conflictAggregates.set(conflict.paragraph_id, aggregate);
    }

    for (const match of result.matches) {
      for (const paragraphId of match.paragraph_ids) {
        paragraphContributions.push({
          paragraph_id: paragraphId,
          semantic_key: match.semantic_key,
          confidence: match.confidence,
          reason: match.reason
        });
      }
    }
  }

  const semanticMatches = new Map<
    string,
    {
      paragraph_ids: Set<string>;
      confidenceSum: number;
      confidenceWeight: number;
      reasons: string[];
    }
  >();

  for (const contribution of paragraphContributions) {
    const aggregate = semanticMatches.get(contribution.semantic_key) ?? {
      paragraph_ids: new Set<string>(),
      confidenceSum: 0,
      confidenceWeight: 0,
      reasons: []
    };
    aggregate.paragraph_ids.add(contribution.paragraph_id);
    if (typeof contribution.confidence === "number") {
      aggregate.confidenceSum += contribution.confidence;
      aggregate.confidenceWeight += 1;
    }
    if (contribution.reason && !aggregate.reasons.includes(contribution.reason)) {
      aggregate.reasons.push(contribution.reason);
    }
    semanticMatches.set(contribution.semantic_key, aggregate);
  }

  let matches: TemplateClassificationResult["matches"] = input.template.semantic_blocks
    .map((block) => {
      const aggregate = semanticMatches.get(block.key);
      if (!aggregate || aggregate.paragraph_ids.size === 0) {
        return undefined;
      }
      const orderedParagraphIds = [...aggregate.paragraph_ids].sort(
        (left, right) => (paragraphOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (paragraphOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
      );
      return {
        semantic_key: block.key,
        paragraph_ids: orderedParagraphIds,
        confidence:
          aggregate.confidenceWeight > 0
            ? roundConfidence(aggregate.confidenceSum / aggregate.confidenceWeight)
            : undefined,
        reason: aggregate.reasons.join(" | ")
      };
    })
    .filter((match): match is NonNullable<typeof match> => Boolean(match));

  const conflicts = [...conflictAggregates.keys()]
    .sort((left, right) => (paragraphOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (paragraphOrder.get(right) ?? Number.MAX_SAFE_INTEGER))
    .map((paragraphId) => ({
      paragraph_id: paragraphId,
      candidate_semantic_keys: [...(conflictAggregates.get(paragraphId)?.candidate_semantic_keys ?? [])].sort(
        (left, right) => (semanticOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (semanticOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
      ),
      reason: joinUniqueStrings(conflictAggregates.get(paragraphId)?.reasons)
    }));

  const matchedParagraphIds = new Set(matches.flatMap((match) => match.paragraph_ids));
  let unmatched_paragraph_ids = orderParagraphIds(
    [
      ...new Set([
        ...modelReportedUnmatchedParagraphIds,
        ...input.context.structureIndex.paragraphs
          .map((paragraph) => paragraph.id)
          .filter((paragraphId) => !matchedParagraphIds.has(paragraphId))
      ])
    ],
    paragraphOrder
  );
  ({ matches, unmatched_paragraph_ids } = applyBlankOrUnknownFallback({
    template: input.template,
    context: input.context,
    matches,
    unmatched_paragraph_ids
  }));
  const unmatchedDiagnostics = unmatched_paragraph_ids.map((paragraphId) =>
    buildUnmatchedParagraphDiagnostic({
      paragraphId,
      paragraphContextMap,
      semanticOrder,
      modelReportedUnmatchedParagraphIds
    })
  );

  const totalConfidenceWeight = matches.reduce(
    (sum, match) => sum + (typeof match.confidence === "number" ? match.paragraph_ids.length : 0),
    0
  );
  const totalConfidenceSum = matches.reduce(
    (sum, match) => sum + (typeof match.confidence === "number" ? match.confidence * match.paragraph_ids.length : 0),
    0
  );
  const diagnostics: TemplateClassificationDiagnostics | undefined =
    unmatchedDiagnostics.length > 0 ||
    ignoredUnknownSemanticMatches.length > 0 ||
    normalizationNotes.length > 0 ||
    refinedParagraphs.length > 0 ||
    hasRefinementTiming
      ? {
          ...(unmatchedDiagnostics.length > 0 ? { unmatched_paragraphs: unmatchedDiagnostics } : {}),
          ...(ignoredUnknownSemanticMatches.length > 0
            ? { ignored_unknown_semantic_matches: ignoredUnknownSemanticMatches }
            : {}),
          ...(normalizationNotes.length > 0
            ? { normalization_notes: uniqueStrings(normalizationNotes) }
            : {}),
          ...(refinedParagraphs.length > 0 ? { refined_paragraphs: refinedParagraphs } : {}),
          ...(hasRefinementTiming ? { refinement_elapsed_ms: refinementElapsedMs } : {})
        }
      : undefined;

  return {
    ...applyDerivedSemanticResolution({
      template: input.template,
      context: input.context,
      classification: {
        template_id: input.template.template_meta.id,
        matches,
        unmatched_paragraph_ids,
        conflicts,
        ...(diagnostics ? { diagnostics } : {}),
        overall_confidence:
          totalConfidenceWeight > 0 ? roundConfidence(totalConfidenceSum / totalConfidenceWeight) : undefined
      }
    })
  };
}

export async function refineTemplateClassification(
  input: {
    template: TemplateContract;
    context: TemplateContext;
    batchResults: TemplateClassificationBatchResult[];
    classification: TemplateClassificationResult;
    llm?: TemplateLlmConfig;
    requestTimeoutMs?: number;
  },
  deps: TemplateClassifierDeps = {}
): Promise<TemplateClassificationResult> {
  const targets = buildTemplateClassificationRefinementTargets(input.template, input.context, input.classification);
  if (targets.length === 0) {
    return input.classification;
  }

  const modelGateway =
    deps.modelGateway ??
    createStructuredModelGateway({
      plannerConfig: deps.llm,
      env: deps.env,
      fetchImpl: deps.fetchImpl
    });
  const refinementRequest = buildTemplateClassificationRefinementModelRequest(
    input.template,
    input.context,
    input.classification,
    targets
  );
  const refinementStartedAt = Date.now();
  const decisionsResponse = await modelGateway.requestJson(
    {
      messages: refinementRequest.messages,
      requestCode: "E_TEMPLATE_CLASSIFICATION_REQUEST",
      upstreamCode: "E_TEMPLATE_CLASSIFICATION_UPSTREAM",
      responseCode: "E_TEMPLATE_CLASSIFICATION_RESPONSE",
      requestLabel: "Template classification refinement request",
      payloadLabel: "Template classification refinement payload",
      diagnosticStage: "classification_refinement",
      schemaUnsupportedCode: "E_TEMPLATE_CLASSIFICATION_SCHEMA_UNSUPPORTED",
      schemaName: refinementRequest.schemaName,
      schema: refinementRequest.schema,
      diagnosticMetadata: refinementRequest.diagnosticMetadata,
      requestTimeoutMs: input.requestTimeoutMs,
      timeoutMessages: {
        requestTimeoutCode: "E_TEMPLATE_CLASSIFICATION_REQUEST",
        requestTimeoutMessage: "Template classification refinement request timed out",
        budgetTimeoutCode: "E_TEMPLATE_CLASSIFICATION_REQUEST",
        budgetTimeoutMessage: (timeoutMs) =>
          `Template classification refinement request timed out after ${timeoutMs}ms.`
      },
      parseContent: (content) =>
        parseTemplateClassificationRefinementResult({
          rawContent: content,
          targetParagraphIds: refinementRequest.targetParagraphIds,
          template: input.template
        })
    },
    input.llm ?? deps.llm
  );
  const refinementElapsedMs = Math.max(0, Date.now() - refinementStartedAt);
  const decisions = coerceTemplateClassificationRefinementDecisions(
    decisionsResponse,
    refinementRequest.targetParagraphIds,
    input.template
  );
  const acceptedParagraphIds = new Set<string>();
  const refinementMatches: TemplateClassificationResult["matches"] = [];
  const refinedParagraphs = buildTemplateClassificationRefinementDiagnostics({
    template: input.template,
    targets,
    decisions,
    acceptedParagraphIds,
    refinementMatches
  });

  const refinementBatchResult: TemplateClassificationBatchResult = {
    batch: {
      bucket_type: "unknown",
      batch_index: 1,
      batch_count: 1,
      paragraphs: input.context.classificationInput.paragraphs.filter((paragraph) =>
        refinementRequest.targetParagraphIds.includes(paragraph.paragraph_id)
      ),
      paragraph_id_set: refinementRequest.targetParagraphIds
    },
    result: {
      template_id: input.template.template_meta.id,
      matches: refinementMatches,
      unmatched_paragraph_ids: [],
      conflicts: [],
      diagnostics: {
        refined_paragraphs: refinedParagraphs,
        refinement_elapsed_ms: refinementElapsedMs
      },
      overall_confidence: (() => {
        const confidenceWeight = refinementMatches.reduce(
          (sum, match) => sum + (typeof match.confidence === "number" ? match.paragraph_ids.length : 0),
          0
        );
        if (confidenceWeight === 0) {
          return undefined;
        }
        return roundConfidence(
          refinementMatches.reduce(
            (sum, match) => sum + (typeof match.confidence === "number" ? match.confidence * match.paragraph_ids.length : 0),
            0
          ) / confidenceWeight
        );
      })()
    }
  };

  const batchResults =
    acceptedParagraphIds.size > 0
      ? input.batchResults.map((batchResult) =>
          filterTemplateClassificationBatchResult(batchResult, acceptedParagraphIds)
        )
      : input.batchResults;
  return aggregateTemplateClassificationResults({
    template: input.template,
    context: input.context,
    batchResults: [...batchResults, refinementBatchResult]
  });
}

function buildTemplateClassificationRefinementTargets(
  template: TemplateContract,
  context: TemplateContext,
  classification: TemplateClassificationResult
): TemplateClassificationRefinementTarget[] {
  const paragraphContextMap = new Map(
    context.classificationInput.paragraphs.map((paragraph) => [paragraph.paragraph_id, paragraph] as const)
  );
  const paragraphMatchMap = new Map<
    string,
    {
      semantic_keys: Set<string>;
      confidence?: number;
      reason?: string;
    }
  >();
  const minConfidence = template.validation_policy.min_confidence;
  for (const match of classification.matches) {
    if (typeof minConfidence !== "number" || typeof match.confidence !== "number" || match.confidence >= minConfidence) {
      continue;
    }
    for (const paragraphId of match.paragraph_ids) {
      const aggregate = paragraphMatchMap.get(paragraphId) ?? {
        semantic_keys: new Set<string>()
      };
      aggregate.semantic_keys.add(match.semantic_key);
      if (aggregate.confidence === undefined || match.confidence < aggregate.confidence) {
        aggregate.confidence = match.confidence;
      }
      if (aggregate.reason === undefined && match.reason) {
        aggregate.reason = match.reason;
      }
      paragraphMatchMap.set(paragraphId, aggregate);
    }
  }

  const fallbackSemanticKey = findBlankOrUnknownSemanticKey(template);
  const paragraphOrder = new Map(
    context.structureIndex.paragraphs.map((paragraph, index) => [paragraph.id, index] as const)
  );
  const targets = new Map<string, TemplateClassificationRefinementTarget>();
  for (const [paragraphId, firstPass] of paragraphMatchMap.entries()) {
    const paragraph = paragraphContextMap.get(paragraphId);
    const candidate_semantic_keys = uniqueStrings([
      ...firstPass.semantic_keys,
      ...collectCompatibleSemanticKeys(template, context, paragraph),
      ...(fallbackSemanticKey ? [fallbackSemanticKey] : [])
    ]);
    targets.set(paragraphId, {
      paragraph_id: paragraphId,
      candidate_semantic_keys,
      first_pass: {
        semantic_keys: [...firstPass.semantic_keys],
        ...(firstPass.confidence !== undefined ? { confidence: firstPass.confidence } : {}),
        ...(firstPass.reason ? { reason: firstPass.reason } : {}),
        source: "low_confidence"
      }
    });
  }

  for (const conflict of classification.conflicts) {
    const existing = targets.get(conflict.paragraph_id);
    const paragraph = paragraphContextMap.get(conflict.paragraph_id);
    const candidate_semantic_keys = uniqueStrings([
      ...(existing?.candidate_semantic_keys ?? []),
      ...conflict.candidate_semantic_keys,
      ...collectCompatibleSemanticKeys(template, context, paragraph),
      ...(fallbackSemanticKey ? [fallbackSemanticKey] : [])
    ]);
    targets.set(conflict.paragraph_id, {
      paragraph_id: conflict.paragraph_id,
      candidate_semantic_keys,
      first_pass: {
        ...(existing?.first_pass.semantic_keys ? { semantic_keys: existing.first_pass.semantic_keys } : {}),
        ...(existing?.first_pass.confidence !== undefined ? { confidence: existing.first_pass.confidence } : {}),
        candidate_semantic_keys: conflict.candidate_semantic_keys,
        ...(conflict.reason ? { reason: conflict.reason } : {}),
        source: "conflict"
      }
    });
  }

  return [...targets.values()].sort(
    (left, right) =>
      (paragraphOrder.get(left.paragraph_id) ?? Number.MAX_SAFE_INTEGER) -
      (paragraphOrder.get(right.paragraph_id) ?? Number.MAX_SAFE_INTEGER)
  );
}

function buildTemplateClassificationRefinementDiagnostics(input: {
  template: TemplateContract;
  targets: TemplateClassificationRefinementTarget[];
  decisions: TemplateClassificationRefinementDecision[];
  acceptedParagraphIds: Set<string>;
  refinementMatches: TemplateClassificationResult["matches"];
}): TemplateClassificationRefinedParagraphDiagnostic[] {
  const fallbackSemanticKey = findBlankOrUnknownSemanticKey(input.template);
  const decisionMap = new Map(input.decisions.map((decision) => [decision.paragraph_id, decision] as const));

  return input.targets.map((target) => {
    const decision = decisionMap.get(target.paragraph_id);
    const second_pass: TemplateClassificationRefinedParagraphDiagnostic["second_pass"] = {
      ...(decision?.semantic_key ? { semantic_key: decision.semantic_key } : {}),
      ...(decision?.candidate_semantic_keys !== undefined
        ? { candidate_semantic_keys: decision.candidate_semantic_keys }
        : {}),
      ...(decision?.confidence !== undefined ? { confidence: decision.confidence } : {}),
      ...(decision?.reason ? { reason: decision.reason } : {})
    };
    const outcome = resolveTemplateClassificationRefinementOutcome({
      fallbackSemanticKey,
      minConfidence: input.template.validation_policy.min_confidence,
      target,
      decision
    });
    if (
      decision?.semantic_key &&
      (outcome === "accepted" || outcome === "accepted_without_confidence" || outcome === "accepted_blank_or_unknown")
    ) {
      input.acceptedParagraphIds.add(target.paragraph_id);
      input.refinementMatches.push({
        semantic_key: decision.semantic_key,
        paragraph_ids: [target.paragraph_id],
        ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
        ...(decision.reason ? { reason: decision.reason } : {})
      });
    }
    return {
      paragraph_id: target.paragraph_id,
      first_pass: target.first_pass,
      second_pass,
      outcome
    };
  });
}

function resolveTemplateClassificationRefinementOutcome(input: {
  fallbackSemanticKey?: string;
  minConfidence?: number;
  target: TemplateClassificationRefinementTarget;
  decision?: TemplateClassificationRefinementDecision;
}): TemplateRefinementOutcome {
  const decision = input.decision;
  if (!decision) {
    return "rejected_invalid";
  }
  if (decision.semantic_key) {
    if (!input.target.candidate_semantic_keys.includes(decision.semantic_key)) {
      return "rejected_invalid";
    }
    if (decision.semantic_key === input.fallbackSemanticKey) {
      return "accepted_blank_or_unknown";
    }
    if (
      typeof input.minConfidence === "number" &&
      typeof decision.confidence === "number" &&
      decision.confidence < input.minConfidence
    ) {
      return "rejected_low_confidence";
    }
    return typeof decision.confidence === "number" ? "accepted" : "accepted_without_confidence";
  }
  if ((decision.candidate_semantic_keys?.length ?? 0) > 0) {
    return "rejected_conflict";
  }
  if (decision.unmatched) {
    return "rejected_unmatched";
  }
  return "rejected_invalid";
}

function filterTemplateClassificationBatchResult(
  batchResult: TemplateClassificationBatchResult,
  excludedParagraphIds: Set<string>
): TemplateClassificationBatchResult {
  return {
    batch: {
      ...batchResult.batch,
      paragraphs: batchResult.batch.paragraphs.filter((paragraph) => !excludedParagraphIds.has(paragraph.paragraph_id)),
      paragraph_id_set: batchResult.batch.paragraph_id_set.filter((paragraphId) => !excludedParagraphIds.has(paragraphId))
    },
    result: {
      ...batchResult.result,
      matches: batchResult.result.matches
        .map((match) => ({
          ...match,
          paragraph_ids: match.paragraph_ids.filter((paragraphId) => !excludedParagraphIds.has(paragraphId))
        }))
        .filter((match) => match.paragraph_ids.length > 0),
      unmatched_paragraph_ids: batchResult.result.unmatched_paragraph_ids.filter(
        (paragraphId) => !excludedParagraphIds.has(paragraphId)
      ),
      conflicts: batchResult.result.conflicts.filter((conflict) => !excludedParagraphIds.has(conflict.paragraph_id))
    }
  };
}

function buildTemplateClassificationRefinementModelRequest(
  template: TemplateContract,
  context: TemplateContext,
  classification: TemplateClassificationResult,
  targets: TemplateClassificationRefinementTarget[]
): TemplateClassificationRefinementModelRequest {
  const payload = buildClassificationRefinementPromptPayload(template, context, classification, targets);
  const payloadContent = JSON.stringify(payload, null, 2);
  const schema = {
    type: "object",
    additionalProperties: true
  };
  const schemaContent = JSON.stringify(schema);
  return {
    targetParagraphIds: targets.map((target) => target.paragraph_id),
    messages: [
      {
        role: "system",
        content:
          "你负责执行固定格式模板分类的第二轮精判。只能处理 target_paragraphs 中列出的段落，并且每段只允许在 candidate_semantic_keys 里做单一决策。 " +
          "You are running the second-pass refinement for fixed-format template classification. Decide each target paragraph using only its candidate_semantic_keys."
      },
      {
        role: "user",
        content: payloadContent
      }
    ],
    schemaName: "template_classification_refinement_result",
    schema,
    diagnosticMetadata: {
      promptBytes: byteLength(payloadContent),
      schemaBytes: byteLength(schemaContent),
      paragraphCount: context.structureIndex.paragraphs.length,
      semanticBlockCount: template.semantic_blocks.length,
      batchType: "refinement",
      batchIndex: 1,
      batchCount: 1,
      batchParagraphCount: targets.length
    }
  };
}

function buildClassificationRefinementPromptPayload(
  template: TemplateContract,
  context: TemplateContext,
  classification: TemplateClassificationResult,
  targets: TemplateClassificationRefinementTarget[]
): Record<string, unknown> {
  const candidateKeySet = new Set(targets.flatMap((target) => target.candidate_semantic_keys));
  const fallbackSemanticKey = findBlankOrUnknownSemanticKey(template);
  const firstTarget = targets[0];

  return {
    instruction:
      "只对 target_paragraphs 做第二轮精判。每个段落只能返回一个 chosen_semantic_key，或者明确返回 unmatched / candidate_semantic_keys 表示仍无法消歧。 " +
      "Return one parseable JSON object with decisions only for target_paragraphs.",
    output_contract: {
      response_root: "Return one parseable JSON object.",
      decision_shape:
        "Each decision should include paragraph_id plus either chosen_semantic_key, or unmatched=true, or candidate_semantic_keys.",
      candidate_scope:
        "chosen_semantic_key must come from the paragraph's candidate_semantic_keys. Keep the decision local to the provided context."
    },
    template: {
      template_meta: template.template_meta,
      semantic_blocks: template.semantic_blocks.filter((block) => candidateKeySet.has(block.key)),
      layout_rules: {
        ...template.layout_rules,
        semantic_rules: template.layout_rules.semantic_rules.filter((rule) => candidateKeySet.has(rule.semantic_key))
      }
    },
    validation_policy: {
      min_confidence: template.validation_policy.min_confidence,
      blank_or_unknown: fallbackSemanticKey ?? null
    },
    first_pass_summary: {
      matches: classification.matches,
      conflicts: classification.conflicts
    },
    output_example: firstTarget
      ? {
          decisions: [
            {
              paragraph_id: firstTarget.paragraph_id,
              chosen_semantic_key: firstTarget.candidate_semantic_keys[0],
              confidence: 0.95
            }
          ]
        }
      : { decisions: [] },
    target_paragraphs: targets.map((target) => ({
      paragraph_id: target.paragraph_id,
      candidate_semantic_keys: target.candidate_semantic_keys,
      first_pass: target.first_pass,
      local_context: buildTemplateClassificationRefinementLocalContext(context, target.paragraph_id)
    }))
  };
}

function buildTemplateClassificationRefinementLocalContext(
  context: TemplateContext,
  paragraphId: string
): Array<Record<string, unknown>> {
  const paragraphs = context.classificationInput.paragraphs;
  const currentIndex = paragraphs.findIndex((paragraph) => paragraph.paragraph_id === paragraphId);
  if (currentIndex < 0) {
    return [];
  }
  const start = Math.max(0, currentIndex - REFINEMENT_CONTEXT_RADIUS);
  const end = Math.min(paragraphs.length - 1, currentIndex + REFINEMENT_CONTEXT_RADIUS);
  return paragraphs.slice(start, end + 1).map((paragraph) => ({
    paragraph_id: paragraph.paragraph_id,
    relative_offset: paragraph.paragraph_id === paragraphId ? 0 : paragraph.paragraph_index - paragraphs[currentIndex]!.paragraph_index,
    text: paragraph.text,
    role: paragraph.role,
    heading_level: paragraph.heading_level,
    list_level: paragraph.list_level,
    style_name: paragraph.style_name,
    in_table: paragraph.in_table,
    bucket_type: paragraph.bucket_type,
    has_image_evidence: paragraph.has_image_evidence,
    image_count: paragraph.image_count,
    is_image_dominant: paragraph.is_image_dominant
  }));
}

function parseTemplateClassificationRefinementResult(input: {
  rawContent: string;
  targetParagraphIds: string[];
  template?: TemplateContract;
}): TemplateClassificationRefinementDecision[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawContent);
  } catch (err) {
    throw new AgentError({
      code: "E_TEMPLATE_CLASSIFICATION_PARSE",
      message: `Template classification refinement returned invalid JSON: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidClassification("template classification refinement result must be a JSON object");
  }
  return coerceTemplateClassificationRefinementDecisions(parsed, input.targetParagraphIds, input.template);
}

function coerceTemplateClassificationRefinementDecisions(
  parsed: unknown,
  targetParagraphIds: string[],
  template?: TemplateContract
): TemplateClassificationRefinementDecision[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  const record = unwrapTemplateClassificationRefinementPayload(parsed as Record<string, unknown>);
  const decisionsRaw = Array.isArray(record.decisions)
    ? record.decisions
    : record.paragraph_id !== undefined
      ? [record]
      : [];
  const knownParagraphIds = new Set(targetParagraphIds);
  const seenParagraphIds = new Set<string>();
  const decisions: TemplateClassificationRefinementDecision[] = [];
  for (const item of decisionsRaw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const decisionRecord = item as Record<string, unknown>;
    const paragraph_id =
      typeof decisionRecord.paragraph_id === "string" ? decisionRecord.paragraph_id.trim() : "";
    if (!paragraph_id || !knownParagraphIds.has(paragraph_id) || seenParagraphIds.has(paragraph_id)) {
      continue;
    }
    seenParagraphIds.add(paragraph_id);
    const rawSemanticKey =
      typeof decisionRecord.chosen_semantic_key === "string"
        ? decisionRecord.chosen_semantic_key.trim()
        : typeof decisionRecord.semantic_key === "string"
          ? decisionRecord.semantic_key.trim()
          : "";
    const normalizedSemanticKey = normalizeTemplateClassificationRefinementSemanticKey(rawSemanticKey, template);
    const semantic_key =
      normalizedSemanticKey && normalizedSemanticKey !== "unmatched" ? normalizedSemanticKey : undefined;
    const status = typeof decisionRecord.status === "string" ? decisionRecord.status.trim() : "";
    const unmatched =
      decisionRecord.unmatched === true || status === "unmatched" || rawSemanticKey === "unmatched";
    const confidence =
      typeof decisionRecord.confidence === "number" &&
      Number.isFinite(decisionRecord.confidence) &&
      decisionRecord.confidence >= 0 &&
      decisionRecord.confidence <= 1
        ? roundConfidence(decisionRecord.confidence)
        : undefined;
    const reason =
      typeof decisionRecord.reason === "string" && decisionRecord.reason.trim()
        ? decisionRecord.reason.trim()
        : undefined;
    const candidate_semantic_keys = Array.isArray(decisionRecord.candidate_semantic_keys)
      ? uniqueStrings(
          decisionRecord.candidate_semantic_keys.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0
          )
        )
      : undefined;
    decisions.push({
      paragraph_id,
      ...(semantic_key ? { semantic_key } : {}),
      ...(candidate_semantic_keys !== undefined ? { candidate_semantic_keys } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(reason ? { reason } : {}),
      ...(unmatched ? { unmatched } : {})
    });
  }
  return decisions;
}

function normalizeTemplateClassificationRefinementSemanticKey(
  semanticKey: string,
  template?: TemplateContract
): string {
  if (!semanticKey || !templateHasSemanticBlock(template, "cover_image")) {
    return semanticKey;
  }
  if (COVER_IMAGE_REFINEMENT_ALIASES.has(semanticKey)) {
    return "cover_image";
  }
  return semanticKey;
}

function templateHasSemanticBlock(template: TemplateContract | undefined, semanticKey: string): boolean {
  return template?.semantic_blocks.some((block) => block.key === semanticKey) === true;
}

function unwrapTemplateClassificationRefinementPayload(input: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(input.decisions) || input.paragraph_id !== undefined) {
    return input;
  }
  for (const key of ["refinement", "result", "data", "payload"]) {
    const candidate = input[key];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if (Array.isArray(record.decisions) || record.paragraph_id !== undefined) {
        return record;
      }
    }
  }
  return input;
}

function collectCompatibleSemanticKeys(
  template: TemplateContract,
  context: TemplateContext,
  paragraph: TemplateParagraphContext | undefined
): string[] {
  if (!paragraph) {
    return template.semantic_blocks.map((block) => block.key);
  }
  return template.layout_rules.semantic_rules
    .filter((rule) => isSemanticRuleCompatibleWithParagraph(rule, paragraph, context))
    .map((rule) => rule.semantic_key);
}

function isSemanticRuleCompatibleWithParagraph(
  rule: TemplateContract["layout_rules"]["semantic_rules"][number],
  paragraph: TemplateParagraphContext,
  context: TemplateContext
): boolean {
  const styleHints = readStyleHints(rule.style_hints);
  const textIsEmpty = paragraph.text.trim().length === 0;

  if (styleHints?.require_image === true && !paragraph.has_image_evidence) {
    return false;
  }
  if (styleHints?.image_dominant === true && !paragraph.is_image_dominant) {
    return false;
  }
  if (styleHints?.allow_empty_text !== true && textIsEmpty && styleHints?.require_image !== true) {
    return false;
  }
  if (typeof styleHints?.in_table === "boolean" && paragraph.in_table !== styleHints.in_table) {
    return false;
  }
  if (styleHints?.must_not_be_in_table === true && paragraph.in_table) {
    return false;
  }
  if (matchesAllowedValue(styleHints?.role, paragraph.role) === false) {
    return false;
  }
  if (matchesAllowedValue(styleHints?.preferred_role, paragraph.role) === false) {
    return false;
  }
  if (matchesAllowedValue(styleHints?.bucket_type, paragraph.bucket_type) === false) {
    return false;
  }
  if (matchesAllowedValue(styleHints?.preferred_bucket_type, paragraph.bucket_type) === false) {
    return false;
  }
  if (typeof styleHints?.heading_level === "number" && paragraph.heading_level !== styleHints.heading_level) {
    return false;
  }
  if (typeof styleHints?.list_level === "number" && paragraph.list_level !== styleHints.list_level) {
    return false;
  }
  if (!matchesPositionHints(rule.position_hints, paragraph, context)) {
    return false;
  }
  return true;
}

function matchesAllowedValue(expected: unknown, actual: string | undefined): boolean | undefined {
  if (expected === undefined) {
    return undefined;
  }
  const allowedValues = coerceStringList(expected);
  if (allowedValues.length === 0) {
    return undefined;
  }
  return actual !== undefined && allowedValues.includes(actual);
}

function matchesPositionHints(
  positionHints: unknown,
  paragraph: TemplateParagraphContext,
  context: TemplateContext
): boolean {
  const hints = coerceStringList(positionHints);
  if (hints.length === 0) {
    return true;
  }
  if (hints.includes("near_top")) {
    const nearTopLimit = Math.max(2, Math.floor(context.classificationInput.paragraphs.length * 0.2));
    if (paragraph.paragraph_index >= nearTopLimit) {
      return false;
    }
  }
  if (hints.includes("first_paragraph") && paragraph.is_first_paragraph !== true) {
    return false;
  }
  if (hints.includes("first_non_blank")) {
    const firstNonBlank = context.classificationInput.paragraphs.find((item) => item.text.trim().length > 0);
    if (firstNonBlank && firstNonBlank.paragraph_id !== paragraph.paragraph_id) {
      return false;
    }
  }
  return true;
}

function coerceStringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

export function parseTemplateClassificationResult(input: {
  template: TemplateContract;
  context: TemplateContext;
  rawContent: string;
  allowedParagraphIds?: Iterable<string>;
  batchDiagnostics?: TemplateClassificationParseBatchDiagnostics;
}): TemplateClassificationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawContent);
  } catch (err) {
    throw new AgentError({
      code: "E_TEMPLATE_CLASSIFICATION_PARSE",
      message: `Template classification returned invalid JSON: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }

  const knownParagraphIds = new Set(
    input.allowedParagraphIds ?? input.context.structureIndex.paragraphs.map((paragraph) => paragraph.id)
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidClassificationWithDiagnostics(
      "classification result must be a JSON object",
      buildTemplateClassificationDiagnostics(parsed, knownParagraphIds.size, input.batchDiagnostics)
    );
  }

  return coerceTemplateClassificationResult({
    template: input.template,
    context: input.context,
    classification: parsed as Record<string, unknown>,
    allowedParagraphIds: knownParagraphIds
  });
}

export function normalizeTemplateClassificationResult(input: {
  template: TemplateContract;
  context: TemplateContext;
  classification: TemplateClassificationResult;
  applyBlankOrUnknownFallback?: boolean;
  applyDerivedSemantics?: boolean;
}): TemplateClassificationResult {
  const paragraphOrder = new Map(
    input.context.structureIndex.paragraphs.map((paragraph, index) => [paragraph.id, index] as const)
  );
  const coerced = coerceTemplateClassificationResult({
    template: input.template,
    context: input.context,
    classification: {
      template_id: input.classification.template_id,
      scope: "paragraph",
      matches: input.classification.matches,
      unmatched_paragraph_ids: input.classification.unmatched_paragraph_ids,
      conflicts: input.classification.conflicts,
      overall_confidence: input.classification.overall_confidence
    },
    existingDiagnostics: input.classification.diagnostics
  });

  let matches = coerced.matches;
  let unmatched_paragraph_ids = orderParagraphIds(
    [
      ...new Set([
        ...coerced.unmatched_paragraph_ids,
        ...input.context.structureIndex.paragraphs
          .map((paragraph) => paragraph.id)
          .filter((paragraphId) => !matches.some((match) => match.paragraph_ids.includes(paragraphId)))
      ])
    ],
    paragraphOrder
  );
  if (input.applyBlankOrUnknownFallback !== false) {
    ({ matches, unmatched_paragraph_ids } = applyBlankOrUnknownFallback({
      template: input.template,
      context: input.context,
      matches,
      unmatched_paragraph_ids
    }));
  }
  const unmatchedParagraphIdSet = new Set(unmatched_paragraph_ids);
  const diagnostics: TemplateClassificationDiagnostics | undefined =
    coerced.diagnostics !== undefined
      ? {
          ...(coerced.diagnostics.unmatched_paragraphs !== undefined
            ? {
                unmatched_paragraphs: coerced.diagnostics.unmatched_paragraphs.filter((item) =>
                  unmatchedParagraphIdSet.has(item.paragraph_id)
                )
              }
            : {}),
          ...(coerced.diagnostics.ignored_unknown_semantic_matches !== undefined
            ? { ignored_unknown_semantic_matches: coerced.diagnostics.ignored_unknown_semantic_matches }
            : {}),
          ...(coerced.diagnostics.normalization_notes !== undefined
            ? { normalization_notes: coerced.diagnostics.normalization_notes }
            : {}),
          ...(coerced.diagnostics.refined_paragraphs !== undefined
            ? { refined_paragraphs: coerced.diagnostics.refined_paragraphs }
            : {}),
          ...(coerced.diagnostics.refinement_elapsed_ms !== undefined
            ? { refinement_elapsed_ms: coerced.diagnostics.refinement_elapsed_ms }
            : {})
        }
      : undefined;

  const normalized = {
    ...coerced,
    matches,
    unmatched_paragraph_ids,
    ...(diagnostics ? { diagnostics } : {})
  };
  return input.applyDerivedSemantics === false
    ? normalized
      : applyDerivedSemanticResolution({
        template: input.template,
        context: input.context,
        classification: normalized
      });
}

function coerceTemplateClassificationResult(input: {
  template: TemplateContract;
  context: TemplateContext;
  classification: Record<string, unknown>;
  allowedParagraphIds?: Iterable<string>;
  existingDiagnostics?: TemplateClassificationDiagnostics;
}): TemplateClassificationResult {
  const semanticKeys = new Set(input.template.semantic_blocks.map((block) => block.key));
  const paragraphOrder = new Map(
    input.context.structureIndex.paragraphs.map((paragraph, index) => [paragraph.id, index] as const)
  );
  const knownParagraphIds = new Set(
    input.allowedParagraphIds ?? input.context.structureIndex.paragraphs.map((paragraph) => paragraph.id)
  );
  const normalizedRoot = unwrapClassificationPayload(input.classification);
  const normalizationNotes = [...(input.existingDiagnostics?.normalization_notes ?? []), ...normalizedRoot.notes];
  const ignoredUnknownSemanticMatches = [
    ...(input.existingDiagnostics?.ignored_unknown_semantic_matches ?? [])
  ];

  if (
    normalizedRoot.record.scope !== undefined &&
    normalizedRoot.record.scope !== "paragraph"
  ) {
    normalizationNotes.push(`ignored non-paragraph scope '${String(normalizedRoot.record.scope)}'`);
  }
  if (
    normalizedRoot.record.template_id !== undefined &&
    normalizedRoot.record.template_id !== input.template.template_meta.id
  ) {
    normalizationNotes.push(
      `ignored template_id '${String(normalizedRoot.record.template_id)}'; expected '${input.template.template_meta.id}'`
    );
  }

  const matchAggregates = new Map<
    string,
    {
      paragraphIds: Set<string>;
      confidenceSum: number;
      confidenceWeight: number;
      reasons: string[];
    }
  >();
  const matchesRaw = readArrayField(normalizedRoot.record.matches, "matches", normalizationNotes);
  for (const [index, item] of matchesRaw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      normalizationNotes.push(`ignored matches[${index}] because it is not an object`);
      continue;
    }
    const record = item as Record<string, unknown>;
    const semanticKey = readOptionalString(record.semantic_key, `matches[${index}].semantic_key`, normalizationNotes);
    if (!semanticKey) {
      normalizationNotes.push(`ignored matches[${index}] because semantic_key is missing`);
      continue;
    }
    const paragraphIds = normalizeParagraphIds({
      value: record.paragraph_ids,
      path: `matches[${index}].paragraph_ids`,
      knownParagraphIds,
      normalizationNotes
    });
    const confidence = readOptionalConfidence(record.confidence, `matches[${index}].confidence`, normalizationNotes);
    const reason = readOptionalString(record.reason, `matches[${index}].reason`, normalizationNotes);
    if (!semanticKeys.has(semanticKey)) {
      ignoredUnknownSemanticMatches.push({
        semantic_key: semanticKey,
        paragraph_ids: paragraphIds,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(reason !== undefined ? { reason } : {})
      });
      normalizationNotes.push(`skipped unknown semantic_key '${semanticKey}' from matches[${index}]`);
      continue;
    }
    if (paragraphIds.length === 0) {
      normalizationNotes.push(`ignored matches[${index}] because it has no valid paragraph_ids`);
      continue;
    }
    const aggregate = matchAggregates.get(semanticKey) ?? {
      paragraphIds: new Set<string>(),
      confidenceSum: 0,
      confidenceWeight: 0,
      reasons: []
    };
    if (matchAggregates.has(semanticKey)) {
      normalizationNotes.push(`merged duplicate semantic_key '${semanticKey}'`);
    }
    paragraphIds.forEach((paragraphId) => aggregate.paragraphIds.add(paragraphId));
    if (confidence !== undefined) {
      aggregate.confidenceSum += confidence * paragraphIds.length;
      aggregate.confidenceWeight += paragraphIds.length;
    }
    if (reason && !aggregate.reasons.includes(reason)) {
      aggregate.reasons.push(reason);
    }
    matchAggregates.set(semanticKey, aggregate);
  }

  const matches = input.template.semantic_blocks
    .map((block) => {
      const aggregate = matchAggregates.get(block.key);
      if (!aggregate || aggregate.paragraphIds.size === 0) {
        return undefined;
      }
      return {
        semantic_key: block.key,
        paragraph_ids: orderParagraphIds([...aggregate.paragraphIds], paragraphOrder),
        ...(aggregate.confidenceWeight > 0
          ? { confidence: roundConfidence(aggregate.confidenceSum / aggregate.confidenceWeight) }
          : {}),
        ...(aggregate.reasons.length > 0 ? { reason: aggregate.reasons.join(" | ") } : {})
      };
    })
    .filter((match): match is NonNullable<typeof match> => Boolean(match));

  const unmatched_paragraph_ids = normalizeParagraphIds({
    value: normalizedRoot.record.unmatched_paragraph_ids,
    path: "unmatched_paragraph_ids",
    knownParagraphIds,
    normalizationNotes
  });

  const conflictAggregates = new Map<
    string,
    {
      candidateSemanticKeys: Set<string>;
      reasons: string[];
    }
  >();
  const conflictsRaw = readArrayField(normalizedRoot.record.conflicts, "conflicts", normalizationNotes);
  for (const [index, item] of conflictsRaw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      normalizationNotes.push(`ignored conflicts[${index}] because it is not an object`);
      continue;
    }
    const record = item as Record<string, unknown>;
    const paragraphId = readOptionalString(record.paragraph_id, `conflicts[${index}].paragraph_id`, normalizationNotes);
    if (!paragraphId) {
      normalizationNotes.push(`ignored conflicts[${index}] because paragraph_id is missing`);
      continue;
    }
    if (!knownParagraphIds.has(paragraphId)) {
      normalizationNotes.push(`ignored conflicts[${index}] paragraph_id '${paragraphId}' because it is out of scope`);
      continue;
    }
    const candidateSemanticKeysRaw = readStringList(
      record.candidate_semantic_keys,
      `conflicts[${index}].candidate_semantic_keys`,
      normalizationNotes
    );
    const knownCandidateSemanticKeys: string[] = [];
    for (const semanticKey of candidateSemanticKeysRaw) {
      if (!semanticKeys.has(semanticKey)) {
        ignoredUnknownSemanticMatches.push({
          semantic_key: semanticKey,
          paragraph_ids: [paragraphId]
        });
        normalizationNotes.push(
          `skipped unknown semantic_key '${semanticKey}' from conflicts[${index}].candidate_semantic_keys`
        );
        continue;
      }
      if (!knownCandidateSemanticKeys.includes(semanticKey)) {
        knownCandidateSemanticKeys.push(semanticKey);
      }
    }
    if (knownCandidateSemanticKeys.length === 0) {
      normalizationNotes.push(`ignored conflicts[${index}] because it has no known candidate_semantic_keys`);
      continue;
    }
    const aggregate = conflictAggregates.get(paragraphId) ?? {
      candidateSemanticKeys: new Set<string>(),
      reasons: []
    };
    if (conflictAggregates.has(paragraphId)) {
      normalizationNotes.push(`merged duplicate conflict paragraph_id '${paragraphId}'`);
    }
    knownCandidateSemanticKeys.forEach((semanticKey) => aggregate.candidateSemanticKeys.add(semanticKey));
    const reason = readOptionalString(record.reason, `conflicts[${index}].reason`, normalizationNotes);
    if (reason && !aggregate.reasons.includes(reason)) {
      aggregate.reasons.push(reason);
    }
    conflictAggregates.set(paragraphId, aggregate);
  }

  const conflicts = orderParagraphIds([...conflictAggregates.keys()], paragraphOrder).map((paragraphId) => {
    const aggregate = conflictAggregates.get(paragraphId)!;
    return {
      paragraph_id: paragraphId,
      candidate_semantic_keys: input.template.semantic_blocks
        .map((block) => block.key)
        .filter((semanticKey) => aggregate.candidateSemanticKeys.has(semanticKey)),
      ...(aggregate.reasons.length > 0 ? { reason: aggregate.reasons.join(" | ") } : {})
    };
  });

  const overall_confidence = readOptionalConfidence(
    normalizedRoot.record.overall_confidence,
    "overall_confidence",
    normalizationNotes
  );

  const diagnostics = buildTemplateClassificationResultDiagnostics({
    unmatchedParagraphs: input.existingDiagnostics?.unmatched_paragraphs,
    ignoredUnknownSemanticMatches,
    normalizationNotes,
    refinedParagraphs: input.existingDiagnostics?.refined_paragraphs,
    refinementElapsedMs: input.existingDiagnostics?.refinement_elapsed_ms
  });

  return {
    template_id: input.template.template_meta.id,
    matches,
    unmatched_paragraph_ids,
    conflicts,
    ...(diagnostics ? { diagnostics } : {}),
    ...(overall_confidence !== undefined ? { overall_confidence } : {})
  };
}

function unwrapClassificationPayload(input: Record<string, unknown>): {
  record: Record<string, unknown>;
  notes: string[];
} {
  const notes: string[] = [];
  if (containsClassificationFields(input)) {
    return { record: input, notes };
  }
  for (const key of ["classification", "result", "data", "batch_result", "payload"]) {
    const candidate = input[key];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      notes.push(`read classification fields from wrapper '${key}'`);
      return { record: candidate as Record<string, unknown>, notes };
    }
  }
  return { record: input, notes };
}

function containsClassificationFields(input: Record<string, unknown>): boolean {
  return ["scope", "matches", "unmatched_paragraph_ids", "conflicts", "overall_confidence"].some((key) => key in input);
}

function buildTemplateClassificationResultDiagnostics(input: {
  unmatchedParagraphs?: TemplateUnmatchedParagraphDiagnostic[];
  ignoredUnknownSemanticMatches: TemplateIgnoredUnknownSemanticMatch[];
  normalizationNotes: string[];
  refinedParagraphs?: TemplateClassificationRefinedParagraphDiagnostic[];
  refinementElapsedMs?: number;
}): TemplateClassificationDiagnostics | undefined {
  const uniqueNormalizationNotes = uniqueStrings(input.normalizationNotes);
  if (
    input.unmatchedParagraphs === undefined &&
    input.ignoredUnknownSemanticMatches.length === 0 &&
    uniqueNormalizationNotes.length === 0 &&
    (input.refinedParagraphs?.length ?? 0) === 0 &&
    input.refinementElapsedMs === undefined
  ) {
    return undefined;
  }
  return {
    ...(input.unmatchedParagraphs !== undefined ? { unmatched_paragraphs: input.unmatchedParagraphs } : {}),
    ...(input.ignoredUnknownSemanticMatches.length > 0
      ? { ignored_unknown_semantic_matches: input.ignoredUnknownSemanticMatches }
      : {}),
    ...(uniqueNormalizationNotes.length > 0 ? { normalization_notes: uniqueNormalizationNotes } : {}),
    ...(input.refinedParagraphs !== undefined && input.refinedParagraphs.length > 0
      ? { refined_paragraphs: input.refinedParagraphs }
      : {}),
    ...(input.refinementElapsedMs !== undefined ? { refinement_elapsed_ms: input.refinementElapsedMs } : {})
  };
}

function applyBlankOrUnknownFallback(input: {
  template: TemplateContract;
  context: TemplateContext;
  matches: TemplateClassificationResult["matches"];
  unmatched_paragraph_ids: string[];
}): {
  matches: TemplateClassificationResult["matches"];
  unmatched_paragraph_ids: string[];
} {
  const fallbackSemanticKey = findBlankOrUnknownSemanticKey(input.template);
  if (!fallbackSemanticKey || input.unmatched_paragraph_ids.length === 0) {
    return {
      matches: input.matches,
      unmatched_paragraph_ids: input.unmatched_paragraph_ids
    };
  }

  const paragraphOrder = new Map(
    input.context.structureIndex.paragraphs.map((paragraph, index) => [paragraph.id, index] as const)
  );
  const paragraphContextMap = new Map(
    input.context.classificationInput.paragraphs.map((paragraph) => [paragraph.paragraph_id, paragraph] as const)
  );
  const fallbackParagraphIds = input.unmatched_paragraph_ids.filter((paragraphId) => {
    const paragraph = paragraphContextMap.get(paragraphId);
    return (
      paragraph !== undefined &&
      paragraph.has_image_evidence !== true &&
      (paragraph.text.trim().length === 0 || paragraph.bucket_type === "unknown")
    );
  });
  if (fallbackParagraphIds.length === 0) {
    return {
      matches: input.matches,
      unmatched_paragraph_ids: input.unmatched_paragraph_ids
    };
  }

  const fallbackSet = new Set(fallbackParagraphIds);
  const matches = input.matches.map((match) =>
    match.semantic_key === fallbackSemanticKey
      ? {
          ...match,
          paragraph_ids: orderParagraphIds([...new Set([...match.paragraph_ids, ...fallbackParagraphIds])], paragraphOrder),
          reason: match.reason ? `${match.reason} | blank_or_unknown fallback` : "blank_or_unknown fallback"
        }
      : match
  );
  if (!matches.some((match) => match.semantic_key === fallbackSemanticKey)) {
    matches.push({
      semantic_key: fallbackSemanticKey,
      paragraph_ids: orderParagraphIds(fallbackParagraphIds, paragraphOrder),
      reason: "blank_or_unknown fallback"
    });
  }

  return {
    matches: matches.sort(
      (left, right) =>
        (input.template.semantic_blocks.findIndex((block) => block.key === left.semantic_key) ?? Number.MAX_SAFE_INTEGER) -
        (input.template.semantic_blocks.findIndex((block) => block.key === right.semantic_key) ?? Number.MAX_SAFE_INTEGER)
    ),
    unmatched_paragraph_ids: input.unmatched_paragraph_ids.filter((paragraphId) => !fallbackSet.has(paragraphId))
  };
}

function findBlankOrUnknownSemanticKey(template: TemplateContract): string | undefined {
  return template.layout_rules.semantic_rules.find((rule) => {
    const styleHints = readStyleHints(rule.style_hints);
    return (
      rule.semantic_key === "blank_or_unknown" &&
      styleHints?.allow_empty_text === true &&
      template.semantic_blocks.some((block) => block.key === rule.semantic_key)
    );
  })?.semantic_key;
}

function applyDerivedSemanticResolution(input: {
  template: TemplateContract;
  context: TemplateContext;
  classification: TemplateClassificationResult;
}): TemplateClassificationResult {
  const derivedSemantics = input.template.derived_semantics ?? [];
  if (derivedSemantics.length === 0) {
    return input.classification;
  }

  const atomicKeySet = new Set(input.template.semantic_blocks.map((block) => block.key));
  const derivedKeySet = new Set(derivedSemantics.map((semantic) => semantic.key));
  const paragraphOrder = new Map(
    input.context.structureIndex.paragraphs.map((paragraph, index) => [paragraph.id, index] as const)
  );
  const paragraphContextMap = new Map(
    input.context.classificationInput.paragraphs.map((paragraph) => [paragraph.paragraph_id, paragraph] as const)
  );
  const atomicMatches = input.classification.matches.filter((match) => atomicKeySet.has(match.semantic_key));
  const nonDerivedMatches = input.classification.matches.filter((match) => !derivedKeySet.has(match.semantic_key));
  const atomicMatchMap = new Map(atomicMatches.map((match) => [match.semantic_key, match] as const));
  const paragraphConfidenceMap = new Map<string, number>();
  for (const match of atomicMatches) {
    if (typeof match.confidence !== "number") {
      continue;
    }
    for (const paragraphId of match.paragraph_ids) {
      paragraphConfidenceMap.set(paragraphId, match.confidence);
    }
  }

  const derivedMatches = derivedSemantics
    .map((semantic) => {
      const candidateParagraphIds = orderParagraphIds(
        Array.from(
          new Set(
            semantic.inherits_from.flatMap((semanticKey) => atomicMatchMap.get(semanticKey)?.paragraph_ids ?? [])
          )
        ),
        paragraphOrder
      );
      if (candidateParagraphIds.length === 0) {
        return undefined;
      }
      const paragraph_ids =
        readDerivedSemanticMode(semantic) === "refine"
          ? candidateParagraphIds.filter((paragraphId) =>
              matchesDerivedSemantic(
                paragraphContextMap.get(paragraphId)?.text ?? "",
                semantic.examples,
                semantic.text_hints ?? [],
                semantic.negative_examples ?? []
              )
            )
          : candidateParagraphIds;
      if (paragraph_ids.length === 0) {
        return undefined;
      }
      const confidences = paragraph_ids
        .map((paragraphId) => paragraphConfidenceMap.get(paragraphId))
        .filter((confidence): confidence is number => typeof confidence === "number");
      return {
        semantic_key: semantic.key,
        paragraph_ids,
        ...(confidences.length > 0
          ? {
              confidence: roundConfidence(
                confidences.reduce((sum, confidence) => sum + confidence, 0) / confidences.length
              )
            }
          : {}),
        reason: buildDerivedSemanticReason(semantic)
      };
    })
    .filter((match): match is NonNullable<typeof match> => Boolean(match));

  const orderedMatches = [
    ...input.template.semantic_blocks
      .map((block) => nonDerivedMatches.find((match) => match.semantic_key === block.key))
      .filter((match): match is NonNullable<typeof match> => Boolean(match)),
    ...derivedSemantics
      .map((semantic) => derivedMatches.find((match) => match.semantic_key === semantic.key))
      .filter((match): match is NonNullable<typeof match> => Boolean(match))
  ];

  return {
    ...input.classification,
    matches: orderedMatches
  };
}

function readDerivedSemanticMode(semantic: NonNullable<TemplateContract["derived_semantics"]>[number]): "aggregate" | "refine" {
  return semantic.mode === "refine" ? "refine" : "aggregate";
}

function matchesDerivedSemantic(
  text: string,
  examples: string[],
  textHints: string[],
  negativeExamples: string[]
): boolean {
  const normalizedText = normalizeComparableText(text);
  if (!normalizedText) {
    return false;
  }
  const negatives = negativeExamples.map(normalizeComparableText).filter(Boolean);
  if (negatives.some((negative) => normalizedText.includes(negative))) {
    return false;
  }
  const positives = [...examples, ...textHints].map(normalizeComparableText).filter(Boolean);
  return positives.some((positive) => normalizedText.includes(positive) || positive.includes(normalizedText));
}

function buildDerivedSemanticReason(semantic: NonNullable<TemplateContract["derived_semantics"]>[number]): string {
  const mode = readDerivedSemanticMode(semantic);
  return mode === "aggregate"
    ? `derived aggregate from ${semantic.inherits_from.join(", ")}`
    : `derived refine from ${semantic.inherits_from.join(", ")} using examples/text_hints`;
}

function normalizeComparableText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function readStyleHints(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
}

function orderParagraphIds(paragraphIds: string[], paragraphOrder: Map<string, number>): string[] {
  return [...paragraphIds].sort(
    (left, right) => (paragraphOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (paragraphOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
  );
}

function buildTemplateClassificationModelRequestForBatch(
  template: TemplateContract,
  context: TemplateContext,
  batch: TemplateClassificationBatch
): TemplateClassificationModelRequest {
  const payload = buildClassificationPromptPayload(template, context, batch);
  const payloadContent = JSON.stringify(payload, null, 2);
  const schema = buildClassificationSchema(template, batch.paragraph_id_set);
  const schemaContent = JSON.stringify(schema);
  return {
    batch,
    messages: [
      {
        role: "system",
        content:
          "你负责执行固定格式模板分类。当前请求只覆盖文档中的一个批次。返回一个可解析的 JSON 对象即可；字段可以按需要省略或补充。 " +
          "You classify one batch of document paragraphs for a fixed-format template. Return one parseable JSON object."
      },
      {
        role: "user",
        content: payloadContent
      }
    ],
    schemaName: "template_classification_result",
    schema,
    diagnosticMetadata: {
      promptBytes: byteLength(payloadContent),
      schemaBytes: byteLength(schemaContent),
      paragraphCount: context.structureIndex.paragraphs.length,
      semanticBlockCount: template.semantic_blocks.length,
      batchType: batch.bucket_type,
      batchIndex: batch.batch_index,
      batchCount: batch.batch_count,
      batchParagraphCount: batch.paragraphs.length
    }
  };
}

function buildClassificationPromptPayload(
  template: TemplateContract,
  context: TemplateContext,
  batch: TemplateClassificationBatch
): Record<string, unknown> {
  const firstSemanticKey = template.semantic_blocks[0]?.key;
  const firstParagraphId = batch.paragraph_id_set[0];
  const outputExampleMatches =
    firstSemanticKey && firstParagraphId
      ? [
          {
            semantic_key: firstSemanticKey,
            paragraph_ids: [firstParagraphId],
            confidence: 0.96,
            reason: `Batch paragraph ${firstParagraphId} best matches semantic_key ${firstSemanticKey}.`
          }
        ]
      : [];
  return {
    instruction:
      "按模板 semantic_blocks 与 layout_rules 对当前批次段落做 paragraph 级分类。返回一个可解析的 JSON 对象；优先说明哪些段落属于哪些 semantic_key、哪些存在冲突、哪些应留空。 " +
      "This request focuses on the current batch paragraphs first, but the response only needs to be a parseable JSON object.",
    output_contract: {
      response_root: "Return one parseable JSON object.",
      optional_fields:
        "matches, unmatched_paragraph_ids, conflicts, and overall_confidence are optional; omit fields you cannot determine.",
      extra_fields: "Extra keys are allowed when they help explain the classification decision.",
      batch_focus:
        "Prioritize batch.paragraph_ids when classifying this batch. References outside the batch may be ignored during normalization."
    },
    template: {
      template_meta: template.template_meta,
      semantic_blocks: template.semantic_blocks,
      layout_rules: template.layout_rules
    },
    observation_summary: {
      document_meta: context.observationSummary.document_meta,
      paragraph_count: context.observationSummary.paragraph_count,
      evidence_summary: context.observationSummary.evidence_summary
    },
    batch: {
      bucket_type: batch.bucket_type,
      batch_index: batch.batch_index,
      batch_count: batch.batch_count,
      paragraph_count: batch.paragraphs.length,
      paragraph_ids: batch.paragraph_id_set
    },
    output_example: {
      scope: "paragraph",
      matches: outputExampleMatches,
      unmatched_paragraph_ids: [],
      conflicts: [],
      overall_confidence: outputExampleMatches.length > 0 ? 0.96 : 0
    },
    paragraphs: batch.paragraphs.map((paragraph) => ({
      paragraph_id: paragraph.paragraph_id,
      text: paragraph.text,
      role: paragraph.role,
      heading_level: paragraph.heading_level,
      list_level: paragraph.list_level,
      style_name: paragraph.style_name,
      in_table: paragraph.in_table,
      paragraph_index: paragraph.paragraph_index,
      is_first_paragraph: paragraph.is_first_paragraph,
      is_last_paragraph: paragraph.is_last_paragraph,
      bucket_type: paragraph.bucket_type,
      has_image_evidence: paragraph.has_image_evidence,
      image_count: paragraph.image_count,
      is_image_dominant: paragraph.is_image_dominant
    }))
  };
}

function buildClassificationSchema(template: TemplateContract, paragraphIds: string[]): Record<string, unknown> {
  void template;
  void paragraphIds;
  return {
    type: "object",
    additionalProperties: true
  };
}

function splitBucketParagraphs(
  template: TemplateContract,
  context: TemplateContext,
  bucketType: TemplateParagraphBucketType,
  paragraphs: TemplateParagraphContext[],
  options: Required<TemplateClassificationBatchingOptions>
): TemplateParagraphContext[][] {
  let segments: TemplateParagraphContext[][] = [];
  let currentSegment: TemplateParagraphContext[] = [];

  for (const paragraph of paragraphs) {
    const candidateSegment = [...currentSegment, paragraph];
    const exceedsParagraphLimit = candidateSegment.length > options.maxParagraphsPerBatch;
    const exceedsPromptLimit = estimateBatchPromptBytes(template, context, bucketType, candidateSegment) > options.maxPromptBytes;

    if ((exceedsParagraphLimit || exceedsPromptLimit) && currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [paragraph];
      continue;
    }

    currentSegment = candidateSegment;
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  segments = ensureSegmentsFitPromptBudget(template, context, bucketType, segments, options.maxPromptBytes);
  return segments;
}

function ensureSegmentsFitPromptBudget(
  template: TemplateContract,
  context: TemplateContext,
  bucketType: TemplateParagraphBucketType,
  segments: TemplateParagraphContext[][],
  maxPromptBytes: number
): TemplateParagraphContext[][] {
  let nextSegments = segments;
  let needsAnotherPass = true;

  while (needsAnotherPass) {
    needsAnotherPass = false;
    const rebuiltSegments: TemplateParagraphContext[][] = [];
    const batchCount = nextSegments.length;

    nextSegments.forEach((segment, index) => {
      const batch: TemplateClassificationBatch = {
        bucket_type: bucketType,
        batch_index: index + 1,
        batch_count: batchCount,
        paragraphs: segment,
        paragraph_id_set: segment.map((paragraph) => paragraph.paragraph_id)
      };
      const promptBytes = exactBatchPromptBytes(template, context, batch);
      if (promptBytes > maxPromptBytes && segment.length > 1) {
        const midpoint = Math.ceil(segment.length / 2);
        rebuiltSegments.push(segment.slice(0, midpoint), segment.slice(midpoint));
        needsAnotherPass = true;
        return;
      }
      rebuiltSegments.push(segment);
    });

    nextSegments = rebuiltSegments;
  }

  return nextSegments;
}

function estimateBatchPromptBytes(
  template: TemplateContract,
  context: TemplateContext,
  bucketType: TemplateParagraphBucketType,
  paragraphs: TemplateParagraphContext[]
): number {
  return exactBatchPromptBytes(template, context, {
    bucket_type: bucketType,
    batch_index: 1,
    batch_count: 1,
    paragraphs,
    paragraph_id_set: paragraphs.map((paragraph) => paragraph.paragraph_id)
  });
}

function exactBatchPromptBytes(
  template: TemplateContract,
  context: TemplateContext,
  batch: TemplateClassificationBatch
): number {
  return byteLength(JSON.stringify(buildClassificationPromptPayload(template, context, batch), null, 2));
}

function normalizeBatchingOptions(
  options: TemplateClassificationBatchingOptions
): Required<TemplateClassificationBatchingOptions> {
  return {
    maxParagraphsPerBatch: clampPositiveInteger(options.maxParagraphsPerBatch, DEFAULT_MAX_BATCH_PARAGRAPHS),
    maxPromptBytes: clampPositiveInteger(options.maxPromptBytes, DEFAULT_MAX_PROMPT_BYTES)
  };
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function roundConfidence(value: number): number {
  return Number(value.toFixed(6));
}

function joinUniqueStrings(values: Set<string> | undefined): string | undefined {
  if (!values || values.size === 0) {
    return undefined;
  }
  return [...values].join(" | ");
}

function buildUnmatchedParagraphDiagnostic(input: {
  paragraphId: string;
  paragraphContextMap: Map<string, TemplateParagraphContext>;
  semanticOrder: Map<string, number>;
  modelReportedUnmatchedParagraphIds: Set<string>;
}): TemplateUnmatchedParagraphDiagnostic {
  const paragraph = input.paragraphContextMap.get(input.paragraphId);
  void input.semanticOrder;

  return {
    paragraph_id: input.paragraphId,
    text_excerpt: truncateText(paragraph?.text ?? "", 120),
    role: paragraph?.role ?? "unknown",
    bucket_type: paragraph?.bucket_type ?? "unknown",
    paragraph_index: paragraph?.paragraph_index ?? -1,
    reason: "no_candidate",
    model_reported_unmatched: input.modelReportedUnmatchedParagraphIds.has(input.paragraphId)
  };
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function invalidClassification(message: string): AgentError {
  return invalidClassificationWithDiagnostics(message);
}

function invalidClassificationWithDiagnostics(
  message: string,
  diagnostics?: TemplateClassificationParseDiagnostics
): AgentError {
  return new AgentError({
    code: "E_TEMPLATE_CLASSIFICATION_INVALID",
    message: diagnostics ? `${message} [${formatTemplateClassificationDiagnostics(diagnostics)}]` : message,
    retryable: false
  });
}

function buildTemplateClassificationDiagnostics(
  parsed: unknown,
  allowedParagraphCount: number,
  batchDiagnostics: TemplateClassificationParseBatchDiagnostics | undefined
): TemplateClassificationParseDiagnostics {
  const topLevelType = describeJsonType(parsed);
  const topLevelKeys =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? formatDiagnosticKeys(Object.keys(parsed as Record<string, unknown>))
      : "(none)";
  const matchesType =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? describeJsonType((parsed as Record<string, unknown>).matches)
      : "undefined";

  return {
    topLevelType,
    topLevelKeys,
    matchesType,
    allowedParagraphCount,
    batchType: batchDiagnostics?.batchType,
    batchIndex: batchDiagnostics?.batchIndex,
    batchCount: batchDiagnostics?.batchCount
  };
}

function formatTemplateClassificationDiagnostics(diagnostics: TemplateClassificationParseDiagnostics): string {
  const parts = [
    `topLevelType=${diagnostics.topLevelType}`,
    `topLevelKeys=${diagnostics.topLevelKeys}`,
    `matchesType=${diagnostics.matchesType}`
  ];
  if (diagnostics.batchType) {
    parts.push(`batchType=${diagnostics.batchType}`);
  }
  if (typeof diagnostics.batchIndex === "number") {
    parts.push(`batchIndex=${diagnostics.batchIndex}`);
  }
  if (typeof diagnostics.batchCount === "number") {
    parts.push(`batchCount=${diagnostics.batchCount}`);
  }
  parts.push(`allowedParagraphCount=${diagnostics.allowedParagraphCount}`);
  return parts.join("; ");
}

function formatDiagnosticKeys(keys: string[]): string {
  return keys.length > 0 ? keys.join(",") : "(none)";
}

function describeJsonType(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function readArrayField(value: unknown, path: string, normalizationNotes: string[]): unknown[] {
  if (value === undefined) {
    normalizationNotes.push(`defaulted missing ${path} to []`);
    return [];
  }
  if (!Array.isArray(value)) {
    normalizationNotes.push(`ignored ${path} because it is ${describeJsonType(value)}; defaulted to []`);
    return [];
  }
  return value;
}

function readStringList(value: unknown, path: string, normalizationNotes: string[]): string[] {
  return readArrayField(value, path, normalizationNotes)
    .map((item, index) => readOptionalString(item, `${path}[${index}]`, normalizationNotes))
    .filter((item): item is string => Boolean(item));
}

function readOptionalString(value: unknown, path: string, normalizationNotes: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    normalizationNotes.push(`ignored ${path} because it is ${describeJsonType(value)}`);
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    normalizationNotes.push(`ignored ${path} because it is empty`);
    return undefined;
  }
  return normalized;
}

function readOptionalConfidence(value: unknown, path: string, normalizationNotes: string[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    normalizationNotes.push(`ignored ${path} because it is not a number between 0 and 1`);
    return undefined;
  }
  return value;
}

function normalizeParagraphIds(input: {
  value: unknown;
  path: string;
  knownParagraphIds: Set<string>;
  normalizationNotes: string[];
}): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const paragraphId of readStringList(input.value, input.path, input.normalizationNotes)) {
    if (!input.knownParagraphIds.has(paragraphId)) {
      input.normalizationNotes.push(`ignored ${input.path} value '${paragraphId}' because it is out of scope`);
      continue;
    }
    if (seen.has(paragraphId)) {
      input.normalizationNotes.push(`deduplicated ${input.path} value '${paragraphId}'`);
      continue;
    }
    seen.add(paragraphId);
    result.push(paragraphId);
  }
  return result;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
