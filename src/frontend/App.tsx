import React, { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { Sidebar } from './components/sidebar/Sidebar';
import { ChatSpace } from './components/chat/ChatSpace';
import { SettingsDrawer } from './components/settings/SettingsDrawer';
import { useChatStore } from './store/useChatStore';

const App: React.FC = () => {
  const { initialize, isInitializing, error } = useChatStore();

  useEffect(() => {
    void initialize();
  }, [initialize]);

  if (isInitializing) {
    return (
      <AppLayout>
        <div className="flex-1 flex items-center justify-center text-gray-300 text-sm">
          正在连接本地桌面服务并加载会话...
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <Sidebar />
      <ChatSpace />
      <SettingsDrawer />
      {error && (
        <div className="absolute bottom-4 left-4 text-xs text-gray-500">
          本地服务状态已更新
        </div>
      )}
    </AppLayout>
  );
};

export default App;