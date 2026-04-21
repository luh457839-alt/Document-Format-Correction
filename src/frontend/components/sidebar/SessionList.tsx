import React, { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../store/useChatStore';

interface SessionListProps {
  searchQuery: string;
}

export const SessionList: React.FC<SessionListProps> = ({ searchQuery }) => {
  const { sessions, currentSessionId, setCurrentSession, isLoadingSessions, renameSession, deleteSession } =
    useChatStore();
  const [menuSessionId, setMenuSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmDeleteSession, setConfirmDeleteSession] = useState<{ sessionId: string; title: string } | null>(
    null
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredSessions = sessions.filter((session) =>
    session.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  useEffect(() => {
    if (!menuSessionId) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      setMenuSessionId(null);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [menuSessionId]);

  useEffect(() => {
    if (editingSessionId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingSessionId]);

  const beginRename = (sessionId: string, title: string) => {
    setMenuSessionId(null);
    setEditingSessionId(sessionId);
    setEditingTitle(title);
  };

  const cancelRename = () => {
    setEditingSessionId(null);
    setEditingTitle('');
  };

  const commitRename = async () => {
    if (!editingSessionId) {
      return;
    }
    const success = await renameSession(editingSessionId, editingTitle);
    if (success) {
      cancelRename();
    }
  };

  if (isLoadingSessions && filteredSessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
        正在加载会话...
      </div>
    );
  }

  if (filteredSessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4 text-center text-sm text-gray-500">
        暂无会话，点击上方按钮创建新对话。
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto">
      {filteredSessions.map((session) => (
        <div
          key={session.sessionId}
          className={`group relative flex items-center gap-2 px-4 py-3 transition-colors ${
            currentSessionId === session.sessionId ? 'bg-gray-700' : 'hover:bg-gray-800'
          }`}
        >
          <button
            onClick={() => void setCurrentSession(session.sessionId)}
            className="min-w-0 flex-1 text-left focus:outline-none focus-visible:outline-none"
          >
            {editingSessionId === session.sessionId ? (
              <input
                ref={inputRef}
                value={editingTitle}
                onChange={(event) => setEditingTitle(event.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void commitRename();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
                className="w-full rounded bg-gray-800 px-2 py-1 text-sm text-gray-100 outline-none ring-1 ring-blue-500"
              />
            ) : (
              <>
                <div className="text-gray-200 text-sm truncate">{session.title}</div>
                <div className="mt-1 text-xs text-gray-500 truncate">
                  {session.isDraft ? '本地草稿' : session.sessionId}
                </div>
              </>
            )}
          </button>

          {editingSessionId !== session.sessionId && (
            <div ref={menuSessionId === session.sessionId ? menuRef : null} className="relative">
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuSessionId((current) => (current === session.sessionId ? null : session.sessionId));
                }}
                className={`rounded-md p-1.5 text-gray-400 transition ${
                  menuSessionId === session.sessionId
                    ? 'bg-gray-800 text-gray-100'
                    : 'opacity-0 group-hover:opacity-100 hover:bg-gray-800 hover:text-gray-100'
                }`}
                title="更多操作"
              >
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm0 5.5A1.5 1.5 0 1010 8.5a1.5 1.5 0 000 3zm0 5.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
                </svg>
              </button>

              {menuSessionId === session.sessionId && (
                <div className="absolute right-0 top-10 z-20 w-32 rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-2xl">
                  <button
                    onClick={() => beginRename(session.sessionId, session.title)}
                    className="block w-full px-3 py-2 text-left text-sm text-gray-200 transition hover:bg-gray-800"
                  >
                    重命名
                  </button>
                  <button
                    onClick={() => {
                      setMenuSessionId(null);
                      setConfirmDeleteSession({ sessionId: session.sessionId, title: session.title });
                    }}
                    className="block w-full px-3 py-2 text-left text-sm text-red-300 transition hover:bg-gray-800"
                  >
                    删除
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      </div>

      {confirmDeleteSession && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-md rounded-xl border border-red-900 bg-gray-900 p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-white">删除会话</h3>
            <p className="mt-3 text-sm leading-6 text-gray-300">
              确认彻底删除“{confirmDeleteSession.title}”吗？该会话的消息、附件关联和标题都会被移除。
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setConfirmDeleteSession(null)}
                className="rounded-md border border-gray-700 px-4 py-2 text-sm text-gray-200 transition hover:bg-gray-800"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  const success = await deleteSession(confirmDeleteSession.sessionId);
                  if (success) {
                    setConfirmDeleteSession(null);
                  }
                }}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-500"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
