import React, { useRef, useState, KeyboardEvent, ChangeEvent } from 'react';

interface InputAreaProps {
  onSendMessage: (text: string) => boolean | Promise<boolean>;
  onUploadDocument: (file: File) => void | Promise<void>;
  disabled: boolean;
  isUploading: boolean;
  pendingFileName?: string;
}

export const InputArea: React.FC<InputAreaProps> = ({
  onSendMessage,
  onUploadDocument,
  disabled,
  isUploading,
  pendingFileName,
}) => {
  const [text, setText] = useState('');
  const [localFileMessage, setLocalFileMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    adjustHeight();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleSend = async () => {
    const trimmedText = text.trim();
    if (disabled || (!trimmedText && !pendingFileName)) {
      return;
    }
    const shouldClear = await onSendMessage(trimmedText);
    if (shouldClear) {
      setText('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      return;
    }
    if (!file.name.toLowerCase().endsWith('.docx')) {
      setLocalFileMessage('仅支持导入 .docx 文件');
      return;
    }

    setLocalFileMessage('');
    await onUploadDocument(file);
  };

  const selectedFileName = pendingFileName || localFileMessage;

  return (
    <div className="p-4 border-t border-gray-800 bg-gray-900">
      {selectedFileName && (
        <div className="mb-3 rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-300">
          当前选择：{selectedFileName}
        </div>
      )}

      <div className="flex items-end gap-2 bg-gray-800 rounded-lg border border-gray-700 p-2 focus-within:border-blue-500 transition-colors">
        <label
          className={`cursor-pointer p-2 rounded-md transition-colors ${
            disabled ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'
          }`}
          title="导入 DOCX"
        >
          <input
            type="file"
            accept=".docx"
            className="hidden"
            onChange={(e) => void handleFileUpload(e)}
            disabled={disabled || isUploading}
          />
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 16V4m0 12l-4-4m4 4l4-4M4 20h16"
            />
          </svg>
        </label>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled
              ? '请先创建或选择会话...'
              : '输入消息，Enter 发送，Shift + Enter 换行...'
          }
          className="flex-1 bg-transparent text-gray-200 text-sm outline-none resize-none max-h-48 overflow-y-auto py-2"
          rows={1}
          disabled={disabled}
        />

        <button
          onClick={() => void handleSend()}
          disabled={disabled || (!text.trim() && !pendingFileName)}
          className="p-2 bg-blue-600 text-white rounded-md disabled:bg-gray-600 disabled:cursor-not-allowed hover:bg-blue-500 transition-colors mb-0.5"
          title="发送消息"
        >
          <svg className="w-4 h-4 text-white transform rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
        </button>
      </div>
    </div>
  );
};
