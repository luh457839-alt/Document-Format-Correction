import React, { useEffect, useRef } from 'react';
import { useChatStore } from '../../store/useChatStore';
import { ChatFeedItem, TurnJobSnapshot } from '../../types';

function statusLabel(status: TurnJobSnapshot['status']): string {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '处理中';
  if (status === 'waiting_user') return '等待确认';
  if (status === 'completed') return '已完成';
  return '失败';
}

function statusTone(status: TurnJobSnapshot['status']): string {
  if (status === 'completed') return 'border-emerald-700 bg-emerald-950/30 text-emerald-200';
  if (status === 'waiting_user') return 'border-amber-700 bg-amber-950/30 text-amber-200';
  if (status === 'failed') return 'border-red-700 bg-red-950/30 text-red-200';
  return 'border-sky-700 bg-sky-950/30 text-sky-200';
}

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
            <div className={`max-w-3xl rounded-lg border rounded-bl-none px-4 py-3 text-sm ${statusTone(job.status)}`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">TS Agent {statusLabel(job.status)}</div>
                  <div className="mt-1 text-xs opacity-80">{job.summary || '正在处理当前请求'}</div>
                </div>
                <button
                  className="text-xs opacity-80 hover:opacity-100 transition-opacity"
                  onClick={() => currentSessionId && toggleTurnJobExpanded(currentSessionId, job.jobId)}
                >
                  {job.isCollapsed ? '展开' : '折叠'}
                </button>
              </div>

              {!job.isCollapsed && job.steps.length > 0 && (
                <div className="mt-3 space-y-2">
                  {job.steps.map((step) => (
                    <div key={step.id} className="rounded-md border border-white/10 bg-black/10 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <span>{step.title}</span>
                        <span className="text-xs opacity-80">
                          {step.status === 'queued'
                            ? '排队中'
                            : step.status === 'running'
                              ? '进行中'
                              : step.status === 'completed'
                                ? '已完成'
                                : '失败'}
                        </span>
                      </div>
                      {step.detail && <div className="mt-1 text-xs opacity-75 whitespace-pre-wrap">{step.detail}</div>}
                    </div>
                  ))}
                </div>
              )}

              {job.error?.message && (
                <div className="mt-3 text-xs whitespace-pre-wrap opacity-90">{job.error.message}</div>
              )}
            </div>
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
};
