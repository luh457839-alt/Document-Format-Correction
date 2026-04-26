import { AgentError } from "../core/errors.js";

export const TEMPLATE_CONTRACT_SCHEMA_VERSION = "2.0";

type JsonRecord = Record<string, unknown>;

export interface TemplateMeta extends JsonRecord {
  id: string;
  name: string;
  version: string;
  schema_version: string;
  description?: string;
  locale?: string;
  author?: string;
  tags?: string[];
}

export interface SemanticBlock extends JsonRecord {
  key: string;
  label: string;
  description: string;
  examples: string[];
  required: boolean;
  multiple: boolean;
  aliases?: string[];
  negative_examples?: string[];
  notes?: string;
}

export type DerivedSemanticMode = "aggregate" | "refine";

export interface DerivedSemanticOperation extends JsonRecord {
  text_style: JsonRecord;
  paragraph_style: JsonRecord;
  relative_spacing?: JsonRecord;
  placement_rules?: JsonRecord;
  language_font_overrides?: OperationBlockLanguageFontOverrides;
}

export type TemplatePatchSelectorPart =
  | "document"
  | "header"
  | "footer"
  | "styles"
  | "numbering"
  | "settings"
  | "by_part_path";

export type TemplatePatchSelectorScope =
  | "paragraph"
  | "run"
  | "table"
  | "row"
  | "cell"
  | "section"
  | "style"
  | "numbering_level"
  | "settings_node";

export interface TemplatePatchSelectorMatch extends JsonRecord {
  paragraph_ids?: string[];
  block_ids?: string[];
  style_id?: string;
  num_id?: string;
  ilvl?: number;
  section_index?: number;
  part_path?: string;
  xml_path?: string;
}

export interface TemplatePatchSelector extends JsonRecord {
  part: TemplatePatchSelectorPart;
  scope: TemplatePatchSelectorScope;
  match?: TemplatePatchSelectorMatch;
}

export type TemplatePatchPrimitiveType =
  | "set_attr"
  | "remove_attr"
  | "set_text"
  | "remove_node"
  | "ensure_node"
  | "replace_node_xml";

export type TemplatePatchAliasType =
  | "set_run_style"
  | "set_paragraph_style"
  | "set_section_layout"
  | "set_table_style"
  | "set_table_cell_style"
  | "set_style_definition"
  | "set_numbering_level"
  | "set_settings_flag";

export type TemplatePatchOperationType = TemplatePatchPrimitiveType | TemplatePatchAliasType;

export interface TemplatePatchOperation extends JsonRecord {
  type: TemplatePatchOperationType;
  path?: string;
  name?: string;
  value?: unknown;
  xml_tag?: string;
  attrs?: Record<string, string>;
  node_xml?: string;
  text_style?: JsonRecord;
  paragraph_style?: JsonRecord;
  table_style?: JsonRecord;
  cell_style?: JsonRecord;
  section_layout?: JsonRecord;
  style_definition?: JsonRecord;
  numbering_level?: JsonRecord;
  settings?: JsonRecord;
  style_id?: string;
}

export interface TemplatePatchBlock extends JsonRecord {
  semantic_key: string;
  selector: TemplatePatchSelector;
  operations: TemplatePatchOperation[];
}

export interface DerivedSemanticBlock extends JsonRecord {
  key: string;
  label: string;
  inherits_from: string[];
  examples: string[];
  mode?: DerivedSemanticMode;
  negative_examples?: string[];
  text_hints?: string[];
  operation: DerivedSemanticOperation;
}

export interface LayoutGlobalRules extends JsonRecord {
  document_scope?: "full_document";
  ordering?: string[];
  numbering_patterns?: string[];
  page_layout_reference?: JsonRecord;
  spacing_tolerance?: unknown;
  allow_unclassified_paragraphs?: boolean;
}

