import React, { useEffect } from 'react';
import { getFormattingRunDownloadUrl } from '../../services/backendApiClient';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

function statusText(status: string): string {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '处理中';
  if (status === 'completed') return '已完成';
  if (status === 'waiting_user') return '等待输入';
  return '失败';
}

export const HistoryPage: React.FC = () => {
  const { history, refreshHistory, error, clearError } = useWorkspaceStore();

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  return (
    <main className="flex-1 overflow-y-auto bg-slate-100 p-8 text-slate-950">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-sky-700">History</p>
            <h1 className="mt-3 text-3xl font-bold">历史记录</h1>
            <p className="mt-2 text-sm text-slate-500">查看本次本地服务生命周期内创建的格式修改任务。</p>
          </div>
          <button type="button" onClick={() => void refreshHistory()} className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50">
            刷新
          </button>
        </div>

        {error && (
          <div className="flex items-start justify-between gap-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{error}</span>
            <button type="button" onClick={clearError} className="font-semibold">关闭</button>
          </div>
        )}

        <div className="space-y-3">
          {history.map((run) => (
            <article key={run.jobId} className="flex flex-col gap-4 rounded-3xl bg-white p-5 shadow-sm md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="break-all text-lg font-semibold text-slate-950">{run.fileName}</h2>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{statusText(run.status)}</span>
                </div>
                <p className="mt-2 text-sm text-slate-500">{run.summary}</p>
                <div className="mt-2 text-xs text-slate-400">{new Date(run.updatedAt).toLocaleString()}</div>
              </div>
              {run.status === 'completed' && (
                <a href={run.downloadUrl || getFormattingRunDownloadUrl(run.jobId)} className="shrink-0 rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-400">
                  下载文档
                </a>
              )}
            </article>
          ))}
        </div>

        {history.length === 0 && (
          <div className="rounded-3xl bg-white p-8 text-center text-sm text-slate-500">暂无历史记录。</div>
        )}
      </div>
    </main>
  );
};
