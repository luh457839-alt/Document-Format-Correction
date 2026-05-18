import { expect } from "vitest";
import type { Phase3Diagnostic, Phase3RunResult } from "../runtime/contracts.js";

const REASONING_COMPATIBILITY_PATTERNS = [
  /The reasoning_content in the thinking mode must be passed back to the API/i,
  /provider adapter expected reasoning_content before replaying the next internal turn/i
];

export function debugRealModelResult(label: string, result: Phase3RunResult): void {
  if (process.env.REAL_MODEL_DEBUG !== "1") {
    return;
  }
  console.log(`[${label}] diagnostics`, JSON.stringify(result.state.diagnostics, null, 2));
  console.log(`[${label}] reply`, result.reply);
}

export function expectRealModelOutputAndStages(
  result: Phase3RunResult,
  stages: Array<Phase3Diagnostic["stage"]> = ["write_tool", "reconcile", "materialize"]
): void {
  expect(result.artifacts.output_docx_path).toBeTruthy();
  for (const stage of stages) {
    expect(result.state.diagnostics.some((entry) => entry.stage === stage)).toBe(true);
  }
}

export function expectNoReasoningCompatibilityRegression(result: Phase3RunResult): void {
  const diagnosticsText = flattenDiagnosticsText(result.state.diagnostics);
  for (const pattern of REASONING_COMPATIBILITY_PATTERNS) {
    expect(pattern.test(diagnosticsText)).toBe(false);
  }
}

export function findDiagnostics(
  diagnostics: Phase3Diagnostic[],
  predicate: (entry: Phase3Diagnostic) => boolean
): Phase3Diagnostic[] {
  return diagnostics.filter(predicate);
}

export function summarizeDiagnostics(diagnostics: Phase3Diagnostic[]): string {
  return diagnostics
    .map((entry) => {
      const stage = String(entry.stage ?? "unknown");
      const errorCode = entry.error_code ? ` error=${String(entry.error_code)}` : "";
      const message = entry.message ? ` message=${String(entry.message)}` : "";
      return `${stage}${errorCode}${message}`;
    })
    .join(" | ");
}

function flattenDiagnosticsText(diagnostics: Phase3Diagnostic[]): string {
  return diagnostics
    .flatMap((entry) => Object.values(entry))
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}