export interface LayoutSemanticRule extends JsonRecord {
  semantic_key: string;
  position_hints?: string[];
  text_hints?: string[];
  numbering_patterns?: string[];
  style_hints?: JsonRecord;
  placement_rules?: JsonRecord;
  occurrence?: {
    min_occurs?: number;
    max_occurs?: number;
  } & JsonRecord;
  adjacency_rules?: JsonRecord;
}

export interface LayoutRules extends JsonRecord {
  global_rules: LayoutGlobalRules;
  semantic_rules: LayoutSemanticRule[];
}

export interface OperationBlock extends JsonRecord {
  semantic_key: string;
  text_style: JsonRecord;
  paragraph_style: JsonRecord;
  relative_spacing?: JsonRecord;
  placement_rules?: JsonRecord;
  language_font_overrides?: OperationBlockLanguageFontOverrides;
}

export interface OperationBlockLanguageFont extends JsonRecord {
  font_name: string;
}

export interface OperationBlockLanguageFontOverrides extends JsonRecord {
  zh?: OperationBlockLanguageFont;
  en?: OperationBlockLanguageFont;
}

export interface ClassificationMatch extends JsonRecord {
  semantic_key: string;
  paragraph_ids: string[];
  confidence?: number;
  reason?: string;
}

export interface ClassificationConflict extends JsonRecord {
  paragraph_id: string;
  candidate_semantic_keys: string[];
  reason?: string;
}

export interface ClassificationContract extends JsonRecord {
  scope: "paragraph";
  single_owner_per_paragraph?: boolean;
  template_id?: string;
  matches?: ClassificationMatch[];
  unmatched_paragraph_ids?: string[];
  conflicts?: ClassificationConflict[];
  overall_confidence?: number;
}

export interface ValidationPolicy extends JsonRecord {
  enforce_validation?: boolean;
  min_confidence?: number;
  require_all_required_semantics?: boolean;
  reject_conflicting_matches?: boolean;
  reject_order_violations?: boolean;
  reject_style_violations?: boolean;
  reject_unmatched_when_required?: boolean;
}

export interface TemplateContract extends JsonRecord {
  template_meta: TemplateMeta;
  semantic_blocks: SemanticBlock[];
  derived_semantics?: DerivedSemanticBlock[];
  layout_rules: LayoutRules;
  patch_blocks: TemplatePatchBlock[];
  operation_blocks?: OperationBlock[];
  classification_contract: ClassificationContract;
  validation_policy: ValidationPolicy;
  style_reference?: JsonRecord;
}

export function parseTemplateContract(input: unknown): TemplateContract {
  validateTemplateContract(input);
  const contract = input as TemplateContract;
  const normalizedPatchBlocks = Array.isArray(contract.patch_blocks) ? contract.patch_blocks : [];
  const patchBlocks =
    normalizedPatchBlocks.length > 0
      ? normalizedPatchBlocks
      : (contract.operation_blocks ?? []).map(convertLegacyOperationBlockToPatchBlock);
  return {
    ...contract,
    patch_blocks: patchBlocks
  };
}

