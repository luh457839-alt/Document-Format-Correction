import { access, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError } from "../src/core/errors.js";
import type { PythonDocxObservationState } from "../src/tools/python-tool-client.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "template-subsystem-"));
  tempDirs.push(dir);
  return dir;
}

async function materializeSeedDocx(target: string): Promise<void> {
  const { materializeDocumentWithPython } = await import("../src/tools/python-tool-client.js");
  await materializeDocumentWithPython({
    id: "seed-doc",
    version: "v1",
    nodes: [
      { id: "seed_0", text: "关于开展年度检查工作的通知" },
      { id: "seed_1", text: "现将有关事项通知如下。" },
      { id: "seed_2", text: "请认真贯彻执行。" }
    ],
    metadata: {
      outputDocxPath: target
    }
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const baseTemplate = {
  template_meta: {
    id: "official_doc_body",
    name: "公文正文模板",
    version: "1.0.0",
    schema_version: "1.0"
  },
  semantic_blocks: [
    {
      key: "title",
      label: "标题",
      description: "位于正文前部的公文主标题。",
      examples: ["关于开展年度检查工作的通知"],
      required: true,
      multiple: false
    },
    {
      key: "body",
      label: "正文",
      description: "公文主体内容。",
      examples: ["现将有关事项通知如下。"],
      required: true,
      multiple: true
    }
  ],
  layout_rules: {
    global_rules: {
      document_scope: "full_document",
      ordering: ["title", "body"],
      allow_unclassified_paragraphs: false
    },
    semantic_rules: [
      {
        semantic_key: "title",
        position_hints: ["near_top"],
        style_hints: {
          style_name: "Heading 1",
          paragraph_alignment: "center"
        }
      },
      {
        semantic_key: "body",
        text_hints: ["现将", "通知如下"],
        style_hints: {
          style_name: "BodyText",
          font_name: "FangSong_GB2312"
        }
      }
    ]
  },
  operation_blocks: [
    {
      semantic_key: "title",
      text_style: {
        font_name: "FZXiaoBiaoSong-B05S",
        font_size_pt: 22
      },
      paragraph_style: {
        paragraph_alignment: "center"
      }
    },
    {
      semantic_key: "body",
      text_style: {
        font_name: "FangSong_GB2312",
        font_size_pt: 16
      },
      paragraph_style: {
        paragraph_alignment: "justify",
        first_line_indent_chars: 2
      },
      relative_spacing: {
        before_pt: 0,
        after_pt: 0
      }
    }
  ],
  classification_contract: {
    scope: "paragraph",
    single_owner_per_paragraph: true
  },
  validation_policy: {
    enforce_validation: true,
    min_confidence: 0.8,
    require_all_required_semantics: true,
    reject_conflicting_matches: true,
    reject_order_violations: true,
    reject_style_violations: true,
    reject_unmatched_when_required: true
  }
} as const;

const baseObservation: PythonDocxObservationState = {
  document_meta: {
    total_paragraphs: 3,
    total_tables: 1
  },
  paragraphs: [
    {
      id: "p1",
      text: "关于开展年度检查工作的通知",
      role: "heading",
      heading_level: 1,
      style_name: "Heading 1",
      run_ids: ["p1_r1"],
      in_table: false
    },
    {
      id: "p2",
      text: "现将有关事项通知如下。",
      role: "body",
      style_name: "BodyText",
      run_ids: ["p2_r1"],
      in_table: false
    },
    {
      id: "p3",
      text: "请认真贯彻执行。",
      role: "body",
      style_name: "BodyText",
      run_ids: ["p3_r1"],
      in_table: false
    }
  ],
  nodes: [
    {
      id: "p1",
      node_type: "paragraph",
      children: [
        {
          id: "p1_r1",
          node_type: "text_run",
          content: "关于开展年度检查工作的通知",
          style: {
            font_name: "FZXiaoBiaoSong-B05S",
            font_size_pt: 22,
            paragraph_alignment: "center"
          }
        }
      ]
    },
    {
      id: "p2",
      node_type: "paragraph",
      children: [
        {
          id: "p2_r1",
          node_type: "text_run",
          content: "现将有关事项通知如下。",
          style: {
            font_name: "FangSong_GB2312",
            font_size_pt: 16,
            paragraph_alignment: "justify"
          }
        }
      ]
    },
    {
      id: "p3",
      node_type: "paragraph",
      children: [
        {
          id: "p3_r1",
          node_type: "text_run",
          content: "请认真贯彻执行。",
          style: {
            font_name: "FangSong_GB2312",
            font_size_pt: 16,
            paragraph_alignment: "justify"
          }
        }
      ]
    },
    {
      id: "tbl_0",
      node_type: "table",
      rows: [
        {
          row_index: 0,
          cells: [
            {
              cell_index: 0,
              paragraphs: [],
              tables: []
            }
          ]
        }
      ]
    }
  ]
};

const mixedLanguageObservation: PythonDocxObservationState = {
  document_meta: {
    total_paragraphs: 2,
    total_tables: 0
  },
  paragraphs: [
    {
      id: "p1",
      text: "关于年度检查工作的通知",
      role: "heading",
      heading_level: 1,
      style_name: "Heading 1",
      run_ids: ["p1_r1"],
      in_table: false
    },
    {
      id: "p2",
      text: "这是NLP,模型2025报告",
      role: "body",
      style_name: "BodyText",
      run_ids: ["p2_r1"],
      in_table: false
    }
  ],
  nodes: [
    {
      id: "p1",
      node_type: "paragraph",
      children: [
        {
          id: "p1_r1",
          node_type: "text_run",
          content: "关于年度检查工作的通知",
          style: {
            font_name: "FZXiaoBiaoSong-B05S",
            font_size_pt: 22,
            paragraph_alignment: "center"
          }
        }
      ]
    },
    {
      id: "p2",
      node_type: "paragraph",
      children: [
        {
          id: "p2_r1",
          node_type: "text_run",
          content: "这是NLP,模型2025报告",
          style: {
            font_name: "FangSong_GB2312",
            font_size_pt: 16,
            is_bold: true,
            paragraph_alignment: "justify"
          }
        }
      ]
    }
  ]
};

describe("template config", () => {
  it("loads a valid template file and preserves template metadata", async () => {
    const { loadTemplateConfig } = await import("../src/templates/template-config.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    await writeFile(templatePath, JSON.stringify(baseTemplate, null, 2), "utf8");

    const loaded = await loadTemplateConfig(templatePath);

    expect(loaded.template_meta.id).toBe("official_doc_body");
    expect(loaded.operation_blocks).toHaveLength(2);
  });

  it("wraps invalid json as a template config error", async () => {
    const { loadTemplateConfig } = await import("../src/templates/template-config.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "broken-template.json");
    await writeFile(templatePath, "{broken", "utf8");

    await expect(loadTemplateConfig(templatePath)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AgentError &&
        err.info.code === "E_TEMPLATE_CONFIG_INVALID_JSON" &&
        err.info.message.includes("broken-template.json")
    );
  });
});

describe("template context builder", () => {
  it("projects observation into template classification input and summary", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");

    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    expect(context.document.nodes.map((node) => node.id)).toEqual(["p1_r1", "p2_r1", "p3_r1"]);
    expect(context.structureIndex.paragraphs.map((paragraph) => paragraph.id)).toEqual(["p1", "p2", "p3"]);
    expect(context.observationSummary.paragraph_count).toBe(3);
    expect(context.observationSummary.classifiable_paragraphs.map((paragraph) => paragraph.paragraph_id)).toEqual([
      "p1",
      "p2",
      "p3"
    ]);
    expect(context.classificationInput.paragraphs.map((paragraph) => ({
      paragraph_id: paragraph.paragraph_id,
      paragraph_index: paragraph.paragraph_index,
      is_first_paragraph: paragraph.is_first_paragraph,
      is_last_paragraph: paragraph.is_last_paragraph,
      bucket_type: paragraph.bucket_type
    }))).toEqual([
      {
        paragraph_id: "p1",
        paragraph_index: 0,
        is_first_paragraph: true,
        is_last_paragraph: false,
        bucket_type: "heading"
      },
      {
        paragraph_id: "p2",
        paragraph_index: 1,
        is_first_paragraph: false,
        is_last_paragraph: false,
        bucket_type: "body"
      },
      {
        paragraph_id: "p3",
        paragraph_index: 2,
        is_first_paragraph: false,
        is_last_paragraph: true,
        bucket_type: "body"
      }
    ]);
    expect(context.observationSummary.classifiable_paragraphs[0]).toMatchObject({
      paragraph_id: "p1",
      paragraph_index: 0,
      is_first_paragraph: true,
      is_last_paragraph: false,
      bucket_type: "heading"
    });
    expect(context.observationSummary.evidence_summary.table_count).toBe(1);
    expect(context.observationSummary.evidence_summary.image_count).toBe(0);
    expect(context.observationSummary.evidence_summary.seal_detection.supported).toBe(false);
  });
});

describe("template classification parser", () => {
  it("parses a valid paragraph-level classification result", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { parseTemplateClassificationResult } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const result = parseTemplateClassificationResult({
      template: baseTemplate,
      context,
      rawContent: JSON.stringify({
        scope: "paragraph",
        matches: [
          {
            semantic_key: "title",
            paragraph_ids: ["p1"],
            confidence: 0.99,
            reason: "位于文首，符合标题样式"
          },
          {
            semantic_key: "body",
            paragraph_ids: ["p2", "p3"],
            confidence: 0.92,
            reason: "连续正文段落"
          }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.95
      })
    });

    expect(result.template_id).toBe("official_doc_body");
    expect(result.matches).toHaveLength(2);
    expect(result.matches[1]?.paragraph_ids).toEqual(["p2", "p3"]);
    expect(result.overall_confidence).toBe(0.95);
  });

  it("ignores unknown semantic matches with diagnostics instead of rejecting the payload", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { parseTemplateClassificationResult } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const result = parseTemplateClassificationResult({
      template: baseTemplate,
      context,
      rawContent: JSON.stringify({
        scope: "paragraph",
        matches: [{ semantic_key: "appendix", paragraph_ids: ["p3"], confidence: 0.9, reason: "附件" }],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.9
      })
    });

    expect(result.matches).toEqual([]);
    expect(result.unmatched_paragraph_ids).toEqual([]);
    expect(result.diagnostics?.ignored_unknown_semantic_matches).toEqual([
      {
        semantic_key: "appendix",
        paragraph_ids: ["p3"],
        confidence: 0.9,
        reason: "附件"
      }
    ]);
    expect(result.diagnostics?.normalization_notes).toContain("skipped unknown semantic_key 'appendix' from matches[0]");
  });

  it("filters unknown conflict candidates and keeps known candidates with diagnostics", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { parseTemplateClassificationResult } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const result = parseTemplateClassificationResult({
      template: baseTemplate,
      context,
      rawContent: JSON.stringify({
        scope: "paragraph",
        matches: [],
        unmatched_paragraph_ids: [],
        conflicts: [
          {
            paragraph_id: "p1",
            candidate_semantic_keys: ["title", "appendix"],
            reason: "只剩一个已知候选"
          },
          {
            paragraph_id: "p2",
            candidate_semantic_keys: ["title", "body", "metadata"],
            reason: "保留两个已知候选"
          }
        ],
        overall_confidence: 0.7
      })
    });

    expect(result.conflicts).toEqual([
      {
        paragraph_id: "p1",
        candidate_semantic_keys: ["title"],
        reason: "只剩一个已知候选"
      },
      {
        paragraph_id: "p2",
        candidate_semantic_keys: ["title", "body"],
        reason: "保留两个已知候选"
      }
    ]);
    expect(result.diagnostics?.ignored_unknown_semantic_matches).toEqual([
      {
        semantic_key: "appendix",
        paragraph_ids: ["p1"]
      },
      {
        semantic_key: "metadata",
        paragraph_ids: ["p2"]
      }
    ]);
    expect(result.diagnostics?.normalization_notes).toContain(
      "skipped unknown semantic_key 'appendix' from conflicts[0].candidate_semantic_keys"
    );
  });

  it("accepts duplicate ownership, overlap, and duplicate semantic keys with normalization notes", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { parseTemplateClassificationResult } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const result = parseTemplateClassificationResult({
      template: baseTemplate,
      context,
      rawContent: JSON.stringify({
        scope: "run",
        matches: [
          { semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.9, reason: "标题" },
          { semantic_key: "body", paragraph_ids: ["p1"], confidence: 0.88, reason: "正文误归类" },
          { semantic_key: "body", paragraph_ids: ["p2", "p3"], confidence: 0.92, reason: "正文" }
        ],
        unmatched_paragraph_ids: ["p1"],
        conflicts: [],
        overall_confidence: 0.9
      })
    });

    expect(result.matches).toEqual([
      { semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.9, reason: "标题" },
      {
        semantic_key: "body",
        paragraph_ids: ["p1", "p2", "p3"],
        confidence: 0.906667,
        reason: "正文误归类 | 正文"
      }
    ]);
    expect(result.unmatched_paragraph_ids).toEqual(["p1"]);
    expect(result.diagnostics?.normalization_notes).toEqual(
      expect.arrayContaining([
        "ignored non-paragraph scope 'run'",
        "merged duplicate semantic_key 'body'"
      ])
    );
  });

  it("unwraps common wrapper objects and records normalization notes", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { parseTemplateClassificationResult } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const result = parseTemplateClassificationResult({
      template: baseTemplate,
      context,
      rawContent: JSON.stringify({
        classification: {
          scope: "paragraph",
          matches: [{ semantic_key: "title", paragraph_ids: ["p1"] }]
        }
      }),
      batchDiagnostics: {
        batchType: "heading",
        batchIndex: 1,
        batchCount: 2
      }
    });

    expect(result.matches).toEqual([{ semantic_key: "title", paragraph_ids: ["p1"] }]);
    expect(result.diagnostics?.normalization_notes).toContain("read classification fields from wrapper 'classification'");
  });

  it("defaults malformed optional fields instead of rejecting the payload", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { parseTemplateClassificationResult } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const result = parseTemplateClassificationResult({
      template: baseTemplate,
      context,
      rawContent: JSON.stringify({
        scope: "paragraph",
        matches: {},
        unmatched_paragraph_ids: "p3",
        conflicts: null,
        overall_confidence: "high"
      }),
      batchDiagnostics: {
        batchType: "body",
        batchIndex: 2,
        batchCount: 2
      }
    });

    expect(result.matches).toEqual([]);
    expect(result.unmatched_paragraph_ids).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.overall_confidence).toBeUndefined();
    expect(result.diagnostics?.normalization_notes).toEqual(
      expect.arrayContaining([
        "ignored matches because it is object; defaulted to []",
        "ignored unmatched_paragraph_ids because it is string; defaulted to []",
        "ignored conflicts because it is null; defaulted to []",
        "ignored overall_confidence because it is not a number between 0 and 1"
      ])
    );
  });

  it("ignores out-of-scope paragraph references and records normalization diagnostics", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { parseTemplateClassificationResult } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const result = parseTemplateClassificationResult({
      template: baseTemplate,
      context,
      allowedParagraphIds: ["p1", "p2"],
      rawContent: JSON.stringify({
        matches: [
          { semantic_key: "title", paragraph_ids: ["p1", "p9"] },
          { semantic_key: "body", paragraph_ids: ["p2", "p3"] }
        ],
        unmatched_paragraph_ids: ["p2", "p8"],
        conflicts: [
          { paragraph_id: "p7", candidate_semantic_keys: ["title", "body"] },
          { paragraph_id: "p2", candidate_semantic_keys: ["body", "appendix"] }
        ]
      })
    });

    expect(result.matches).toEqual([
      { semantic_key: "title", paragraph_ids: ["p1"] },
      { semantic_key: "body", paragraph_ids: ["p2"] }
    ]);
    expect(result.unmatched_paragraph_ids).toEqual(["p2"]);
    expect(result.conflicts).toEqual([{ paragraph_id: "p2", candidate_semantic_keys: ["body"] }]);
    expect(result.diagnostics?.ignored_unknown_semantic_matches).toEqual([
      { semantic_key: "appendix", paragraph_ids: ["p2"] }
    ]);
    expect(result.diagnostics?.normalization_notes).toEqual(
      expect.arrayContaining([
        "ignored matches[0].paragraph_ids value 'p9' because it is out of scope",
        "ignored matches[1].paragraph_ids value 'p3' because it is out of scope",
        "ignored unmatched_paragraph_ids value 'p8' because it is out of scope",
        "ignored conflicts[0] paragraph_id 'p7' because it is out of scope"
      ])
    );
  });
});

