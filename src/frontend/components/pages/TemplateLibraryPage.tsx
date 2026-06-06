import React, { useEffect, useState } from 'react';
import { fetchTemplateConfigs } from '../../services/backendApiClient';
import { TemplateMetaSummary } from '../../types/apiContracts';

export const TemplateLibraryPage: React.FC = () => {
  const [templates, setTemplates] = useState<TemplateMetaSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    fetchTemplateConfigs()
      .then(setTemplates)
      .catch((exc) => setError(exc instanceof Error ? exc.message : '加载模板库失败'))
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <main className="flex-1 overflow-y-auto bg-slate-100 p-8 text-slate-950">
      <div className="mx-auto max-w-6xl space-y-6">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-sky-700">Template Library</p>
          <h1 className="mt-3 text-3xl font-bold">模板库</h1>
          <p className="mt-2 text-sm text-slate-500">展示可用于工作台快速套用的正式模板元数据。</p>
        </div>

        {error && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {isLoading && <div className="rounded-2xl bg-white px-4 py-3 text-sm text-slate-500">正在加载模板...</div>}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <article key={template.id} className="rounded-3xl bg-white p-5 shadow-sm">
              <div className="text-xs uppercase tracking-[0.2em] text-slate-400">{template.version}</div>
              <h2 className="mt-2 text-lg font-semibold text-slate-950">{template.name}</h2>
              <p className="mt-2 min-h-10 text-sm text-slate-500">{template.description || '暂无模板说明。'}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {(template.tags || []).map((tag) => (
                  <span key={tag} className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">{tag}</span>
                ))}
              </div>
              <div className="mt-4 break-all rounded-2xl bg-slate-100 px-3 py-2 text-xs text-slate-500">{template.path}</div>
            </article>
          ))}
        </div>

        {!isLoading && templates.length === 0 && (
          <div className="rounded-3xl bg-white p-8 text-center text-sm text-slate-500">暂无模板，请在 templates 目录放入 JSON 模板。</div>
        )}
      </div>
    </main>
  );
};
