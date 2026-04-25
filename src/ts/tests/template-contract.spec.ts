import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AgentError } from "../src/core/errors.js";

const validContract = {
  template_meta: {
    id: "official_doc_body",
    name: "公文正文模板",
    version: "1.0.0",
    schema_version: "1.0",
    locale: "zh-CN"
  },
  semantic_blocks: [
    {
      key: "title",
      label: "标题",
      description: "位于正文前部的公文主标题。",
      examples: ["关于开展年度检查工作的通知"],
      required: true,
      multiple: false,
      notes: "扩展字段允许透传"
    },
    {
      key: "body",
      label: "正文",
      description: "公文主体内容。",
      examples: ["现将有关事项通知如下。"],
      required: true,
      multiple: false
    }
  ],
  layout_rules: {
    global_rules: {
      document_scope: "full_document",
      ordering: ["title", "body"],
      numbering_patterns: ["一、", "（一）"],
      allow_unclassified_paragraphs: false,
      custom_hint: "keep"
    },
    semantic_rules: [
      {
        semantic_key: "title",
        position_hints: ["center", "near_top"],
        occurrence: {
          min_occurs: 1,
          max_occurs: 1
        }
      },
      {
        semantic_key: "body",
        text_hints: ["现将", "通知如下"],
        occurrence: {
          min_occurs: 1,
          max_occurs: 1
        }
      }
    ]
  },
  operation_blocks: [
    {
      semantic_key: "title",
      text_style: {
        font_family: "方正小标宋简体",
        font_size_pt: 22,
        bold: false
      },
      paragraph_style: {
        alignment: "center"
      }
    },
    {
      semantic_key: "body",
      text_style: {
        font_family: "仿宋_GB2312",
        font_size_pt: 16
      },
      paragraph_style: {
        alignment: "justify",
        first_line_indent_chars: 2
      }
    }
  ],
  classification_contract: {
    scope: "paragraph",
    single_owner_per_paragraph: true,
    matches: [
      {
        semantic_key: "title",
        paragraph_ids: ["p1"],
        confidence: 0.98,
        reason: "标题位于文首居中"
      }
    ],
    unmatched_paragraph_ids: [],
    conflicts: [],
    overall_confidence: 0.98
  },
  validation_policy: {
    enforce_validation: true,
    min_confidence: 0.8,
    require_all_required_semantics: true,
    reject_conflicting_matches: true,
    reject_order_violations: true,
    reject_style_violations: true
  },
  vendor_metadata: {
    passthrough: true
  }
};