describe("template classification batching", () => {
  it("builds bucketed batched requests with loose JSON-object guidance", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { buildTemplateClassificationModelRequests } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/batched.docx",
      observation: {
        document_meta: {
          total_paragraphs: 7,
          total_tables: 1
        },
        paragraphs: [
          {
            id: "p1",
            text: "关于年度检查工作的通知",
            role: "heading",
            heading_level: 1,
            style_name: "Heading 1",
            run_ids: ["p1_r1"],
            in_table: false
          },
          {
            id: "p2",
            text: "第一段正文，说明总体要求。",
            role: "body",
            style_name: "BodyText",
            run_ids: ["p2_r1"],
            in_table: false
          },
          {
            id: "p3",
            text: "第二段正文，说明办理流程。",
            role: "body",
            style_name: "BodyText",
            run_ids: ["p3_r1"],
            in_table: false
          },
          {
            id: "p4",
            text: "第三段正文，说明报送要求。",
            role: "body",
            style_name: "BodyText",
            run_ids: ["p4_r1"],
            in_table: false
          },
          {
            id: "p5",
            text: "（一）请各单位按时报送。",
            role: "list_item",
            list_level: 0,
            style_name: "List Paragraph",
            run_ids: ["p5_r1"],
            in_table: false
          },
          {
            id: "p6",
            text: "表格内文字",
            role: "body",
            style_name: "Table Text",
            run_ids: ["p6_r1"],
            in_table: true
          },
          {
            id: "p7",
            text: "附件：统计口径说明",
            role: "footer",
            style_name: "Footer",
            run_ids: ["p7_r1"],
            in_table: false
          }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "关于年度检查工作的通知", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "第一段正文，说明总体要求。", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "第二段正文，说明办理流程。", style: {} }] },
          { id: "p4", node_type: "paragraph", children: [{ id: "p4_r1", node_type: "text_run", content: "第三段正文，说明报送要求。", style: {} }] },
          { id: "p5", node_type: "paragraph", children: [{ id: "p5_r1", node_type: "text_run", content: "（一）请各单位按时报送。", style: {} }] },
          { id: "p6", node_type: "paragraph", children: [{ id: "p6_r1", node_type: "text_run", content: "表格内文字", style: {} }] },
          { id: "p7", node_type: "paragraph", children: [{ id: "p7_r1", node_type: "text_run", content: "附件：统计口径说明", style: {} }] }
        ]
      }
    });

    const requests = buildTemplateClassificationModelRequests(baseTemplate, context, {
      maxParagraphsPerBatch: 2,
      maxPromptBytes: 32_000
    });

    expect(requests.map((request) => `${request.batch.bucket_type}:${request.batch.batch_index}/${request.batch.batch_count}`)).toEqual([
      "heading:1/1",
      "list_item:1/1",
      "body:1/2",
      "body:2/2",
      "table_text:1/1",
      "unknown:1/1"
    ]);

    const firstBodyBatch = requests.find(
      (request) => request.batch.bucket_type === "body" && request.batch.batch_index === 1
    );
    expect(firstBodyBatch).toBeDefined();
    const firstBodyPayload = JSON.parse(String(firstBodyBatch?.messages[1]?.content ?? "{}")) as {
      batch?: Record<string, unknown>;
      paragraphs?: Array<Record<string, unknown>>;
      instruction?: string;
      output_contract?: Record<string, unknown>;
      output_example?: Record<string, unknown>;
    };
    expect(firstBodyPayload.batch).toMatchObject({
      bucket_type: "body",
      batch_index: 1,
      batch_count: 2
    });
    expect(firstBodyPayload.paragraphs?.map((paragraph) => paragraph.paragraph_id)).toEqual(["p2", "p3"]);
    expect(firstBodyBatch?.messages[1]?.content).toContain("parseable JSON object");
    expect(firstBodyBatch?.messages[1]?.content).toContain("optional");
    expect(firstBodyBatch?.messages[1]?.content).toContain("Extra keys are allowed");
    expect(firstBodyPayload.output_contract).toMatchObject({
      response_root: expect.stringContaining("parseable JSON object"),
      optional_fields: expect.stringContaining("optional"),
      extra_fields: expect.stringContaining("Extra keys are allowed")
    });
    expect(firstBodyPayload.output_example).toMatchObject({
      scope: "paragraph",
      matches: [
        {
          semantic_key: "title",
          paragraph_ids: ["p2"]
        }
      ],
      unmatched_paragraph_ids: [],
      conflicts: []
    });

    expect(firstBodyBatch?.schema).toEqual({
      type: "object",
      additionalProperties: true
    });
  });

  it("aggregates batch results deterministically across semantic merges and conflicts", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const {
      aggregateTemplateClassificationResults,
      buildTemplateClassificationBatches
    } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/aggregate.docx",
      observation: {
        document_meta: {
          total_paragraphs: 5,
          total_tables: 0
        },
        paragraphs: [
          { id: "p1", text: "关于年度检查工作的通知", role: "heading", heading_level: 1, style_name: "Heading 1", run_ids: ["p1_r1"], in_table: false },
          { id: "p2", text: "第一段正文", role: "body", style_name: "BodyText", run_ids: ["p2_r1"], in_table: false },
          { id: "p3", text: "第二段正文", role: "body", style_name: "BodyText", run_ids: ["p3_r1"], in_table: false },
          { id: "p4", text: "第三段正文", role: "body", style_name: "BodyText", run_ids: ["p4_r1"], in_table: false },
          { id: "p5", text: "附件说明", role: "footer", style_name: "Footer", run_ids: ["p5_r1"], in_table: false }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "关于年度检查工作的通知", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "第一段正文", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "第二段正文", style: {} }] },
          { id: "p4", node_type: "paragraph", children: [{ id: "p4_r1", node_type: "text_run", content: "第三段正文", style: {} }] },
          { id: "p5", node_type: "paragraph", children: [{ id: "p5_r1", node_type: "text_run", content: "附件说明", style: {} }] }
        ]
      }
    });
    const batches = buildTemplateClassificationBatches(baseTemplate, context, {
      maxParagraphsPerBatch: 2,
      maxPromptBytes: 32_000
    });

    const result = aggregateTemplateClassificationResults({
      template: baseTemplate,
      context,
      batchResults: [
        {
          batch: batches[0],
          result: {
            template_id: "official_doc_body",
            matches: [{ semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.95, reason: "标题段落" }],
            unmatched_paragraph_ids: [],
            conflicts: [],
            overall_confidence: 0.95
          }
        },
        {
          batch: batches[1],
          result: {
            template_id: "official_doc_body",
            matches: [
              {
                semantic_key: "body",
                paragraph_ids: ["p3", "p2"],
                confidence: 0.8,
                reason: "正文前两段"
              }
            ],
            unmatched_paragraph_ids: [],
            conflicts: [],
            overall_confidence: 0.8
          }
        },
        {
          batch: batches[2],
          result: {
            template_id: "official_doc_body",
            matches: [{ semantic_key: "body", paragraph_ids: ["p4"], confidence: 0.6, reason: "正文续段" }],
            unmatched_paragraph_ids: [],
            conflicts: [],
            overall_confidence: 0.6
          }
        },
        {
          batch: {
            ...batches[2],
            bucket_type: "unknown"
          },
          result: {
            template_id: "official_doc_body",
            matches: [{ semantic_key: "title", paragraph_ids: ["p4"], confidence: 0.7, reason: "误判成标题" }],
            unmatched_paragraph_ids: [],
            conflicts: [],
            overall_confidence: 0.7
          }
        }
      ]
    });

    expect(result.matches).toEqual([
      {
        semantic_key: "title",
        paragraph_ids: ["p1", "p4"],
        confidence: 0.825,
        reason: "标题段落 | 误判成标题"
      },
      {
        semantic_key: "body",
        paragraph_ids: ["p2", "p3", "p4"],
        confidence: 0.733333,
        reason: "正文前两段 | 正文续段"
      }
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.unmatched_paragraph_ids).toEqual(["p5"]);
    expect(result.diagnostics?.unmatched_paragraphs).toEqual([
      {
        paragraph_id: "p5",
        text_excerpt: "附件说明",
        role: "footer",
        bucket_type: "unknown",
        paragraph_index: 4,
        reason: "no_candidate",
        model_reported_unmatched: false
      }
    ]);
    expect(result.overall_confidence).toBeCloseTo(0.77, 5);
  });

  it("aggregates ignored unknown semantic diagnostics without creating matches or conflicts", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { aggregateTemplateClassificationResults } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/aggregate-unknown.docx",
      observation: baseObservation
    });

    const result = aggregateTemplateClassificationResults({
      template: baseTemplate,
      context,
      batchResults: [
        {
          batch: {
            bucket_type: "heading",
            batch_index: 1,
            batch_count: 2,
            paragraphs: [context.classificationInput.paragraphs[0]!],
            paragraph_id_set: ["p1"]
          },
          result: {
            template_id: "official_doc_body",
            matches: [{ semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.95, reason: "标题段落" }],
            unmatched_paragraph_ids: [],
            conflicts: [],
            overall_confidence: 0.95
          }
        },
        {
          batch: {
            bucket_type: "body",
            batch_index: 1,
            batch_count: 1,
            paragraphs: [context.classificationInput.paragraphs[1]!, context.classificationInput.paragraphs[2]!],
            paragraph_id_set: ["p2", "p3"]
          },
          result: {
            template_id: "official_doc_body",
            matches: [{ semantic_key: "body", paragraph_ids: ["p2"], confidence: 0.9, reason: "正文" }],
            unmatched_paragraph_ids: [],
            conflicts: [],
            diagnostics: {
              ignored_unknown_semantic_matches: [
                { semantic_key: "appendix", paragraph_ids: ["p3"], confidence: 0.8, reason: "附件" },
                { semantic_key: "metadata", paragraph_ids: ["p3"] }
              ]
            },
            overall_confidence: 0.9
          }
        }
      ]
    });

    expect(result.matches.map((match) => match.semantic_key)).toEqual(["title", "body"]);
    expect(result.conflicts).toEqual([]);
    expect(result.unmatched_paragraph_ids).toEqual(["p3"]);
    expect(result.diagnostics).toEqual({
      unmatched_paragraphs: [
        {
          paragraph_id: "p3",
          text_excerpt: "请认真贯彻执行。",
          role: "body",
          bucket_type: "body",
          paragraph_index: 2,
          reason: "no_candidate",
          model_reported_unmatched: false
        }
      ],
      ignored_unknown_semantic_matches: [
        { semantic_key: "appendix", paragraph_ids: ["p3"], confidence: 0.8, reason: "附件" },
        { semantic_key: "metadata", paragraph_ids: ["p3"] }
      ]
    });
  });
});