export function validateTemplateContract(input: unknown): asserts input is TemplateContract {
  const contract = requireObject(input, "template contract");
  const templateMeta = requireObject(contract.template_meta, "template_meta");
  const schemaVersion = requireNonEmptyString(templateMeta.schema_version, "template_meta.schema_version");
  if (schemaVersion !== TEMPLATE_CONTRACT_SCHEMA_VERSION) {
    throw invalidTemplateContract(
      "E_TEMPLATE_SCHEMA_VERSION_UNSUPPORTED",
      `template_meta.schema_version '${schemaVersion}' is incompatible; expected '${TEMPLATE_CONTRACT_SCHEMA_VERSION}'.`
    );
  }

  requireNonEmptyString(templateMeta.id, "template_meta.id");
  requireNonEmptyString(templateMeta.name, "template_meta.name");
  requireNonEmptyString(templateMeta.version, "template_meta.version");

  const semanticBlocks = requireArray(contract.semantic_blocks, "semantic_blocks");
  const semanticKeySet = new Set<string>();
  for (const [index, rawSemanticBlock] of semanticBlocks.entries()) {
    const semanticBlock = requireObject(rawSemanticBlock, `semantic_blocks[${index}]`);
    const semanticKey = requireNonEmptyString(semanticBlock.key, `semantic_blocks[${index}].key`);
    if (semanticKeySet.has(semanticKey)) {
      throw invalidTemplateContract(
        "E_TEMPLATE_CONTRACT_INVALID",
        `semantic_blocks contains duplicate key '${semanticKey}'.`
      );
    }
    semanticKeySet.add(semanticKey);
    requireNonEmptyString(semanticBlock.label, `semantic_blocks[${index}].label`);
    requireNonEmptyString(semanticBlock.description, `semantic_blocks[${index}].description`);
    requireStringArray(semanticBlock.examples, `semantic_blocks[${index}].examples`, { allowEmpty: false });
    requireBoolean(semanticBlock.required, `semantic_blocks[${index}].required`);
    requireBoolean(semanticBlock.multiple, `semantic_blocks[${index}].multiple`);
  }

  const derivedSemanticBlocks =
    contract.derived_semantics !== undefined
      ? requireArray(contract.derived_semantics, "derived_semantics")
      : [];
  const derivedSemanticKeySet = new Set<string>();
  for (const [index, rawDerivedSemanticBlock] of derivedSemanticBlocks.entries()) {
    const derivedSemanticBlock = requireObject(rawDerivedSemanticBlock, `derived_semantics[${index}]`);
    const semanticKey = requireNonEmptyString(derivedSemanticBlock.key, `derived_semantics[${index}].key`);
    if (semanticKeySet.has(semanticKey) || derivedSemanticKeySet.has(semanticKey)) {
      throw invalidTemplateContract(
        "E_TEMPLATE_CONTRACT_INVALID",
        `derived_semantics contains duplicate or conflicting key '${semanticKey}'.`
      );
    }
    derivedSemanticKeySet.add(semanticKey);
    requireNonEmptyString(derivedSemanticBlock.label, `derived_semantics[${index}].label`);
    if (derivedSemanticBlock.mode !== undefined && derivedSemanticBlock.mode !== "aggregate" && derivedSemanticBlock.mode !== "refine") {
      throw invalidTemplateContract(
        "E_TEMPLATE_CONTRACT_INVALID",
        `derived_semantics[${index}].mode must be 'aggregate' or 'refine'.`
      );
    }
    const inheritsFrom = requireStringArray(derivedSemanticBlock.inherits_from, `derived_semantics[${index}].inherits_from`, {
      allowEmpty: false
    });
    for (const inheritedSemanticKey of inheritsFrom) {
      ensureSemanticKeyExists(inheritedSemanticKey, semanticKeySet, "derived_semantics");
    }
    requireStringArray(derivedSemanticBlock.examples, `derived_semantics[${index}].examples`, { allowEmpty: false });
    if (derivedSemanticBlock.negative_examples !== undefined) {
      requireStringArray(derivedSemanticBlock.negative_examples, `derived_semantics[${index}].negative_examples`, {
        allowEmpty: false
      });
    }
    if (derivedSemanticBlock.text_hints !== undefined) {
      requireStringArray(derivedSemanticBlock.text_hints, `derived_semantics[${index}].text_hints`, {
        allowEmpty: false
      });
    }
    const operation = requireObject(derivedSemanticBlock.operation, `derived_semantics[${index}].operation`);
    requireObject(operation.text_style, `derived_semantics[${index}].operation.text_style`);
    requireObject(operation.paragraph_style, `derived_semantics[${index}].operation.paragraph_style`);
    validateLanguageFontOverrides(
      operation.language_font_overrides,
      `derived_semantics[${index}].operation.language_font_overrides`
    );
  }

  const layoutRules = requireObject(contract.layout_rules, "layout_rules");
  const globalRules = requireObject(layoutRules.global_rules, "layout_rules.global_rules");
  if (globalRules.document_scope !== undefined && globalRules.document_scope !== "full_document") {
    throw invalidTemplateContract(
      "E_TEMPLATE_CONTRACT_INVALID",
      `layout_rules.global_rules.document_scope must be 'full_document'.`
    );
  }
  if (globalRules.ordering !== undefined) {
    const ordering = requireStringArray(globalRules.ordering, "layout_rules.global_rules.ordering");
    for (const semanticKey of ordering) {
      ensureSemanticKeyExists(semanticKey, semanticKeySet, "layout_rules.global_rules.ordering");
    }
  }

  const semanticRules = requireArray(layoutRules.semantic_rules, "layout_rules.semantic_rules");
  for (const [index, rawSemanticRule] of semanticRules.entries()) {
    const semanticRule = requireObject(rawSemanticRule, `layout_rules.semantic_rules[${index}]`);
    const semanticKey = requireNonEmptyString(
      semanticRule.semantic_key,
      `layout_rules.semantic_rules[${index}].semantic_key`
    );
    ensureSemanticKeyExists(semanticKey, semanticKeySet, "layout_rules.semantic_rules");
    if (semanticRule.numbering_patterns !== undefined) {
      requireStringArray(
        semanticRule.numbering_patterns,
        `layout_rules.semantic_rules[${index}].numbering_patterns`,
        {
          allowEmpty: false
        }
      );
    }
  }

  const rawPatchBlocks = Array.isArray(contract.patch_blocks) ? contract.patch_blocks : [];
  const rawOperationBlocks = Array.isArray(contract.operation_blocks) ? contract.operation_blocks : [];
  if (rawPatchBlocks.length === 0 && rawOperationBlocks.length === 0) {
    throw invalidTemplateContract(
      "E_TEMPLATE_CONTRACT_INVALID",
      "template contract requires patch_blocks."
    );
  }

  if (rawPatchBlocks.length > 0) {
    const patchBlocks = requireArray(contract.patch_blocks, "patch_blocks");
    for (const [index, rawPatchBlock] of patchBlocks.entries()) {
      const patchBlock = requireObject(rawPatchBlock, `patch_blocks[${index}]`);
      requireNonEmptyString(patchBlock.semantic_key, `patch_blocks[${index}].semantic_key`);
      const selector = requireObject(patchBlock.selector, `patch_blocks[${index}].selector`);
      validatePatchSelector(selector, `patch_blocks[${index}].selector`);
      const operations = requireArray(patchBlock.operations, `patch_blocks[${index}].operations`);
      if (operations.length === 0) {
        throw invalidTemplateContract(
          "E_TEMPLATE_CONTRACT_INVALID",
          `patch_blocks[${index}].operations must not be empty.`
        );
      }
      operations.forEach((rawOperation, operationIndex) => {
        validatePatchOperation(
          requireObject(rawOperation, `patch_blocks[${index}].operations[${operationIndex}]`),
          `patch_blocks[${index}].operations[${operationIndex}]`
        );
      });
    }
  } else {
    const operationBlocks = requireArray(contract.operation_blocks, "operation_blocks");
    const operationSemanticCounts = new Map<string, number>();
    for (const [index, rawOperationBlock] of operationBlocks.entries()) {
      const operationBlock = requireObject(rawOperationBlock, `operation_blocks[${index}]`);
      const semanticKey = requireNonEmptyString(operationBlock.semantic_key, `operation_blocks[${index}].semantic_key`);
      ensureSemanticKeyExists(semanticKey, semanticKeySet, "operation_blocks");
      requireObject(operationBlock.text_style, `operation_blocks[${index}].text_style`);
      requireObject(operationBlock.paragraph_style, `operation_blocks[${index}].paragraph_style`);
      validateLanguageFontOverrides(
        operationBlock.language_font_overrides,
        `operation_blocks[${index}].language_font_overrides`
      );
      operationSemanticCounts.set(semanticKey, (operationSemanticCounts.get(semanticKey) ?? 0) + 1);
    }

    for (const semanticKey of semanticKeySet) {
      const count = operationSemanticCounts.get(semanticKey) ?? 0;
      if (count !== 1) {
        throw invalidTemplateContract(
          "E_TEMPLATE_CONTRACT_INVALID",
          `operation_blocks must contain exactly one item for semantic key '${semanticKey}'.`
        );
      }
    }
  }

  const classificationContract = requireObject(contract.classification_contract, "classification_contract");
  if (classificationContract.scope !== "paragraph") {
    throw invalidTemplateContract(
      "E_TEMPLATE_CONTRACT_INVALID",
      "classification_contract.scope must be 'paragraph'."
    );
  }
  if (classificationContract.matches !== undefined) {
    const matches = requireArray(classificationContract.matches, "classification_contract.matches");
    for (const [index, rawMatch] of matches.entries()) {
      const match = requireObject(rawMatch, `classification_contract.matches[${index}]`);
      const semanticKey = requireNonEmptyString(match.semantic_key, `classification_contract.matches[${index}].semantic_key`);
      ensureSemanticKeyExists(semanticKey, semanticKeySet, "classification_contract.matches");
      requireStringArray(match.paragraph_ids, `classification_contract.matches[${index}].paragraph_ids`, {
        allowEmpty: false
      });
      if (match.confidence !== undefined) {
        requireConfidence(match.confidence, `classification_contract.matches[${index}].confidence`);
      }
      if (match.reason !== undefined) {
        requireNonEmptyString(match.reason, `classification_contract.matches[${index}].reason`);
      }
    }
  }
  if (classificationContract.unmatched_paragraph_ids !== undefined) {
    requireStringArray(
      classificationContract.unmatched_paragraph_ids,
      "classification_contract.unmatched_paragraph_ids",
      { allowEmpty: true }
    );
  }
  if (classificationContract.conflicts !== undefined) {
    const conflicts = requireArray(classificationContract.conflicts, "classification_contract.conflicts");
    for (const [index, rawConflict] of conflicts.entries()) {
      const conflict = requireObject(rawConflict, `classification_contract.conflicts[${index}]`);
      requireNonEmptyString(conflict.paragraph_id, `classification_contract.conflicts[${index}].paragraph_id`);
      const candidateKeys = requireStringArray(
        conflict.candidate_semantic_keys,
        `classification_contract.conflicts[${index}].candidate_semantic_keys`,
        { allowEmpty: false }
      );
      for (const semanticKey of candidateKeys) {
        ensureSemanticKeyExists(semanticKey, semanticKeySet, "classification_contract.conflicts");
      }
      if (conflict.reason !== undefined) {
        requireNonEmptyString(conflict.reason, `classification_contract.conflicts[${index}].reason`);
      }
    }
  }
  if (classificationContract.overall_confidence !== undefined) {
    requireConfidence(classificationContract.overall_confidence, "classification_contract.overall_confidence");
  }

  const validationPolicy = requireObject(contract.validation_policy, "validation_policy");
  if (validationPolicy.min_confidence !== undefined) {
    requireConfidence(validationPolicy.min_confidence, "validation_policy.min_confidence");
  }
  for (const booleanField of [
    "enforce_validation",
    "require_all_required_semantics",
    "reject_conflicting_matches",
    "reject_order_violations",
    "reject_style_violations",
    "reject_unmatched_when_required"
  ] as const) {
    if (validationPolicy[booleanField] !== undefined) {
      requireBoolean(validationPolicy[booleanField], `validation_policy.${booleanField}`);
    }
  }
}

