import { readFile } from "node:fs/promises";
import path from "node:path";
import { AgentError } from "../core/errors.js";
import { parseTemplateContract, type TemplateContract } from "./template-contract.js";

export async function loadTemplateConfig(templatePath: string): Promise<TemplateContract> {
  const normalizedPath = normalizePath(templatePath, "templatePath");
  let rawText = "";
  try {
    rawText = await readFile(normalizedPath, "utf8");
  } catch (err) {
    throw new AgentError({
      code: "E_TEMPLATE_CONFIG_LOAD_FAILED",
      message: `Failed to read template config '${normalizedPath}': ${String(err)}`,
      retryable: false,
      cause: err
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new AgentError({
      code: "E_TEMPLATE_CONFIG_INVALID_JSON",
      message: `Template config '${path.basename(normalizedPath)}' is not valid JSON: ${String(err)}`,
      retryable: false,
      cause: err
    });
  }

  try {
    return parseTemplateContract(parsed);
  } catch (err) {
    if (err instanceof AgentError) {
      throw new AgentError({
        ...err.info,
        message: `Template config '${normalizedPath}' is invalid: ${err.info.message}`
      });
    }
    throw err;
  }
}

function normalizePath(value: string, field: string): string {
  if (!value.trim()) {
    throw new AgentError({
      code: "E_TEMPLATE_CONFIG_INVALID_PATH",
      message: `${field} must be a non-empty string.`,
      retryable: false
    });
  }
  return value.trim();
}