describe("template classification refinement", () => {
  function buildObservation(paragraphs: Array<{
    id: string;
    text: string;
    role: string;
    heading_level?: number;
    style_name?: string;
    in_table?: boolean;
    image_count?: number;
  }>): PythonDocxObservationState {
    return {
      document_meta: {
        total_paragraphs: paragraphs.length,
        total_tables: 0
      },
      paragraphs: paragraphs.map((paragraph) => ({
        id: paragraph.id,
        text: paragraph.text,
        role: paragraph.role,
        heading_level: paragraph.heading_level,
        style_name: paragraph.style_name,
        run_ids: paragraph.text.trim().length > 0 ? [`${paragraph.id}_r1`] : [],
        in_table: paragraph.in_table ?? false
      })),
      nodes: paragraphs.map((paragraph) => ({
        id: paragraph.id,
        node_type: "paragraph" as const,
        children: [
          ...(paragraph.text.trim().length > 0
            ? [
                {
                  id: `${paragraph.id}_r1`,
                  node_type: "text_run" as const,
                  content: paragraph.text,
                  style: {}
                }
              ]
            : []),
          ...Array.from({ length: paragraph.image_count ?? 0 }, (_, imageIndex) => ({
            id: `${paragraph.id}_img${imageIndex + 1}`,
            node_type: "image" as const,
            src: `memory://${paragraph.id}/${imageIndex + 1}.png`,
            size: {
              width: 640,
              height: 360
            }
          }))
        ]
      }))
    };
  }

  function buildBlankFallbackTemplate() {
    return {
      ...baseTemplate,
      semantic_blocks: [
        ...baseTemplate.semantic_blocks,
        {
          key: "blank_or_unknown",
          label: "空白或未知",
          description: "吸收空白段和无法稳定判定的段落。",
          examples: [""],
          required: false,
          multiple: true
        }
      ],
      layout_rules: {
        ...baseTemplate.layout_rules,
        semantic_rules: [
          ...baseTemplate.layout_rules.semantic_rules,
          {
            semantic_key: "blank_or_unknown",
            style_hints: {
              allow_empty_text: true
            }
          }
        ]
      },
      operation_blocks: [
        ...baseTemplate.operation_blocks,
        {
          semantic_key: "blank_or_unknown",
          text_style: {},
          paragraph_style: {}
        }
      ]
    };
  }

  function buildCoverImageTemplate() {
    const templateWithBlankFallback = buildBlankFallbackTemplate();
    return {
      ...templateWithBlankFallback,
      semantic_blocks: [
        {
          key: "cover_image",
          label: "图片段落",
          description: "任意具备图片证据的图片段落，可包含少量图号或说明文字。",
          examples: ["（图片段落）"],
          required: false,
          multiple: true
        },
        ...templateWithBlankFallback.semantic_blocks
      ],
      layout_rules: {
        ...templateWithBlankFallback.layout_rules,
        global_rules: {
          ...templateWithBlankFallback.layout_rules.global_rules
        },
        semantic_rules: [
          {
            semantic_key: "cover_image",
            style_hints: {
              allow_empty_text: true,
              require_image: true,
              must_not_be_in_table: true
            },
            occurrence: {
              min_occurs: 0,
              max_occurs: 200
            }
          },
          ...templateWithBlankFallback.layout_rules.semantic_rules
        ]
      },
      operation_blocks: [
        {
          semantic_key: "cover_image",
          text_style: {},
          paragraph_style: {}
        },
        ...templateWithBlankFallback.operation_blocks
      ]
    };
  }

  async function classifyCoverImageParagraphWithRefinementChoice(chosenSemanticKey: string) {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { classifyTemplateParagraphs } = await import("../src/templates/template-classifier.js");
    const template = buildCoverImageTemplate();
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/refine-cover-image.docx",
      observation: buildObservation([
        {
          id: "p1",
          text: "",
          role: "unknown",
          image_count: 1
        },
        {
          id: "p2",
          text: "关于开展年度检查工作的通知",
          role: "heading",
          heading_level: 1,
          style_name: "Heading 1"
        }
      ])
    });

    return classifyTemplateParagraphs(
      {
        template,
        context
      },
      {
        modelGateway: {
          requestJson: async (input) => {
            const payload = JSON.parse(String(input.messages[1]?.content ?? "{}")) as Record<string, unknown>;
            if (input.schemaName === "template_classification_refinement_result") {
              return {
                decisions: [
                  {
                    paragraph_id: "p1",
                    chosen_semantic_key: chosenSemanticKey,
                    confidence: 0.98,
                    reason: `Second pass picked ${chosenSemanticKey}.`
                  }
                ]
              };
            }

            const paragraphIds = ((payload.batch as { paragraph_ids?: string[] } | undefined)?.paragraph_ids ?? []);
            if (paragraphIds.includes("p2")) {
              return {
                template_id: "official_doc_body",
                matches: [{ semantic_key: "title", paragraph_ids: ["p2"], confidence: 0.97, reason: "标题段落" }],
                unmatched_paragraph_ids: [],
                conflicts: [],
                overall_confidence: 0.97
              };
            }
            return {
              template_id: "official_doc_body",
              matches: [],
              unmatched_paragraph_ids: [],
              conflicts: [
                {
                  paragraph_id: "p1",
                  candidate_semantic_keys: ["title"],
                  reason: "首段靠近标题区域"
                }
              ],
              overall_confidence: 0.4
            };
          }
        }
      }
    );
  }

  it("accepts a second-pass override for low-confidence paragraphs", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { classifyTemplateParagraphs } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/refine-low-confidence.docx",
      observation: buildObservation([
        {
          id: "p1",
          text: "关于开展年度检查工作的通知",
          role: "heading",
          heading_level: 1,
          style_name: "Heading 1"
        },
        {
          id: "p2",
          text: "现将有关事项通知如下。",
          role: "body",
          style_name: "BodyText"
        }
      ])
    });

    const requests: Array<{ schemaName: string; payload: Record<string, unknown> }> = [];
    const result = await classifyTemplateParagraphs(
      {
        template: baseTemplate,
        context
      },
      {
        modelGateway: {
          requestJson: async (input) => {
            const payload = JSON.parse(String(input.messages[1]?.content ?? "{}")) as Record<string, unknown>;
            requests.push({
              schemaName: input.schemaName,
              payload
            });
            if (input.schemaName === "template_classification_refinement_result") {
              return {
                decisions: [
                  {
                    paragraph_id: "p2",
                    chosen_semantic_key: "body",
                    confidence: 0.93,
                    reason: "Second pass confirms body semantic."
                  }
                ]
              };
            }

            const paragraphIds = ((payload.batch as { paragraph_ids?: string[] } | undefined)?.paragraph_ids ?? []);
            if (paragraphIds.includes("p1")) {
              return {
                template_id: "official_doc_body",
                matches: [{ semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.97, reason: "标题段落" }],
                unmatched_paragraph_ids: [],
                conflicts: [],
                overall_confidence: 0.97
              };
            }
            return {
              template_id: "official_doc_body",
              matches: [{ semantic_key: "body", paragraph_ids: ["p2"], confidence: 0.42, reason: "正文候选" }],
              unmatched_paragraph_ids: [],
              conflicts: [],
              overall_confidence: 0.42
            };
          }
        }
      }
    );

    expect(requests.map((request) => request.schemaName)).toEqual([
      "template_classification_result",
      "template_classification_result",
      "template_classification_refinement_result"
    ]);
    expect((requests[2]?.payload.target_paragraphs as Array<{ paragraph_id: string }>).map((item) => item.paragraph_id)).toEqual([
      "p2"
    ]);
    expect(result.matches).toEqual([
      {
        semantic_key: "title",
        paragraph_ids: ["p1"],
        confidence: 0.97,
        reason: "标题段落"
      },
      {
        semantic_key: "body",
        paragraph_ids: ["p2"],
        confidence: 0.93,
        reason: "Second pass confirms body semantic."
      }
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.unmatched_paragraph_ids).toEqual([]);
    expect(result.overall_confidence).toBe(0.95);
    expect(result.diagnostics?.refined_paragraphs).toEqual([
      {
        paragraph_id: "p2",
        first_pass: {
          semantic_keys: ["body"],
          confidence: 0.42,
          reason: "正文候选",
          source: "low_confidence"
        },
        second_pass: {
          semantic_key: "body",
          confidence: 0.93,
          reason: "Second pass confirms body semantic."
        },
        outcome: "accepted"
      }
    ]);
    expect(result.diagnostics?.refinement_elapsed_ms).toEqual(expect.any(Number));
  });

  it("exposes paragraph-level image evidence in refinement context and accepts cover_image", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { classifyTemplateParagraphs } = await import("../src/templates/template-classifier.js");
    const template = buildCoverImageTemplate();
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/refine-cover-image.docx",
      observation: buildObservation([
        {
          id: "p1",
          text: "",
          role: "unknown",
          image_count: 1
        },
        {
          id: "p2",
          text: "关于开展年度检查工作的通知",
          role: "heading",
          heading_level: 1,
          style_name: "Heading 1"
        }
      ])
    });

    expect(context.classificationInput.paragraphs[0]).toMatchObject({
      paragraph_id: "p1",
      has_image_evidence: true,
      image_count: 1,
      is_image_dominant: true
    });
    expect(context.observationSummary.classifiable_paragraphs[0]).toMatchObject({
      paragraph_id: "p1",
      has_image_evidence: true,
      image_count: 1,
      is_image_dominant: true
    });

    const requests: Array<{ schemaName: string; payload: Record<string, unknown> }> = [];
    const result = await classifyTemplateParagraphs(
      {
        template,
        context
      },
      {
        modelGateway: {
          requestJson: async (input) => {
            const payload = JSON.parse(String(input.messages[1]?.content ?? "{}")) as Record<string, unknown>;
            requests.push({
              schemaName: input.schemaName,
              payload
            });
            if (input.schemaName === "template_classification_refinement_result") {
              return {
                decisions: [
                  {
                    paragraph_id: "p1",
                    chosen_semantic_key: "cover_image",
                    confidence: 0.98,
                    reason: "Top image-only paragraph is the cover image."
                  }
                ]
              };
            }

            const paragraphIds = ((payload.batch as { paragraph_ids?: string[] } | undefined)?.paragraph_ids ?? []);
            if (paragraphIds.includes("p2")) {
              return {
                template_id: "official_doc_body",
                matches: [{ semantic_key: "title", paragraph_ids: ["p2"], confidence: 0.97, reason: "标题段落" }],
                unmatched_paragraph_ids: [],
                conflicts: [],
                overall_confidence: 0.97
              };
            }
            return {
              template_id: "official_doc_body",
              matches: [],
              unmatched_paragraph_ids: [],
              conflicts: [
                {
                  paragraph_id: "p1",
                  candidate_semantic_keys: ["title"],
                  reason: "首段靠近标题区域"
                }
              ],
              overall_confidence: 0.4
            };
          }
        }
      }
    );

    const refinementRequest = requests.find((request) => request.schemaName === "template_classification_refinement_result");
    const targetParagraph = (
      refinementRequest?.payload.target_paragraphs as Array<Record<string, unknown>> | undefined
    )?.find((item) => item.paragraph_id === "p1");
    expect(targetParagraph).toBeDefined();
    expect(targetParagraph?.candidate_semantic_keys).toContain("cover_image");
    expect(targetParagraph?.local_context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paragraph_id: "p1",
          has_image_evidence: true,
          image_count: 1,
          is_image_dominant: true
        })
      ])
    );

    expect(result.matches).toEqual([
      {
        semantic_key: "cover_image",
        paragraph_ids: ["p1"],
        confidence: 0.98,
        reason: "Top image-only paragraph is the cover image."
      },
      {
        semantic_key: "title",
        paragraph_ids: ["p2"],
        confidence: 0.97,
        reason: "标题段落"
      }
    ]);
    expect(result.unmatched_paragraph_ids).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.diagnostics?.refined_paragraphs).toEqual([
      {
        paragraph_id: "p1",
        first_pass: {
          candidate_semantic_keys: ["title"],
          reason: "首段靠近标题区域",
          source: "conflict"
        },
        second_pass: {
          semantic_key: "cover_image",
          confidence: 0.98,
          reason: "Top image-only paragraph is the cover image."
        },
        outcome: "accepted"
      }
    ]);
  });

  it.each(["图片段落", "标题图片", "封面图片"])(
    "normalizes refinement image alias %s into cover_image",
    async (chosenSemanticKey) => {
      const result = await classifyCoverImageParagraphWithRefinementChoice(chosenSemanticKey);

      expect(result.matches).toEqual([
        {
          semantic_key: "cover_image",
          paragraph_ids: ["p1"],
          confidence: 0.98,
          reason: `Second pass picked ${chosenSemanticKey}.`
        },
        {
          semantic_key: "title",
          paragraph_ids: ["p2"],
          confidence: 0.97,
          reason: "标题段落"
        }
      ]);
      expect(result.conflicts).toEqual([]);
      expect(result.unmatched_paragraph_ids).toEqual([]);
      expect(result.diagnostics?.refined_paragraphs?.[0]).toEqual({
        paragraph_id: "p1",
        first_pass: {
          candidate_semantic_keys: ["title"],
          reason: "首段靠近标题区域",
          source: "conflict"
        },
        second_pass: {
          semantic_key: "cover_image",
          confidence: 0.98,
          reason: `Second pass picked ${chosenSemanticKey}.`
        },
        outcome: "accepted"
      });
    }
  );

  it("keeps refinement decisions rejected when the semantic key is not a known image alias", async () => {
    const result = await classifyCoverImageParagraphWithRefinementChoice("figure_image");

    expect(result.matches).toEqual([
      {
        semantic_key: "title",
        paragraph_ids: ["p2"],
        confidence: 0.97,
        reason: "标题段落"
      }
    ]);
    expect(result.conflicts).toEqual([
      {
        paragraph_id: "p1",
        candidate_semantic_keys: ["title"],
        reason: "首段靠近标题区域"
      }
    ]);
    expect(result.diagnostics?.refined_paragraphs?.[0]).toEqual({
      paragraph_id: "p1",
      first_pass: {
        candidate_semantic_keys: ["title"],
        reason: "首段靠近标题区域",
        source: "conflict"
      },
      second_pass: {
        semantic_key: "figure_image",
        confidence: 0.98,
        reason: "Second pass picked figure_image."
      },
      outcome: "rejected_invalid"
    });
  });

  it("resolves conflict paragraphs into blank_or_unknown fallback", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { classifyTemplateParagraphs } = await import("../src/templates/template-classifier.js");
    const template = buildBlankFallbackTemplate();
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/refine-conflict.docx",
      observation: buildObservation([
        {
          id: "p1",
          text: "关于开展年度检查工作的通知",
          role: "heading",
          heading_level: 1,
          style_name: "Heading 1"
        },
        {
          id: "p2",
          text: "",
          role: "body",
          style_name: "BodyText"
        }
      ])
    });

    const result = await classifyTemplateParagraphs(
      {
        template,
        context
      },
      {
        modelGateway: {
          requestJson: async (input) => {
            const payload = JSON.parse(String(input.messages[1]?.content ?? "{}")) as Record<string, unknown>;
            if (input.schemaName === "template_classification_refinement_result") {
              return {
                decisions: [
                  {
                    paragraph_id: "p2",
                    chosen_semantic_key: "blank_or_unknown",
                    reason: "Blank paragraph should use fallback semantic."
                  }
                ]
              };
            }

            const paragraphIds = ((payload.batch as { paragraph_ids?: string[] } | undefined)?.paragraph_ids ?? []);
            if (paragraphIds.includes("p1")) {
              return {
                template_id: "official_doc_body",
                matches: [{ semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.97, reason: "标题段落" }],
                unmatched_paragraph_ids: [],
                conflicts: [],
                overall_confidence: 0.97
              };
            }
            return {
              template_id: "official_doc_body",
              matches: [],
              unmatched_paragraph_ids: [],
              conflicts: [
                {
                  paragraph_id: "p2",
                  candidate_semantic_keys: ["title", "body"],
                  reason: "空白段容易误判"
                }
              ],
              overall_confidence: 0.3
            };
          }
        }
      }
    );

    expect(result.matches).toEqual([
      {
        semantic_key: "title",
        paragraph_ids: ["p1"],
        confidence: 0.97,
        reason: "标题段落"
      },
      {
        semantic_key: "blank_or_unknown",
        paragraph_ids: ["p2"],
        reason: "Blank paragraph should use fallback semantic."
      }
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.unmatched_paragraph_ids).toEqual([]);
    expect(result.diagnostics?.refined_paragraphs).toEqual([
      {
        paragraph_id: "p2",
        first_pass: {
          candidate_semantic_keys: ["title", "body"],
          reason: "空白段容易误判",
          source: "conflict"
        },
        second_pass: {
          semantic_key: "blank_or_unknown",
          reason: "Blank paragraph should use fallback semantic."
        },
        outcome: "accepted_blank_or_unknown"
      }
    ]);
  });

  it("does not absorb image-only cover paragraphs into blank_or_unknown fallback", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { classifyTemplateParagraphs } = await import("../src/templates/template-classifier.js");
    const template = buildCoverImageTemplate();
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/refine-cover-image-unmatched.docx",
      observation: buildObservation([
        {
          id: "p1",
          text: "",
          role: "unknown",
          image_count: 1
        }
      ])
    });

    const result = await classifyTemplateParagraphs(
      {
        template,
        context
      },
      {
        modelGateway: {
          requestJson: async () => ({
            template_id: "official_doc_body",
            matches: [],
            unmatched_paragraph_ids: ["p1"],
            conflicts: [],
            overall_confidence: 0.2
          })
        }
      }
    );

    expect(result.matches).toEqual([]);
    expect(result.unmatched_paragraph_ids).toEqual(["p1"]);
    expect(result.conflicts).toEqual([]);
  });

  it("adds cover_image as a candidate for mid-document image paragraphs", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { classifyTemplateParagraphs } = await import("../src/templates/template-classifier.js");
    const template = buildCoverImageTemplate();
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/refine-mid-document-image.docx",
      observation: buildObservation([
        {
          id: "p1",
          text: "关于开展年度检查工作的通知",
          role: "heading",
          heading_level: 1,
          style_name: "Heading 1"
        },
        {
          id: "p2",
          text: "图7.1.1 模型输出截图",
          role: "body",
          style_name: "BodyText",
          image_count: 1
        }
      ])
    });

    const requests: Array<{ schemaName: string; payload: Record<string, unknown> }> = [];
    const result = await classifyTemplateParagraphs(
      {
        template,
        context
      },
      {
        modelGateway: {
          requestJson: async (input) => {
            const payload = JSON.parse(String(input.messages[1]?.content ?? "{}")) as Record<string, unknown>;
            requests.push({
              schemaName: input.schemaName,
              payload
            });
            if (input.schemaName === "template_classification_refinement_result") {
              return {
                decisions: [
                  {
                    paragraph_id: "p2",
                    chosen_semantic_key: "cover_image",
                    confidence: 0.96,
                    reason: "Image evidence indicates this is an image paragraph."
                  }
                ]
              };
            }

            const paragraphIds = ((payload.batch as { paragraph_ids?: string[] } | undefined)?.paragraph_ids ?? []);
            if (paragraphIds.includes("p1")) {
              return {
                template_id: "official_doc_body",
                matches: [{ semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.97, reason: "标题段落" }],
                unmatched_paragraph_ids: [],
                conflicts: [],
                overall_confidence: 0.97
              };
            }
            return {
              template_id: "official_doc_body",
              matches: [],
              unmatched_paragraph_ids: [],
              conflicts: [
                {
                  paragraph_id: "p2",
                  candidate_semantic_keys: ["body"],
                  reason: "正文图示段落"
                }
              ],
              overall_confidence: 0.45
            };
          }
        }
      }
    );

    const refinementRequest = requests.find((request) => request.schemaName === "template_classification_refinement_result");
    const targetParagraph = (
      refinementRequest?.payload.target_paragraphs as Array<Record<string, unknown>> | undefined
    )?.find((item) => item.paragraph_id === "p2");
    expect(targetParagraph).toBeDefined();
    expect(targetParagraph?.candidate_semantic_keys).toContain("cover_image");
    expect(targetParagraph?.local_context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paragraph_id: "p2",
          has_image_evidence: true,
          image_count: 1,
          is_image_dominant: false
        })
      ])
    );
    expect(result.matches).toEqual([
      {
        semantic_key: "cover_image",
        paragraph_ids: ["p2"],
        confidence: 0.96,
        reason: "Image evidence indicates this is an image paragraph."
      },
      {
        semantic_key: "title",
        paragraph_ids: ["p1"],
        confidence: 0.97,
        reason: "标题段落"
      }
    ]);
    expect(result.unmatched_paragraph_ids).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("accepts multiple cover_image paragraphs in one template", async () => {
    const { normalizeTemplateClassificationResult } = await import("../src/templates/template-classifier.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const template = buildCoverImageTemplate();
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/multi-image-paragraphs.docx",
      observation: buildObservation([
        {
          id: "p1",
          text: "关于开展年度检查工作的通知",
          role: "heading",
          heading_level: 1,
          style_name: "Heading 1"
        },
        {
          id: "p2",
          text: "",
          role: "unknown",
          image_count: 1
        },
        {
          id: "p3",
          text: "图2 实验截图",
          role: "body",
          style_name: "BodyText",
          image_count: 1
        },
        {
          id: "p4",
          text: "现将有关事项通知如下。",
          role: "body",
          style_name: "BodyText"
        }
      ])
    });

    const normalized = normalizeTemplateClassificationResult({
      template,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          {
            semantic_key: "title",
            paragraph_ids: ["p1"],
            confidence: 0.97,
            reason: "标题段落"
          },
          {
            semantic_key: "cover_image",
            paragraph_ids: ["p2", "p3"],
            confidence: 0.95,
            reason: "image paragraphs"
          },
          {
            semantic_key: "body",
            paragraph_ids: ["p4"],
            confidence: 0.94,
            reason: "正文段落"
          }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(normalized.matches).toEqual([
      {
        semantic_key: "cover_image",
        paragraph_ids: ["p2", "p3"],
        confidence: 0.95,
        reason: "image paragraphs"
      },
      {
        semantic_key: "title",
        paragraph_ids: ["p1"],
        confidence: 0.97,
        reason: "标题段落"
      },
      {
        semantic_key: "body",
        paragraph_ids: ["p4"],
        confidence: 0.94,
        reason: "正文段落"
      }
    ]);
    const validation = validateTemplateClassification({ template, context, classification: normalized });
    expect(validation.issues.some((issue) => issue.error_code === "single_semantic_multiple_paragraphs")).toBe(false);
    expect(validation.issues.some((issue) => issue.error_code === "occurrence_above_max")).toBe(false);
    expect(validation.issues.some((issue) => issue.error_code === "ordering_violation")).toBe(false);
  });

  it("deduplicates paragraphs that are both low-confidence and conflicting", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { classifyTemplateParagraphs } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/refine-dedup.docx",
      observation: buildObservation([
        {
          id: "p1",
          text: "关于开展年度检查工作的通知",
          role: "heading",
          heading_level: 1,
          style_name: "Heading 1"
        },
        {
          id: "p2",
          text: "现将有关事项通知如下。",
          role: "body",
          style_name: "BodyText"
        }
      ])
    });

    const requests: Array<{ schemaName: string; payload: Record<string, unknown> }> = [];
    const result = await classifyTemplateParagraphs(
      {
        template: baseTemplate,
        context
      },
      {
        modelGateway: {
          requestJson: async (input) => {
            const payload = JSON.parse(String(input.messages[1]?.content ?? "{}")) as Record<string, unknown>;
            requests.push({
              schemaName: input.schemaName,
              payload
            });
            if (input.schemaName === "template_classification_refinement_result") {
              return {
                decisions: [
                  {
                    paragraph_id: "p2",
                    chosen_semantic_key: "body",
                    confidence: 0.91,
                    reason: "Second pass removes the ambiguity."
                  }
                ]
              };
            }

            const paragraphIds = ((payload.batch as { paragraph_ids?: string[] } | undefined)?.paragraph_ids ?? []);
            if (paragraphIds.includes("p1")) {
              return {
                template_id: "official_doc_body",
                matches: [{ semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.98, reason: "标题段落" }],
                unmatched_paragraph_ids: [],
                conflicts: [],
                overall_confidence: 0.98
              };
            }
            return {
              template_id: "official_doc_body",
              matches: [{ semantic_key: "body", paragraph_ids: ["p2"], confidence: 0.45, reason: "正文候选" }],
              unmatched_paragraph_ids: [],
              conflicts: [
                {
                  paragraph_id: "p2",
                  candidate_semantic_keys: ["title", "body"],
                  reason: "模型给出多个候选"
                }
              ],
              overall_confidence: 0.45
            };
          }
        }
      }
    );

    expect((requests[2]?.payload.target_paragraphs as Array<{ paragraph_id: string }>).map((item) => item.paragraph_id)).toEqual([
      "p2"
    ]);
    expect(result.matches[1]).toEqual({
      semantic_key: "body",
      paragraph_ids: ["p2"],
      confidence: 0.91,
      reason: "Second pass removes the ambiguity."
    });
    expect(result.conflicts).toEqual([]);
  });

  it("keeps the first-pass failure when refinement remains below threshold", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { classifyTemplateParagraphs } = await import("../src/templates/template-classifier.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/refine-still-low.docx",
      observation: buildObservation([
        {
          id: "p1",
          text: "关于开展年度检查工作的通知",
          role: "heading",
          heading_level: 1,
          style_name: "Heading 1"
        },
        {
          id: "p2",
          text: "现将有关事项通知如下。",
          role: "body",
          style_name: "BodyText"
        }
      ])
    });

    const result = await classifyTemplateParagraphs(
      {
        template: baseTemplate,
        context
      },
      {
        modelGateway: {
          requestJson: async (input) => {
            const payload = JSON.parse(String(input.messages[1]?.content ?? "{}")) as Record<string, unknown>;
            if (input.schemaName === "template_classification_refinement_result") {
              return {
                decisions: [
                  {
                    paragraph_id: "p2",
                    chosen_semantic_key: "body",
                    confidence: 0.55,
                    reason: "Still not confident enough."
                  }
                ]
              };
            }

            const paragraphIds = ((payload.batch as { paragraph_ids?: string[] } | undefined)?.paragraph_ids ?? []);
            if (paragraphIds.includes("p1")) {
              return {
                template_id: "official_doc_body",
                matches: [{ semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.97, reason: "标题段落" }],
                unmatched_paragraph_ids: [],
                conflicts: [],
                overall_confidence: 0.97
              };
            }
            return {
              template_id: "official_doc_body",
              matches: [{ semantic_key: "body", paragraph_ids: ["p2"], confidence: 0.42, reason: "正文候选" }],
              unmatched_paragraph_ids: [],
              conflicts: [],
              overall_confidence: 0.42
            };
          }
        }
      }
    );
    const validation = validateTemplateClassification({
      template: baseTemplate,
      context,
      classification: result
    });

    expect(result.matches[1]).toEqual({
      semantic_key: "body",
      paragraph_ids: ["p2"],
      confidence: 0.42,
      reason: "正文候选"
    });
    expect(result.diagnostics?.refined_paragraphs?.[0]?.outcome).toBe("rejected_low_confidence");
    expect(validation.issues.map((issue) => issue.error_code)).toContain("confidence_below_threshold");
  });

  it("keeps the first-pass conflict when refinement remains unresolved", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { classifyTemplateParagraphs } = await import("../src/templates/template-classifier.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/refine-still-conflict.docx",
      observation: buildObservation([
        {
          id: "p1",
          text: "关于开展年度检查工作的通知",
          role: "heading",
          heading_level: 1,
          style_name: "Heading 1"
        },
        {
          id: "p2",
          text: "现将有关事项通知如下。",
          role: "body",
          style_name: "BodyText"
        }
      ])
    });

    const result = await classifyTemplateParagraphs(
      {
        template: baseTemplate,
        context
      },
      {
        modelGateway: {
          requestJson: async (input) => {
            const payload = JSON.parse(String(input.messages[1]?.content ?? "{}")) as Record<string, unknown>;
            if (input.schemaName === "template_classification_refinement_result") {
              return {
                decisions: [
                  {
                    paragraph_id: "p2",
                    candidate_semantic_keys: ["title", "body"],
                    reason: "Second pass still cannot break the tie."
                  }
                ]
              };
            }

            const paragraphIds = ((payload.batch as { paragraph_ids?: string[] } | undefined)?.paragraph_ids ?? []);
            if (paragraphIds.includes("p1")) {
              return {
                template_id: "official_doc_body",
                matches: [{ semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.97, reason: "标题段落" }],
                unmatched_paragraph_ids: [],
                conflicts: [],
                overall_confidence: 0.97
              };
            }
            return {
              template_id: "official_doc_body",
              matches: [],
              unmatched_paragraph_ids: [],
              conflicts: [
                {
                  paragraph_id: "p2",
                  candidate_semantic_keys: ["title", "body"],
                  reason: "模型给出多个候选"
                }
              ],
              overall_confidence: 0.3
            };
          }
        }
      }
    );
    const validation = validateTemplateClassification({
      template: baseTemplate,
      context,
      classification: result
    });

    expect(result.conflicts).toEqual([
      {
        paragraph_id: "p2",
        candidate_semantic_keys: ["title", "body"],
        reason: "模型给出多个候选"
      }
    ]);
    expect(result.diagnostics?.refined_paragraphs?.[0]?.outcome).toBe("rejected_conflict");
    expect(validation.issues.map((issue) => issue.error_code)).toContain("classification_conflict");
  });

  it("skips refinement when the first pass is already confident and conflict-free", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { classifyTemplateParagraphs } = await import("../src/templates/template-classifier.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/no-refine.docx",
      observation: buildObservation([
        {
          id: "p1",
          text: "关于开展年度检查工作的通知",
          role: "heading",
          heading_level: 1,
          style_name: "Heading 1"
        },
        {
          id: "p2",
          text: "现将有关事项通知如下。",
          role: "body",
          style_name: "BodyText"
        }
      ])
    });

    const requests: string[] = [];
    const result = await classifyTemplateParagraphs(
      {
        template: baseTemplate,
        context
      },
      {
        modelGateway: {
          requestJson: async (input) => {
            requests.push(input.schemaName);
            const payload = JSON.parse(String(input.messages[1]?.content ?? "{}")) as Record<string, unknown>;
            const paragraphIds = ((payload.batch as { paragraph_ids?: string[] } | undefined)?.paragraph_ids ?? []);
            if (paragraphIds.includes("p1")) {
              return {
                template_id: "official_doc_body",
                matches: [{ semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.98, reason: "标题段落" }],
                unmatched_paragraph_ids: [],
                conflicts: [],
                overall_confidence: 0.98
              };
            }
            return {
              template_id: "official_doc_body",
              matches: [{ semantic_key: "body", paragraph_ids: ["p2"], confidence: 0.92, reason: "正文" }],
              unmatched_paragraph_ids: [],
              conflicts: [],
              overall_confidence: 0.92
            };
          }
        }
      }
    );

    expect(requests).toEqual(["template_classification_result", "template_classification_result"]);
    expect(result.diagnostics?.refined_paragraphs).toBeUndefined();
    expect(result.matches.map((match) => match.semantic_key)).toEqual(["title", "body"]);
  });
});

