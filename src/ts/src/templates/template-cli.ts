import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AgentError, asAppError } from "../core/errors.js";
import { readTemplateStageErrorMetadata } from "./template-stage-error.js";
import { runTemplatePipeline } from "./template-runner.js";
import type {
  TemplateClassificationResult,
  TemplateExecutionResult,
  TemplateIgnoredUnknownSemanticMatch,
  TemplateRunInput,
  TemplateRunReport,
  TemplateRunWarning,
  TemplateRunnerDeps,
  TemplateUnmatchedParagraphDiagnostic,
  TemplateValidationIssue,
  TemplateValidationResult
} from "./types.js";

interface TemplateCliArgs {
  inputJsonPath: string;
  outputJsonPath: string;
}

interface TemplateCliErrorOutput {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    stage?: string;
    stage_timings_ms?: TemplateRunReport["stage_timings_ms"];
  };
}

export interface TemplateCliDeps extends TemplateRunnerDeps {
  runTemplate?: (input: TemplateRunInput, deps?: TemplateRunnerDeps) => Promise<TemplateRunReport>;
}

export async function runTemplateCli(argv: string[]): Promise<number> {
  return await runTemplateCliWithDeps(argv);
}

export async function runTemplateCliWithDeps(argv: string[], deps: TemplateCliDeps = {}): Promise<number> {
  let args: TemplateCliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    const info = asAppError(err, "E_TEMPLATE_CLI_ARGS");
    console.error(`${info.code}: ${info.message}`);
    return 1;
  }

  try {
    const inputText = await readFile(args.inputJsonPath, "utf8");
    const input = parseTemplateCliInput(inputText);
    const runTemplate = deps.runTemplate ?? runTemplatePipeline;
    const report = await runTemplate(input, deps);
    await writeFile(args.outputJsonPath, `${JSON.stringify(orderTemplateRunReportForJson(report), null, 2)}\n`, "utf8");
    return 0;
  } catch (err) {
    const info = asAppError(err, "E_TEMPLATE_CLI_FAILED");
    const metadata = readTemplateStageErrorMetadata(err);
    const output: TemplateCliErrorOutput = {
      error: {
        code: info.code,
        message: info.message,
        retryable: info.retryable,
        ...(metadata.stage ? { stage: metadata.stage } : {}),
        ...(metadata.stageTimingsMs ? { stage_timings_ms: metadata.stageTimingsMs } : {})
      }
    };
    await writeFile(args.outputJsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    return 1;
  }
}

function parseArgs(argv: string[]): TemplateCliArgs {
  let inputJsonPath = "";
  let outputJsonPath = "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input-json") {
      inputJsonPath = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--output-json") {
      outputJsonPath = argv[i + 1] ?? "";
      i += 1;
    }
  }

  if (!inputJsonPath || !outputJsonPath) {
    throw new AgentError({
      code: "E_TEMPLATE_CLI_ARGS",
      message: "Usage: --input-json <path> --output-json <path>",
      retryable: false
    });
  }

  return { inputJsonPath, outputJsonPath };
}