function invalidTemplateContract(code: string, message: string): AgentError {
  return new AgentError({
    code,
    message,
    retryable: false
  });
}

function validateLanguageFontOverrides(input: unknown, path: string): void {
  if (input === undefined) {
    return;
  }
  const overrides = requireObject(input, path);
  for (const key of Object.keys(overrides)) {
    if (key !== "zh" && key !== "en") {
      throw invalidTemplateContract(
        "E_TEMPLATE_CONTRACT_INVALID",
        `${path}.${key} is not supported; only zh and en are allowed.`
      );
    }
  }
  validateLanguageFontOverride(overrides.zh, `${path}.zh`);
  validateLanguageFontOverride(overrides.en, `${path}.en`);
}

function validateLanguageFontOverride(input: unknown, path: string): void {
  if (input === undefined) {
    return;
  }
  const override = requireObject(input, path);
  for (const key of Object.keys(override)) {
    if (key !== "font_name") {
      throw invalidTemplateContract(
        "E_TEMPLATE_CONTRACT_INVALID",
        `${path}.${key} is not supported; only font_name is allowed.`
      );
    }
  }
  requireNonEmptyString(override.font_name, `${path}.font_name`);
}

function validatePatchSelector(input: JsonRecord, path: string): void {
  const part = requireNonEmptyString(input.part, `${path}.part`);
  if (!["document", "header", "footer", "styles", "numbering", "settings", "by_part_path"].includes(part)) {
    throw invalidTemplateContract("E_TEMPLATE_CONTRACT_INVALID", `${path}.part '${part}' is not supported.`);
  }
  const scope = requireNonEmptyString(input.scope, `${path}.scope`);
  if (
    !["paragraph", "run", "table", "row", "cell", "section", "style", "numbering_level", "settings_node"].includes(
      scope
    )
  ) {
    throw invalidTemplateContract("E_TEMPLATE_CONTRACT_INVALID", `${path}.scope '${scope}' is not supported.`);
  }
  if (input.match !== undefined) {
    const match = requireObject(input.match, `${path}.match`);
    if (match.paragraph_ids !== undefined) {
      requireStringArray(match.paragraph_ids, `${path}.match.paragraph_ids`, { allowEmpty: false });
    }
    if (match.block_ids !== undefined) {
      requireStringArray(match.block_ids, `${path}.match.block_ids`, { allowEmpty: false });
    }
    if (match.style_id !== undefined) {
      requireNonEmptyString(match.style_id, `${path}.match.style_id`);
    }
    if (match.num_id !== undefined) {
      requireNonEmptyString(match.num_id, `${path}.match.num_id`);
    }
    if (match.ilvl !== undefined && (!Number.isInteger(match.ilvl) || Number(match.ilvl) < 0)) {
      throw invalidTemplateContract("E_TEMPLATE_CONTRACT_INVALID", `${path}.match.ilvl must be a non-negative integer.`);
    }
    if (match.section_index !== undefined && (!Number.isInteger(match.section_index) || Number(match.section_index) < 0)) {
      throw invalidTemplateContract(
        "E_TEMPLATE_CONTRACT_INVALID",
        `${path}.match.section_index must be a non-negative integer.`
      );
    }
    if (match.part_path !== undefined) {
      requireNonEmptyString(match.part_path, `${path}.match.part_path`);
    }
    if (match.xml_path !== undefined) {
      requireNonEmptyString(match.xml_path, `${path}.match.xml_path`);
    }
  }
}

