export const PHASE4_MATERIALIZED_PATCH_TYPES = new Set([
  "set_text",
  "set_attribute",
  "set_attr",
  "remove_attr",
  "ensure_node",
  "remove_node",
  "replace_node_xml"
] as const);

export const PHASE4_STRUCTURED_REJECTIONS = new Set([
  "merge_paragraph",
  "split_paragraph"
] as const);

export const PHASE4_SYNTHETIC_TARGET_PREFIXES = [
  "target:document:section:0",
  "target:styles:",
  "target:numbering:",
  "target:settings:"
] as const;
