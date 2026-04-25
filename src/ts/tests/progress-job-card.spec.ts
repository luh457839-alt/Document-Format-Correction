import { describe, expect, it } from "vitest";
import React from "../../frontend/node_modules/react/index.js";
import { renderToStaticMarkup } from "../../frontend/node_modules/react-dom/server.node.js";

import { ProgressJobCard } from "../../frontend/components/common/ProgressJobCard";

describe("ProgressJobCard", () => {
  it("renders template refinement diagnostics for failed template jobs", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProgressJobCard, {
        titlePrefix: "模板任务",
        job: {
          jobId: "template-1",
          sessionId: "templates",
          status: "failed",
          acceptedAt: 1,
          updatedAt: 2,
          summary: "段落分类仍然冲突",
          isCollapsed: false,
          steps: [
            {
              id: "validate_result",
              title: "归一化模板执行结果",
              status: "failed",
              detail: "classification_conflict: 段落分类仍然冲突"
            }
          ],
          debug: {
            refinementSummary: [
              {
                paragraphId: "p_0",
                firstPass: {
                  semanticKeys: ["title", "body"],
                  candidateSemanticKeys: ["title", "body", "blank_or_unknown"],
                  confidence: 0.52,
                  reason: "标题和正文特征都命中",
                  source: "conflict"
                },
                secondPass: {
                  semanticKey: "title",
                  candidateSemanticKeys: ["title", "body"],
                  confidence: 0.48,
                  reason: "上下文仍不足以收敛"
                },
                outcome: "rejected_conflict"
              }
            ]
          }
        }
      })
    );

    expect(markup).toContain("诊断摘要");
    expect(markup).toContain("段落 p_0");
    expect(markup).toContain("first pass: title, body");
    expect(markup).toContain("second pass: title");
    expect(markup).toContain("二次判定后仍冲突");
  });
});
