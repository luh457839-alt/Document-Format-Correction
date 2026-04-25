import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "template-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("template cli", () => {
  it("writes a template run report with stable json field order", async () => {
    const { runTemplateCliWithDeps } = await import("../src/templates/template-cli.js");
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "input.json");
    const outputPath = path.join(dir, "output.json");

    await writeFile(
      inputPath,
      JSON.stringify(
        {
          docxPath: "D:/docs/sample.docx",
          templatePath: "D:/docs/template.json",
          debug: true
        },
        null,
        2
      ),
      "utf8"
    );

    const code = await runTemplateCliWithDeps(["--input-json", inputPath, "--output-json", outputPath], {
      runTemplate: async () => ({
        status: "executed",
        template_meta: {
          id: "official_doc_body",
          name: "公文正文模板",
          version: "1.0.0",
          schema_version: "1.0"
        },
        observation_summary: {
          document_meta: {
            total_paragraphs: 3,
            total_tables: 0
          },
          paragraph_count: 3,
          classifiable_paragraphs: [],
          evidence_summary: {
            table_count: 0,
            image_count: 0,
            seal_detection: {
              supported: false,
              detected: false
            }
          }
        },
        classification_result: {
          template_id: "official_doc_body",
          matches: [],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 1
        },
        validation_result: {
          passed: true,
          issues: []
        },
        warnings: [
          {
            code: "body_paragraph_suspicious_numbering_prefix",
            message: "Paragraph matched body_paragraph but still starts with numbering prefix '2.'; output was generated with a warning.",
            paragraph_ids: ["p2"],
            diagnostics: {
              semantic_key: "body_paragraph",
              text_excerpt: "2. 现将有关事项通知如下。",
              numbering_prefix: "2.",
              detected_prefix: "2.",
              warning_kind: "body_paragraph_numbering_prefix"
            }
          }
        ],
        execution_plan: [],
        write_plan: [],
        execution_result: {
          applied: true,
          output_docx_path: "D:/docs/sample.template-output.docx",
          change_summary: "0 change(s) applied",
          artifacts: {
            write_operation_count: 0,
            executed_step_count: 0,
            materialized: true,
            output_docx_path: "D:/docs/sample.template-output.docx"
          },
          issues: []
        }
      })
    });

    expect(code).toBe(0);
    const rawOutput = await readFile(outputPath, "utf8");
    const output = JSON.parse(rawOutput) as {
      status?: string;
      template_meta?: { id?: string };
      warnings?: Array<Record<string, unknown>>;
      execution_result?: Record<string, unknown>;
    };
    expect(output.status).toBe("executed");
    expect(output.template_meta?.id).toBe("official_doc_body");
    expect(output.warnings).toEqual([
      {
        code: "body_paragraph_suspicious_numbering_prefix",
        message: "Paragraph matched body_paragraph but still starts with numbering prefix '2.'; output was generated with a warning.",
        paragraph_ids: ["p2"],
        diagnostics: {
          semantic_key: "body_paragraph",
          text_excerpt: "2. 现将有关事项通知如下。",
          numbering_prefix: "2.",
          detected_prefix: "2.",
          warning_kind: "body_paragraph_numbering_prefix"
        }
      }
    ]);
    expect(rawOutput).toContain('"diagnostics"');
    expect(Object.keys(output)).toEqual([
      "status",
      "template_meta",
      "observation_summary",
      "classification_result",
      "validation_result",
      "warnings",
      "execution_plan",
      "write_plan",
      "execution_result"
    ]);
    expect(Object.keys(output.execution_result ?? {})).toEqual([
      "applied",
      "output_docx_path",
      "change_summary",
      "artifacts",
      "issues"
    ]);
  });

  it("omits undefined report fields instead of serializing null placeholders", async () => {
    const { runTemplateCliWithDeps } = await import("../src/templates/template-cli.js");
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "input.json");
    const outputPath = path.join(dir, "output.json");

    await writeFile(
      inputPath,
      JSON.stringify(
        {
          docxPath: "D:/docs/sample.docx",
          templatePath: "D:/docs/template.json"
        },
        null,
        2
      ),
      "utf8"
    );

    const code = await runTemplateCliWithDeps(["--input-json", inputPath, "--output-json", outputPath], {
      runTemplate: async () => ({
        status: "failed",
        template_meta: {
          id: "official_doc_body",
          name: "公文正文模板",
          version: "1.0.0",
          schema_version: "1.0"
        },
        observation_summary: {
          document_meta: {
            total_paragraphs: 1,
            total_tables: 0
          },
          paragraph_count: 1,
          classifiable_paragraphs: [],
          evidence_summary: {
            table_count: 0,
            image_count: 0,
            seal_detection: {
              supported: false,
              detected: false
            }
          }
        },
        classification_result: {
          template_id: "official_doc_body",
          matches: [],
          unmatched_paragraph_ids: ["p_0"],
          conflicts: [],
          diagnostics: {
            unmatched_paragraphs: [
              {
                paragraph_id: "p_0",
                text_excerpt: "未匹配段落",
                role: "body",
                bucket_type: "body",
                paragraph_index: 0,
                reason: "no_candidate",
                model_reported_unmatched: true
              }
            ]
          },
          overall_confidence: 0.2
        },
        validation_result: {
          passed: false,
          issues: [
            {
              error_code: "unclassified_paragraphs_present",
              message: "unmatched paragraphs are not allowed by template policy",
              paragraph_ids: ["p_0"],
              diagnostics: {
                unmatched_paragraphs: [
                  {
                    paragraph_id: "p_0",
                    text_excerpt: "未匹配段落",
                    role: "body",
                    bucket_type: "body",
                    paragraph_index: 0,
                    reason: "no_candidate",
                    model_reported_unmatched: true
                  }
                ],
                policy: {
                  allow_unclassified_paragraphs: false,
                  reject_unmatched_when_required: true
                }
              }
            }
          ]
        },
        execution_plan: [],
        write_plan: [],
        execution_result: {
          applied: false,
          issues: [
            {
              error_code: "unclassified_paragraphs_present",
              message: "unmatched paragraphs are not allowed by template policy",
              paragraph_ids: ["p_0"],
              diagnostics: {
                unmatched_paragraphs: [
                  {
                    paragraph_id: "p_0",
                    text_excerpt: "未匹配段落",
                    role: "body",
                    bucket_type: "body",
                    paragraph_index: 0,
                    reason: "no_candidate",
                    model_reported_unmatched: true
                  }
                ],
                policy: {
                  allow_unclassified_paragraphs: false,
                  reject_unmatched_when_required: true
                }
              }
            }
          ]
        }
      })
    });

    expect(code).toBe(0);
    const rawOutput = await readFile(outputPath, "utf8");
    const output = JSON.parse(rawOutput) as {
      classification_result?: { diagnostics?: { unmatched_paragraphs?: Array<Record<string, unknown>> } };
      validation_result?: { issues?: Array<{ diagnostics?: { policy?: Record<string, unknown> } }> };
      execution_result?: Record<string, unknown>;
    };
    expect(rawOutput).not.toContain('"output_docx_path"');
    expect(rawOutput).not.toContain('"change_summary"');
    expect(rawOutput).not.toContain("null");
    expect(output.classification_result?.diagnostics?.unmatched_paragraphs).toEqual([
      {
        paragraph_id: "p_0",
        text_excerpt: "未匹配段落",
        role: "body",
        bucket_type: "body",
        paragraph_index: 0,
        reason: "no_candidate",
        model_reported_unmatched: true
      }
    ]);
    expect(output.validation_result?.issues?.[0]?.diagnostics?.policy).toEqual({
      allow_unclassified_paragraphs: false,
      reject_unmatched_when_required: true
    });
    expect(Object.keys(output.execution_result ?? {})).toEqual(["applied", "issues"]);
  });

  it("serializes ignored unknown semantic diagnostics and execution issue summaries", async () => {
    const { runTemplateCliWithDeps } = await import("../src/templates/template-cli.js");
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "input.json");
    const outputPath = path.join(dir, "output.json");

    await writeFile(
      inputPath,
      JSON.stringify(
        {
          docxPath: "D:/docs/sample.docx",
          templatePath: "D:/docs/template.json"
        },
        null,
        2
      ),
      "utf8"
    );

    const code = await runTemplateCliWithDeps(["--input-json", inputPath, "--output-json", outputPath], {
      runTemplate: async () => ({
        status: "executed",
        template_meta: {
          id: "official_doc_body",
          name: "公文正文模板",
          version: "1.0.0",
          schema_version: "1.0"
        },
        observation_summary: {
          document_meta: {
            total_paragraphs: 1,
            total_tables: 0
          },
          paragraph_count: 1,
          classifiable_paragraphs: [],
          evidence_summary: {
            table_count: 0,
            image_count: 0,
            seal_detection: {
              supported: false,
              detected: false
            }
          }
        },
        classification_result: {
          template_id: "official_doc_body",
          matches: [],
          unmatched_paragraph_ids: [],
          conflicts: [],
          diagnostics: {
            ignored_unknown_semantic_matches: [
              {
                semantic_key: "appendix",
                paragraph_ids: ["p_0"],
                confidence: 0.8,
                reason: "附件"
              }
            ],
            normalization_notes: ["skipped unknown semantic_key 'appendix' from matches[0]"]
          },
          overall_confidence: 0.8
        },
        validation_result: {
          passed: true,
          issues: []
        },
        execution_plan: [],
        write_plan: [],
        execution_result: {
          applied: true,
          issues: [
            {
              error_code: "ignored_unknown_semantic_tags",
              message: "Ignored unknown semantic tags: appendix(1)."
            }
          ]
        }
      })
    });

    expect(code).toBe(0);
    const rawOutput = await readFile(outputPath, "utf8");
    const output = JSON.parse(rawOutput) as {
      classification_result?: {
        diagnostics?: {
          ignored_unknown_semantic_matches?: Array<Record<string, unknown>>;
          normalization_notes?: string[];
        };
      };
      execution_result?: { issues?: Array<Record<string, unknown>> };
    };
    expect(rawOutput).not.toContain("null");
    expect(output.classification_result?.diagnostics?.ignored_unknown_semantic_matches).toEqual([
      {
        semantic_key: "appendix",
        paragraph_ids: ["p_0"],
        confidence: 0.8,
        reason: "附件"
      }
    ]);
    expect(output.classification_result?.diagnostics?.normalization_notes).toEqual([
      "skipped unknown semantic_key 'appendix' from matches[0]"
    ]);
    expect(output.execution_result?.issues).toEqual([
      {
        error_code: "ignored_unknown_semantic_tags",
        message: "Ignored unknown semantic tags: appendix(1)."
      }
    ]);
  });

  it("serializes refinement diagnostics and refinement stage timings", async () => {
    const { runTemplateCliWithDeps } = await import("../src/templates/template-cli.js");
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "input.json");
    const outputPath = path.join(dir, "output.json");

    await writeFile(
      inputPath,
      JSON.stringify(
        {
          docxPath: "D:/docs/sample.docx",
          templatePath: "D:/docs/template.json"
        },
        null,
        2
      ),
      "utf8"
    );

    const code = await runTemplateCliWithDeps(["--input-json", inputPath, "--output-json", outputPath], {
      runTemplate: async () => ({
        status: "executed",
        template_meta: {
          id: "official_doc_body",
          name: "公文正文模板",
          version: "1.0.0",
          schema_version: "1.0"
        },
        stage_timings_ms: {
          observation_ms: 5,
          classification_request_ms: 11,
          refinement_ms: 17,
          validation_ms: 3,
          execution_ms: 9
        },
        observation_summary: {
          document_meta: {
            total_paragraphs: 2,
            total_tables: 0
          },
          paragraph_count: 2,
          classifiable_paragraphs: [],
          evidence_summary: {
            table_count: 0,
            image_count: 0,
            seal_detection: {
              supported: false,
              detected: false
            }
          }
        },
        classification_result: {
          template_id: "official_doc_body",
          matches: [],
          unmatched_paragraph_ids: [],
          conflicts: [],
          diagnostics: {
            refined_paragraphs: [
              {
                paragraph_id: "p2",
                first_pass: {
                  semantic_keys: ["body"],
                  confidence: 0.4,
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
        },
        validation_result: {
          passed: true,
          issues: []
        },
        execution_plan: [],
        write_plan: [],
        execution_result: {
          applied: true,
          issues: []
        }
      })
    });

    expect(code).toBe(0);
    const output = JSON.parse(await readFile(outputPath, "utf8")) as {
      stage_timings_ms?: Record<string, unknown>;
      classification_result?: {
        diagnostics?: {
          refined_paragraphs?: Array<Record<string, unknown>>;
          refinement_elapsed_ms?: number;
        };
      };
    };
    expect(output.stage_timings_ms?.refinement_ms).toBe(17);
    expect(output.classification_result?.diagnostics?.refinement_elapsed_ms).toBe(17);
    expect(output.classification_result?.diagnostics?.refined_paragraphs).toEqual([
      {
        paragraph_id: "p2",
        first_pass: {
          semantic_keys: ["body"],
          confidence: 0.4,
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

  it("serializes numbering diagnostics for validation issues", async () => {
    const { runTemplateCliWithDeps } = await import("../src/templates/template-cli.js");
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "input.json");
    const outputPath = path.join(dir, "output.json");

    await writeFile(
      inputPath,
      JSON.stringify(
        {
          docxPath: "D:/docs/sample.docx",
          templatePath: "D:/docs/template.json"
        },
        null,
        2
      ),
      "utf8"
    );

    const code = await runTemplateCliWithDeps(["--input-json", inputPath, "--output-json", outputPath], {
      runTemplate: async () => ({
        status: "failed",
        template_meta: {
          id: "official_doc_body",
          name: "公文正文模板",
          version: "1.0.0",
          schema_version: "1.0"
        },
        observation_summary: {
          document_meta: {
            total_paragraphs: 1,
            total_tables: 0
          },
          paragraph_count: 1,
          classifiable_paragraphs: [],
          evidence_summary: {
            table_count: 0,
            image_count: 0,
            seal_detection: {
              supported: false,
              detected: false
            }
          }
        },
        classification_result: {
          template_id: "official_doc_body",
          matches: [],
          unmatched_paragraph_ids: [],
          conflicts: [],
          overall_confidence: 0.5
        },
        validation_result: {
          passed: false,
          issues: [
            {
              error_code: "numbering_pattern_not_allowed",
              message: "paragraph 'p_29' numbering prefix '3.1' is not allowed by template",
              semantic_key: "caption",
              paragraph_ids: ["p_29"],
              diagnostics: {
                semantic_key: "caption",
                numbering_prefix: "3.1",
                rule_source: "semantic_rule",
                allowed_patterns: ["^图\\s*\\d+$"]
              }
            }
          ]
        },
        execution_plan: [],
        write_plan: [],
        execution_result: {
          applied: false,
          issues: []
        }
      })
    });

    expect(code).toBe(0);
    const output = JSON.parse(await readFile(outputPath, "utf8")) as {
      validation_result?: {
        issues?: Array<{ diagnostics?: Record<string, unknown> }>;
      };
    };
    expect(output.validation_result?.issues?.[0]?.diagnostics).toEqual({
      semantic_key: "caption",
      numbering_prefix: "3.1",
      rule_source: "semantic_rule",
      allowed_patterns: ["^图\\s*\\d+$"]
    });
  });

  it("writes structured input errors for invalid template cli payloads", async () => {
    const { runTemplateCli } = await import("../src/templates/template-cli.js");
    const dir = await makeTempDir();
    const inputPath = path.join(dir, "input.json");
    const outputPath = path.join(dir, "output.json");

    await writeFile(inputPath, JSON.stringify({ templatePath: "only-template.json" }, null, 2), "utf8");

    const code = await runTemplateCli(["--input-json", inputPath, "--output-json", outputPath]);

    expect(code).toBe(1);
    const output = JSON.parse(await readFile(outputPath, "utf8")) as {
      error?: { code?: string; message?: string };
    };
    expect(output.error?.code).toBe("E_TEMPLATE_CLI_INPUT_INVALID");
    expect(output.error?.message).toContain("docxPath");
  });
});