function validatePatchOperation(input: JsonRecord, path: string): void {
  const type = requireNonEmptyString(input.type, `${path}.type`);
  if (
    ![
      "set_attr",
      "remove_attr",
      "set_text",
      "remove_node",
      "ensure_node",
      "replace_node_xml",
      "set_run_style",
      "set_paragraph_style",
      "set_section_layout",
      "set_table_style",
      "set_table_cell_style",
      "set_style_definition",
      "set_numbering_level",
      "set_settings_flag"
    ].includes(type)
  ) {
    throw invalidTemplateContract("E_TEMPLATE_CONTRACT_INVALID", `${path}.type '${type}' is not supported.`);
  }

  if (type === "set_attr" || type === "remove_attr") {
    requireNonEmptyString(input.name, `${path}.name`);
  }
  if (type === "ensure_node") {
    requireNonEmptyString(input.xml_tag, `${path}.xml_tag`);
  }
  if (type === "replace_node_xml") {
    requireNonEmptyString(input.node_xml, `${path}.node_xml`);
  }
  if (type === "set_run_style") {
    requireObject(input.text_style, `${path}.text_style`);
  }
  if (type === "set_paragraph_style") {
    if (input.paragraph_style === undefined && input.style_id === undefined) {
      throw invalidTemplateContract(
        "E_TEMPLATE_CONTRACT_INVALID",
        `${path} requires paragraph_style or style_id for set_paragraph_style.`
      );
    }
  }
  if (type === "set_section_layout") {
    requireObject(input.section_layout, `${path}.section_layout`);
  }
  if (type === "set_table_style") {
    requireObject(input.table_style, `${path}.table_style`);
  }
  if (type === "set_table_cell_style") {
    requireObject(input.cell_style, `${path}.cell_style`);
  }
  if (type === "set_style_definition") {
    requireObject(input.style_definition, `${path}.style_definition`);
  }
  if (type === "set_numbering_level") {
    requireObject(input.numbering_level, `${path}.numbering_level`);
  }
  if (type === "set_settings_flag") {
    requireObject(input.settings, `${path}.settings`);
  }
}