function parseTemplateCliInput(text: string): TemplateRunInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AgentError({
      code: "E_TEMPLATE_CLI_INPUT_PARSE",
      message: `Invalid template CLI input JSON: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidTemplateCliInput("template CLI input must be an object");
  }
  const raw = parsed as Record<string, unknown>;
  const docxPath = normalizeRequiredString(raw.docxPath, "docxPath");
  const templatePath = normalizeRequiredString(raw.templatePath, "templatePath");
  const debug = raw.debug === undefined ? undefined : normalizeBoolean(raw.debug, "debug");
  const llm =
    raw.llm && typeof raw.llm === "object" && !Array.isArray(raw.llm)
      ? (raw.llm as TemplateRunInput["llm"])
      : undefined;

  return {
    docxPath,
    templatePath,
    llm,
    debug
  };
}

function orderTemplateRunReportForJson(report: TemplateRunReport): TemplateRunReport {
  return {
    status: report.status,
    template_meta: report.template_meta,
    ...(report.stage_timings_ms !== undefined ? { stage_timings_ms: report.stage_timings_ms } : {}),
    observation_summary: report.observation_summary,
    classification_result: orderClassificationResultForJson(report.classification_result),
    validation_result: orderValidationResultForJson(report.validation_result),
    ...(report.warnings !== undefined ? { warnings: report.warnings.map(orderRunWarningForJson) } : {}),
    execution_plan: report.execution_plan,
    patch_plan: report.patch_plan,
    write_plan: report.write_plan,
    execution_result: orderExecutionResultForJson(report.execution_result)
  };
}

function orderClassificationResultForJson(result: TemplateClassificationResult): TemplateClassificationResult {
  return {
    template_id: result.template_id,
    matches: result.matches,
    unmatched_paragraph_ids: result.unmatched_paragraph_ids,
    conflicts: result.conflicts,
    ...(result.diagnostics !== undefined
      ? {
          diagnostics: {
            ...(result.diagnostics.unmatched_paragraphs !== undefined
              ? {
                  unmatched_paragraphs: result.diagnostics.unmatched_paragraphs.map(
                    orderUnmatchedParagraphDiagnosticForJson
                  )
                }
              : {}),
            ...(result.diagnostics.ignored_unknown_semantic_matches !== undefined
              ? {
                  ignored_unknown_semantic_matches:
                    result.diagnostics.ignored_unknown_semantic_matches.map(
                      orderIgnoredUnknownSemanticMatchForJson
                    )
                }
              : {}),
            ...(result.diagnostics.normalization_notes !== undefined
              ? {
                  normalization_notes: result.diagnostics.normalization_notes
                }
              : {}),
            ...(result.diagnostics.refined_paragraphs !== undefined
              ? {
                  refined_paragraphs: result.diagnostics.refined_paragraphs.map((item) => ({
                    paragraph_id: item.paragraph_id,
                    first_pass: item.first_pass,
                    second_pass: item.second_pass,
                    outcome: item.outcome
                  }))
                }
              : {}),
            ...(result.diagnostics.refinement_elapsed_ms !== undefined
              ? {
                  refinement_elapsed_ms: result.diagnostics.refinement_elapsed_ms
                }
              : {})
          }
        }
      : {}),
    ...(result.overall_confidence !== undefined ? { overall_confidence: result.overall_confidence } : {})
  };
}

function orderIgnoredUnknownSemanticMatchForJson(
  diagnostic: TemplateIgnoredUnknownSemanticMatch
): TemplateIgnoredUnknownSemanticMatch {
  return {
    semantic_key: diagnostic.semantic_key,
    paragraph_ids: diagnostic.paragraph_ids,
    ...(diagnostic.confidence !== undefined ? { confidence: diagnostic.confidence } : {}),
    ...(diagnostic.reason !== undefined ? { reason: diagnostic.reason } : {})
  };
}

function orderValidationResultForJson(result: TemplateValidationResult): TemplateValidationResult {
  return {
    passed: result.passed,
    issues: result.issues.map(orderValidationIssueForJson)
  };
}

function orderValidationIssueForJson(issue: TemplateValidationIssue): TemplateValidationIssue {
  return {
    error_code: issue.error_code,
    message: issue.message,
    ...(issue.semantic_key !== undefined ? { semantic_key: issue.semantic_key } : {}),
    ...(issue.paragraph_ids !== undefined ? { paragraph_ids: issue.paragraph_ids } : {}),
    ...(issue.diagnostics !== undefined
      ? {
          diagnostics: {
            ...(issue.diagnostics.semantic_key !== undefined ? { semantic_key: issue.diagnostics.semantic_key } : {}),
            ...(issue.diagnostics.numbering_prefix !== undefined
              ? { numbering_prefix: issue.diagnostics.numbering_prefix }
              : {}),
            ...(issue.diagnostics.rule_source !== undefined ? { rule_source: issue.diagnostics.rule_source } : {}),
            ...(issue.diagnostics.allowed_patterns !== undefined
              ? { allowed_patterns: issue.diagnostics.allowed_patterns }
              : {}),
            ...(issue.diagnostics.unmatched_paragraphs !== undefined
              ? {
                  unmatched_paragraphs: issue.diagnostics.unmatched_paragraphs.map(
                    orderUnmatchedParagraphDiagnosticForJson
                  )
                }
              : {}),
            ...(issue.diagnostics.policy !== undefined ? { policy: issue.diagnostics.policy } : {})
          }
        }
      : {})
  };
}

function orderUnmatchedParagraphDiagnosticForJson(
  diagnostic: TemplateUnmatchedParagraphDiagnostic
): TemplateUnmatchedParagraphDiagnostic {
  return {
    paragraph_id: diagnostic.paragraph_id,
    text_excerpt: diagnostic.text_excerpt,
    role: diagnostic.role,
    bucket_type: diagnostic.bucket_type,
    paragraph_index: diagnostic.paragraph_index,
    reason: diagnostic.reason,
    ...(diagnostic.candidate_semantic_keys !== undefined
      ? { candidate_semantic_keys: diagnostic.candidate_semantic_keys }
      : {}),
    ...(diagnostic.conflict_reason !== undefined ? { conflict_reason: diagnostic.conflict_reason } : {}),
    ...(diagnostic.model_reported_unmatched !== undefined
      ? { model_reported_unmatched: diagnostic.model_reported_unmatched }
      : {})
  };
}

function orderExecutionResultForJson(result: TemplateExecutionResult): TemplateExecutionResult {
  return {
    applied: result.applied,
    ...(result.output_docx_path !== undefined ? { output_docx_path: result.output_docx_path } : {}),
    ...(result.change_summary !== undefined ? { change_summary: result.change_summary } : {}),
    ...(result.artifacts !== undefined ? { artifacts: result.artifacts } : {}),
    ...(result.issues !== undefined ? { issues: result.issues.map(orderValidationIssueForJson) } : {})
  };
}

function orderRunWarningForJson(warning: TemplateRunWarning): TemplateRunWarning {
  return {
    code: warning.code,
    message: warning.message,
    paragraph_ids: warning.paragraph_ids,
    diagnostics: {
      semantic_key: warning.diagnostics.semantic_key,
      text_excerpt: warning.diagnostics.text_excerpt,
      numbering_prefix: warning.diagnostics.numbering_prefix,
      ...(warning.diagnostics.detected_prefix !== undefined
        ? { detected_prefix: warning.diagnostics.detected_prefix }
        : {}),
      warning_kind: warning.diagnostics.warning_kind
    }
  };
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidTemplateCliInput(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidTemplateCliInput(`${field} must be a boolean`);
  }
  return value;
}

function invalidTemplateCliInput(message: string): AgentError {
  return new AgentError({
    code: "E_TEMPLATE_CLI_INPUT_INVALID",
    message,
    retryable: false
  });
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && currentFilePath === process.argv[1]) {
  runTemplateCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const info = asAppError(err, "E_TEMPLATE_CLI_FATAL");
      console.error(`${info.code}: ${info.message}`);
      process.exitCode = 1;
    });
}
