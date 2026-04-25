import React, { useEffect, useRef } from 'react';
import { useChatStore } from '../../store/useChatStore';
import { ChatFeedItem, TurnJobSnapshot } from '../../types';
import { ProgressJobCard } from '../common/ProgressJobCard';

export const MessageFeed: React.FC = () => {
  const { currentSessionId, messages, localMessages, turnJobs, toggleTurnJobExpanded } = useChatStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  const currentMessages = currentSessionId ? messages[currentSessionId] || [] : [];
  const currentLocalMessages = currentSessionId ? localMessages[currentSessionId] || [] : [];
  const currentTurnJobs = currentSessionId ? turnJobs[currentSessionId] || [] : [];

  const anchoredJobs = new Map<string, TurnJobSnapshot[]>();
  const trailingJobs: TurnJobSnapshot[] = [];
  currentTurnJobs.forEach((job) => {
    if (job.anchorMessageId) {
      anchoredJobs.set(job.anchorMessageId, [...(anchoredJobs.get(job.anchorMessageId) || []), job]);
      return;
    }
    trailingJobs.push(job);
  });

  const feedItems: ChatFeedItem[] = [];
  currentMessages.forEach((message) => {
    feedItems.push({ kind: 'message', key: message.messageId, message });
    (anchoredJobs.get(message.messageId) || []).forEach((job) => {
      feedItems.push({ kind: 'job', key: job.jobId, job });
    });
  });
  currentLocalMessages.forEach((message) => {
    feedItems.push({ kind: 'message', key: message.messageId, message });
    (anchoredJobs.get(message.messageId) || []).forEach((job) => {
      feedItems.push({ kind: 'job', key: job.jobId, job });
    });
  });
  trailingJobs.forEach((job) => {
    feedItems.push({ kind: 'job', key: job.jobId, job });
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [feedItems.length]);

  if (!currentSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        请在左侧选择或新建一个对话
      </div>
    );
  }

  if (feedItems.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 px-6 text-center">
        当前会话还没有消息。输入你的需求，或先导入一个 DOCX 文档开始处理。
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      {feedItems.map((item) => {
        if (item.kind === 'message') {
          const msg = item.message;
          return (
            <div
              key={item.key}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-3xl rounded-lg p-4 text-sm ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-br-none'
                    : 'bg-gray-800 text-gray-200 border border-gray-700 rounded-bl-none'
                } ${msg.isTemporary ? 'opacity-90 ring-1 ring-blue-300/30' : ''}`}
              >
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {msg.attachments.map((file) => (
                      <div key={file.fileId} className="bg-black/20 px-2 py-1 rounded text-xs">
                        {file.fileName}
                      </div>
                    ))}
                  </div>
                )}
                <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
              </div>
            </div>
          );
        }

        const job = item.job;
        return (
          <div key={item.key} className="flex justify-start">
            <ProgressJobCard
              job={job}
              onToggleCollapse={() => currentSessionId && toggleTurnJobExpanded(currentSessionId, job.jobId)}
            />
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
};