describe("template validation and planning", () => {
  it("passes validation and generates a deterministic atomic plan", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const { buildTemplateAtomicPlan } = await import("../src/templates/template-atomic-planner.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });
    const classification = {
      template_id: "official_doc_body",
      matches: [
        {
          semantic_key: "title",
          paragraph_ids: ["p1"],
          confidence: 0.99,
          reason: "标题"
        },
        {
          semantic_key: "body",
          paragraph_ids: ["p2", "p3"],
          confidence: 0.92,
          reason: "正文"
        }
      ],
      unmatched_paragraph_ids: [],
      conflicts: [],
      overall_confidence: 0.95
    };

    const validation = validateTemplateClassification({
      template: baseTemplate,
      context,
      classification
    });
    const executionPlan = buildTemplateAtomicPlan({
      template: baseTemplate,
      classification
    });

    expect(validation.passed).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(executionPlan).toEqual([
      {
        semantic_key: "title",
        paragraph_ids: ["p1"],
        text_style: baseTemplate.operation_blocks[0].text_style,
        paragraph_style: baseTemplate.operation_blocks[0].paragraph_style
      },
      {
        semantic_key: "body",
        paragraph_ids: ["p2", "p3"],
        text_style: baseTemplate.operation_blocks[1].text_style,
        paragraph_style: baseTemplate.operation_blocks[1].paragraph_style,
        relative_spacing: baseTemplate.operation_blocks[1].relative_spacing
      }
    ]);
  });

  it("resolves derived semantics locally and trims parent write targets in favor of refined children", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { normalizeTemplateClassificationResult } = await import("../src/templates/template-classifier.js");
    const { buildTemplateAtomicPlan } = await import("../src/templates/template-atomic-planner.js");
    const { buildTemplateWritePlan } = await import("../src/templates/template-write-planner.js");
    const derivedTemplate = {
      template_meta: {
        id: "official_doc_atomic_with_derived",
        name: "公文原子与派生语义模板",
        version: "1.0.0",
        schema_version: "1.0"
      },
      semantic_blocks: [
        {
          key: "document_title",
          label: "标题",
          description: "公文主标题。",
          examples: ["关于开展年度检查工作的通知"],
          required: true,
          multiple: false
        },
        {
          key: "body_paragraph",
          label: "正文段落",
          description: "普通正文段落。",
          examples: ["现将有关事项通知如下。"],
          required: true,
          multiple: true
        },
        {
          key: "list_item_level_0",
          label: "一级列表",
          description: "一级列表项。",
          examples: ["（一）请认真组织实施。"],
          required: false,
          multiple: true
        }
      ],
      derived_semantics: [
        {
          key: "body_content",
          label: "正文",
          mode: "aggregate",
          inherits_from: ["body_paragraph", "list_item_level_0"],
          examples: ["现将有关事项通知如下。"],
          operation: {
            text_style: {
              font_name: "FangSong_GB2312",
              font_size_pt: 16
            },
            paragraph_style: {
              paragraph_alignment: "justify"
            }
          }
        },
        {
          key: "copy_to_authority",
          label: "抄送机关",
          mode: "refine",
          inherits_from: ["body_paragraph", "list_item_level_0"],
          examples: ["抄送：市委办公室。"],
          text_hints: ["抄送", "送："],
          negative_examples: ["现将"],
          operation: {
            text_style: {
              font_name: "KaiTi"
            },
            paragraph_style: {
              paragraph_alignment: "left"
            }
          }
        }
      ],
      layout_rules: {
        global_rules: {
          document_scope: "full_document",
          ordering: ["document_title", "body_paragraph", "list_item_level_0"],
          allow_unclassified_paragraphs: false
        },
        semantic_rules: [
          {
            semantic_key: "document_title",
            position_hints: ["near_top"],
            occurrence: {
              min_occurs: 1,
              max_occurs: 1
            }
          },
          {
            semantic_key: "body_paragraph",
            occurrence: {
              min_occurs: 1,
              max_occurs: 10
            }
          },
          {
            semantic_key: "list_item_level_0",
            occurrence: {
              min_occurs: 0,
              max_occurs: 10
            }
          }
        ]
      },
      operation_blocks: [
        {
          semantic_key: "document_title",
          text_style: {
            font_name: "FZXiaoBiaoSong-B05S",
            font_size_pt: 22
          },
          paragraph_style: {
            paragraph_alignment: "center"
          }
        },
        {
          semantic_key: "body_paragraph",
          text_style: {
            font_name: "SimSun"
          },
          paragraph_style: {
            paragraph_alignment: "justify"
          }
        },
        {
          semantic_key: "list_item_level_0",
          text_style: {
            font_name: "SimSun"
          },
          paragraph_style: {
            paragraph_alignment: "justify"
          }
        }
      ],
      classification_contract: {
        scope: "paragraph",
        single_owner_per_paragraph: true
      },
      validation_policy: {
        min_confidence: 0.8,
        require_all_required_semantics: true,
        reject_conflicting_matches: true,
        reject_order_violations: true,
        reject_style_violations: true,
        reject_unmatched_when_required: true
      }
    } as const;
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/derived.docx",
      observation: {
        document_meta: {
          total_paragraphs: 4,
          total_tables: 0
        },
        paragraphs: [
          {
            id: "p1",
            text: "关于开展年度检查工作的通知",
            role: "heading",
            heading_level: 1,
            style_name: "Heading 1",
            run_ids: ["p1_r1"],
            in_table: false
          },
          {
            id: "p2",
            text: "现将有关事项通知如下。",
            role: "body",
            style_name: "BodyText",
            run_ids: ["p2_r1"],
            in_table: false
          },
          {
            id: "p3",
            text: "（一）请认真组织实施。",
            role: "list_item",
            list_level: 0,
            style_name: "List Paragraph",
            run_ids: ["p3_r1"],
            in_table: false
          },
          {
            id: "p4",
            text: "抄送：市委办公室。",
            role: "body",
            style_name: "BodyText",
            run_ids: ["p4_r1"],
            in_table: false
          }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "关于开展年度检查工作的通知", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "现将有关事项通知如下。", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "（一）请认真组织实施。", style: {} }] },
          { id: "p4", node_type: "paragraph", children: [{ id: "p4_r1", node_type: "text_run", content: "抄送：市委办公室。", style: {} }] }
        ]
      }
    });
    const classification = normalizeTemplateClassificationResult({
      template: derivedTemplate as any,
      context,
      classification: {
        template_id: "official_doc_atomic_with_derived",
        matches: [
          {
            semantic_key: "document_title",
            paragraph_ids: ["p1"],
            confidence: 0.99,
            reason: "标题"
          },
          {
            semantic_key: "body_paragraph",
            paragraph_ids: ["p2", "p4"],
            confidence: 0.93,
            reason: "正文段落"
          },
          {
            semantic_key: "list_item_level_0",
            paragraph_ids: ["p3"],
            confidence: 0.91,
            reason: "一级列表"
          }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.95
      }
    });
    const executionPlan = buildTemplateAtomicPlan({
      template: derivedTemplate as any,
      classification
    });
    const writePlan = buildTemplateWritePlan({
      template: derivedTemplate as any,
      executionPlan,
      document: context.document,
      structureIndex: context.structureIndex
    });

    expect(classification.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semantic_key: "body_content",
          paragraph_ids: ["p2", "p3", "p4"]
        }),
        expect.objectContaining({
          semantic_key: "copy_to_authority",
          paragraph_ids: ["p4"]
        })
      ])
    );
    expect(executionPlan).toEqual([
      {
        semantic_key: "document_title",
        paragraph_ids: ["p1"],
        text_style: derivedTemplate.operation_blocks[0].text_style,
        paragraph_style: derivedTemplate.operation_blocks[0].paragraph_style
      },
      {
        semantic_key: "body_content",
        paragraph_ids: ["p2", "p3"],
        text_style: derivedTemplate.derived_semantics[0].operation.text_style,
        paragraph_style: derivedTemplate.derived_semantics[0].operation.paragraph_style
      },
      {
        semantic_key: "copy_to_authority",
        paragraph_ids: ["p4"],
        text_style: derivedTemplate.derived_semantics[1].operation.text_style,
        paragraph_style: derivedTemplate.derived_semantics[1].operation.paragraph_style
      }
    ]);
    expect(writePlan.issues).toEqual([]);
    expect(writePlan.writePlan.map((step) => ({
      id: step.id,
      type: step.type,
      paragraphIds: step.targetSelector?.scope === "paragraph_ids" ? step.targetSelector.paragraphIds : undefined
    }))).toEqual([
      {
        id: "document_title:set_font",
        type: "set_font",
        paragraphIds: ["p1"]
      },
      {
        id: "document_title:set_size",
        type: "set_size",
        paragraphIds: ["p1"]
      },
      {
        id: "document_title:set_alignment",
        type: "set_alignment",
        paragraphIds: ["p1"]
      },
      {
        id: "body_content:set_font",
        type: "set_font",
        paragraphIds: ["p2", "p3"]
      },
      {
        id: "body_content:set_size",
        type: "set_size",
        paragraphIds: ["p2", "p3"]
      },
      {
        id: "body_content:set_alignment",
        type: "set_alignment",
        paragraphIds: ["p2", "p3"]
      },
      {
        id: "copy_to_authority:set_font",
        type: "set_font",
        paragraphIds: ["p4"]
      },
      {
        id: "copy_to_authority:set_alignment",
        type: "set_alignment",
        paragraphIds: ["p4"]
      }
    ]);
  });

  it("normalizes unknown semantic diagnostics and absorbs blank_or_unknown fallback", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { normalizeTemplateClassificationResult } = await import("../src/templates/template-classifier.js");
    const template = {
      ...baseTemplate,
      semantic_blocks: [
        ...baseTemplate.semantic_blocks,
        {
          key: "blank_or_unknown",
          label: "空白或未知段落",
          description: "承接空白和 unknown bucket 段落。",
          examples: ["（空白段）"],
          required: false,
          multiple: true
        }
      ],
      layout_rules: {
        ...baseTemplate.layout_rules,
        semantic_rules: [
          ...baseTemplate.layout_rules.semantic_rules,
          {
            semantic_key: "blank_or_unknown",
            style_hints: {
              preferred_role: ["unknown"],
              allow_empty_text: true
            }
          }
        ]
      },
      operation_blocks: [
        ...baseTemplate.operation_blocks,
        {
          semantic_key: "blank_or_unknown",
          text_style: {},
          paragraph_style: {}
        }
      ]
    };
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/normalize-fallback.docx",
      observation: {
        document_meta: {
          total_paragraphs: 5,
          total_tables: 0
        },
        paragraphs: [
          {
            id: "p1",
            text: "关于开展年度检查工作的通知",
            role: "heading",
            heading_level: 1,
            style_name: "Heading 1",
            run_ids: ["p1_r1"],
            in_table: false
          },
          {
            id: "p2",
            text: "现将有关事项通知如下。",
            role: "body",
            style_name: "BodyText",
            run_ids: ["p2_r1"],
            in_table: false
          },
          {
            id: "p3",
            text: "",
            role: "body",
            style_name: "BodyText",
            run_ids: ["p3_r1"],
            in_table: false
          },
          {
            id: "p4",
            text: "——",
            role: "unknown",
            style_name: "Normal",
            run_ids: ["p4_r1"],
            in_table: false
          },
          {
            id: "p5",
            text: "附录：术语说明",
            role: "body",
            style_name: "BodyText",
            run_ids: ["p5_r1"],
            in_table: false
          }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "关于开展年度检查工作的通知", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "现将有关事项通知如下。", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "", style: {} }] },
          { id: "p4", node_type: "paragraph", children: [{ id: "p4_r1", node_type: "text_run", content: "——", style: {} }] },
          { id: "p5", node_type: "paragraph", children: [{ id: "p5_r1", node_type: "text_run", content: "附录：术语说明", style: {} }] }
        ]
      }
    });

    const classification = normalizeTemplateClassificationResult({
      template: template as any,
      context,
      classification: {
        template_id: "official_doc_body_with_fallback",
        matches: [
          {
            semantic_key: "title",
            paragraph_ids: ["p1"],
            confidence: 0.99,
            reason: "标题"
          },
          {
            semantic_key: "body",
            paragraph_ids: ["p2"],
            confidence: 0.92,
            reason: "正文"
          },
          {
            semantic_key: "appendix",
            paragraph_ids: ["p5"],
            confidence: 0.63,
            reason: "未知 tag"
          }
        ],
        unmatched_paragraph_ids: ["p3", "p4"],
        conflicts: [],
        overall_confidence: 0.94
      }
    });

    expect(classification.unmatched_paragraph_ids).toEqual(["p5"]);
    expect(classification.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semantic_key: "blank_or_unknown",
          paragraph_ids: ["p3", "p4"]
        })
      ])
    );
    expect(classification.diagnostics?.ignored_unknown_semantic_matches).toEqual([
      {
        semantic_key: "appendix",
        paragraph_ids: ["p5"],
        confidence: 0.63,
        reason: "未知 tag"
      }
    ]);
    expect(classification.diagnostics?.normalization_notes).toContain("skipped unknown semantic_key 'appendix' from matches[2]");
  });

  it("keeps strict validation failures for structured paragraphs not covered by the template", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { normalizeTemplateClassificationResult } = await import("../src/templates/template-classifier.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const template = {
      ...baseTemplate,
      semantic_blocks: [
        ...baseTemplate.semantic_blocks,
        {
          key: "blank_or_unknown",
          label: "空白或未知段落",
          description: "承接空白和 unknown bucket 段落。",
          examples: ["（空白段）"],
          required: false,
          multiple: true
        }
      ],
      layout_rules: {
        ...baseTemplate.layout_rules,
        semantic_rules: [
          ...baseTemplate.layout_rules.semantic_rules,
          {
            semantic_key: "blank_or_unknown",
            style_hints: {
              preferred_role: ["unknown"],
              allow_empty_text: true
            }
          }
        ]
      },
      operation_blocks: [
        ...baseTemplate.operation_blocks,
        {
          semantic_key: "blank_or_unknown",
          text_style: {},
          paragraph_style: {}
        }
      ]
    };
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/strict-unmatched.docx",
      observation: {
        document_meta: {
          total_paragraphs: 4,
          total_tables: 1
        },
        paragraphs: [
          {
            id: "p1",
            text: "关于开展年度检查工作的通知",
            role: "heading",
            heading_level: 1,
            style_name: "Heading 1",
            run_ids: ["p1_r1"],
            in_table: false
          },
          {
            id: "p2",
            text: "现将有关事项通知如下。",
            role: "body",
            style_name: "BodyText",
            run_ids: ["p2_r1"],
            in_table: false
          },
          {
            id: "p3",
            text: "（一）请认真组织实施。",
            role: "list_item",
            list_level: 0,
            style_name: "List Paragraph",
            run_ids: ["p3_r1"],
            in_table: false
          },
          {
            id: "p4",
            text: "指标 | 说明 | 备注",
            role: "body",
            style_name: "Table Text",
            run_ids: ["p4_r1"],
            in_table: true
          }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "关于开展年度检查工作的通知", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "现将有关事项通知如下。", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "（一）请认真组织实施。", style: {} }] },
          { id: "p4", node_type: "paragraph", children: [{ id: "p4_r1", node_type: "text_run", content: "指标 | 说明 | 备注", style: {} }] }
        ]
      }
    });
    const classification = normalizeTemplateClassificationResult({
      template: template as any,
      context,
      classification: {
        template_id: "official_doc_body_with_fallback",
        matches: [
          {
            semantic_key: "title",
            paragraph_ids: ["p1"],
            confidence: 0.99,
            reason: "标题"
          },
          {
            semantic_key: "body",
            paragraph_ids: ["p2"],
            confidence: 0.92,
            reason: "正文"
          }
        ],
        unmatched_paragraph_ids: ["p3", "p4"],
        conflicts: [],
        overall_confidence: 0.95
      }
    });
    const validation = validateTemplateClassification({
      template: template as any,
      context,
      classification
    });
    const unmatchedIssue = validation.issues.find((issue) => issue.error_code === "unclassified_paragraphs_present");

    expect(classification.unmatched_paragraph_ids).toEqual(["p3", "p4"]);
    expect(validation.passed).toBe(false);
    expect(unmatchedIssue).toMatchObject({
      error_code: "unclassified_paragraphs_present",
      paragraph_ids: ["p3", "p4"],
      diagnostics: {
        unmatched_paragraphs: [
          expect.objectContaining({
            paragraph_id: "p3",
            role: "list_item",
            bucket_type: "list_item"
          }),
          expect.objectContaining({
            paragraph_id: "p4",
            role: "body",
            bucket_type: "table_text"
          })
        ],
        policy: {
          allow_unclassified_paragraphs: false,
          reject_unmatched_when_required: true
        }
      }
    });
  });

  it("ignores unknown semantic matches injected into atomic planning", async () => {
    const { buildTemplateAtomicPlan } = await import("../src/templates/template-atomic-planner.js");

    const executionPlan = buildTemplateAtomicPlan({
      template: baseTemplate,
      classification: {
        template_id: "official_doc_body",
        matches: [
          {
            semantic_key: "title",
            paragraph_ids: ["p1"],
            confidence: 0.99,
            reason: "标题"
          },
          {
            semantic_key: "appendix",
            paragraph_ids: ["p3"],
            confidence: 0.91,
            reason: "外部注入的未知 tag"
          }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(executionPlan).toEqual([
      {
        semantic_key: "title",
        paragraph_ids: ["p1"],
        text_style: baseTemplate.operation_blocks[0].text_style,
        paragraph_style: baseTemplate.operation_blocks[0].paragraph_style
      }
    ]);
  });

  it("reports required, confidence, order, conflict and unmatched violations", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const validation = validateTemplateClassification({
      template: baseTemplate,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          {
            semantic_key: "body",
            paragraph_ids: ["p1"],
            confidence: 0.4,
            reason: "错误归类"
          }
        ],
        unmatched_paragraph_ids: ["p2", "p3"],
        conflicts: [
          {
            paragraph_id: "p1",
            candidate_semantic_keys: ["title", "body"],
            reason: "歧义"
          }
        ],
        overall_confidence: 0.4
      }
    });

    expect(validation.passed).toBe(false);
    expect(validation.issues.map((issue) => issue.error_code)).toEqual(
      expect.arrayContaining([
        "required_semantic_missing",
        "confidence_below_threshold",
        "classification_conflict",
        "unclassified_paragraphs_present",
        "style_violation"
      ])
    );
  });

  it("reports ordering violations when semantic blocks appear out of template order", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const validation = validateTemplateClassification({
      template: baseTemplate,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          {
            semantic_key: "title",
            paragraph_ids: ["p2"],
            confidence: 0.91,
            reason: "错误标题"
          },
          {
            semantic_key: "body",
            paragraph_ids: ["p1"],
            confidence: 0.88,
            reason: "错误正文"
          }
        ],
        unmatched_paragraph_ids: ["p3"],
        conflicts: [],
        overall_confidence: 0.9
      }
    });

    expect(validation.passed).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "ordering_violation"
        })
      ])
    );
  });

  it("allows unmatched paragraphs when template policy explicitly permits them", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        layout_rules: {
          ...baseTemplate.layout_rules,
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            allow_unclassified_paragraphs: true
          }
        },
        validation_policy: {
          ...baseTemplate.validation_policy,
          reject_unmatched_when_required: false
        }
      },
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          {
            semantic_key: "title",
            paragraph_ids: ["p1"],
            confidence: 0.99,
            reason: "标题"
          },
          {
            semantic_key: "body",
            paragraph_ids: ["p2"],
            confidence: 0.91,
            reason: "正文"
          }
        ],
        unmatched_paragraph_ids: ["p3"],
        conflicts: [],
        overall_confidence: 0.93
      }
    });

    expect(validation.passed).toBe(true);
    expect(validation.issues).toEqual([]);
  });

  it("attaches unmatched paragraph context and policy snapshot to strict validation failures", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const validation = validateTemplateClassification({
      template: baseTemplate,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          {
            semantic_key: "title",
            paragraph_ids: ["p1"],
            confidence: 0.99,
            reason: "标题"
          }
        ],
        unmatched_paragraph_ids: ["p2", "p3"],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(validation.passed).toBe(false);
    expect(validation.issues).toContainEqual({
      error_code: "unclassified_paragraphs_present",
      message: "unmatched paragraphs are not allowed by template policy",
      paragraph_ids: ["p2", "p3"],
      diagnostics: {
        unmatched_paragraphs: [
          {
            paragraph_id: "p2",
            text_excerpt: "现将有关事项通知如下。",
            role: "body",
            bucket_type: "body",
            paragraph_index: 1,
            reason: "no_candidate",
            model_reported_unmatched: false
          },
          {
            paragraph_id: "p3",
            text_excerpt: "请认真贯彻执行。",
            role: "body",
            bucket_type: "body",
            paragraph_index: 2,
            reason: "no_candidate",
            model_reported_unmatched: false
          }
        ],
        policy: {
          allow_unclassified_paragraphs: false,
          reject_unmatched_when_required: true
        }
      }
    });
  });

  it("fails with evidence_insufficient when seal evidence is required but unsupported", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        layout_rules: {
          ...baseTemplate.layout_rules,
          semantic_rules: [
            ...baseTemplate.layout_rules.semantic_rules,
            {
              semantic_key: "body",
              position_hints: ["seal_bottom_right"]
            }
          ]
        }
      },
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          {
            semantic_key: "title",
            paragraph_ids: ["p1"],
            confidence: 0.99,
            reason: "标题"
          },
          {
            semantic_key: "body",
            paragraph_ids: ["p2", "p3"],
            confidence: 0.92,
            reason: "正文"
          }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(validation.passed).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "evidence_insufficient"
        })
      ])
    );
  });

  it("reports deterministic semantic hint violations for conservative classification checks", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        semantic_blocks: baseTemplate.semantic_blocks.map((block) =>
          block.key === "title"
            ? {
                ...block,
                negative_examples: ["现将"]
              }
            : block
        ),
        layout_rules: {
          ...baseTemplate.layout_rules,
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            numbering_patterns: ["^一、"]
          },
          semantic_rules: [
            {
              semantic_key: "title",
              position_hints: ["first_non_blank"]
            },
            {
              semantic_key: "body",
              text_hints: ["不存在的提示"],
              position_hints: ["near_top"]
            }
          ]
        },
        validation_policy: {
          ...baseTemplate.validation_policy,
          reject_unmatched_when_required: false,
          reject_style_violations: false
        }
      },
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          { semantic_key: "title", paragraph_ids: ["p2"], confidence: 0.99, reason: "误判标题" },
          { semantic_key: "body", paragraph_ids: ["p3"], confidence: 0.92, reason: "正文" }
        ],
        unmatched_paragraph_ids: ["p1"],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(validation.passed).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ error_code: "negative_example_match", semantic_key: "title" }),
        expect.objectContaining({ error_code: "text_hint_missing", semantic_key: "body" }),
        expect.objectContaining({ error_code: "position_hint_violation", semantic_key: "title" }),
        expect.objectContaining({ error_code: "position_hint_violation", semantic_key: "body" })
      ])
    );
  });

  it("reports numbering and placement rule violations deterministically", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/numbered.docx",
      observation: {
        ...baseObservation,
        paragraphs: [
          { ...baseObservation.paragraphs[0], id: "p1", text: "1. 错误编号标题", run_ids: ["p1_r1"] },
          { ...baseObservation.paragraphs[1], id: "p2", text: "一、正确编号正文", run_ids: ["p2_r1"] },
          { ...baseObservation.paragraphs[2], id: "p3", text: "普通正文", run_ids: ["p3_r1"] }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "1. 错误编号标题", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "一、正确编号正文", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "普通正文", style: {} }] }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        layout_rules: {
          ...baseTemplate.layout_rules,
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            numbering_patterns: ["^[一二三四五六七八九十]+、"]
          },
          semantic_rules: [
            {
              semantic_key: "title",
              placement_rules: {
                immediately_before_semantic: "body"
              }
            },
            {
              semantic_key: "body",
              placement_rules: {
                after_semantic: "title"
              }
            }
          ]
        },
        validation_policy: {
          ...baseTemplate.validation_policy,
          reject_unmatched_when_required: false,
          reject_style_violations: false
        }
      } as any,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          { semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.99, reason: "标题" },
          { semantic_key: "body", paragraph_ids: ["p3"], confidence: 0.92, reason: "正文" }
        ],
        unmatched_paragraph_ids: ["p2"],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(validation.passed).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ error_code: "numbering_pattern_not_allowed", semantic_key: "title" }),
        expect.objectContaining({ error_code: "placement_rule_violation", semantic_key: "title" })
      ])
    );
  });

  it("treats numbering patterns as prefix regex rules instead of literal examples", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/numbering-prefixes.docx",
      observation: {
        ...baseObservation,
        paragraphs: [
          { ...baseObservation.paragraphs[0], id: "p1", text: "二、工作目标", run_ids: ["p1_r1"] },
          { ...baseObservation.paragraphs[1], id: "p2", text: "（二）具体安排", run_ids: ["p2_r1"] },
          { ...baseObservation.paragraphs[2], id: "p3", text: "十、补充说明", run_ids: ["p3_r1"] }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "二、工作目标", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "（二）具体安排", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "十、补充说明", style: {} }] }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        layout_rules: {
          ...baseTemplate.layout_rules,
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            numbering_patterns: ["^[一二三四五六七八九十]+、$", "^（[一二三四五六七八九十]+）$"]
          },
          semantic_rules: [
            {
              semantic_key: "title",
              numbering_patterns: ["^[一二三四五六七八九十]+、$"]
            },
            {
              semantic_key: "body",
              numbering_patterns: ["^（[一二三四五六七八九十]+）$"]
            }
          ]
        },
        validation_policy: {
          ...baseTemplate.validation_policy,
          require_all_required_semantics: false,
          reject_unmatched_when_required: false,
          reject_style_violations: false
        }
      } as any,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          { semantic_key: "title", paragraph_ids: ["p1", "p3"], confidence: 0.99, reason: "章节标题" },
          { semantic_key: "body", paragraph_ids: ["p2"], confidence: 0.92, reason: "括号编号段" }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(validation.issues.filter((issue) => issue.error_code === "numbering_pattern_not_allowed")).toEqual([]);
  });

  it("keeps literal numbering strings as literal compatibility behavior", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/numbering-literal.docx",
      observation: {
        ...baseObservation,
        paragraphs: [
          { ...baseObservation.paragraphs[0], id: "p1", text: "一、工作目标", run_ids: ["p1_r1"] },
          { ...baseObservation.paragraphs[1], id: "p2", text: "二、工作要求", run_ids: ["p2_r1"] },
          { ...baseObservation.paragraphs[2], id: "p3", text: "普通正文", run_ids: ["p3_r1"] }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "一、工作目标", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "二、工作要求", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "普通正文", style: {} }] }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        layout_rules: {
          ...baseTemplate.layout_rules,
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            numbering_patterns: ["一、"]
          },
          semantic_rules: [
            {
              semantic_key: "title",
              numbering_patterns: ["一、"]
            },
            {
              semantic_key: "body"
            }
          ]
        },
        validation_policy: {
          ...baseTemplate.validation_policy,
          require_all_required_semantics: false,
          reject_unmatched_when_required: false,
          reject_style_violations: false
        }
      } as any,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          { semantic_key: "title", paragraph_ids: ["p1", "p2"], confidence: 0.99, reason: "章节标题" }
        ],
        unmatched_paragraph_ids: ["p3"],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "numbering_pattern_not_allowed",
          semantic_key: "title",
          paragraph_ids: ["p2"]
        })
      ])
    );
  });

  it("prefers semantic-level numbering rules and does not apply heading rules to body paragraphs", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/semantic-numbering.docx",
      observation: {
        ...baseObservation,
        paragraphs: [
          { ...baseObservation.paragraphs[0], id: "p1", text: "一、工作目标", run_ids: ["p1_r1"] },
          { ...baseObservation.paragraphs[1], id: "p2", text: "（一）实施范围", run_ids: ["p2_r1"] },
          { ...baseObservation.paragraphs[2], id: "p3", text: "一、这是正文，不是标题", run_ids: ["p3_r1"] }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "一、工作目标", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "（一）实施范围", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "一、这是正文，不是标题", style: {} }] }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        semantic_blocks: [
          ...baseTemplate.semantic_blocks,
          {
            key: "heading_level_2",
            label: "二级标题",
            description: "括号编号标题",
            examples: ["（一）实施范围"],
            required: false,
            multiple: true
          }
        ],
        layout_rules: {
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            ordering: ["title", "heading_level_2", "body"],
            numbering_patterns: ["^一、$"]
          },
          semantic_rules: [
            {
              semantic_key: "title",
              numbering_patterns: ["^[一二三四五六七八九十]+、$"]
            },
            {
              semantic_key: "heading_level_2",
              numbering_patterns: ["^（[一二三四五六七八九十]+）$"]
            },
            {
              semantic_key: "body"
            }
          ]
        },
        operation_blocks: [
          ...baseTemplate.operation_blocks,
          {
            semantic_key: "heading_level_2",
            text_style: {},
            paragraph_style: {}
          }
        ],
        validation_policy: {
          ...baseTemplate.validation_policy,
          require_all_required_semantics: false,
          reject_unmatched_when_required: false,
          reject_style_violations: false
        }
      } as any,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          { semantic_key: "title", paragraph_ids: ["p1"], confidence: 0.99, reason: "一级标题" },
          { semantic_key: "heading_level_2", paragraph_ids: ["p2"], confidence: 0.98, reason: "二级标题" },
          { semantic_key: "body", paragraph_ids: ["p3"], confidence: 0.92, reason: "正文" }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(validation.issues.filter((issue) => issue.error_code === "numbering_pattern_not_allowed")).toEqual([]);
  });

  it("falls back to global numbering rules when semantic-level rules are absent", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/global-numbering-fallback.docx",
      observation: {
        ...baseObservation,
        paragraphs: [
          { ...baseObservation.paragraphs[0], id: "p1", text: "一、工作目标", run_ids: ["p1_r1"] },
          { ...baseObservation.paragraphs[1], id: "p2", text: "1. Implementation", run_ids: ["p2_r1"] },
          { ...baseObservation.paragraphs[2], id: "p3", text: "普通正文", run_ids: ["p3_r1"] }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "一、工作目标", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "1. Implementation", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "普通正文", style: {} }] }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        layout_rules: {
          ...baseTemplate.layout_rules,
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            numbering_patterns: ["^[一二三四五六七八九十]+、$"]
          },
          semantic_rules: [
            {
              semantic_key: "title"
            },
            {
              semantic_key: "body"
            }
          ]
        },
        validation_policy: {
          ...baseTemplate.validation_policy,
          require_all_required_semantics: false,
          reject_unmatched_when_required: false,
          reject_style_violations: false
        }
      } as any,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          { semantic_key: "title", paragraph_ids: ["p1", "p2"], confidence: 0.99, reason: "标题" }
        ],
        unmatched_paragraph_ids: ["p3"],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "numbering_pattern_not_allowed",
          semantic_key: "title",
          paragraph_ids: ["p2"]
        })
      ])
    );
  });

  it("does not reject heading level 2 semantics when a DOCX heading uses a hierarchical numeric prefix", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/heading-level-2-hierarchical-numbering.docx",
      observation: {
        ...baseObservation,
        paragraphs: [
          { ...baseObservation.paragraphs[0], id: "p1", text: "3.1 实验数据集", role: "heading", heading_level: 2, run_ids: ["p1_r1"] },
          { ...baseObservation.paragraphs[1], id: "p2", text: "普通正文", role: "body", heading_level: undefined, run_ids: ["p2_r1"] }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "3.1 实验数据集", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "普通正文", style: {} }] }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        semantic_blocks: [
          ...baseTemplate.semantic_blocks,
          {
            key: "heading_level_2",
            label: "二级标题",
            description: "DOCX 二级标题。",
            examples: ["3.1 实验数据集"],
            required: false,
            multiple: true
          }
        ],
        layout_rules: {
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            ordering: ["title", "heading_level_2", "body"],
            numbering_patterns: ["^[一二三四五六七八九十]+、$"]
          },
          semantic_rules: [
            {
              semantic_key: "title"
            },
            {
              semantic_key: "heading_level_2",
              numbering_patterns: ["^（[一二三四五六七八九十]+）$"],
              style_hints: {
                role: "heading",
                heading_level: 2
              }
            },
            {
              semantic_key: "body"
            }
          ]
        },
        operation_blocks: [
          ...baseTemplate.operation_blocks,
          {
            semantic_key: "heading_level_2",
            text_style: {},
            paragraph_style: {}
          }
        ],
        validation_policy: {
          ...baseTemplate.validation_policy,
          require_all_required_semantics: false,
          reject_unmatched_when_required: false,
          reject_style_violations: false
        }
      } as any,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          { semantic_key: "heading_level_2", paragraph_ids: ["p1"], confidence: 0.98, reason: "DOCX 二级标题" },
          { semantic_key: "body", paragraph_ids: ["p2"], confidence: 0.92, reason: "正文" }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(validation.issues.filter((issue) => issue.error_code === "numbering_pattern_not_allowed")).toEqual([]);
  });

  it("does not reject heading level 3 semantics when a DOCX heading uses a hierarchical numeric prefix", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/heading-level-3-hierarchical-numbering.docx",
      observation: {
        ...baseObservation,
        paragraphs: [
          { ...baseObservation.paragraphs[0], id: "p1", text: "3.1.1 数据来源", role: "heading", heading_level: 3, run_ids: ["p1_r1"] },
          { ...baseObservation.paragraphs[1], id: "p2", text: "普通正文", role: "body", heading_level: undefined, run_ids: ["p2_r1"] }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "3.1.1 数据来源", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "普通正文", style: {} }] }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        semantic_blocks: [
          ...baseTemplate.semantic_blocks,
          {
            key: "heading_level_3",
            label: "三级标题",
            description: "DOCX 三级标题。",
            examples: ["3.1.1 数据来源"],
            required: false,
            multiple: true
          }
        ],
        layout_rules: {
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            ordering: ["title", "heading_level_3", "body"],
            numbering_patterns: ["^[一二三四五六七八九十]+、$"]
          },
          semantic_rules: [
            {
              semantic_key: "title"
            },
            {
              semantic_key: "heading_level_3",
              numbering_patterns: ["^\\d+[.)．、]$"],
              style_hints: {
                role: "heading",
                heading_level: 3
              }
            },
            {
              semantic_key: "body"
            }
          ]
        },
        operation_blocks: [
          ...baseTemplate.operation_blocks,
          {
            semantic_key: "heading_level_3",
            text_style: {},
            paragraph_style: {}
          }
        ],
        validation_policy: {
          ...baseTemplate.validation_policy,
          require_all_required_semantics: false,
          reject_unmatched_when_required: false,
          reject_style_violations: false
        }
      } as any,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          { semantic_key: "heading_level_3", paragraph_ids: ["p1"], confidence: 0.98, reason: "DOCX 三级标题" },
          { semantic_key: "body", paragraph_ids: ["p2"], confidence: 0.92, reason: "正文" }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(validation.issues.filter((issue) => issue.error_code === "numbering_pattern_not_allowed")).toEqual([]);
  });

  it("allows hierarchical numeric prefixes for body paragraphs without broadening heading level 3", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/body-hierarchical-numbering.docx",
      observation: {
        ...baseObservation,
        paragraphs: [
          { ...baseObservation.paragraphs[0], id: "p1", text: "3. 实验设置", role: "heading", heading_level: 3, run_ids: ["p1_r1"] },
          { ...baseObservation.paragraphs[1], id: "p2", text: "3.1 实验数据集", role: "body", heading_level: undefined, run_ids: ["p2_r1"] },
          { ...baseObservation.paragraphs[2], id: "p3", text: "3.1.1 数据来源", role: "body", heading_level: undefined, run_ids: ["p3_r1"] }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "3. 实验设置", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "3.1 实验数据集", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "3.1.1 数据来源", style: {} }] }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        semantic_blocks: [
          ...baseTemplate.semantic_blocks,
          {
            key: "heading_level_3",
            label: "三级标题",
            description: "一级数字编号标题",
            examples: ["3. 实验设置"],
            required: false,
            multiple: true
          }
        ],
        layout_rules: {
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            ordering: ["title", "heading_level_3", "body"],
            numbering_patterns: ["^[一二三四五六七八九十]+、$"]
          },
          semantic_rules: [
            {
              semantic_key: "title"
            },
            {
              semantic_key: "heading_level_3",
              numbering_patterns: ["^\\d+[.)．、]$"]
            },
            {
              semantic_key: "body",
              numbering_patterns: ["^\\d+\\.\\d+(?:\\.\\d+)*[)）、．。、]?$"]
            }
          ]
        },
        operation_blocks: [
          ...baseTemplate.operation_blocks,
          {
            semantic_key: "heading_level_3",
            text_style: {},
            paragraph_style: {}
          }
        ],
        validation_policy: {
          ...baseTemplate.validation_policy,
          require_all_required_semantics: false,
          reject_unmatched_when_required: false,
          reject_style_violations: false
        }
      } as any,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          { semantic_key: "heading_level_3", paragraph_ids: ["p1"], confidence: 0.99, reason: "三级标题" },
          { semantic_key: "body", paragraph_ids: ["p2", "p3"], confidence: 0.96, reason: "正文" }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.97
      }
    });

    expect(validation.issues.filter((issue) => issue.error_code === "numbering_pattern_not_allowed")).toEqual([]);
  });

  it("keeps hierarchical numeric prefixes invalid for semantics without explicit allowance and reports diagnostics", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/hierarchical-numbering-diagnostics.docx",
      observation: {
        ...baseObservation,
        paragraphs: [
          { ...baseObservation.paragraphs[0], id: "p1", text: "3.1.1 数据来源", role: "body", run_ids: ["p1_r1"] },
          { ...baseObservation.paragraphs[1], id: "p2", text: "普通正文", run_ids: ["p2_r1"] },
          { ...baseObservation.paragraphs[2], id: "p3", text: "附注", run_ids: ["p3_r1"] }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "3.1.1 数据来源", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "普通正文", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "附注", style: {} }] }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        semantic_blocks: [
          ...baseTemplate.semantic_blocks,
          {
            key: "caption",
            label: "图注",
            description: "不允许正文编号的说明文字。",
            examples: ["图 1 说明"],
            required: false,
            multiple: true
          }
        ],
        layout_rules: {
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            ordering: ["title", "body", "caption"],
            numbering_patterns: ["^[一二三四五六七八九十]+、$"]
          },
          semantic_rules: [
            {
              semantic_key: "title"
            },
            {
              semantic_key: "body"
            },
            {
              semantic_key: "caption",
              numbering_patterns: ["^图\\s*\\d+$"]
            }
          ]
        },
        operation_blocks: [
          ...baseTemplate.operation_blocks,
          {
            semantic_key: "caption",
            text_style: {},
            paragraph_style: {}
          }
        ],
        validation_policy: {
          ...baseTemplate.validation_policy,
          require_all_required_semantics: false,
          reject_unmatched_when_required: false,
          reject_style_violations: false
        }
      } as any,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          { semantic_key: "caption", paragraph_ids: ["p1"], confidence: 0.94, reason: "说明段" },
          { semantic_key: "body", paragraph_ids: ["p2", "p3"], confidence: 0.9, reason: "正文" }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "numbering_pattern_not_allowed",
          semantic_key: "caption",
          paragraph_ids: ["p1"],
          diagnostics: {
            semantic_key: "caption",
            numbering_prefix: "3.1.1",
            rule_source: "semantic_rule",
            allowed_patterns: ["^图\\s*\\d+$"]
          }
        })
      ])
    );
  });

  it("does not treat standalone decimal values as hierarchical numbering prefixes", async () => {
    const { detectTemplateNumberingPrefix } = await import("../src/templates/template-numbering.js");

    expect(detectTemplateNumberingPrefix("0.7003")).toBeUndefined();
    expect(detectTemplateNumberingPrefix("  0.7003")).toBeUndefined();
    expect(detectTemplateNumberingPrefix("2.1 数据来源")).toBe("2.1");
    expect(detectTemplateNumberingPrefix("3.1.1数据来源")).toBe("3.1.1");
  });

  it("does not block table_text when a table cell starts with a standalone decimal value", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/table-decimal.docx",
      observation: {
        ...baseObservation,
        document_meta: {
          total_paragraphs: 1,
          total_tables: 1
        },
        paragraphs: [
          {
            id: "p1",
            text: "0.7003",
            role: "body",
            style_name: "Table Text",
            run_ids: ["p1_r1"],
            in_table: true
          }
        ],
        nodes: [
          {
            id: "p1",
            node_type: "paragraph",
            children: [{ id: "p1_r1", node_type: "text_run", content: "0.7003", style: {} }]
          }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        semantic_blocks: [
          {
            key: "table_text",
            label: "表格文本",
            description: "表格中的普通数值和文本。",
            examples: ["0.7003"],
            required: false,
            multiple: true
          }
        ],
        layout_rules: {
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            ordering: ["table_text"],
            numbering_patterns: [
              "^[一二三四五六七八九十]+、$",
              "^（[一二三四五六七八九十]+）$",
              "^\\d+[.)．、]$",
              "^[(（]\\d+[)）]$"
            ]
          },
          semantic_rules: [
            {
              semantic_key: "table_text",
              style_hints: {
                preferred_role: ["table_text", "body"],
                preferred_bucket_type: ["table_text"],
                in_table: true
              }
            }
          ]
        },
        operation_blocks: [
          {
            semantic_key: "table_text",
            text_style: {},
            paragraph_style: {}
          }
        ],
        validation_policy: {
          ...baseTemplate.validation_policy,
          require_all_required_semantics: false,
          reject_unmatched_when_required: false,
          reject_style_violations: false
        }
      } as any,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [{ semantic_key: "table_text", paragraph_ids: ["p1"], confidence: 0.98, reason: "表格数值" }],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.98
      }
    });

    expect(validation.issues.filter((issue) => issue.error_code === "numbering_pattern_not_allowed")).toEqual([]);
  });
});

