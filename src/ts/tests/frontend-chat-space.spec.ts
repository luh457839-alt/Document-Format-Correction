import { afterEach, describe, expect, it, vi } from "vitest";
import React from "../../frontend/node_modules/react/index.js";
import { renderToStaticMarkup } from "../../frontend/node_modules/react-dom/server.node.js";

const sendMessage = vi.fn();
const importDocument = vi.fn();
const clearError = vi.fn();
let capturedInputAreaProps: {
  disabled: boolean;
  onSendMessage: (text: string) => Promise<void> | void;
} | null = null;

vi.mock("../../frontend/store/useChatStore", () => ({
  useChatStore: () => ({
    currentSessionId: null,
    isSending: false,
    isUploading: false,
    attachedDocuments: {},
    pendingDocuments: {},
    error: null,
    sendMessage,
    importDocument,
    clearError
  })
}));

vi.mock("../../frontend/components/chat/MessageFeed", () => ({
  MessageFeed: () => React.createElement("div", { "data-testid": "message-feed" })
}));

vi.mock("../../frontend/components/chat/InputArea", () => ({
  InputArea: (props: {
    disabled: boolean;
    onSendMessage: (text: string) => Promise<void> | void;
  }) => {
    capturedInputAreaProps = props;
    return React.createElement("div", { "data-testid": "input-area" });
  }
}));

import { ChatSpace } from "../../frontend/components/chat/ChatSpace";

afterEach(() => {
  sendMessage.mockReset();
  importDocument.mockReset();
  clearError.mockReset();
  capturedInputAreaProps = null;
});

describe("ChatSpace first-send availability", () => {
  it("keeps the input enabled and forwards the first typed message even without a current session id", async () => {
    renderToStaticMarkup(React.createElement(ChatSpace));

    expect(capturedInputAreaProps).not.toBeNull();
    expect(capturedInputAreaProps?.disabled).toBe(false);

    await capturedInputAreaProps?.onSendMessage("首条消息");

    expect(sendMessage).toHaveBeenCalledWith("首条消息");
  });
});