describe("template contract", () => {
  it("accepts a valid contract and preserves unknown fields", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");

    const parsed = parseTemplateContract(validContract);

    expect(parsed.template_meta.id).toBe("official_doc_body");
    expect(parsed.semantic_blocks[0]?.notes).toBe("扩展字段允许透传");
    expect(parsed.layout_rules.global_rules.custom_hint).toBe("keep");
    expect(parsed.vendor_metadata).toEqual({ passthrough: true });
  });

  it("rejects missing required core fields", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const missingMetaId = {
      ...validContract,
      template_meta: {
        ...validContract.template_meta,
        id: ""
      }
    };

    expect(() => parseTemplateContract(missingMetaId)).toThrowError(AgentError);
    expect(() => parseTemplateContract(missingMetaId)).toThrow(/template_meta\.id/i);
  });

  it("rejects non-boolean enforce_validation values", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const invalid = {
      ...validContract,
      validation_policy: {
        ...validContract.validation_policy,
        enforce_validation: "yes"
      }
    };

    expect(() => parseTemplateContract(invalid)).toThrow(/validation_policy\.enforce_validation/i);
  });

  it("rejects duplicate semantic keys", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const duplicated = {
      ...validContract,
      semantic_blocks: [
        ...validContract.semantic_blocks,
        {
          key: "title",
          label: "重复标题",
          description: "重复语义。",
          examples: ["重复"],
          required: false,
          multiple: false
        }
      ]
    };

    expect(() => parseTemplateContract(duplicated)).toThrow(/semantic_blocks.*title/i);
  });

  it("rejects missing or unknown operation block semantic keys", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const missingOperation = {
      ...validContract,
      operation_blocks: [validContract.operation_blocks[0]]
    };
    const unknownOperation = {
      ...validContract,
      operation_blocks: [
        ...validContract.operation_blocks,
        {
          semantic_key: "signature",
          text_style: {},
          paragraph_style: {}
        }
      ]
    };

    expect(() => parseTemplateContract(missingOperation)).toThrow(/operation_blocks.*body/i);
    expect(() => parseTemplateContract(unknownOperation)).toThrow(/operation_blocks.*signature/i);
  });

  it("accepts optional language font overrides on operation blocks", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const withLanguageOverrides = {
      ...validContract,
      operation_blocks: [
        {
          ...validContract.operation_blocks[0],
          language_font_overrides: {
            zh: {
              font_name: "SimSun"
            },
            en: {
              font_name: "Times New Roman"
            }
          }
        },
        validContract.operation_blocks[1]
      ]
    };

    const parsed = parseTemplateContract(withLanguageOverrides);

    expect(parsed.operation_blocks[0]?.language_font_overrides).toEqual({
      zh: {
        font_name: "SimSun"
      },
      en: {
        font_name: "Times New Roman"
      }
    });
  });

  it("rejects invalid language font override payloads", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const invalid = {
      ...validContract,
      operation_blocks: [
        {
          ...validContract.operation_blocks[0],
          language_font_overrides: {
            zh: {
              font_name: ""
            }
          }
        },
        validContract.operation_blocks[1]
      ]
    };

    expect(() => parseTemplateContract(invalid)).toThrow(/language_font_overrides\.zh\.font_name/i);
  });

  it("rejects unresolved semantic references in layout ordering and semantic rules", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const invalidOrdering = {
      ...validContract,
      layout_rules: {
        ...validContract.layout_rules,
        global_rules: {
          ...validContract.layout_rules.global_rules,
          ordering: ["title", "recipient", "body"]
        }
      }
    };
    const invalidSemanticRule = {
      ...validContract,
      layout_rules: {
        ...validContract.layout_rules,
        semantic_rules: [
          ...validContract.layout_rules.semantic_rules,
          {
            semantic_key: "recipient",
            occurrence: {
              min_occurs: 0,
              max_occurs: 1
            }
          }
        ]
      }
    };

    expect(() => parseTemplateContract(invalidOrdering)).toThrow(/ordering.*recipient/i);
    expect(() => parseTemplateContract(invalidSemanticRule)).toThrow(/semantic_rules.*recipient/i);
  });

  it("accepts semantic-level numbering pattern rules", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const withSemanticNumberingRules = {
      ...validContract,
      layout_rules: {
        ...validContract.layout_rules,
        semantic_rules: [
          {
            ...validContract.layout_rules.semantic_rules[0],
            numbering_patterns: ["^[一二三四五六七八九十]+、$"]
          },
          {
            ...validContract.layout_rules.semantic_rules[1],
            numbering_patterns: ["^（[一二三四五六七八九十]+）$"]
          }
        ]
      }
    };

    const parsed = parseTemplateContract(withSemanticNumberingRules);

    expect(parsed.layout_rules.semantic_rules[0]?.numbering_patterns).toEqual(["^[一二三四五六七八九十]+、$"]);
    expect(parsed.layout_rules.semantic_rules[1]?.numbering_patterns).toEqual(["^（[一二三四五六七八九十]+）$"]);
  });

  it("rejects non-paragraph classification scope and incompatible schema versions", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const invalidScope = {
      ...validContract,
      classification_contract: {
        ...validContract.classification_contract,
        scope: "run"
      }
    };
    const incompatibleSchema = {
      ...validContract,
      template_meta: {
        ...validContract.template_meta,
        schema_version: "2.0"
      }
    };

    expect(() => parseTemplateContract(invalidScope)).toThrow(/classification_contract\.scope/i);
    expect(() => parseTemplateContract(incompatibleSchema)).toThrow(/schema_version/i);
  });

  it("rejects derived semantic inheritance, key conflicts, and missing operations", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const missingAtomicParent = {
      ...validContract,
      derived_semantics: [
        {
          key: "body_content",
          label: "正文",
          mode: "aggregate",
          inherits_from: ["body", "list_item"],
          examples: ["现将有关事项通知如下。"],
          operation: {
            text_style: {},
            paragraph_style: {}
          }
        }
      ]
    };
    const conflictingKey = {
      ...validContract,
      derived_semantics: [
        {
          key: "body",
          label: "正文聚合",
          mode: "aggregate",
          inherits_from: ["body"],
          examples: ["现将有关事项通知如下。"],
          operation: {
            text_style: {},
            paragraph_style: {}
          }
        }
      ]
    };
    const missingOperation = {
      ...validContract,
      derived_semantics: [
        {
          key: "body_content",
          label: "正文",
          mode: "aggregate",
          inherits_from: ["body"],
          examples: ["现将有关事项通知如下。"]
        }
      ]
    };

    expect(() => parseTemplateContract(missingAtomicParent)).toThrow(/derived_semantics.*list_item/i);
    expect(() => parseTemplateContract(conflictingKey)).toThrow(/derived_semantics.*body/i);
    expect(() => parseTemplateContract(missingOperation)).toThrow(/derived_semantics.*operation/i);
  });

  it("parses the structural sample contract from docs/examples", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const samplePath = new URL("../../../docs/examples/fixed-template-contract.sample.json", import.meta.url);
    const sample = JSON.parse(await readFile(samplePath, "utf8")) as Record<string, unknown>;

    const parsed = parseTemplateContract(sample);
    const semanticKeys = parsed.semantic_blocks.map((block) => block.key);
    const operationKeys = parsed.operation_blocks.map((block) => block.semantic_key);
    const derivedKeys = parsed.derived_semantics?.map((block) => block.key);
    const documentTitle = parsed.semantic_blocks.find((block) => block.key === "document_title");
    const documentTitleRule = parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "document_title");
    const bodyParagraph = parsed.semantic_blocks.find((block) => block.key === "body_paragraph");
    const bodyParagraphRule = parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "body_paragraph");

    expect(parsed.template_meta.id).toBe("fixed_template_structural_sample");
    expect(semanticKeys).toEqual([
      "cover_image",
      "document_title",
      "heading_level_1",
      "heading_level_2",
      "heading_level_3",
      "body_paragraph",
      "list_item_level_0",
      "list_item_level_1",
      "table_text",
      "blank_or_unknown"
    ]);
    expect(derivedKeys).toEqual(["body_content", "copy_to_authority"]);
    expect(operationKeys).toEqual(semanticKeys);
    expect(parsed.layout_rules.global_rules.allow_unclassified_paragraphs).toBe(false);
    expect(parsed.validation_policy.enforce_validation).toBe(false);
    expect(parsed.validation_policy.require_all_required_semantics).toBe(false);
    expect(parsed.validation_policy.reject_conflicting_matches).toBe(false);
    expect(parsed.validation_policy.reject_order_violations).toBe(false);
    expect(parsed.validation_policy.reject_style_violations).toBe(false);
    expect(parsed.validation_policy.reject_unmatched_when_required).toBe(false);
    expect(parsed.authoring_guidance).toMatchObject({
      coverage_contract: {
        required_atomic_semantics: semanticKeys
      },
      inheritance_mechanism: {
        aggregate: expect.any(Object),
        refine: expect.any(Object)
      }
    });
    expect(documentTitle?.required).toBe(false);
    expect(documentTitleRule?.occurrence).toMatchObject({
      min_occurs: 0,
      max_occurs: 1
    });
    expect(bodyParagraph?.required).toBe(true);
    expect(bodyParagraphRule?.occurrence).toMatchObject({
      min_occurs: 1
    });
    expect(documentTitleRule?.style_hints).toMatchObject({
      allow_empty_text: true
    });
    expect(bodyParagraphRule?.style_hints).toMatchObject({
      allow_empty_text: true
    });
    expect(parsed.layout_rules.global_rules.numbering_patterns).toEqual([
      "^[一二三四五六七八九十]+、$",
      "^（[一二三四五六七八九十]+）$",
      "^\\d+[.)．、]$",
      "^[(（]\\d+[)）]$"
    ]);
    expect(parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "heading_level_1")?.numbering_patterns).toBeUndefined();
    expect(parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "heading_level_2")?.numbering_patterns).toBeUndefined();
    expect(parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "heading_level_3")?.numbering_patterns).toBeUndefined();
    expect(parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "body_paragraph")?.numbering_patterns).toEqual([
      "^\\d+\\.\\d+(?:\\.\\d+)*[)）、．。、]?$"
    ]);
  });

  it("keeps templates/test_1.json as a pure-format, non-validating template", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const templatePath = new URL("../../../templates/test_1.json", import.meta.url);
    const template = JSON.parse(await readFile(templatePath, "utf8")) as Record<string, unknown>;

    const parsed = parseTemplateContract(template);
    const semanticKeys = parsed.semantic_blocks.map((block) => block.key);
    const blankRule = parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "blank_or_unknown");
    const blankOperation = parsed.operation_blocks.find((block) => block.semantic_key === "blank_or_unknown");
    const documentTitle = parsed.semantic_blocks.find((block) => block.key === "document_title");
    const documentTitleRule = parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "document_title");
    const bodyParagraph = parsed.semantic_blocks.find((block) => block.key === "body_paragraph");
    const bodyParagraphRule = parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "body_paragraph");

    expect(parsed.template_meta.id).toBe("test_1");
    expect(semanticKeys).toEqual([
      "cover_image",
      "document_title",
      "heading_level_1",
      "heading_level_2",
      "heading_level_3",
      "body_paragraph",
      "list_item_level_0",
      "list_item_level_1",
      "table_text",
      "blank_or_unknown"
    ]);
    expect(parsed.layout_rules.global_rules.allow_unclassified_paragraphs).toBe(true);
    expect(parsed.layout_rules.global_rules.ordering).toBeUndefined();
    expect(parsed.layout_rules.global_rules.numbering_patterns).toBeUndefined();
    expect(parsed.validation_policy.enforce_validation).toBe(false);
    expect(parsed.validation_policy.require_all_required_semantics).toBe(false);
    expect(parsed.validation_policy.reject_conflicting_matches).toBe(false);
    expect(parsed.validation_policy.reject_order_violations).toBe(false);
    expect(parsed.validation_policy.reject_style_violations).toBe(false);
    expect(parsed.validation_policy.reject_unmatched_when_required).toBe(false);
    expect(parsed.validation_policy.min_confidence).toBeUndefined();
    expect(blankRule?.style_hints).toMatchObject({
      allow_empty_text: true
    });
    expect(parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "cover_image")?.style_hints).toMatchObject({
      allow_empty_text: true
    });
    expect(parsed.semantic_blocks.find((block) => block.key === "cover_image")).toMatchObject({
      label: "图片段落",
      multiple: true
    });
    expect(documentTitle?.required).toBe(false);
    expect(documentTitle?.multiple).toBe(true);
    expect(documentTitleRule?.occurrence).toBeUndefined();
    expect(bodyParagraph?.required).toBe(false);
    expect(bodyParagraph?.multiple).toBe(true);
    expect(bodyParagraphRule?.occurrence).toBeUndefined();
    expect(documentTitleRule?.style_hints).toMatchObject({
      allow_empty_text: true
    });
    expect(bodyParagraphRule?.style_hints).toMatchObject({
      allow_empty_text: true
    });
    expect(parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "cover_image")?.position_hints).toBeUndefined();
    expect(parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "cover_image")?.occurrence).toBeUndefined();
    expect(parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "heading_level_1")?.numbering_patterns).toBeUndefined();
    expect(parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "heading_level_2")?.numbering_patterns).toBeUndefined();
    expect(parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "heading_level_3")?.numbering_patterns).toBeUndefined();
    expect(parsed.layout_rules.semantic_rules.find((rule) => rule.semantic_key === "body_paragraph")?.numbering_patterns).toBeUndefined();
    expect(blankOperation).toEqual({
      semantic_key: "blank_or_unknown",
      text_style: {},
      paragraph_style: {}
    });
  });

  it("keeps the markdown authoring guide explicit about rule fields versus example fields", async () => {
    const guidePath = new URL("../../../docs/examples/fixed-template-contract.sample.md", import.meta.url);
    const guide = await readFile(guidePath, "utf8");

    expect(guide).toContain("规则字段");
    expect(guide).toContain("示例字段");
    expect(guide).toContain("默认不做结构性校验");
    expect(guide).toContain("默认不做格式性校验");
    expect(guide).toContain("默认允许空文本");
    expect(guide).toContain("用户上传任何格式的文档都允许通过");
    expect(guide).toContain("只有用户明确要求时");
    expect(guide).toContain("`numbering_patterns` 不参与 paragraph owner 决策");
    expect(guide).toContain("`heading_level_n` 表示 DOCX 原生标题层级");
    expect(guide).toContain("语义集合主要用于分类、写入映射和未来可选校验");
    expect(guide).toContain("`examples` / `negative_examples`");
  });
});