function convertLegacyOperationBlockToPatchBlock(block: OperationBlock): TemplatePatchBlock {
  const operations: TemplatePatchOperation[] = [];
  if (Object.keys(block.paragraph_style ?? {}).length > 0) {
    operations.push({
      type: "set_paragraph_style",
      paragraph_style: block.paragraph_style
    });
  }
  if (Object.keys(block.text_style ?? {}).length > 0) {
    operations.push({
      type: "set_run_style",
      text_style: block.text_style
    });
  }
  if ((block.relative_spacing as Record<string, unknown> | undefined)?.before_pt !== undefined) {
    operations.push({
      type: "set_paragraph_style",
      paragraph_style: {
        space_before_pt: (block.relative_spacing as Record<string, unknown>).before_pt
      }
    });
  }
  if ((block.relative_spacing as Record<string, unknown> | undefined)?.after_pt !== undefined) {
    operations.push({
      type: "set_paragraph_style",
      paragraph_style: {
        space_after_pt: (block.relative_spacing as Record<string, unknown>).after_pt
      }
    });
  }
  return {
    semantic_key: block.semantic_key,
    selector: {
      part: "document",
      scope: "paragraph"
    },
    operations
  };
}

function requireObject(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidTemplateContract("E_TEMPLATE_CONTRACT_INVALID", `${path} must be an object.`);
  }
  return value as JsonRecord;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalidTemplateContract("E_TEMPLATE_CONTRACT_INVALID", `${path} must be an array.`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidTemplateContract("E_TEMPLATE_CONTRACT_INVALID", `${path} must be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string, options?: { allowEmpty?: boolean }): string[] {
  const entries = requireArray(value, path);
  if (!options?.allowEmpty && entries.length === 0) {
    throw invalidTemplateContract("E_TEMPLATE_CONTRACT_INVALID", `${path} must not be empty.`);
  }
  return entries.map((entry, index) => requireNonEmptyString(entry, `${path}[${index}]`));
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidTemplateContract("E_TEMPLATE_CONTRACT_INVALID", `${path} must be a boolean.`);
  }
  return value;
}

function requireConfidence(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidTemplateContract("E_TEMPLATE_CONTRACT_INVALID", `${path} must be a number between 0 and 1.`);
  }
  return value;
}

function ensureSemanticKeyExists(semanticKey: string, semanticKeySet: Set<string>, sourcePath: string): void {
  if (!semanticKeySet.has(semanticKey)) {
    throw invalidTemplateContract(
      "E_TEMPLATE_CONTRACT_INVALID",
      `${sourcePath} references undeclared semantic key '${semanticKey}'.`
    );
  }
}
