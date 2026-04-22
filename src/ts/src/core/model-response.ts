export interface ModelResponseDiagnostics {
  finishReason?: string;
  refusal?: string;
  messageShape?: string;
  choiceCount?: number;
  recoveredFrom?: string;
}

export interface ModelResponseContentResult {
  content: string | null;
  diagnostics: ModelResponseDiagnostics;
  issue:
    | "ok"
    | "missing_choices"
    | "missing_message"
    | "empty_string"
    | "missing_content"
    | "array_without_text"
    | "unsupported_content"
    | "refusal";
}

export function parseOpenAiCompatibleChatText(rawText: string): ModelResponseContentResult {
  return extractOpenAiCompatibleChatText(JSON.parse(rawText) as unknown);
}

export function extractOpenAiCompatibleChatText(parsed: unknown): ModelResponseContentResult {
  if (!isObject(parsed) || !Array.isArray(parsed.choices)) {
    return {
      content: null,
      diagnostics: {},
      issue: "missing_choices"
    };
  }

  const choiceCount = parsed.choices.length;
  const firstChoice = parsed.choices[0];
  const finishReason =
    isObject(firstChoice) && typeof firstChoice.finish_reason === "string" && firstChoice.finish_reason.trim()
      ? firstChoice.finish_reason.trim()
      : undefined;

  if (!isObject(firstChoice) || !isObject(firstChoice.message)) {
    return {
      content: null,
      diagnostics: {
        choiceCount,
        finishReason,
        messageShape: describeChoiceShape(firstChoice)
      },
      issue: "missing_message"
    };
  }

  const message = firstChoice.message;
  const refusal =
    typeof message.refusal === "string" && message.refusal.trim() ? message.refusal.trim() : undefined;
  const diagnostics: ModelResponseDiagnostics = {
    choiceCount,
    finishReason,
    refusal,
    messageShape: describeMessageShape(message)
  };
  const content = message.content;

  if (typeof content === "string") {
    const normalized = content.trim();
    return {
      content: normalized || null,
      diagnostics,
      issue: normalized ? "ok" : "empty_string"
    };
  }

  if (Array.isArray(content)) {
    const normalized = content
      .map(extractVisibleText)
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("")
      .trim();
    return {
      content: normalized || null,
      diagnostics,
      issue: normalized ? "ok" : "array_without_text"
    };
  }

  if (refusal) {
    return {
      content: null,
      diagnostics,
      issue: "refusal"
    };
  }

  if (content === undefined || content === null) {
    const fallback = extractFallbackEnvelopeText(firstChoice, message);
    if (fallback) {
      return {
        content: fallback.content,
        diagnostics: {
          ...diagnostics,
          recoveredFrom: fallback.recoveredFrom
        },
        issue: "ok"
      };
    }
    return {
      content: null,
      diagnostics,
      issue: "missing_content"
    };
  }

  return {
    content: null,
    diagnostics,
    issue: "unsupported_content"
  };
}

export function buildModelResponseErrorMessage(
  payloadLabel: string,
  result: ModelResponseContentResult
): string {
  const summary = summarizeModelResponseDiagnostics(result.diagnostics);
  const suffix = summary ? ` Envelope summary: ${summary}.` : "";
  switch (result.issue) {
    case "ok":
      return `${payloadLabel} returned content.${suffix}`;
    case "missing_choices":
      return `${payloadLabel} is missing choices[].${suffix}`;
    case "missing_message":
      return `${payloadLabel} has incomplete choices[0] without message.${suffix}`;
    case "empty_string":
      return `${payloadLabel} has empty message content string.${suffix}`;
    case "array_without_text":
      return `${payloadLabel} has message content array without text parts.${suffix}`;
    case "refusal":
      return `${payloadLabel} contains refusal instead of message content.${suffix}`;
    case "missing_content":
      return `${payloadLabel} is missing message content.${suffix}`;
    case "unsupported_content":
      return `${payloadLabel} has unsupported message content type.${suffix}`;
  }
}

export function shouldRetryMissingModelContent(result: ModelResponseContentResult): boolean {
  return (
    result.content === null &&
    !result.diagnostics.refusal &&
    (result.issue === "empty_string" ||
      result.issue === "missing_content" ||
      result.issue === "array_without_text" ||
      result.issue === "unsupported_content")
  );
}

export function summarizeModelResponseDiagnostics(diagnostics: ModelResponseDiagnostics): string {
  const parts: string[] = [];
  if (typeof diagnostics.choiceCount === "number") {
    parts.push(`choices=${diagnostics.choiceCount}`);
  }
  if (diagnostics.finishReason) {
    parts.push(`finish_reason=${truncateDiagnostic(diagnostics.finishReason, 40)}`);
  }
  if (diagnostics.refusal) {
    parts.push(`refusal=${truncateDiagnostic(diagnostics.refusal, 80)}`);
  }
  if (diagnostics.messageShape) {
    parts.push(`message=${diagnostics.messageShape}`);
  }
  if (diagnostics.recoveredFrom) {
    parts.push(`recovered_from=${diagnostics.recoveredFrom}`);
  }
  return parts.join(", ");
}

function extractFallbackEnvelopeText(
  choice: unknown,
  message: Record<string, unknown>
): { content: string; recoveredFrom: string } | null {
  const candidates: Array<{ value: unknown; recoveredFrom: string }> = [
    { value: message.text, recoveredFrom: "message.text" },
    { value: message.output_text, recoveredFrom: "message.output_text" },
    { value: message.content_text, recoveredFrom: "message.content_text" }
  ];

  if (isObject(choice)) {
    candidates.push(
      { value: choice.text, recoveredFrom: "choices[0].text" },
      { value: choice.output_text, recoveredFrom: "choices[0].output_text" }
    );
    if (isObject(choice.delta)) {
      candidates.push({ value: choice.delta.content, recoveredFrom: "choices[0].delta.content" });
    }
  }

  for (const candidate of candidates) {
    const normalized = extractTextCandidate(candidate.value);
    if (normalized) {
      return {
        content: normalized,
        recoveredFrom: candidate.recoveredFrom
      };
    }
  }

  return null;
}

function extractTextCandidate(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }
  if (Array.isArray(value)) {
    const normalized = value
      .map(extractVisibleText)
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("")
      .trim();
    return normalized || null;
  }
  return extractVisibleText(value)?.trim() || null;
}

function extractVisibleText(part: unknown): string | null {
  if (typeof part === "string") {
    return part;
  }
  if (!isObject(part)) {
    return null;
  }

  if (typeof part.text === "string") {
    return part.text;
  }

  if (isObject(part.text) && typeof part.text.value === "string") {
    return part.text.value;
  }

  if (typeof part.value === "string" && isTextLikePartType(part.type)) {
    return part.value;
  }

  return null;
}

function describeChoiceShape(choice: unknown): string {
  if (!isObject(choice)) {
    return `type=${describeValueType(choice)}`;
  }
  const keys = Object.keys(choice).sort();
  return `keys=${keys.length > 0 ? keys.join(",") : "none"}`;
}

function describeMessageShape(message: Record<string, unknown>): string {
  const keys = Object.keys(message).sort();
  return `keys=${keys.length > 0 ? keys.join(",") : "none"};content=${describeContentShape(message.content)}`;
}

function describeContentShape(content: unknown): string {
  if (Array.isArray(content)) {
    return `array(${content.length})`;
  }
  if (content === null) {
    return "null";
  }
  return describeValueType(content);
}

function describeValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function truncateDiagnostic(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextLikePartType(value: unknown): boolean {
  return typeof value === "string" && /text/i.test(value);
}
