import React, { useState } from 'react';
import { SearchBox } from './SearchBox';
import { SessionList } from './SessionList';
import { useChatStore } from '../../store/useChatStore';

interface SidebarProps {
  isTemplateRoute?: boolean;
  onNavigateHome?: () => void;
  onNavigateTemplates?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isTemplateRoute = false, onNavigateHome, onNavigateTemplates }) => {
  const { startDraftSession, isLoadingSessions, toggleSettings, isSettingsOpen } = useChatStore();
  const [searchQuery, setSearchQuery] = useState('');

  const handleCreateSession = async () => {
    onNavigateHome?.();
    startDraftSession();
  };

  const handleFixedTemplateEdit = () => {
    if (isTemplateRoute) {
      onNavigateHome?.();
      return;
    }
    onNavigateTemplates?.();
  };

  return (
    <div className="w-64 flex flex-col bg-gray-900 border-r border-gray-800 h-full">
      <SearchBox onSearch={setSearchQuery} />

      <div className="p-4 border-b border-gray-800">
        <button
          type="button"
          onClick={() => void handleCreateSession()}
          disabled={isLoadingSessions}
          className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-400 text-white rounded-md text-sm font-medium transition-colors"
        >
          {isLoadingSessions ? '处理中...' : '+ 新建对话'}
        </button>
        <button
          type="button"
          onClick={handleFixedTemplateEdit}
          className="mt-2 w-full py-2 border border-gray-600 text-gray-300 hover:bg-gray-700 rounded-md text-sm font-medium transition-colors"
        >
          固定模板修改
        </button>
      </div>

      <SessionList searchQuery={searchQuery} onSelectSession={onNavigateHome} />

      <div className="border-t border-gray-800 p-4">
        <button
          onClick={() => toggleSettings(true)}
          className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
            isSettingsOpen
              ? 'bg-gray-800 text-white'
              : 'text-gray-300 hover:bg-gray-800 hover:text-white'
          }`}
          title="打开设置"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span>设置</span>
        </button>
      </div>
    </div>
  );
};
