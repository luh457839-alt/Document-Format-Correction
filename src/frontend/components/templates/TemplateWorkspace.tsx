import React, { ChangeEvent, useEffect, useRef, useState } from 'react';
import { ProgressJobCard } from '../common/ProgressJobCard';
import {
  fetchTemplateConfigs,
  fetchTemplateRun,
  importTemplateDocument,
  openTemplateOutput,
  startTemplateRun,
} from '../../services/api';
import { TemplateConfigOption, TemplateDocument, TemplateJobSnapshot } from '../../types';

function isActiveStatus(status: TemplateJobSnapshot['status'] | undefined): boolean {
  return status === 'queued' || status === 'running';
}

export const TemplateWorkspace: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimerRef = useRef<number | null>(null);
  const [configs, setConfigs] = useState<TemplateConfigOption[]>([]);
  const [selectedTemplatePath, setSelectedTemplatePath] = useState('');
  const [document, setDocument] = useState<TemplateDocument | null>(null);
  const [job, setJob] = useState<TemplateJobSnapshot | null>(null);
  const [outputPath, setOutputPath] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isJobActive = isActiveStatus(job?.status);
  const canStart = Boolean(document?.uploadedPath && selectedTemplatePath && !isJobActive && !isUploading);
  const controlsDisabled = isUploading || isJobActive;

  useEffect(() => {
    let isMounted = true;
    fetchTemplateConfigs()
      .then((nextConfigs) => {
        if (!isMounted) return;
        setConfigs(nextConfigs);
        setSelectedTemplatePath((current) => current || nextConfigs[0]?.path || '');
      })
      .catch((exc: unknown) => {
        if (isMounted) {
          setError(exc instanceof Error ? exc.message : '加载模板配置失败');
        }
      });
    return () => {
      isMounted = false;
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!job || !isActiveStatus(job.status)) {
      return;
    }

    pollTimerRef.current = window.setTimeout(() => {
      void fetchTemplateRun(job.jobId)
        .then((result) => {
          setJob((current) => ({ ...result.job, isCollapsed: current?.isCollapsed ?? false }));
          setOutputPath(result.outputPath || result.job.outputPath || '');
        })
        .catch((exc: unknown) => {
          setJob((current) =>
            current
              ? {
                  ...current,
                  status: 'failed',
                  updatedAt: Date.now(),
                  summary: '模板任务轮询失败',
                  error: { message: exc instanceof Error ? exc.message : '模板任务轮询失败' },
                }
              : current
          );
        });
    }, 700);
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
      }
    };
  }, [job]);

  const handlePickDocument = () => {
    if (controlsDisabled) return;
    fileInputRef.current?.click();
  };

  const handleDocumentChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError(null);
    setIsUploading(true);
    try {
      const uploaded = await importTemplateDocument(file);
      setDocument(uploaded);
      setJob(null);
      setOutputPath('');
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'DOCX 上传失败');
    } finally {
      setIsUploading(false);
    }
  };

  const handleStart = async () => {
    if (!document?.uploadedPath || !selectedTemplatePath || !canStart) return;

    setError(null);
    setOutputPath('');
    try {
      const result = await startTemplateRun(document.uploadedPath, selectedTemplatePath);
      setJob({ ...result.job, isCollapsed: false });
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '启动模板任务失败');
    }
  };

  const handleOpenOutput = async () => {
    if (!outputPath || controlsDisabled) return;
    setError(null);
    try {
      await openTemplateOutput(outputPath);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : '打开输出位置失败');
    }
  };

  return (
    <main className="flex-1 overflow-y-auto bg-gray-900 px-6 py-8">
      <div className="mx-auto flex min-h-full max-w-6xl flex-col items-center justify-center">
        <div className="w-full rounded-3xl border border-gray-800 bg-gray-950/70 p-8 shadow-2xl shadow-black/30">
          <div className="mb-8 text-center">
            <p className="text-xs uppercase tracking-[0.35em] text-sky-300/70">Fixed Template Workflow</p>
            <h1 className="mt-3 text-2xl font-semibold text-white">固定模板修改</h1>
            <p className="mt-2 text-sm text-gray-400">导入 DOCX，选择根目录 templates 中的 JSON 配置，然后启动占位任务。</p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".docx"
            className="hidden"
            onChange={(event) => void handleDocumentChange(event)}
          />

          <div className="grid items-center gap-6 md:grid-cols-[1fr_220px_1fr]">
            <button
              type="button"
              onClick={handlePickDocument}
              disabled={controlsDisabled}
              className="min-h-48 rounded-2xl border border-dashed border-sky-700 bg-sky-950/20 px-6 py-8 text-left transition-colors hover:bg-sky-950/40 disabled:cursor-not-allowed disabled:border-gray-700 disabled:bg-gray-800 disabled:text-gray-500"
            >
              <div className="text-sm text-sky-200">导入 DOCX</div>
              <div className="mt-4 text-2xl font-semibold text-white">
                {isUploading ? '正在上传...' : document?.fileName || '点击选择文件'}
              </div>
              <div className="mt-3 text-xs text-gray-400">再次点击可替换待处理文档。</div>
            </button>

            <div className="flex flex-col items-center gap-4">
              <select
                value={selectedTemplatePath}
                onChange={(event) => setSelectedTemplatePath(event.target.value)}
                disabled={controlsDisabled}
                className="w-full rounded-xl border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none transition-colors hover:border-sky-600 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500"
                aria-label="选择 JSON 模板"
              >
                <option value="">选择 JSON 模板</option>
                {configs.map((config) => (
                  <option key={config.path} value={config.path}>
                    {config.fileName}
                  </option>
                ))}
              </select>

              <div className="text-6xl font-light leading-none text-sky-300">→</div>

              <button
                type="button"
                onClick={() => void handleStart()}
                disabled={!canStart}
                className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500"
              >
                开始模板修改
              </button>
            </div>

            <button
              type="button"
              onClick={() => void handleOpenOutput()}
              disabled={!outputPath || controlsDisabled}
              className="min-h-48 rounded-2xl border border-emerald-800 bg-emerald-950/20 px-6 py-8 text-left transition-colors hover:bg-emerald-950/40 disabled:cursor-not-allowed disabled:border-gray-700 disabled:bg-gray-800 disabled:text-gray-500"
            >
              <div className="text-sm text-emerald-200">输出位置</div>
              <div className="mt-4 break-all text-2xl font-semibold text-white">
                {outputPath ? '打开输出文件夹' : '等待任务完成'}
              </div>
              <div className="mt-3 break-all text-xs text-gray-400">{outputPath || '完成后显示输出路径。'}</div>
            </button>
          </div>

          {error && (
            <div className="mt-6 rounded-xl border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}

          {job?.warnings && job.warnings.length > 0 && (
            <div className="mt-6 rounded-xl border border-amber-700 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
              {job.warnings.map((warning) => (
                <div key={`${warning.code}-${warning.message}`}>{warning.message}</div>
              ))}
            </div>
          )}

          <div className="mt-8 flex justify-center">
            {job && (
              <ProgressJobCard
                job={job}
                titlePrefix="模板任务"
                onToggleCollapse={() =>
                  setJob((current) =>
                    current ? { ...current, isCollapsed: !current.isCollapsed } : current
                  )
                }
              />
            )}
          </div>
        </div>
      </div>
    </main>
  );
};
