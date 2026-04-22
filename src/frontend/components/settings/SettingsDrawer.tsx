import React, { useEffect, useState } from 'react';
import { useChatStore } from '../../store/useChatStore';
import { UserSettings } from '../../types';

function parseRequiredNumber(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseNullableNumber(value: string): number | null {
  if (!value.trim()) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export const SettingsDrawer: React.FC = () => {
  const {
    settings,
    updateSettings,
    persistSettings,
    reloadSettings,
    isSettingsOpen,
    toggleSettings,
  } = useChatStore();

  const [localSettings, setLocalSettings] = useState<UserSettings>(settings);
  const [isSaving, setIsSaving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    let cancelled = false;
    void (async () => {
      setIsRefreshing(true);
      try {
        await reloadSettings();
      } finally {
        if (!cancelled) {
          setIsRefreshing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isSettingsOpen, reloadSettings]);

  useEffect(() => {
    if (isSettingsOpen) {
      setLocalSettings(settings);
    }
  }, [isSettingsOpen, settings]);

  const updateLocalSettings = <K extends keyof UserSettings>(
    key: K,
    value: UserSettings[K]
  ) => {
    setLocalSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      updateSettings(localSettings);
      await persistSettings(localSettings);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReload = async () => {
    setIsRefreshing(true);
    try {
      await reloadSettings();
    } finally {
      setIsRefreshing(false);
    }
  };

  if (!isSettingsOpen) {
    return null;
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/50 transition-opacity"
        onClick={() => toggleSettings(false)}
      />

      <div className="fixed left-0 top-0 bottom-0 z-50 flex w-96 max-w-full flex-col border-r border-gray-700 bg-gray-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-700 p-4">
          <div>
            <h2 className="text-lg font-semibold text-white">模型设置</h2>
            <p className="mt-1 text-xs text-gray-400">
              打开时会从本地 config.json 重新读取；保存后将写回本地配置，并用于后续 TS Agent 会话。
            </p>
          </div>
          <button
            onClick={() => toggleSettings(false)}
            className="text-gray-400 transition-colors hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          <section className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-white">聊天模型</h3>
              <p className="mt-1 text-xs text-gray-400">用于主对话消息生成。</p>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Chat Base URL
              </label>
              <input
                type="text"
                value={localSettings.apiBaseUrl}
                onChange={(e) => updateLocalSettings('apiBaseUrl', e.target.value)}
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                placeholder="http://localhost:8080/v1"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Chat API Key
              </label>
              <input
                type="password"
                value={localSettings.apiKey}
                onChange={(e) => updateLocalSettings('apiKey', e.target.value)}
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                placeholder="sk-..."
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Chat Model
              </label>
              <input
                type="text"
                value={localSettings.selectedModel}
                onChange={(e) => updateLocalSettings('selectedModel', e.target.value)}
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                placeholder="gemma-4"
              />
            </div>
          </section>

          <section className="space-y-4 border-t border-gray-700 pt-6">
            <div>
              <h3 className="text-sm font-semibold text-white">规划模型</h3>
              <p className="mt-1 text-xs text-gray-400">用于 Planner / ReAct 阶段。</p>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Planner Base URL
              </label>
              <input
                type="text"
                value={localSettings.plannerBaseUrl}
                onChange={(e) => updateLocalSettings('plannerBaseUrl', e.target.value)}
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                placeholder="http://localhost:8080/v1"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Planner API Key
              </label>
              <input
                type="password"
                value={localSettings.plannerApiKey}
                onChange={(e) => updateLocalSettings('plannerApiKey', e.target.value)}
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                placeholder="sk-..."
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Planner Model
              </label>
              <input
                type="text"
                value={localSettings.plannerModel}
                onChange={(e) => updateLocalSettings('plannerModel', e.target.value)}
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                placeholder="gemma-4"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Runtime Mode
              </label>
              <select
                value={localSettings.runtimeMode}
                onChange={(e) =>
                  updateLocalSettings(
                    'runtimeMode',
                    e.target.value as UserSettings['runtimeMode']
                  )
                }
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
              >
                <option value="react_loop">react_loop</option>
                <option value="plan_once">plan_once</option>
              </select>
              <p className="mt-2 text-xs text-gray-500">
                react_loop 适合多轮规划执行，plan_once 适合单次规划。
              </p>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Planner Request Timeout (ms)
              </label>
              <input
                type="number"
                min={0}
                value={localSettings.plannerTimeoutMs ?? ''}
                onChange={(e) => updateLocalSettings('plannerTimeoutMs', parseNullableNumber(e.target.value))}
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                placeholder="留空表示使用模型默认"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Step Timeout (ms)
              </label>
              <input
                type="number"
                min={0}
                value={localSettings.stepTimeoutMs}
                onChange={(e) =>
                  updateLocalSettings('stepTimeoutMs', parseRequiredNumber(e.target.value, localSettings.stepTimeoutMs))
                }
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Task Timeout (ms)
              </label>
              <input
                type="number"
                min={0}
                value={localSettings.taskTimeoutMs ?? ''}
                onChange={(e) => updateLocalSettings('taskTimeoutMs', parseNullableNumber(e.target.value))}
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                placeholder="留空表示不设整轮硬超时"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Python Tool Timeout (ms)
              </label>
              <input
                type="number"
                min={0}
                value={localSettings.pythonToolTimeoutMs ?? ''}
                onChange={(e) =>
                  updateLocalSettings('pythonToolTimeoutMs', parseNullableNumber(e.target.value))
                }
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                placeholder="留空表示继承 Step Timeout"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Max Turns
              </label>
              <input
                type="number"
                min={1}
                value={localSettings.maxTurns}
                onChange={(e) =>
                  updateLocalSettings('maxTurns', parseRequiredNumber(e.target.value, localSettings.maxTurns))
                }
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Sync Request Timeout (ms)
              </label>
              <input
                type="number"
                min={0}
                value={localSettings.syncRequestTimeoutMs}
                onChange={(e) =>
                  updateLocalSettings(
                    'syncRequestTimeoutMs',
                    parseRequiredNumber(e.target.value, localSettings.syncRequestTimeoutMs)
                  )
                }
                className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
              />
              <p className="mt-2 text-xs text-gray-500">
                仅用于同步等待；异步任务默认允许持续后台运行。
              </p>
            </div>
          </section>
        </div>

        <div className="border-t border-gray-700 bg-gray-800 p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-gray-400">
              {isRefreshing ? '正在从本地配置重新读取...' : '可手动重新同步当前 config.json 内容'}
            </span>
            <button
              onClick={handleReload}
              disabled={isRefreshing || isSaving}
              className="rounded-md border border-gray-600 px-3 py-1 text-xs font-medium text-gray-200 transition-colors hover:border-gray-500 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRefreshing ? '读取中...' : '重新读取配置'}
            </button>
          </div>
          <button
            onClick={handleSave}
            disabled={isSaving || isRefreshing}
            className="w-full rounded-md bg-blue-600 py-2 font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-gray-600"
          >
            {isSaving ? '保存中...' : '保存并生效'}
          </button>
        </div>
      </div>
    </>
  );
};
