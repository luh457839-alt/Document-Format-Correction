import { AgentError } from "../core/errors.js";

const DOCX_PARSE_REJECTION_PATTERNS = [
  /package not found at/i,
  /failed to load docx observation parser/i,
  /failed to (open|load|parse|read).*(docx|document|package)/i,
  /docx (parse|parser|package)/i,
  /badzipfile/i,
  /not a zip file/i,
  /word\/document\.xml/i,
  /xmlsyntaxerror/i,
  /not well-formed/i,
  /corrupt/i,
  /malformed/i
];

const PYTHON_ENVIRONMENT_FAILURE_PATTERNS = [
  /no module named ['"]src['"]/i,
  /no module named ['"]docx['"]/i,
  /python-docx is required/i,
  /spawn .*enoent/i,
  /failed to start python tool/i
];

export function shouldFallbackToNativeDocxObservation(err: unknown): boolean {
  if (!(err instanceof AgentError)) {
    return false;
  }

  if (err.info.code === "E_PYTHON_DEPENDENCY_MISSING") {
    return true;
  }

  const message = err.info.message ?? "";
  if (matchesAny(message, DOCX_PARSE_REJECTION_PATTERNS)) {
    return true;
  }

  if (matchesAny(message, PYTHON_ENVIRONMENT_FAILURE_PATTERNS)) {
    return false;
  }

  return err.info.code === "E_DOCX_PARSE_FAILED";
}

function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}
