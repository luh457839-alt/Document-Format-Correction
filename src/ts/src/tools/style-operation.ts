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
    case "set_page_layout": {
      const pageLayout: Record<string, unknown> = {};
      const paperSize = pickPaperSize(payload.paper_size, payload.paperSize);
      if (paperSize !== undefined) {
        pageLayout.paper_size = paperSize;
      }
      for (const [outputField, values] of [
        ["margin_top_cm", [payload.margin_top_cm, payload.marginTopCm]],
        ["margin_bottom_cm", [payload.margin_bottom_cm, payload.marginBottomCm]],
        ["margin_left_cm", [payload.margin_left_cm, payload.marginLeftCm]],
        ["margin_right_cm", [payload.margin_right_cm, payload.marginRightCm]]
      ] as const) {
        const margin = pickPositiveNumber(...values);
        if (margin !== undefined) {
          pageLayout[outputField] = margin;
        }
      }
      if (Object.keys(pageLayout).length === 0) {
        throw invalidPayload(operation.type, "set_page_layout requires paper_size or at least one positive margin_*_cm");
      }
      return pageLayout;
    }
    case "set_paragraph_spacing": {
      const before = pickPositiveOrZeroNumber(payload.before_pt, payload.beforePt, payload.space_before_pt, payload.spaceBeforePt);
      const after = pickPositiveOrZeroNumber(payload.after_pt, payload.afterPt, payload.space_after_pt, payload.spaceAfterPt);
      const spacing: Record<string, unknown> = {};
      if (before !== undefined) {
        spacing.space_before_pt = before;
      }
      if (after !== undefined) {
        spacing.space_after_pt = after;
      }
      if (Object.keys(spacing).length === 0) {
        throw invalidPayload(operation.type, "set_paragraph_spacing requires before_pt or after_pt");
      }
      return spacing;
    }
    case "set_paragraph_indent": {
      const directIndent = pickPositiveOrZeroNumber(
        payload.first_line_indent_pt,
        payload.firstLineIndentPt
      );
      if (directIndent !== undefined) {
        return { first_line_indent_pt: directIndent };
      }
      const indentChars = pickPositiveNumber(payload.first_line_indent_chars, payload.firstLineIndentChars);
      if (indentChars === undefined) {
        throw invalidPayload(operation.type, "set_paragraph_indent requires first_line_indent_pt or first_line_indent_chars");
      }
      const fontSize = pickPositiveNumber(payload.font_size_pt, payload.fontSizePt, payload.fontSize) ?? 12;
      return { first_line_indent_pt: indentChars * fontSize };
    }
    case "set_style_definition": {
      const styleDefinition = pickNonEmptyRecord(payload.style_definition, payload.styleDefinition);
      if (!styleDefinition) {
        throw invalidPayload(operation.type, "set_style_definition requires style_definition");
      }
      return { style_definition: styleDefinition };
    }
    case "set_numbering_level": {
      const numberingLevel = pickNonEmptyRecord(payload.numbering_level, payload.numberingLevel);
      if (!numberingLevel) {
        throw invalidPayload(operation.type, "set_numbering_level requires numbering_level");
      }
      return { numbering_level: numberingLevel };
    }
    case "set_settings_flag": {
      const settings = pickNonEmptyRecord(payload.settings);
      if (!settings) {
        throw invalidPayload(operation.type, "set_settings_flag requires settings");
      }
      return { settings };
    }
    case "set_attr": {
      const name = pickNonEmptyString(payload.name);
      if (!name) {
        throw invalidPayload(operation.type, "set_attr requires name");
      }
      return {
        ...(pickNonEmptyString(payload.path) ? { path: String(payload.path).trim() } : {}),
        name,
        value: payload.value
      };
    }
    case "remove_attr": {
      const name = pickNonEmptyString(payload.name);
      if (!name) {
        throw invalidPayload(operation.type, "remove_attr requires name");
      }
      return {
        ...(pickNonEmptyString(payload.path) ? { path: String(payload.path).trim() } : {}),
        name
      };
    }
    case "set_text":
      return {
        ...(pickNonEmptyString(payload.path) ? { path: String(payload.path).trim() } : {}),
        value: payload.value ?? ""
      };
    case "remove_node":
      return {
        ...(pickNonEmptyString(payload.path) ? { path: String(payload.path).trim() } : {})
      };
    case "ensure_node": {
      const path = pickNonEmptyString(payload.path);
      const xmlTag = pickNonEmptyString(payload.xml_tag, payload.xmlTag);
      if (!path || !xmlTag) {
        throw invalidPayload(operation.type, "ensure_node requires path and xml_tag");
      }
      const attrs = pickStringRecord(payload.attrs);
      return {
        path,
        xml_tag: xmlTag,
        ...(attrs ? { attrs } : {})
      };
    }
    case "replace_node_xml": {
      const nodeXml = pickNonEmptyString(payload.node_xml, payload.nodeXml);
      if (!nodeXml) {
        throw invalidPayload(operation.type, "replace_node_xml requires node_xml");
      }
      return {
        ...(pickNonEmptyString(payload.path) ? { path: String(payload.path).trim() } : {}),
        node_xml: nodeXml
      };
    }
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

function pickPaperSize(...values: unknown[]): "A4" | "Letter" | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "a4") {
      return "A4";
    }
    if (normalized === "letter") {
      return "Letter";
    }
  }
  return undefined;
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

function pickPositiveOrZeroNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
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

function pickNonEmptyRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function pickStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(([, entryValue]) => typeof entryValue === "string");
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
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
