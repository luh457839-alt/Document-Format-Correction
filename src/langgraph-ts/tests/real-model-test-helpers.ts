import { expect } from "vitest";
import type { RuntimeDiagnostic, RunResult } from "../runtime/contracts.js";

const REASONING_COMPATIBILITY_PATTERNS = [
  /The reasoning_content in the thinking mode must be passed back to the API/i,
  /provider adapter expected reasoning_content before replaying the next internal turn/i
];

export function debugRealModelResult(label: string, result: RunResult): void {
  if (process.env.REAL_MODEL_DEBUG !== "1") {
    return;
  }
  console.log(`[${label}] diagnostics`, JSON.stringify(result.state.diagnostics, null, 2));
  console.log(`[${label}] reply`, result.reply);
}

export function debugRealModelTraceDiagnostics(label: string, result: RunResult): void {
  if (process.env.REAL_MODEL_DEBUG !== "1") {
    return;
  }
  const traceDiagnostics = result.state.diagnostics.filter((entry) =>
    entry.provider_diagnostic_kind === "provider_tool_call_trace" ||
    entry.provider_diagnostic_kind === "provider_tool_call_normalized"
  );
  if (traceDiagnostics.length > 0) {
    console.log(`[${label}] provider-trace`, JSON.stringify(traceDiagnostics, null, 2));
  }
}

export function expectRealModelOutputAndStages(
  result: RunResult,
  stages: Array<RuntimeDiagnostic["stage"]> = ["write_tool", "reconcile", "materialize"]
): void {
  expect(result.artifacts.output_docx_path).toBeTruthy();
  for (const stage of stages) {
    expect(result.state.diagnostics.some((entry) => entry.stage === stage)).toBe(true);
  }
}

export function expectNoReasoningCompatibilityRegression(result: RunResult): void {
  const diagnosticsText = flattenDiagnosticsText(result.state.diagnostics);
  for (const pattern of REASONING_COMPATIBILITY_PATTERNS) {
    expect(pattern.test(diagnosticsText)).toBe(false);
  }
}

export function expectControlledRealModelOutcome(
  result: RunResult,
  allowedSignals: string[]
): void {
  expectNoReasoningCompatibilityRegression(result);
  expect(result.artifacts.output_docx_path).toBeFalsy();
  const diagnosticsText = flattenDiagnosticsText(result.state.diagnostics);
  expect(
    allowedSignals.some((signal) => diagnosticsText.includes(signal)),
    `expected controlled failure signals=${allowedSignals.join(", ")} diagnostics=${summarizeDiagnostics(result.state.diagnostics)}`
  ).toBe(true);
}

export function findDiagnostics(
  diagnostics: RuntimeDiagnostic[],
  predicate: (entry: RuntimeDiagnostic) => boolean
): RuntimeDiagnostic[] {
  return diagnostics.filter(predicate);
}

export function summarizeDiagnostics(diagnostics: RuntimeDiagnostic[]): string {
  return diagnostics
    .map((entry) => {
      const stage = String(entry.stage ?? "unknown");
      const errorCode = entry.error_code ? ` error=${String(entry.error_code)}` : "";
      const message = entry.message ? ` message=${String(entry.message)}` : "";
      return `${stage}${errorCode}${message}`;
    })
    .join(" | ");
}

function flattenDiagnosticsText(diagnostics: RuntimeDiagnostic[]): string {
  return diagnostics
    .flatMap((entry) => Object.values(entry))
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}
