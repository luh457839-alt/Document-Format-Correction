import { AgentError } from "../core/errors.js";
import type { Operation } from "../core/types.js";

const HIGHLIGHT_COLOR_ALIASES: Record<string, string> = {
  yellow: "yellow",
  "#ffff00": "yellow",
  ffff00: "yellow",
  green: "green",
  "#00ff00": "green",
  "00ff00": "green",
  cyan: "cyan",
  "#00ffff": "cyan",
  "00ffff": "cyan",
  magenta: "magenta",
  "#ff00ff": "magenta",
  ff00ff: "magenta",
  blue: "blue",
  "#0000ff": "blue",
  "0000ff": "blue",
  red: "red",
  "#ff0000": "red",
  ff0000: "red",
  darkblue: "darkBlue",
  "#000080": "darkBlue",
  "000080": "darkBlue",
  darkcyan: "darkCyan",
  "#008080": "darkCyan",
  "008080": "darkCyan",
  darkgreen: "darkGreen",
  "#008000": "darkGreen",
  "008000": "darkGreen",
  darkmagenta: "darkMagenta",
  "#800080": "darkMagenta",
  "800080": "darkMagenta",
  darkred: "darkRed",
  "#800000": "darkRed",
  "800000": "darkRed",
  darkyellow: "darkYellow",
  "#808000": "darkYellow",
  "808000": "darkYellow",
  darkgray: "darkGray",
  "#808080": "darkGray",
  "808080": "darkGray",
  lightgray: "lightGray",
  "#c0c0c0": "lightGray",
  c0c0c0: "lightGray",
  black: "black",
  "#000000": "black",
  "000000": "black",
  none: "none"
};

export function normalizeWriteOperationPayload(operation: Operation): Record<string, unknown> {
  const payload = operation.payload;
  switch (operation.type) {
    case "set_font": {
      const fontName = pickNonEmptyString(payload.font_name, payload.fontName);
      if (!fontName) {
        throw invalidPayload(operation.type, "set_font requires font_name");
      }
      return { font_name: fontName };
    }
    case "set_size": {
      const fontSize = pickPositiveNumber(payload.font_size_pt, payload.fontSizePt, payload.fontSize);
      if (fontSize === undefined) {
        throw invalidPayload(operation.type, "set_size requires font_size_pt");
      }
      return { font_size_pt: fontSize };
    }
    case "set_line_spacing": {
      const lineSpacing = pickLineSpacingValue(payload.line_spacing);
      if (lineSpacing === undefined) {
        throw invalidPayload(
          operation.type,
          "set_line_spacing requires line_spacing as a positive number or { mode: 'exact', pt: positive number }"
        );
      }
      return { line_spacing: lineSpacing };
    }
    case "set_alignment": {
      const alignment = pickNonEmptyString(payload.paragraph_alignment, payload.alignment);
      if (!alignment) {
        throw invalidPayload(operation.type, "set_alignment requires paragraph_alignment");
      }
      return { paragraph_alignment: alignment };
    }
    case "set_font_color": {
      const color = pickHexColor(payload.font_color, payload.fontColor);
      if (!color) {
        throw invalidPayload(operation.type, "set_font_color requires font_color");
      }
      return { font_color: color };
    }
    case "set_bold":
      return { is_bold: pickRequiredBoolean(operation.type, "is_bold", payload.is_bold, payload.isBold) };
    case "set_italic":
      return { is_italic: pickRequiredBoolean(operation.type, "is_italic", payload.is_italic, payload.isItalic) };
    case "set_underline":
      return {
        is_underline: pickRequiredBoolean(operation.type, "is_underline", payload.is_underline, payload.isUnderline)
      };
    case "set_strike":
      return { is_strike: pickRequiredBoolean(operation.type, "is_strike", payload.is_strike, payload.isStrike) };
    case "set_highlight_color": {
      const highlight = pickHighlightColor(payload.highlight_color, payload.highlightColor);
      if (!highlight) {
        throw invalidPayload(operation.type, "set_highlight_color requires highlight_color");
      }
      return { highlight_color: highlight };
    }
    case "set_all_caps":
      return {
        is_all_caps: pickRequiredBoolean(operation.type, "is_all_caps", payload.is_all_caps, payload.isAllCaps)
      };
    case "merge_paragraph":
      return {};
    case "split_paragraph": {
      const splitOffset = pickPositiveInteger(payload.split_offset, payload.splitOffset);
      if (splitOffset === undefined) {
        throw invalidPayload(operation.type, "split_paragraph requires split_offset");
      }
      return { split_offset: splitOffset };
    }
    default:
      return payload as Record<string, unknown>;
  }
}

function invalidPayload(operationType: Operation["type"], message: string): AgentError {
  return new AgentError({
    code: "E_INVALID_OPERATION_PAYLOAD",
    message: `${operationType}: ${message}`,
    retryable: false
  });
}

function pickNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function pickPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const num = pickPositiveNumber(value);
    if (num !== undefined && Number.isInteger(num)) {
      return num;
    }
  }
  return undefined;
}

function pickLineSpacingValue(value: unknown): number | { mode: "exact"; pt: number } | undefined {
  const multiple = pickPositiveNumber(value);
  if (multiple !== undefined) {
    return multiple;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const mode = pickNonEmptyString((value as { mode?: unknown }).mode);
  if (mode !== "exact") {
    return undefined;
  }
  const pt = pickPositiveNumber((value as { pt?: unknown }).pt);
  if (pt === undefined) {
    return undefined;
  }
  return { mode: "exact", pt };
}

function pickHexColor(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
      return normalized.toUpperCase();
    }
  }
  return undefined;
}

function pickHighlightColor(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    const normalized = value.trim().replace(/\s+/g, "").toLowerCase();
    const mapped = HIGHLIGHT_COLOR_ALIASES[normalized];
    if (mapped) {
      return mapped;
    }
  }
  return undefined;
}

function pickRequiredBoolean(operationType: Operation["type"], fieldName: string, ...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number" && (value === 0 || value === 1)) {
      return value === 1;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") {
        return true;
      }
      if (normalized === "false" || normalized === "0") {
        return false;
      }
    }
  }
  throw invalidPayload(operationType, `${operationType} requires ${fieldName}`);
}
