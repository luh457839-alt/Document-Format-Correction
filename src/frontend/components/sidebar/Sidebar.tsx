import React, { useState } from 'react';

interface SidebarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  onCreateTask: () => void;
}

const navItems = [
  { path: '/', label: '工作台', icon: 'W' },
  { path: '/templates', label: '模板库', icon: 'T' },
  { path: '/history', label: '历史记录', icon: 'H' },
];

export const Sidebar: React.FC<SidebarProps> = ({ currentPath, onNavigate, onCreateTask }) => {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const handleCreateTask = () => {
    onNavigate('/');
    onCreateTask();
  };

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-slate-800 bg-slate-950 transition-all duration-200 ${
        isCollapsed ? 'w-20' : 'w-72'
      }`}
    >
      <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-5">
        <button
          type="button"
          onClick={() => setIsCollapsed((value) => !value)}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-800 text-slate-200 transition-colors hover:bg-slate-700"
          title="切换侧边栏"
        >
          ☰
        </button>
        {!isCollapsed && (
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">文档格式修改 Agent</div>
            <div className="mt-1 truncate text-xs text-slate-500">Workspace Prompt Builder</div>
          </div>
        )}
      </div>

      <div className="border-b border-slate-800 p-4">
        <button
          type="button"
          onClick={handleCreateTask}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-500 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-sky-400"
        >
          <span>+</span>
          {!isCollapsed && <span>新建任务</span>}
        </button>
      </div>

      <nav className="flex-1 space-y-2 px-3 py-4">
        {navItems.map((item) => {
          const isActive = currentPath === item.path;
          return (
            <button
              key={item.path}
              type="button"
              onClick={() => onNavigate(item.path)}
              className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm transition-colors ${
                isActive
                  ? 'bg-sky-500 text-white'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
              title={item.label}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-black/20 text-xs font-semibold">
                {item.icon}
              </span>
              {!isCollapsed && <span>{item.label}</span>}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-slate-800 p-3">
        <button
          type="button"
          onClick={() => onNavigate('/settings')}
          className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm transition-colors ${
            currentPath === '/settings'
              ? 'bg-sky-500 text-white'
              : 'text-slate-300 hover:bg-slate-800 hover:text-white'
          }`}
          title="设置"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-black/20 text-xs font-semibold">
            S
          </span>
          {!isCollapsed && <span>设置</span>}
        </button>
        {!isCollapsed && <div className="px-3 pb-2 pt-4 text-xs text-slate-500">本地用户</div>}
      </div>
    </aside>
  );
};