describe("template runner", () => {
  it("builds ordered write operations for supported template styles", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { buildTemplateWritePlan } = await import("../src/templates/template-write-planner.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const result = buildTemplateWritePlan({
      executionPlan: [
        {
          semantic_key: "body",
          paragraph_ids: ["p2", "p3"],
          text_style: {
            font_name: "FangSong_GB2312",
            font_size_pt: 16,
            font_color: "#112233",
            is_bold: true,
            is_italic: false
          },
          paragraph_style: {
            line_spacing: 1.5,
            paragraph_alignment: "justify"
          }
        }
      ],
      document: context.document,
      structureIndex: context.structureIndex
    });

    expect(result.issues).toEqual([]);
    expect(result.writePlan.map((item) => item.type)).toEqual([
      "set_font",
      "set_size",
      "set_line_spacing",
      "set_alignment",
      "set_font_color",
      "set_bold",
      "set_italic"
    ]);
    expect(result.writePlan.every((item) => item.targetSelector?.scope === "paragraph_ids")).toBe(true);
    expect(result.writePlan.every((item) => item.targetNodeId === undefined)).toBe(true);
    expect(result.writePlan.every((item) => item.targetNodeIds === undefined)).toBe(true);
    expect(result.writePlan[0]).toMatchObject({
      id: "body:set_font",
      payload: {
        font_name: "FangSong_GB2312"
      },
      targetSelector: {
        scope: "paragraph_ids",
        paragraphIds: ["p2", "p3"]
      }
    });
  });

  it("generates page, spacing, and first-line indent operations for supported template styles", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { buildTemplateWritePlan } = await import("../src/templates/template-write-planner.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const result = buildTemplateWritePlan({
      template: {
        ...baseTemplate,
        layout_rules: {
          ...baseTemplate.layout_rules,
          global_rules: {
            ...baseTemplate.layout_rules.global_rules,
            page_layout_reference: {
              paper_size: "Letter",
              margin_top_cm: 3
            }
          }
        },
        style_reference: {
          page: {
            paper_size: "A4",
            margin_top_cm: 3.7,
            margin_bottom_cm: 3.5,
            margin_left_cm: 2.8,
            margin_right_cm: 2.6
          }
        }
      } as any,
      executionPlan: [
        {
          semantic_key: "body",
          paragraph_ids: ["p2"],
          text_style: {
            font_size_pt: 15
          },
          paragraph_style: {
            first_line_indent_chars: 2
          },
          relative_spacing: {
            before_pt: 6,
            after_pt: 3
          }
        }
      ],
      document: context.document,
      structureIndex: context.structureIndex
    });

    expect(result.issues).toEqual([]);
    expect(result.writePlan.map((item) => item.type)).toEqual([
      "set_page_layout",
      "set_size",
      "set_paragraph_spacing",
      "set_paragraph_indent"
    ]);
    expect(result.writePlan[0]).toMatchObject({
      id: "template:set_page_layout",
      payload: {
        paper_size: "A4",
        margin_top_cm: 3.7,
        margin_bottom_cm: 3.5,
        margin_left_cm: 2.8,
        margin_right_cm: 2.6
      }
    });
    expect(result.writePlan[0]?.targetSelector).toBeUndefined();
    expect(result.writePlan[2]).toMatchObject({
      id: "body:set_paragraph_spacing",
      payload: {
        space_before_pt: 6,
        space_after_pt: 3
      }
    });
    expect(result.writePlan[3]).toMatchObject({
      id: "body:set_paragraph_indent",
      payload: {
        first_line_indent_pt: 30
      }
    });
  });

  it("fails write plan generation when unsupported template fields are declared", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { buildTemplateWritePlan } = await import("../src/templates/template-write-planner.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });

    const result = buildTemplateWritePlan({
      executionPlan: [
        {
          semantic_key: "body",
          paragraph_ids: ["p2"],
          text_style: {
            font_name: "FangSong_GB2312"
          },
          paragraph_style: {
            paragraph_alignment: "justify"
          },
          relative_spacing: {
            before_pt: 3,
            around_pt: 2
          },
          placement_rules: {
            before_semantic: "title"
          }
        }
      ],
      document: context.document,
      structureIndex: context.structureIndex
    });

    expect(result.writePlan).toEqual([]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "unsupported_style_field",
          semantic_key: "body"
        })
      ])
    );
    expect(result.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("relative_spacing.around_pt")])
    );
  });

  it("splits mixed-language runs and appends run-level font overrides after paragraph planning", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { buildTemplateWritePlan } = await import("../src/templates/template-write-planner.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/mixed.docx",
      observation: mixedLanguageObservation
    });

    const result = buildTemplateWritePlan({
      executionPlan: [
        {
          semantic_key: "body",
          paragraph_ids: ["p2"],
          text_style: {
            font_name: "FangSong_GB2312",
            font_size_pt: 16
          },
          paragraph_style: {
            paragraph_alignment: "justify"
          },
          language_font_overrides: {
            zh: {
              font_name: "FangSong_GB2312"
            },
            en: {
              font_name: "Times New Roman"
            }
          }
        }
      ],
      document: context.document,
      structureIndex: context.structureIndex
    });

    expect(result.issues).toEqual([]);
    expect((result as any).document.nodes.map((node: any) => ({
      id: node.id,
      text: node.text,
      sourceRunId: node.sourceRunId
    }))).toEqual([
      {
        id: "p1_r1",
        text: "关于年度检查工作的通知",
        sourceRunId: undefined
      },
      {
        id: "p2_r1__seg_0",
        text: "这是",
        sourceRunId: "p2_r1"
      },
      {
        id: "p2_r1__seg_1",
        text: "NLP",
        sourceRunId: "p2_r1"
      },
      {
        id: "p2_r1__seg_2",
        text: ",模型",
        sourceRunId: "p2_r1"
      },
      {
        id: "p2_r1__seg_3",
        text: "2025",
        sourceRunId: "p2_r1"
      },
      {
        id: "p2_r1__seg_4",
        text: "报告",
        sourceRunId: "p2_r1"
      }
    ]);
    expect((result as any).structureIndex.paragraphMap["p2"].runNodeIds).toEqual([
      "p2_r1__seg_0",
      "p2_r1__seg_1",
      "p2_r1__seg_2",
      "p2_r1__seg_3",
      "p2_r1__seg_4"
    ]);
    expect(result.writePlan.map((item) => ({
      id: item.id,
      type: item.type,
      targetSelector: item.targetSelector,
      targetNodeIds: item.targetNodeIds,
      payload: item.payload
    }))).toEqual([
      {
        id: "body:set_font",
        type: "set_font",
        targetSelector: {
          scope: "paragraph_ids",
          paragraphIds: ["p2"]
        },
        targetNodeIds: undefined,
        payload: {
          font_name: "FangSong_GB2312"
        }
      },
      {
        id: "body:set_size",
        type: "set_size",
        targetSelector: {
          scope: "paragraph_ids",
          paragraphIds: ["p2"]
        },
        targetNodeIds: undefined,
        payload: {
          font_size_pt: 16
        }
      },
      {
        id: "body:set_alignment",
        type: "set_alignment",
        targetSelector: {
          scope: "paragraph_ids",
          paragraphIds: ["p2"]
        },
        targetNodeIds: undefined,
        payload: {
          paragraph_alignment: "justify"
        }
      },
      {
        id: "body:language_font:zh",
        type: "set_font",
        targetSelector: undefined,
        targetNodeIds: ["p2_r1__seg_0", "p2_r1__seg_2", "p2_r1__seg_4"],
        payload: {
          font_name: "FangSong_GB2312"
        }
      },
      {
        id: "body:language_font:en",
        type: "set_font",
        targetSelector: undefined,
        targetNodeIds: ["p2_r1__seg_1", "p2_r1__seg_3"],
        payload: {
          font_name: "Times New Roman"
        }
      }
    ]);
  });

  it("returns an executed report when write planning and execution succeed", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    const executableTemplate = {
      ...baseTemplate,
      operation_blocks: [
        {
          semantic_key: "title",
          text_style: {
            font_name: "FZXiaoBiaoSong-B05S",
            font_size_pt: 22,
            is_bold: true
          },
          paragraph_style: {
            paragraph_alignment: "center"
          }
        },
        {
          semantic_key: "body",
          text_style: {
            font_name: "FangSong_GB2312",
            font_size_pt: 16,
            font_color: "#112233"
          },
          paragraph_style: {
            paragraph_alignment: "justify",
            line_spacing: 1.5
          }
        }
      ]
    };
    await writeFile(templatePath, JSON.stringify(executableTemplate, null, 2), "utf8");

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath,
        debug: true
      },
      {
        observeDocx: async () => baseObservation,
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "title",
              paragraph_ids: ["p1"],
              confidence: 0.99,
              reason: "标题"
            },
            {
              semantic_key: "body",
              paragraph_ids: ["p2", "p3"],
              confidence: 0.92,
              reason: "正文"
            }
          ],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 0.95
        }),
        executeWritePlan: async ({ writePlan, outputDocxPath }) => ({
          applied: true,
          finalDoc: {
            id: "template:D:/docs/sample.docx",
            version: "v1",
            nodes: [],
            metadata: {
              inputDocxPath: "D:/docs/sample.docx",
              outputDocxPath
            }
          },
          changeSummary: `${writePlan.length} change(s) applied`,
          artifacts: {
            executed_step_count: writePlan.length,
            step_summaries: writePlan.map((item) => `Applied ${item.type}`),
            change_set_summary: {
              change_count: writePlan.length,
              rolled_back: false
            }
          }
        }),
        materializeDoc: async (doc) => ({
          doc,
          summary: `Materialized document to ${String(doc.metadata?.outputDocxPath)}.`,
          artifacts: {
            outputDocxPath: doc.metadata?.outputDocxPath
          }
        })
      }
    );

    expect(report.status).toBe("executed");
    expect(report.stage_timings_ms).toEqual(
      expect.objectContaining({
        observation_ms: expect.any(Number),
        classification_request_ms: expect.any(Number),
        validation_ms: expect.any(Number),
        execution_ms: expect.any(Number)
      })
    );
    expect(report.validation_result.passed).toBe(true);
    expect(report.execution_plan).toHaveLength(2);
    expect(report.write_plan.map((item) => item.type)).toEqual([
      "set_font",
      "set_size",
      "set_alignment",
      "set_bold",
      "set_font",
      "set_size",
      "set_line_spacing",
      "set_alignment",
      "set_font_color"
    ]);
    expect(report.execution_result.applied).toBe(true);
    expect(path.normalize(report.execution_result.output_docx_path ?? "")).toBe(
      path.normalize("D:/docs/sample.template-output.docx")
    );
    expect(report.execution_result.change_summary).toBe(
      `9 change(s) applied\nMaterialized document to ${path.normalize("D:/docs/sample.template-output.docx")}.`
    );
    expect(report.execution_result.artifacts).toEqual(
      expect.objectContaining({
        write_operation_count: 9,
        executed_step_count: 9,
        materialized: true,
        output_docx_path: path.normalize("D:/docs/sample.template-output.docx"),
        step_summaries: expect.any(Array),
        change_set_summary: expect.objectContaining({
          change_count: 9,
          rolled_back: false
        }),
        materialize_artifacts_summary: expect.objectContaining({
          outputDocxPath: path.normalize("D:/docs/sample.template-output.docx")
        })
      })
    );
  });

  it("propagates refinement diagnostics and stage timings through the runner report", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    await writeFile(templatePath, JSON.stringify(baseTemplate, null, 2), "utf8");

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath
      },
      {
        observeDocx: async () => baseObservation,
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "title",
              paragraph_ids: ["p1"],
              confidence: 0.99,
              reason: "标题"
            },
            {
              semantic_key: "body",
              paragraph_ids: ["p2", "p3"],
              confidence: 0.92,
              reason: "正文"
            }
          ],
          unmatched_paragraph_ids: [],
          conflicts: [],
          diagnostics: {
            refined_paragraphs: [
              {
                paragraph_id: "p2",
                first_pass: {
                  semantic_keys: ["body"],
                  confidence: 0.42,
                  reason: "正文候选",
                  source: "low_confidence"
                },
                second_pass: {
                  semantic_key: "body",
                  confidence: 0.92,
                  reason: "二次判定修复"
                },
                outcome: "accepted"
              }
            ],
            refinement_elapsed_ms: 17
          },
          overall_confidence: 0.95
        }),
        executeWritePlan: async ({ outputDocxPath }) => ({
          applied: true,
          finalDoc: {
            id: "template:D:/docs/sample.docx",
            version: "v1",
            nodes: [],
            metadata: {
              inputDocxPath: "D:/docs/sample.docx",
              outputDocxPath
            }
          },
          changeSummary: "applied",
          artifacts: {
            executed_step_count: 0
          }
        }),
        materializeDoc: async (doc) => ({
          doc,
          summary: "materialized"
        })
      }
    );

    expect(report.status).toBe("executed");
    expect(report.stage_timings_ms?.refinement_ms).toBe(17);
    expect(report.classification_result.diagnostics?.refined_paragraphs).toEqual([
      {
        paragraph_id: "p2",
        first_pass: {
          semantic_keys: ["body"],
          confidence: 0.42,
          reason: "正文候选",
          source: "low_confidence"
        },
        second_pass: {
          semantic_key: "body",
          confidence: 0.92,
          reason: "二次判定修复"
        },
        outcome: "accepted"
      }
    ]);
  });

  it("executes while summarizing ignored unknown semantic tags", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    const executableTemplate = {
      ...baseTemplate,
      operation_blocks: [
        {
          semantic_key: "title",
          text_style: {
            font_name: "FZXiaoBiaoSong-B05S",
            font_size_pt: 22
          },
          paragraph_style: {
            paragraph_alignment: "center"
          }
        },
        {
          semantic_key: "body",
          text_style: {
            font_name: "FangSong_GB2312",
            font_size_pt: 16
          },
          paragraph_style: {
            paragraph_alignment: "justify"
          }
        }
      ]
    };
    await writeFile(templatePath, JSON.stringify(executableTemplate, null, 2), "utf8");

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath
      },
      {
        observeDocx: async () => baseObservation,
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "title",
              paragraph_ids: ["p1"],
              confidence: 0.99,
              reason: "标题"
            },
            {
              semantic_key: "body",
              paragraph_ids: ["p2"],
              confidence: 0.92,
              reason: "正文"
            },
            {
              semantic_key: "appendix",
              paragraph_ids: ["p3"],
              confidence: 0.9,
              reason: "附件"
            },
            {
              semantic_key: "metadata",
              paragraph_ids: ["p3"],
              confidence: 0.85,
              reason: "元数据"
            }
          ],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 0.95
        }),
        executeWritePlan: async ({ writePlan, outputDocxPath }) => ({
          applied: true,
          finalDoc: {
            id: "template:D:/docs/sample.docx",
            version: "v1",
            nodes: [],
            metadata: {
              inputDocxPath: "D:/docs/sample.docx",
              outputDocxPath
            }
          },
          changeSummary: `${writePlan.length} change(s) applied`,
          artifacts: {
            executed_step_count: writePlan.length
          }
        }),
        materializeDoc: async (doc) => ({
          doc,
          summary: `Materialized document to ${String(doc.metadata?.outputDocxPath)}.`
        })
      }
    );

    expect(report.status).toBe("failed");
    expect(report.classification_result.matches.map((match) => match.semantic_key)).toEqual(["title", "body"]);
    expect(report.classification_result.unmatched_paragraph_ids).toEqual(["p3"]);
    expect(report.classification_result.diagnostics?.ignored_unknown_semantic_matches).toEqual([
      {
        semantic_key: "appendix",
        paragraph_ids: ["p3"],
        confidence: 0.9,
        reason: "附件"
      },
      {
        semantic_key: "metadata",
        paragraph_ids: ["p3"],
        confidence: 0.85,
        reason: "元数据"
      }
    ]);
    expect(report.write_plan).toEqual([]);
    expect(report.execution_result.applied).toBe(false);
    expect(report.validation_result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "unclassified_paragraphs_present",
          paragraph_ids: ["p3"]
        })
      ])
    );
  });

  it("returns only stable execution artifacts when debug is disabled", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    const executableTemplate = {
      ...baseTemplate,
      layout_rules: {
        ...baseTemplate.layout_rules,
        semantic_rules: [
          {
            semantic_key: "title",
            position_hints: ["near_top"]
          },
          {
            semantic_key: "body",
            text_hints: ["现将", "贯彻执行"]
          }
        ]
      },
      operation_blocks: [
        {
          semantic_key: "title",
          text_style: {
            font_name: "FZXiaoBiaoSong-B05S",
            font_size_pt: 22
          },
          paragraph_style: {
            paragraph_alignment: "center"
          }
        },
        {
          semantic_key: "body",
          text_style: {
            font_name: "FangSong_GB2312",
            font_size_pt: 16
          },
          paragraph_style: {
            paragraph_alignment: "justify"
          }
        }
      ]
    };
    await writeFile(templatePath, JSON.stringify(executableTemplate, null, 2), "utf8");

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath
      },
      {
        observeDocx: async () => baseObservation,
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "title",
              paragraph_ids: ["p1"],
              confidence: 0.99,
              reason: "标题"
            },
            {
              semantic_key: "body",
              paragraph_ids: ["p2", "p3"],
              confidence: 0.92,
              reason: "正文"
            }
          ],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 0.95
        }),
        executeWritePlan: async ({ writePlan, outputDocxPath }) => ({
          applied: true,
          finalDoc: {
            id: "template:D:/docs/sample.docx",
            version: "v1",
            nodes: [],
            metadata: {
              inputDocxPath: "D:/docs/sample.docx",
              outputDocxPath
            }
          },
          changeSummary: `${writePlan.length} change(s) applied`,
          artifacts: {
            executed_step_count: writePlan.length,
            step_summaries: writePlan.map((item) => `Applied ${item.type}`),
            change_set_summary: {
              change_count: writePlan.length,
              rolled_back: false
            }
          }
        }),
        materializeDoc: async (doc) => ({
          doc,
          summary: `Materialized document to ${String(doc.metadata?.outputDocxPath)}.`,
          artifacts: {
            outputDocxPath: doc.metadata?.outputDocxPath,
            tempDir: "hidden"
          }
        })
      }
    );

    expect(report.execution_result.artifacts).toEqual({
      write_operation_count: 6,
      executed_step_count: 6,
      materialized: true,
      output_docx_path: path.normalize("D:/docs/sample.template-output.docx")
    });
  });

  it("fails validation before write execution when a single-instance semantic matches multiple paragraphs", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    const executableTemplate = {
      ...baseTemplate,
      operation_blocks: [
        {
          semantic_key: "title",
          text_style: {
            font_name: "FZXiaoBiaoSong-B05S",
            font_size_pt: 22
          },
          paragraph_style: {
            paragraph_alignment: "center"
          }
        },
        {
          semantic_key: "body",
          text_style: {
            font_name: "FangSong_GB2312",
            font_size_pt: 16
          },
          paragraph_style: {
            paragraph_alignment: "justify"
          }
        }
      ]
    };
    await writeFile(templatePath, JSON.stringify(executableTemplate, null, 2), "utf8");
    let writeExecuted = false;

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath
      },
      {
        observeDocx: async () => baseObservation,
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "title",
              paragraph_ids: ["p1", "p2"],
              confidence: 0.99,
              reason: "两个主标题"
            },
            {
              semantic_key: "body",
              paragraph_ids: ["p3"],
              confidence: 0.92,
              reason: "正文"
            }
          ],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 0.95
        }),
        executeWritePlan: async ({ context, outputDocxPath }) => {
          writeExecuted = true;
          return {
            applied: true,
            finalDoc: {
              ...context.document,
              metadata: {
                ...context.document.metadata,
                inputDocxPath: "D:/docs/sample.docx",
                outputDocxPath
              }
            }
          };
        }
      }
    );

    expect(report.status).toBe("failed");
    expect(writeExecuted).toBe(false);
    expect(report.write_plan).toEqual([]);
    expect(report.execution_plan).toEqual([]);
    expect(report.validation_result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "single_semantic_multiple_paragraphs",
          semantic_key: "title",
          paragraph_ids: ["p1", "p2"]
        })
      ])
    );
  });

  it("normalizes blank and unknown paragraphs into an allow-empty no-op semantic before strict validation", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    const fallbackTemplate = {
      ...baseTemplate,
      semantic_blocks: [
        ...baseTemplate.semantic_blocks,
        {
          key: "blank_or_unknown",
          label: "空白或未知段落",
          description: "承接空白或未知段落。",
          examples: ["（空白段）"],
          required: false,
          multiple: true
        }
      ],
      layout_rules: {
        ...baseTemplate.layout_rules,
        semantic_rules: [
          {
            semantic_key: "title",
            position_hints: ["near_top"],
            style_hints: {
              style_name: "Heading 1",
              paragraph_alignment: "center"
            }
          },
          {
            semantic_key: "body",
            text_hints: ["现将", "通知如下"],
            style_hints: {
              style_name: "BodyText",
              font_name: "FangSong_GB2312"
            }
          },
          {
            semantic_key: "blank_or_unknown",
            style_hints: {
              preferred_role: ["unknown"],
              allow_empty_text: true
            }
          }
        ]
      },
      operation_blocks: [
        {
          semantic_key: "title",
          text_style: {
            font_name: "FZXiaoBiaoSong-B05S",
            font_size_pt: 22
          },
          paragraph_style: {
            paragraph_alignment: "center"
          }
        },
        {
          semantic_key: "body",
          text_style: {
            font_name: "FangSong_GB2312",
            font_size_pt: 16
          },
          paragraph_style: {
            paragraph_alignment: "justify"
          }
        },
        {
          semantic_key: "blank_or_unknown",
          text_style: {},
          paragraph_style: {}
        }
      ]
    };
    await writeFile(templatePath, JSON.stringify(fallbackTemplate, null, 2), "utf8");
    const observationWithFallbackParagraphs: PythonDocxObservationState = {
      document_meta: {
        total_paragraphs: 4,
        total_tables: 0
      },
      paragraphs: [
        baseObservation.paragraphs[0]!,
        baseObservation.paragraphs[1]!,
        {
          id: "p3",
          text: "",
          role: "unknown",
          style_name: "Normal",
          run_ids: ["p3_r1"],
          in_table: false
        },
        {
          id: "p4",
          text: "——",
          role: "decorative",
          style_name: "Normal",
          run_ids: ["p4_r1"],
          in_table: false
        }
      ],
      nodes: [
        baseObservation.nodes[0]!,
        baseObservation.nodes[1]!,
        { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "", style: {} }] },
        { id: "p4", node_type: "paragraph", children: [{ id: "p4_r1", node_type: "text_run", content: "——", style: {} }] }
      ]
    };

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/fallback.docx",
        templatePath
      },
      {
        observeDocx: async () => observationWithFallbackParagraphs,
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "title",
              paragraph_ids: ["p1"],
              confidence: 0.99,
              reason: "标题"
            },
            {
              semantic_key: "body",
              paragraph_ids: ["p2"],
              confidence: 0.92,
              reason: "正文"
            }
          ],
          unmatched_paragraph_ids: ["p3", "p4"],
          conflicts: [],
          overall_confidence: 0.95
        }),
        executeWritePlan: async ({ writePlan, outputDocxPath }) => ({
          applied: true,
          finalDoc: {
            id: "template:D:/docs/fallback.docx",
            version: "v1",
            nodes: [],
            metadata: {
              inputDocxPath: "D:/docs/fallback.docx",
              outputDocxPath
            }
          },
          changeSummary: `${writePlan.length} change(s) applied`,
          artifacts: {
            executed_step_count: writePlan.length
          }
        }),
        materializeDoc: async (doc) => ({
          doc,
          summary: `Materialized document to ${String(doc.metadata?.outputDocxPath)}.`
        })
      }
    );

    expect(report.status).toBe("executed");
    expect(report.validation_result.passed).toBe(true);
    expect(report.classification_result.unmatched_paragraph_ids).toEqual([]);
    expect(report.classification_result.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          semantic_key: "blank_or_unknown",
          paragraph_ids: ["p3", "p4"]
        })
      ])
    );
    expect(report.write_plan.every((item) => !item.id.startsWith("blank_or_unknown:"))).toBe(true);
    expect(report.write_plan.map((item) => item.type)).toEqual([
      "set_font",
      "set_size",
      "set_alignment",
      "set_font",
      "set_size",
      "set_alignment"
    ]);
  });

  it("returns a failed report with write-plan issues and preserves the atomic execution plan", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    await writeFile(
      templatePath,
      JSON.stringify(
        {
          ...baseTemplate,
          operation_blocks: baseTemplate.operation_blocks.map((block) =>
            block.semantic_key === "body"
              ? {
                  ...block,
                  relative_spacing: {
                    ...block.relative_spacing,
                    around_pt: 2
                  }
                }
              : block
          )
        },
        null,
        2
      ),
      "utf8"
    );

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath
      },
      {
        observeDocx: async () => baseObservation,
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [],
          unmatched_paragraph_ids: ["p1", "p2", "p3"],
          conflicts: [],
          overall_confidence: 0.2
        })
      }
    );

    expect(report.status).toBe("failed");
    expect(report.validation_result.passed).toBe(false);
    expect(report.execution_plan).toEqual([]);
    expect(report.write_plan).toEqual([]);
    expect(report.execution_result.applied).toBe(false);
    expect(report.execution_result.change_summary).toBeUndefined();
    expect(report.execution_result.output_docx_path).toBeUndefined();
    expect(report.execution_result.artifacts).toBeUndefined();
    expect(report.classification_result.unmatched_paragraph_ids).toEqual(["p1", "p2", "p3"]);
    expect(report.validation_result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "unclassified_paragraphs_present",
          diagnostics: expect.objectContaining({
            unmatched_paragraphs: [
              expect.objectContaining({
                paragraph_id: "p1",
                role: "heading",
                bucket_type: "heading",
                paragraph_index: 0
              }),
              expect.objectContaining({
                paragraph_id: "p2",
                role: "body",
                bucket_type: "body",
                paragraph_index: 1
              }),
              expect.objectContaining({
                paragraph_id: "p3",
                role: "body",
                bucket_type: "body",
                paragraph_index: 2
              })
            ],
            policy: {
              allow_unclassified_paragraphs: false,
              reject_unmatched_when_required: true
            }
          })
        })
      ])
    );
  });

  it("returns a failed report when write plan generation finds unsupported fields", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    await writeFile(
      templatePath,
      JSON.stringify(
        {
          ...baseTemplate,
          operation_blocks: baseTemplate.operation_blocks.map((block) =>
            block.semantic_key === "body"
              ? {
                  ...block,
                  relative_spacing: {
                    ...block.relative_spacing,
                    around_pt: 2
                  }
                }
              : block
          )
        },
        null,
        2
      ),
      "utf8"
    );

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath
      },
      {
        observeDocx: async () => baseObservation,
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "title",
              paragraph_ids: ["p1"],
              confidence: 0.99,
              reason: "标题"
            },
            {
              semantic_key: "body",
              paragraph_ids: ["p2", "p3"],
              confidence: 0.92,
              reason: "正文"
            }
          ],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 0.95
        })
      }
    );

    expect(report.status).toBe("failed");
    expect(report.execution_plan).toHaveLength(2);
    expect(report.write_plan).toEqual([]);
    expect(report.execution_result.applied).toBe(false);
    expect(report.execution_result.change_summary).toBeUndefined();
    expect(report.execution_result.artifacts).toBeUndefined();
    expect(report.execution_result.output_docx_path).toBeUndefined();
    expect(report.execution_result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "unsupported_style_field",
          semantic_key: "body"
        })
      ])
    );
  });

  it("preserves execution_plan and write_plan when write execution fails", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    const executableTemplate = {
      ...baseTemplate,
      operation_blocks: [
        {
          semantic_key: "title",
          text_style: {
            font_name: "FZXiaoBiaoSong-B05S",
            font_size_pt: 22
          },
          paragraph_style: {
            paragraph_alignment: "center"
          }
        },
        {
          semantic_key: "body",
          text_style: {
            font_name: "FangSong_GB2312",
            font_size_pt: 16
          },
          paragraph_style: {
            paragraph_alignment: "justify"
          }
        }
      ]
    };
    await writeFile(templatePath, JSON.stringify(executableTemplate, null, 2), "utf8");

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath
      },
      {
        observeDocx: async () => baseObservation,
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "title",
              paragraph_ids: ["p1"],
              confidence: 0.99,
              reason: "标题"
            },
            {
              semantic_key: "body",
              paragraph_ids: ["p2", "p3"],
              confidence: 0.92,
              reason: "正文"
            }
          ],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 0.95
        }),
        executeWritePlan: async () => {
          throw new AgentError({
            code: "E_DOCX_WRITE_FAILED",
            message: "DOCX write failed: boom",
            retryable: false
          });
        }
      }
    );

    expect(report.status).toBe("failed");
    expect(report.execution_plan).toHaveLength(2);
    expect(report.write_plan.map((item) => item.type)).toEqual([
      "set_font",
      "set_size",
      "set_alignment",
      "set_font",
      "set_size",
      "set_alignment"
    ]);
    expect(report.execution_result.applied).toBe(false);
    expect(report.execution_result.change_summary).toBeUndefined();
    expect(report.execution_result.output_docx_path).toBeUndefined();
    expect(report.execution_result.issues).toEqual([
      expect.objectContaining({
        error_code: "E_DOCX_WRITE_FAILED",
        message: "DOCX write failed: boom"
      })
    ]);
    expect(report.execution_result.artifacts).toEqual(
      expect.objectContaining({
        write_operation_count: 6,
        executed_step_count: 0,
        materialized: false
      })
    );
  });

  it("executes the real template write and materialize chain to a DOCX file", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const docxPath = path.join(dir, "sample.docx");
    const templatePath = path.join(dir, "template.json");
    await materializeSeedDocx(docxPath);
    await writeFile(
      templatePath,
      JSON.stringify(
        {
          ...baseTemplate,
          layout_rules: {
            global_rules: {
              document_scope: "full_document",
              ordering: ["title", "body"],
              allow_unclassified_paragraphs: false
            },
            semantic_rules: [
              {
                semantic_key: "title",
                position_hints: ["near_top"]
              },
              {
                semantic_key: "body",
                text_hints: ["现将", "贯彻执行"]
              }
            ]
          },
          validation_policy: {
            min_confidence: 0.8,
            require_all_required_semantics: true,
            reject_conflicting_matches: true,
            reject_order_violations: true,
            reject_style_violations: false,
            reject_unmatched_when_required: true
          },
          operation_blocks: [
            {
              semantic_key: "title",
              text_style: {
                font_name: "SimSun",
                font_size_pt: 22,
                is_bold: true
              },
              paragraph_style: {
                paragraph_alignment: "center"
              }
            },
            {
              semantic_key: "body",
              text_style: {
                font_name: "SimSun",
                font_size_pt: 16
              },
              paragraph_style: {
                paragraph_alignment: "justify"
              }
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const report = await runTemplatePipeline(
      {
        docxPath,
        templatePath
      },
      {
        classifyParagraphs: async ({ context }) => {
          const paragraphIds = context.structureIndex.paragraphs.map((paragraph) => paragraph.id);
          return {
            template_id: "official_doc_body",
            matches: [
              {
                semantic_key: "title",
                paragraph_ids: [paragraphIds[0]!],
                confidence: 0.99,
                reason: "首段作为标题"
              },
              {
                semantic_key: "body",
                paragraph_ids: paragraphIds.slice(1),
                confidence: 0.95,
                reason: "后续段落作为正文"
              }
            ],
            unmatched_paragraph_ids: [],
            conflicts: [],
            overall_confidence: 0.97
          };
        }
      }
    );

    expect(report.status).toBe("executed");
    expect(report.execution_result.applied).toBe(true);
    expect(report.write_plan.length).toBeGreaterThan(0);
    expect(report.execution_result.output_docx_path).toBeTruthy();
    expect(report.execution_result.artifacts?.write_operation_count).toBe(report.write_plan.length);

    const outputDocxPath = report.execution_result.output_docx_path!;
    await expect(access(outputDocxPath, fsConstants.R_OK)).resolves.toBeUndefined();
    const content = await readFile(outputDocxPath);
    expect(content.byteLength).toBeGreaterThan(0);
  });

  it("fails without output path when materialize fails after execution and keeps write_plan", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    const executableTemplate = {
      ...baseTemplate,
      operation_blocks: [
        {
          semantic_key: "title",
          text_style: {
            font_name: "FZXiaoBiaoSong-B05S",
            font_size_pt: 22
          },
          paragraph_style: {
            paragraph_alignment: "center"
          }
        },
        {
          semantic_key: "body",
          text_style: {
            font_name: "FangSong_GB2312",
            font_size_pt: 16
          },
          paragraph_style: {
            paragraph_alignment: "justify"
          }
        }
      ]
    };
    await writeFile(templatePath, JSON.stringify(executableTemplate, null, 2), "utf8");

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath,
        debug: true
      },
      {
        observeDocx: async () => baseObservation,
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "title",
              paragraph_ids: ["p1"],
              confidence: 0.99,
              reason: "标题"
            },
            {
              semantic_key: "body",
              paragraph_ids: ["p2", "p3"],
              confidence: 0.92,
              reason: "正文"
            }
          ],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 0.95
        }),
        executeWritePlan: async ({ writePlan, outputDocxPath }) => ({
          applied: true,
          finalDoc: {
            id: "template:D:/docs/sample.docx",
            version: "v1",
            nodes: [],
            metadata: {
              inputDocxPath: "D:/docs/sample.docx",
              outputDocxPath
            }
          },
          changeSummary: `${writePlan.length} change(s) applied`,
          artifacts: {
            executed_step_count: writePlan.length,
            step_summaries: writePlan.map((item) => `Applied ${item.type}`),
            change_set_summary: {
              change_count: writePlan.length,
              rolled_back: false
            }
          }
        }),
        materializeDoc: async () => {
          throw new AgentError({
            code: "E_DOCX_WRITE_FAILED",
            message: "materialize failed",
            retryable: false
          });
        }
      }
    );

    expect(report.status).toBe("failed");
    expect(report.execution_plan).toHaveLength(2);
    expect(report.write_plan.map((item) => item.type)).toEqual([
      "set_font",
      "set_size",
      "set_alignment",
      "set_font",
      "set_size",
      "set_alignment"
    ]);
    expect(report.execution_result.applied).toBe(false);
    expect(report.execution_result.output_docx_path).toBeUndefined();
    expect(report.execution_result.change_summary).toBe("6 change(s) applied");
    expect(report.execution_result.issues).toEqual([
      expect.objectContaining({
        error_code: "E_DOCX_WRITE_FAILED",
        message: "materialize failed"
      })
    ]);
    expect(report.execution_result.artifacts).toEqual(
      expect.objectContaining({
        write_operation_count: 6,
        executed_step_count: 6,
        materialized: false,
        step_summaries: [
          "Applied set_font",
          "Applied set_size",
          "Applied set_alignment",
          "Applied set_font",
          "Applied set_size",
          "Applied set_alignment"
        ],
        change_set_summary: expect.objectContaining({
          change_count: 6,
          rolled_back: false
        })
      })
    );
  });

  it("adds warnings when an auto-corrected body_paragraph still starts with a numbering prefix", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    await writeFile(
      templatePath,
      JSON.stringify(
        {
          ...baseTemplate,
          semantic_blocks: [
            {
              key: "document_title",
              label: "文档标题",
              description: "文档标题。",
              examples: ["关于开展年度检查工作的通知"],
              required: true,
              multiple: false
            },
            {
              key: "body_paragraph",
              label: "正文段落",
              description: "正文段落。",
              examples: ["2. 现将有关事项通知如下。"],
              required: true,
              multiple: true
            }
          ],
          layout_rules: {
            global_rules: {
              document_scope: "full_document",
              ordering: ["document_title", "body_paragraph"],
              allow_unclassified_paragraphs: false
            },
            semantic_rules: [
              {
                semantic_key: "document_title",
                position_hints: ["near_top"]
              },
              {
                semantic_key: "body_paragraph",
                style_hints: {
                  role: "body",
                  bucket_type: "body"
                }
              }
            ]
          },
          operation_blocks: [
            {
              semantic_key: "document_title",
              text_style: {
                font_name: "FZXiaoBiaoSong-B05S",
                font_size_pt: 22
              },
              paragraph_style: {
                paragraph_alignment: "center"
              }
            },
            {
              semantic_key: "body_paragraph",
              text_style: {
                font_name: "FangSong_GB2312",
                font_size_pt: 16
              },
              paragraph_style: {
                paragraph_alignment: "justify",
                first_line_indent_chars: 2
              }
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath
      },
      {
        observeDocx: async () => ({
          ...baseObservation,
          document_meta: {
            total_paragraphs: 2,
            total_tables: 0
          },
          paragraphs: [
            baseObservation.paragraphs[0]!,
            {
              ...baseObservation.paragraphs[1]!,
              text: "2. 现将有关事项通知如下。"
            }
          ],
          nodes: [
            baseObservation.nodes[0]!,
            {
              id: "p2",
              node_type: "paragraph",
              children: [
                {
                  id: "p2_r1",
                  node_type: "text_run",
                  content: "2. 现将有关事项通知如下。",
                  style: {
                    font_name: "KaiTi",
                    font_size_pt: 15,
                    paragraph_alignment: "left"
                  }
                }
              ]
            }
          ]
        }),
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "document_title",
              paragraph_ids: ["p1"],
              confidence: 0.99,
              reason: "标题"
            },
            {
              semantic_key: "body_paragraph",
              paragraph_ids: ["p2"],
              confidence: 0.95,
              reason: "正文"
            }
          ],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 0.97
        }),
        executeWritePlan: async ({ context, writePlan, outputDocxPath }) => ({
          applied: true,
          finalDoc: {
            ...context.document,
            metadata: {
              ...context.document.metadata,
              inputDocxPath: "D:/docs/sample.docx",
              outputDocxPath
            }
          },
          changeSummary: `${writePlan.length} change(s) applied`,
          artifacts: {
            executed_step_count: writePlan.length
          }
        }),
        materializeDoc: async (doc) => ({
          doc,
          summary: `Materialized document to ${String(doc.metadata?.outputDocxPath)}.`
        })
      }
    );

    expect(report.status).toBe("executed");
    expect(report.warnings).toEqual([
      expect.objectContaining({
        code: "body_paragraph_suspicious_numbering_prefix",
        paragraph_ids: ["p2"],
        diagnostics: expect.objectContaining({
          semantic_key: "body_paragraph",
          numbering_prefix: "2.",
          detected_prefix: "2.",
          warning_kind: "body_paragraph_numbering_prefix",
          text_excerpt: "2. 现将有关事项通知如下。"
        })
      })
    ]);
  });

  it("does not emit body_paragraph numbering warnings when enforce_validation is false", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    await writeFile(
      templatePath,
      JSON.stringify(
        {
          ...baseTemplate,
          semantic_blocks: [
            {
              key: "document_title",
              label: "文档标题",
              description: "文档标题。",
              examples: ["关于开展年度检查工作的通知"],
              required: true,
              multiple: false
            },
            {
              key: "body_paragraph",
              label: "正文段落",
              description: "正文段落。",
              examples: ["2. 现将有关事项通知如下。"],
              required: true,
              multiple: true
            }
          ],
          layout_rules: {
            global_rules: {
              document_scope: "full_document",
              ordering: ["document_title", "body_paragraph"],
              allow_unclassified_paragraphs: false
            },
            semantic_rules: [
              {
                semantic_key: "document_title",
                position_hints: ["near_top"]
              },
              {
                semantic_key: "body_paragraph",
                numbering_patterns: ["^$"],
                style_hints: {
                  role: "body",
                  bucket_type: "body"
                }
              }
            ]
          },
          operation_blocks: [
            {
              semantic_key: "document_title",
              text_style: {
                font_name: "FZXiaoBiaoSong-B05S",
                font_size_pt: 22
              },
              paragraph_style: {
                paragraph_alignment: "center"
              }
            },
            {
              semantic_key: "body_paragraph",
              text_style: {
                font_name: "FangSong_GB2312",
                font_size_pt: 16
              },
              paragraph_style: {
                paragraph_alignment: "justify",
                first_line_indent_chars: 2
              }
            }
          ],
          validation_policy: {
            ...baseTemplate.validation_policy,
            enforce_validation: false
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath
      },
      {
        observeDocx: async () => ({
          ...baseObservation,
          document_meta: {
            total_paragraphs: 2,
            total_tables: 0
          },
          paragraphs: [
            baseObservation.paragraphs[0]!,
            {
              ...baseObservation.paragraphs[1]!,
              text: "2. 现将有关事项通知如下。"
            }
          ],
          nodes: [
            baseObservation.nodes[0]!,
            {
              id: "p2",
              node_type: "paragraph",
              children: [
                {
                  id: "p2_r1",
                  node_type: "text_run",
                  content: "2. 现将有关事项通知如下。",
                  style: {
                    font_name: "KaiTi",
                    font_size_pt: 15,
                    paragraph_alignment: "left"
                  }
                }
              ]
            }
          ]
        }),
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "document_title",
              paragraph_ids: ["p1"],
              confidence: 0.99,
              reason: "标题"
            },
            {
              semantic_key: "body_paragraph",
              paragraph_ids: ["p2"],
              confidence: 0.95,
              reason: "正文"
            }
          ],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 0.97
        }),
        executeWritePlan: async ({ context, writePlan, outputDocxPath }) => ({
          applied: true,
          finalDoc: {
            ...context.document,
            metadata: {
              ...context.document.metadata,
              inputDocxPath: "D:/docs/sample.docx",
              outputDocxPath
            }
          },
          changeSummary: `${writePlan.length} change(s) applied`,
          artifacts: {
            executed_step_count: writePlan.length
          }
        }),
        materializeDoc: async (doc) => ({
          doc,
          summary: `Materialized document to ${String(doc.metadata?.outputDocxPath)}.`
        })
      }
    );

    expect(report.status).toBe("executed");
    expect(report.validation_result.passed).toBe(true);
    expect(report.validation_result.issues).toEqual([]);
    expect(report.validation_result.runtime_warnings ?? []).toEqual([]);
    expect(report.warnings ?? []).toEqual([]);
  });

  it("downgrades disallowed body_paragraph numbering prefixes into runtime warnings", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const prefixes = ["1.", "一、", "（一）", "2.1"];

    for (const prefix of prefixes) {
      const dir = await makeTempDir();
      const templatePath = path.join(dir, `template-${prefix.length}.json`);
      await writeFile(
        templatePath,
        JSON.stringify(
          {
            ...baseTemplate,
            semantic_blocks: [
              {
                key: "body_paragraph",
                label: "正文段落",
                description: "正文段落。",
                examples: [`${prefix}现将有关事项通知如下。`],
                required: true,
                multiple: true
              }
            ],
            layout_rules: {
              global_rules: {
                document_scope: "full_document",
                ordering: ["body_paragraph"],
                allow_unclassified_paragraphs: false
              },
              semantic_rules: [
                {
                  semantic_key: "body_paragraph",
                  style_hints: {
                    role: "body",
                    bucket_type: "body"
                  },
                  numbering_patterns: ["^$"]
                }
              ]
            },
            operation_blocks: [
              {
                semantic_key: "body_paragraph",
                text_style: {
                  font_name: "FangSong_GB2312",
                  font_size_pt: 16
                },
                paragraph_style: {
                  paragraph_alignment: "justify"
                }
              }
            ],
            validation_policy: {
              ...baseTemplate.validation_policy,
              require_all_required_semantics: false
            }
          },
          null,
          2
        ),
        "utf8"
      );

      const report = await runTemplatePipeline(
        {
          docxPath: "D:/docs/sample.docx",
          templatePath
        },
        {
          observeDocx: async () => ({
            ...baseObservation,
            document_meta: {
              total_paragraphs: 1,
              total_tables: 0
            },
            paragraphs: [
              {
                ...baseObservation.paragraphs[1]!,
                text: `${prefix} 现将有关事项通知如下。`
              }
            ],
            nodes: [
              {
                id: "p2",
                node_type: "paragraph",
                children: [
                  {
                    id: "p2_r1",
                    node_type: "text_run",
                    content: `${prefix} 现将有关事项通知如下。`,
                    style: {
                      font_name: "KaiTi",
                      font_size_pt: 15,
                      paragraph_alignment: "left"
                    }
                  }
                ]
              }
            ]
          }),
          classifyParagraphs: async () => ({
            template_id: "official_doc_body",
            matches: [
              {
                semantic_key: "body_paragraph",
                paragraph_ids: ["p2"],
                confidence: 0.95,
                reason: "正文"
              }
            ],
            unmatched_paragraph_ids: [],
            conflicts: [],
            overall_confidence: 0.97
          }),
          executeWritePlan: async ({ context, writePlan, outputDocxPath }) => ({
            applied: true,
            finalDoc: {
              ...context.document,
              metadata: {
                ...context.document.metadata,
                inputDocxPath: "D:/docs/sample.docx",
                outputDocxPath
              }
            },
            changeSummary: `${writePlan.length} change(s) applied`,
            artifacts: {
              executed_step_count: writePlan.length
            }
          }),
          materializeDoc: async (doc) => ({
            doc,
            summary: `Materialized document to ${String(doc.metadata?.outputDocxPath)}.`
          })
        }
      );

      expect(report.status).toBe("executed");
      expect(report.validation_result.passed).toBe(true);
      expect(report.validation_result.issues).toEqual([]);
      expect(report.warnings).toEqual([
        expect.objectContaining({
          code: "body_paragraph_suspicious_numbering_prefix",
          paragraph_ids: ["p2"],
          diagnostics: expect.objectContaining({
            semantic_key: "body_paragraph",
            numbering_prefix: prefix,
            warning_kind: "body_paragraph_numbering_prefix",
            text_excerpt: `${prefix} 现将有关事项通知如下。`
          })
        })
      ]);
    }
  });

  it("does not add numbering warnings when the body_paragraph was not modified", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    await writeFile(
      templatePath,
      JSON.stringify(
        {
          ...baseTemplate,
          semantic_blocks: [
            {
              key: "body_paragraph",
              label: "正文段落",
              description: "正文段落。",
              examples: ["一、现将有关事项通知如下。"],
              required: true,
              multiple: true
            }
          ],
          layout_rules: {
            global_rules: {
              document_scope: "full_document",
              ordering: ["body_paragraph"],
              allow_unclassified_paragraphs: false
            },
            semantic_rules: [
              {
                semantic_key: "body_paragraph",
                style_hints: {
                  role: "body",
                  bucket_type: "body"
                }
              }
            ]
          },
          operation_blocks: [
            {
              semantic_key: "body_paragraph",
              text_style: {},
              paragraph_style: {}
            }
          ],
          validation_policy: {
            ...baseTemplate.validation_policy,
            require_all_required_semantics: false
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath
      },
      {
        observeDocx: async () => ({
          ...baseObservation,
          document_meta: {
            total_paragraphs: 1,
            total_tables: 0
          },
          paragraphs: [
            {
              ...baseObservation.paragraphs[0]!,
              role: "body",
              heading_level: undefined,
              style_name: "BodyText",
              text: "一、现将有关事项通知如下。"
            }
          ],
          nodes: [
            {
              id: "p1",
              node_type: "paragraph",
              children: [{ id: "p1_r1", node_type: "text_run", content: "一、现将有关事项通知如下。", style: {} }]
            }
          ]
        }),
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "body_paragraph",
              paragraph_ids: ["p1"],
              confidence: 0.95,
              reason: "正文"
            }
          ],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 0.97
        }),
        executeWritePlan: async ({ context, outputDocxPath }) => ({
          applied: true,
          finalDoc: {
            ...context.document,
            metadata: {
              ...context.document.metadata,
              inputDocxPath: "D:/docs/sample.docx",
              outputDocxPath
            }
          },
          changeSummary: "0 change(s) applied",
          artifacts: {
            executed_step_count: 0
          }
        }),
        materializeDoc: async (doc) => ({
          doc,
          summary: `Materialized document to ${String(doc.metadata?.outputDocxPath)}.`
        })
      }
    );

    expect(report.status).toBe("executed");
    expect(report.warnings ?? []).toEqual([]);
  });

  it("does not add numbering warnings for failed runs or non-body semantics", async () => {
    const { runTemplatePipeline } = await import("../src/templates/template-runner.js");
    const dir = await makeTempDir();
    const templatePath = path.join(dir, "template.json");
    await writeFile(
      templatePath,
      JSON.stringify(
        {
          ...baseTemplate,
          semantic_blocks: [
            {
              key: "section_heading",
              label: "章节标题",
              description: "章节标题。",
              examples: ["（一）总体要求"],
              required: true,
              multiple: true
            }
          ],
          layout_rules: {
            global_rules: {
              document_scope: "full_document",
              ordering: ["section_heading"],
              allow_unclassified_paragraphs: false
            },
            semantic_rules: [
              {
                semantic_key: "section_heading",
                style_hints: {
                  role: "body"
                }
              }
            ]
          },
          operation_blocks: [
            {
              semantic_key: "section_heading",
              text_style: {
                font_name: "HeiTi",
                font_size_pt: 16
              },
              paragraph_style: {
                paragraph_alignment: "left"
              }
            }
          ],
          validation_policy: {
            ...baseTemplate.validation_policy,
            require_all_required_semantics: false
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const report = await runTemplatePipeline(
      {
        docxPath: "D:/docs/sample.docx",
        templatePath
      },
      {
        observeDocx: async () => ({
          ...baseObservation,
          document_meta: {
            total_paragraphs: 1,
            total_tables: 0
          },
          paragraphs: [
            {
              ...baseObservation.paragraphs[0]!,
              role: "body",
              heading_level: undefined,
              style_name: "BodyText",
              text: "（一）总体要求"
            }
          ],
          nodes: [
            {
              id: "p1",
              node_type: "paragraph",
              children: [{ id: "p1_r1", node_type: "text_run", content: "（一）总体要求", style: {} }]
            }
          ]
        }),
        classifyParagraphs: async () => ({
          template_id: "official_doc_body",
          matches: [
            {
              semantic_key: "section_heading",
              paragraph_ids: ["p1"],
              confidence: 0.95,
              reason: "章节标题"
            }
          ],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 0.97
        }),
        executeWritePlan: async () => {
          throw new AgentError({
            code: "E_DOCX_WRITE_FAILED",
            message: "DOCX write failed",
            retryable: false
          });
        }
      }
    );

    expect(report.status).toBe("failed");
    expect(report.warnings ?? []).toEqual([]);
  });

  it("keeps numbering_pattern_not_allowed blocking for non-body semantics", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/section-heading-numbering.docx",
      observation: {
        ...baseObservation,
        document_meta: {
          total_paragraphs: 1,
          total_tables: 0
        },
        paragraphs: [
          {
            ...baseObservation.paragraphs[0]!,
            role: "body",
            heading_level: undefined,
            style_name: "BodyText",
            text: "（一）总体要求"
          }
        ],
        nodes: [
          {
            id: "p1",
            node_type: "paragraph",
            children: [{ id: "p1_r1", node_type: "text_run", content: "（一）总体要求", style: {} }]
          }
        ]
      }
    });
    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        semantic_blocks: [
          {
            key: "section_heading",
            label: "章节标题",
            description: "章节标题。",
            examples: ["（一）总体要求"],
            required: true,
            multiple: true
          }
        ],
        layout_rules: {
          global_rules: {
            document_scope: "full_document",
            ordering: ["section_heading"],
            allow_unclassified_paragraphs: false
          },
          semantic_rules: [
            {
              semantic_key: "section_heading",
              numbering_patterns: ["^第[一二三四五六七八九十]+部分$"]
            }
          ]
        },
        operation_blocks: [
          {
            semantic_key: "section_heading",
            text_style: {},
            paragraph_style: {}
          }
        ],
        validation_policy: {
          ...baseTemplate.validation_policy,
          require_all_required_semantics: false
        }
      },
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          {
            semantic_key: "section_heading",
            paragraph_ids: ["p1"],
            confidence: 0.95,
            reason: "章节标题"
          }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.97
      }
    });

    expect(validation.passed).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "numbering_pattern_not_allowed",
          semantic_key: "section_heading",
          paragraph_ids: ["p1"],
          diagnostics: expect.objectContaining({
            semantic_key: "section_heading",
            numbering_prefix: "（一）"
          })
        })
      ])
    );
  });

  it("reports occurrence min, max, and single semantic cardinality violations", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/sample.docx",
      observation: baseObservation
    });
    const occurrenceTemplate = {
      ...baseTemplate,
      layout_rules: {
        ...baseTemplate.layout_rules,
        semantic_rules: [
          {
            semantic_key: "title",
            style_hints: {
              style_name: "Heading 1"
            },
            occurrence: {
              min_occurs: 1,
              max_occurs: 1
            }
          },
          {
            semantic_key: "body",
            occurrence: {
              min_occurs: 3,
              max_occurs: 1
            }
          }
        ]
      },
      validation_policy: {
        ...baseTemplate.validation_policy,
        reject_unmatched_when_required: false
      }
    };

    const validation = validateTemplateClassification({
      template: occurrenceTemplate,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          {
            semantic_key: "title",
            paragraph_ids: ["p1", "p2"],
            confidence: 0.99,
            reason: "两个标题候选"
          },
          {
            semantic_key: "body",
            paragraph_ids: ["p3"],
            confidence: 0.92,
            reason: "正文不足"
          }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.95
      }
    });

    expect(validation.passed).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "single_semantic_multiple_paragraphs",
          semantic_key: "title",
          paragraph_ids: ["p1", "p2"]
        }),
        expect.objectContaining({
          error_code: "occurrence_above_max",
          semantic_key: "title",
          paragraph_ids: ["p1", "p2"]
        }),
        expect.objectContaining({
          error_code: "occurrence_below_min",
          semantic_key: "body",
          paragraph_ids: ["p3"]
        })
      ])
    );
  });

  it("validates structural style hints including role, bucket, level, table, and must_not_match", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/style-hints.docx",
      observation: {
        document_meta: {
          total_paragraphs: 4,
          total_tables: 1
        },
        paragraphs: [
          {
            id: "p1",
            text: "一、课程目标",
            role: "heading",
            heading_level: 1,
            style_name: "Heading 1",
            run_ids: ["p1_r1"],
            in_table: false
          },
          {
            id: "p2",
            text: "  - 报告需包含截图",
            role: "list_item",
            list_level: 1,
            style_name: "List Paragraph",
            run_ids: ["p2_r1"],
            in_table: false
          },
          {
            id: "p3",
            text: "表格内文字",
            role: "body",
            style_name: "Table Text",
            run_ids: ["p3_r1"],
            in_table: true
          },
          {
            id: "p4",
            text: "普通正文",
            role: "body",
            style_name: "BodyText",
            run_ids: ["p4_r1"],
            in_table: false
          }
        ],
        nodes: [
          { id: "p1", node_type: "paragraph", children: [{ id: "p1_r1", node_type: "text_run", content: "一、课程目标", style: {} }] },
          { id: "p2", node_type: "paragraph", children: [{ id: "p2_r1", node_type: "text_run", content: "  - 报告需包含截图", style: {} }] },
          { id: "p3", node_type: "paragraph", children: [{ id: "p3_r1", node_type: "text_run", content: "表格内文字", style: {} }] },
          { id: "p4", node_type: "paragraph", children: [{ id: "p4_r1", node_type: "text_run", content: "普通正文", style: {} }] }
        ]
      }
    });
    const structuralTemplate = {
      ...baseTemplate,
      semantic_blocks: [
        ...baseTemplate.semantic_blocks,
        {
          key: "document_title",
          label: "文档主标题",
          description: "不应匹配章节标题。",
          examples: ["课程评分细则"],
          required: false,
          multiple: false
        },
        {
          key: "list_item_level_0",
          label: "一级列表",
          description: "一级列表项。",
          examples: ["- 一级"],
          required: false,
          multiple: true
        },
        {
          key: "table_text",
          label: "表格文本",
          description: "表格内文本。",
          examples: ["表格内文字"],
          required: false,
          multiple: true
        }
      ],
      layout_rules: {
        ...baseTemplate.layout_rules,
        semantic_rules: [
          {
            semantic_key: "document_title",
            style_hints: {
              preferred_role: ["heading", "title"],
              preferred_bucket_type: ["heading", "title"],
              must_not_be_in_table: true,
              must_not_match: ["heading_level_1", "heading_level_2", "heading_level_3"]
            }
          },
          {
            semantic_key: "body",
            style_hints: {
              role: "body",
              bucket_type: "body",
              must_not_be_in_table: true
            }
          },
          {
            semantic_key: "list_item_level_0",
            style_hints: {
              role: "list_item",
              list_level: 0,
              must_not_be_in_table: true
            }
          },
          {
            semantic_key: "table_text",
            style_hints: {
              preferred_role: ["table_text", "body"],
              preferred_bucket_type: ["table_text"],
              in_table: true,
              heading_level: 2
            }
          }
        ]
      },
      operation_blocks: [
        ...baseTemplate.operation_blocks,
        {
          semantic_key: "document_title",
          text_style: {},
          paragraph_style: {}
        },
        {
          semantic_key: "list_item_level_0",
          text_style: {},
          paragraph_style: {}
        },
        {
          semantic_key: "table_text",
          text_style: {},
          paragraph_style: {}
        }
      ],
      validation_policy: {
        ...baseTemplate.validation_policy,
        require_all_required_semantics: false,
        reject_unmatched_when_required: false
      }
    };

    const validation = validateTemplateClassification({
      template: structuralTemplate,
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          { semantic_key: "document_title", paragraph_ids: ["p1"], confidence: 0.99, reason: "误把一级标题当主标题" },
          { semantic_key: "body", paragraph_ids: ["p3"], confidence: 0.9, reason: "表格内正文" },
          { semantic_key: "list_item_level_0", paragraph_ids: ["p2"], confidence: 0.9, reason: "二级列表误判" },
          { semantic_key: "table_text", paragraph_ids: ["p4"], confidence: 0.9, reason: "普通正文误判表格" }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.92
      }
    });

    expect(validation.passed).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "style_violation",
          semantic_key: "document_title",
          paragraph_ids: ["p1"],
          message: expect.stringContaining("must not match")
        }),
        expect.objectContaining({
          error_code: "style_violation",
          semantic_key: "body",
          paragraph_ids: ["p3"],
          message: expect.stringContaining("must not be in table")
        }),
        expect.objectContaining({
          error_code: "style_violation",
          semantic_key: "list_item_level_0",
          paragraph_ids: ["p2"],
          message: expect.stringContaining("list_level")
        }),
        expect.objectContaining({
          error_code: "style_violation",
          semantic_key: "table_text",
          paragraph_ids: ["p4"],
          message: expect.stringContaining("in_table")
        })
      ])
    );
  });

  it("allows the standard template to pass when document_title is missing but body_paragraph exists", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const templatePath = new URL("../../../templates/test_1.json", import.meta.url);
    const template = parseTemplateContract(JSON.parse(await readFile(templatePath, "utf8")) as Record<string, unknown>);
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/no-title.docx",
      observation: {
        document_meta: {
          total_paragraphs: 1,
          total_tables: 0
        },
        paragraphs: [
          {
            id: "p1",
            text: "现将有关事项通知如下。",
            role: "body",
            style_name: "BodyText",
            run_ids: ["p1_r1"],
            in_table: false
          }
        ],
        nodes: [
          {
            id: "p1",
            node_type: "paragraph",
            children: [
              {
                id: "p1_r1",
                node_type: "text_run",
                content: "现将有关事项通知如下。",
                style: {
                  font_name: "FangSong_GB2312",
                  font_size_pt: 16,
                  paragraph_alignment: "justify"
                }
              }
            ]
          }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template,
      context,
      classification: {
        template_id: "test_1",
        matches: [
          {
            semantic_key: "body_paragraph",
            paragraph_ids: ["p1"],
            confidence: 0.98,
            reason: "正文"
          }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.98
      }
    });

    expect(validation.passed).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(validation.runtime_warnings ?? []).toEqual([]);
  });

  it("defaults the standard template to pass even when body_paragraph is missing and document_title is duplicated", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const templatePath = new URL("../../../templates/test_1.json", import.meta.url);
    const template = parseTemplateContract(JSON.parse(await readFile(templatePath, "utf8")) as Record<string, unknown>);
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/title-only.docx",
      observation: {
        document_meta: {
          total_paragraphs: 2,
          total_tables: 0
        },
        paragraphs: [
          {
            id: "p1",
            text: "项目实施方案",
            role: "title",
            style_name: "Title",
            run_ids: ["p1_r1"],
            in_table: false
          },
          {
            id: "p2",
            text: "补充标题",
            role: "title",
            style_name: "Title",
            run_ids: ["p2_r1"],
            in_table: false
          }
        ],
        nodes: [
          {
            id: "p1",
            node_type: "paragraph",
            children: [
              {
                id: "p1_r1",
                node_type: "text_run",
                content: "项目实施方案",
                style: {
                  font_name: "SimSun",
                  font_size_pt: 14,
                  paragraph_alignment: "left",
                  is_bold: true
                }
              }
            ]
          },
          {
            id: "p2",
            node_type: "paragraph",
            children: [
              {
                id: "p2_r1",
                node_type: "text_run",
                content: "补充标题",
                style: {
                  font_name: "SimSun",
                  font_size_pt: 14,
                  paragraph_alignment: "left",
                  is_bold: true
                }
              }
            ]
          }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template,
      context,
      classification: {
        template_id: "test_1",
        matches: [
          {
            semantic_key: "document_title",
            paragraph_ids: ["p1", "p2"],
            confidence: 0.98,
            reason: "两个主标题"
          }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.98
      }
    });

    expect(validation.passed).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(validation.runtime_warnings ?? []).toEqual([]);
  });

  it("keeps legacy child validation flags inert unless enforce_validation is explicitly true", async () => {
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const { enforce_validation, ...legacyValidationPolicy } = baseTemplate.validation_policy;
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/legacy-template.docx",
      observation: {
        document_meta: {
          total_paragraphs: 1,
          total_tables: 0
        },
        paragraphs: [
          {
            id: "p1",
            text: "2. 现将有关事项通知如下。",
            role: "body",
            style_name: "BodyText",
            run_ids: ["p1_r1"],
            in_table: false
          }
        ],
        nodes: [
          {
            id: "p1",
            node_type: "paragraph",
            children: [
              {
                id: "p1_r1",
                node_type: "text_run",
                content: "2. 现将有关事项通知如下。",
                style: {
                  font_name: "KaiTi",
                  font_size_pt: 15,
                  paragraph_alignment: "left"
                }
              }
            ]
          }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template: {
        ...baseTemplate,
        semantic_blocks: [
          {
            key: "body_paragraph",
            label: "正文段落",
            description: "正文段落。",
            examples: ["现将有关事项通知如下。"],
            required: true,
            multiple: false
          }
        ],
        layout_rules: {
          global_rules: {
            document_scope: "full_document",
            ordering: ["body_paragraph"],
            allow_unclassified_paragraphs: false
          },
          semantic_rules: [
            {
              semantic_key: "body_paragraph",
              numbering_patterns: ["^$"],
              style_hints: {
                role: "body",
                must_not_be_in_table: true
              },
              occurrence: {
                min_occurs: 1,
                max_occurs: 1
              }
            }
          ]
        },
        operation_blocks: [
          {
            semantic_key: "body_paragraph",
            text_style: {},
            paragraph_style: {}
          }
        ],
        validation_policy: legacyValidationPolicy
      },
      context,
      classification: {
        template_id: "official_doc_body",
        matches: [
          {
            semantic_key: "body_paragraph",
            paragraph_ids: ["p1"],
            confidence: 0.4,
            reason: "正文"
          }
        ],
        unmatched_paragraph_ids: ["p1"],
        conflicts: [
          {
            paragraph_id: "p1",
            candidate_semantic_keys: ["body_paragraph", "title"],
            reason: "低置信度冲突"
          }
        ],
        overall_confidence: 0.4
      }
    });

    expect(validation.passed).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(validation.runtime_warnings ?? []).toEqual([]);
  });

  it("keeps test_1 non-restrictive even if enforce_validation is explicitly enabled", async () => {
    const { parseTemplateContract } = await import("../src/templates/template-contract.js");
    const { validateTemplateClassification } = await import("../src/templates/template-validator.js");
    const { buildTemplateContextFromObservation } = await import("../src/templates/template-context-builder.js");
    const context = buildTemplateContextFromObservation({
      docxPath: "D:/docs/title-only.docx",
      observation: {
        document_meta: {
          total_paragraphs: 2,
          total_tables: 0
        },
        paragraphs: [
          {
            id: "p1",
            text: "项目实施方案",
            role: "title",
            style_name: "Title",
            run_ids: ["p1_r1"],
            in_table: false
          },
          {
            id: "p2",
            text: "补充标题",
            role: "title",
            style_name: "Title",
            run_ids: ["p2_r1"],
            in_table: false
          }
        ],
        nodes: [
          {
            id: "p1",
            node_type: "paragraph",
            children: [
              {
                id: "p1_r1",
                node_type: "text_run",
                content: "项目实施方案",
                style: {
                  font_name: "SimSun",
                  font_size_pt: 14,
                  paragraph_alignment: "left",
                  is_bold: true
                }
              }
            ]
          },
          {
            id: "p2",
            node_type: "paragraph",
            children: [
              {
                id: "p2_r1",
                node_type: "text_run",
                content: "补充标题",
                style: {
                  font_name: "SimSun",
                  font_size_pt: 14,
                  paragraph_alignment: "left",
                  is_bold: true
                }
              }
            ]
          }
        ]
      }
    });

    const validation = validateTemplateClassification({
      template: parseTemplateContract({
        ...(JSON.parse(await readFile(new URL("../../../templates/test_1.json", import.meta.url), "utf8")) as Record<string, unknown>),
        validation_policy: {
          enforce_validation: true,
          min_confidence: 0.8,
          require_all_required_semantics: true,
          reject_conflicting_matches: true,
          reject_order_violations: true,
          reject_style_violations: true,
          reject_unmatched_when_required: true
        }
      }),
      context,
      classification: {
        template_id: "test_1",
        matches: [
          {
            semantic_key: "document_title",
            paragraph_ids: ["p1", "p2"],
            confidence: 0.98,
            reason: "两个主标题"
          }
        ],
        unmatched_paragraph_ids: [],
        conflicts: [],
        overall_confidence: 0.98
      }
    });

    expect(validation.passed).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(validation.runtime_warnings ?? []).toEqual([]);
  });
});
