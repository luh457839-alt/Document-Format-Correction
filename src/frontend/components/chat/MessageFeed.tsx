import React, { useEffect, useRef } from 'react';
import { useChatStore } from '../../store/useChatStore';

export const MessageFeed: React.FC = () => {
  const { currentSessionId, messages, isSending } = useChatStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  const currentMessages = currentSessionId ? messages[currentSessionId] || [] : [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages, isSending]);

  if (!currentSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        请在左侧选择或新建一个对话
      </div>
    );
  }

  if (currentMessages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 px-6 text-center">
        当前会话还没有消息。输入你的需求，或先导入一个 DOCX 文档开始处理。
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      {currentMessages.map((msg) => (
        <div
          key={msg.messageId}
          className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`max-w-3xl rounded-lg p-4 text-sm ${
              msg.role === 'user'
                ? 'bg-blue-600 text-white rounded-br-none'
                : 'bg-gray-800 text-gray-200 border border-gray-700 rounded-bl-none'
            }`}
          >
            {msg.attachments && msg.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {msg.attachments.map((file) => (
                  <div key={file.fileId} className="bg-black/20 px-2 py-1 rounded text-xs">
                    📎 {file.fileName}
                  </div>
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
          </div>
        </div>
      ))}

      {isSending && (
        <div className="flex justify-start">
          <div className="max-w-3xl rounded-lg p-4 text-sm bg-gray-800 text-gray-400 border border-gray-700 rounded-bl-none">
            正在等待 TS Agent 返回结果...
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
};