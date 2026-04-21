import React, { ReactNode } from 'react';

interface AppLayoutProps {
  children: ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({ children }) => {
  return (
    // 统一定义全局的 Flex 布局、满屏视口、防滚动溢出、深色背景及基础文本颜色
    <div className="flex h-screen w-screen overflow-hidden bg-gray-900 font-sans antialiased text-gray-200 relative">
      {children}
    </div>
  );
};