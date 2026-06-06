import React, { useEffect, useState } from 'react';
import { fetchModelConfig, saveModelConfig } from '../../services/backendApiClient';
import { ModelConfigPayload } from '../../types/apiContracts';

const emptyConfig: ModelConfigPayload = {
  chat: {
    baseUrl: '',
    apiKey: '',
    model: '',
  },
  planner: {
    baseUrl: '',
    apiKey: '',
    model: '',
    runtimeMode: 'react_loop',
    stepTimeoutMs: 60000,
    maxTurns: 24,
    syncRequestTimeoutMs: 300000,
  },
  warnings: [],
};

function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseRequiredNumber(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const SettingsPage: React.FC = () => {
  const [config, setConfig] = useState<ModelConfigPayload>(emptyConfig);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadConfig = async () => {
    setIsLoading(true);
    setError(null);
    try {
      setConfig(await fetchModelConfig());
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '加载模型配置失败');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  const saveConfig = async () => {
    setIsSaving(true);
    setError(null);
    setMessage('');
    try {
      setConfig(await saveModelConfig(config));
      setMessage('配置已保存。');
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '保存模型配置失败');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <main className="flex-1 overflow-y-auto bg-slate-100 p-8 text-slate-950">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-sky-700">Settings</p>
            <h1 className="mt-3 text-3xl font-bold">全局设置</h1>
            <p className="mt-2 text-sm text-slate-500">配置后端 Agent 使用的模型服务参数。</p>
          </div>
          <button type="button" onClick={() => void loadConfig()} disabled={isLoading} className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400">
            重新读取
          </button>
        </div>

        {error && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {message && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>}
        {config.warnings && config.warnings.length > 0 && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {config.warnings.map((warning) => <div key={`${warning.code}-${warning.message}`}>{warning.message}</div>)}
          </div>
        )}

        <section className="rounded-3xl bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold">聊天模型</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="space-y-2 text-sm">
              <span className="text-slate-500">Base URL</span>
              <input value={config.chat.baseUrl} onChange={(event) => setConfig({ ...config, chat: { ...config.chat, baseUrl: event.target.value } })} className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-sky-500" />
            </label>
            <label className="space-y-2 text-sm">
              <span className="text-slate-500">Model</span>
              <input value={config.chat.model} onChange={(event) => setConfig({ ...config, chat: { ...config.chat, model: event.target.value } })} className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-sky-500" />
            </label>
            <label className="space-y-2 text-sm md:col-span-2">
              <span className="text-slate-500">API Key</span>
              <input type="password" value={config.chat.apiKey} onChange={(event) => setConfig({ ...config, chat: { ...config.chat, apiKey: event.target.value } })} className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-sky-500" />
            </label>
          </div>
        </section>

        <section className="rounded-3xl bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold">规划模型</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="space-y-2 text-sm">
              <span className="text-slate-500">Base URL</span>
              <input value={config.planner.baseUrl} onChange={(event) => setConfig({ ...config, planner: { ...config.planner, baseUrl: event.target.value } })} className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-sky-500" />
            </label>
            <label className="space-y-2 text-sm">
              <span className="text-slate-500">Model</span>
              <input value={config.planner.model} onChange={(event) => setConfig({ ...config, planner: { ...config.planner, model: event.target.value } })} className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-sky-500" />
            </label>
            <label className="space-y-2 text-sm md:col-span-2">
              <span className="text-slate-500">API Key</span>
              <input type="password" value={config.planner.apiKey} onChange={(event) => setConfig({ ...config, planner: { ...config.planner, apiKey: event.target.value } })} className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-sky-500" />
            </label>
            <label className="space-y-2 text-sm">
              <span className="text-slate-500">Runtime Mode</span>
              <select value={config.planner.runtimeMode || 'react_loop'} onChange={(event) => setConfig({ ...config, planner: { ...config.planner, runtimeMode: event.target.value as ModelConfigPayload['planner']['runtimeMode'] } })} className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-sky-500">
                <option value="react_loop">react_loop</option>
                <option value="plan_once">plan_once</option>
              </select>
            </label>
            <label className="space-y-2 text-sm">
              <span className="text-slate-500">Max Turns</span>
              <input type="number" min={0} value={config.planner.maxTurns ?? 24} onChange={(event) => setConfig({ ...config, planner: { ...config.planner, maxTurns: parseRequiredNumber(event.target.value, 24) } })} className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-sky-500" />
            </label>
            <label className="space-y-2 text-sm">
              <span className="text-slate-500">Step Timeout (ms)</span>
              <input type="number" min={0} value={config.planner.stepTimeoutMs ?? 60000} onChange={(event) => setConfig({ ...config, planner: { ...config.planner, stepTimeoutMs: parseRequiredNumber(event.target.value, 60000) } })} className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-sky-500" />
            </label>
            <label className="space-y-2 text-sm">
              <span className="text-slate-500">Request Timeout (ms)</span>
              <input type="number" min={0} value={config.planner.timeoutMs ?? ''} onChange={(event) => setConfig({ ...config, planner: { ...config.planner, timeoutMs: parseOptionalNumber(event.target.value) } })} className="w-full rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-sky-500" />
            </label>
          </div>
        </section>

        <div className="flex justify-end">
          <button type="button" onClick={() => void saveConfig()} disabled={isSaving || isLoading} className="rounded-2xl bg-sky-500 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-300">
            {isSaving ? '保存中...' : '保存设置'}
          </button>
        </div>
      </div>
    </main>
  );
};
