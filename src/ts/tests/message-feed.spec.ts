import { afterEach, describe, expect, it, vi } from "vitest";
import React from "../../frontend/node_modules/react/index.js";
import { renderToStaticMarkup } from "../../frontend/node_modules/react-dom/server.node.js";

const useChatStore = vi.fn();

vi.mock("../../frontend/store/useChatStore", () => ({
  useChatStore: () => useChatStore()
}));

import { MessageFeed } from "../../frontend/components/chat/MessageFeed";

afterEach(() => {
  useChatStore.mockReset();
});

describe("MessageFeed", () => {
  it("renders aggregated TS Agent steps without changing card controls", () => {
    useChatStore.mockReturnValue({
      currentSessionId: "chat-main",
      messages: {
        "chat-main": [
          {
            messageId: "msg-1",
            sessionId: "chat-main",
            role: "user",
            content: "批量调整正文和标题样式"
          }
        ]
      },
      localMessages: { "chat-main": [] },
      turnJobs: {
        "chat-main": [
          {
            jobId: "job-1",
            sessionId: "chat-main",
            status: "running",
            acceptedAt: 1,
            updatedAt: 2,
            summary: "正在规划并执行步骤",
            isCollapsed: false,
            steps: [
              {
                id: "runtime:summary:body:set_size",
                title: "已完成正文字号修改，共计12次",
                status: "completed",
                updatedAt: 2
              },
              {
                id: "runtime:summary:heading:set_font_color",
                title: "已完成标题颜色修改，共计3次",
                status: "completed",
                updatedAt: 2
              }
            ]
          }
        ]
      },
      toggleTurnJobExpanded: vi.fn()
    });

    const markup = renderToStaticMarkup(React.createElement(MessageFeed));

    expect(markup).toContain("TS Agent 处理中");
    expect(markup).toContain("已完成正文字号修改，共计12次");
    expect(markup).toContain("已完成标题颜色修改，共计3次");
    expect(markup).toContain("折叠");
  });
});
