import React from 'react';
import { MessageFeed } from './MessageFeed';
import { InputArea } from './InputArea';
import { useChatStore } from '../../store/useChatStore';

export const ChatSpace: React.FC = () => {
  const {
    currentSessionId,
    isSending,
    isUploading,
    attachedDocuments,
    pendingDocuments,
    error,
    sendMessage,
    importDocument,
    clearError,
  } = useChatStore();

  const attachedDocument = currentSessionId ? attachedDocuments[currentSessionId] : null;
  const pendingDocument = currentSessionId ? pendingDocuments[currentSessionId] : null;

  const handleSendMessage = async (text: string) => {
    await sendMessage(text);
  };

  const handleUploadDocument = async (file: File) => {
    await importDocument(file);
  };

  return (
    <div className="flex-1 flex flex-col bg-gray-900 relative">
      {attachedDocument && (
        <div className="px-4 pt-4">
          <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
            已绑定文档：
            <span className="ml-2 font-medium break-all">
              {String(attachedDocument.name || attachedDocument.path || 'DOCX 文档')}
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="px-4 pt-4">
          <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200 flex items-start justify-between gap-4">
            <span className="whitespace-pre-wrap">{error}</span>
            <button
              onClick={clearError}
              className="text-red-300 hover:text-white transition-colors"
              title="关闭错误提示"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <MessageFeed />
      <InputArea
        onSendMessage={handleSendMessage}
        onUploadDocument={handleUploadDocument}
        disabled={isSending || isUploading}
        isUploading={isUploading}
        pendingFileName={pendingDocument?.name}
      />
    </div>
  );
};
