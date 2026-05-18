import { z } from "zod";
import type { OperationType } from "../core/types.js";
import type { ToolValidationMessage, WriteToolInput } from "./contracts.js";

const operationTypes = [
  "set_font",
  "set_size",
  "set_line_spacing",
  "set_alignment",
  "set_font_color",
  "set_bold",
  "set_italic",
  "set_underline",
  "set_strike",
  "set_highlight_color",
  "set_all_caps",
  "set_page_layout",
  "set_paragraph_spacing",
  "set_paragraph_indent",
  "set_style_definition",
  "set_numbering_level",
  "set_settings_flag",
  "set_attr",
  "remove_attr",
  "set_text",
  "remove_node",
  "ensure_node",
  "replace_node_xml",
  "merge_paragraph",
  "split_paragraph"
] as const satisfies readonly OperationType[];

const nonEmptyString = z.string().trim().min(1);

const nodeSelectorSchema = z
  .object({
    scope: z.enum(["body", "heading", "list_item", "all_text", "paragraph_ids"]),
    headingLevel: z.number().int().min(0).optional(),
    paragraphIds: z.array(nonEmptyString).min(1).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "paragraph_ids" && (!value.paragraphIds || value.paragraphIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "paragraphIds is required for paragraph_ids selectors",
        path: ["paragraphIds"]
      });
    }
  });

const targetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("selector"),
      selector: nodeSelectorSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("semantic_selector"),
      semantic: z.enum(["semantic_heading", "title_like_paragraphs", "body_like_paragraphs"])
    })
    .strict(),
  z
    .object({
      kind: z.literal("node_ids"),
      node_ids: z.array(nonEmptyString).min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("patch_targets"),
      patch_target_ids: z.array(nonEmptyString).min(1),
      patch_part_paths: z.array(nonEmptyString).min(1).optional()
    })
    .strict()
]);

const writeToolInputSchema = z
  .object({
    request_id: nonEmptyString,
    operation: z.enum(operationTypes),
    target: targetSchema,
    payload: z.record(z.string(), z.unknown()),
    idempotency_key: nonEmptyString.optional()
  })
  .strict();

export function parseWriteToolInput(input: unknown): WriteToolInput | ToolValidationMessage {
  const parsed = writeToolInputSchema.safeParse(input);
  if (parsed.success) {
    return parsed.data as WriteToolInput;
  }

  return {
    ok: false,
    stage: resolveValidationStage(parsed.error.issues),
    error_code: "E_TOOL_INPUT_INVALID",
    message: parsed.error.issues.map((issue) => issue.message).join("; "),
    retryable: false,
    details: {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    }
  };
}

function resolveValidationStage(issues: z.ZodIssue[]): ToolValidationMessage["stage"] {
  return issues.some((issue) => issue.path[0] === "payload") ? "payload" : "target";
}
