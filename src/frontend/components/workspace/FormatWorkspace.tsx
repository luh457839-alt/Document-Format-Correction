import React, { ChangeEvent, DragEvent, useEffect, useRef } from 'react';
import { getFormattingRunDownloadUrl } from '../../services/backendApiClient';
import { ConfigFieldMode, ConfigValue, FormattingConfig, HeadingConfig } from '../../types/apiContracts';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

const headingKeys = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

function modeLabel(mode: ConfigFieldMode): string {
  if (mode === 'default') return '默认';
  if (mode === 'custom') return '自定义';
  return '不修改';
}

function inputValue<T>(value: ConfigValue<T>): string {
  return value.value === undefined || value.value === null ? '' : String(value.value);
}

function textConfigValue(value: string): ConfigValue<string> {
  return value.trim() ? { mode: 'custom', value } : { mode: 'no_change' };
}

function numberConfigValue(value: string): ConfigValue<number> {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? { mode: 'custom', value: parsed } : { mode: 'no_change' };
}

function booleanConfigValue(value: string): ConfigValue<boolean> {
  if (value === 'default') return { mode: 'default', value: true };
  if (value === 'true') return { mode: 'custom', value: true };
  if (value === 'false') return { mode: 'custom', value: false };
  return { mode: 'no_change' };
}

const FieldShell: React.FC<{ label: string; mode?: ConfigFieldMode; children: React.ReactNode }> = ({
  label,
  mode,
  children,
}) => (
  <label className="block space-y-2">
    <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
      <span>{label}</span>
      {mode && <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">{modeLabel(mode)}</span>}
    </div>
    {children}
  </label>
);

const TextInput: React.FC<{
  label: string;
  value: ConfigValue<string>;
  onChange: (value: ConfigValue<string>) => void;
  disabled: boolean;
  placeholder?: string;
}> = ({ label, value, onChange, disabled, placeholder }) => (
  <FieldShell label={label} mode={value.mode}>
    <input
      type="text"
      value={inputValue(value)}
      disabled={disabled}
      onChange={(event) => onChange(textConfigValue(event.target.value))}
      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
      placeholder={placeholder || '不修改'}
    />
  </FieldShell>
);

const NumberInput: React.FC<{
  label: string;
  value: ConfigValue<number>;
  onChange: (value: ConfigValue<number>) => void;
  disabled: boolean;
  step?: number;
}> = ({ label, value, onChange, disabled, step = 1 }) => (
  <FieldShell label={label} mode={value.mode}>
    <input
      type="number"
      step={step}
      value={inputValue(value)}
      disabled={disabled}
      onChange={(event) => onChange(numberConfigValue(event.target.value))}
      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
      placeholder="不修改"
    />
  </FieldShell>
);

const SelectInput: React.FC<{
  label: string;
  value: ConfigValue<boolean>;
  onChange: (value: ConfigValue<boolean>) => void;
  disabled: boolean;
}> = ({ label, value, onChange, disabled }) => (
  <FieldShell label={label} mode={value.mode}>
    <select
      value={value.mode === 'default' ? 'default' : value.mode === 'no_change' ? 'no_change' : String(value.value)}
      disabled={disabled}
      onChange={(event) => onChange(booleanConfigValue(event.target.value))}
      className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
    >
      <option value="no_change">不修改</option>
      <option value="default">使用默认</option>
      <option value="true">加粗</option>
      <option value="false">不加粗</option>
    </select>
  </FieldShell>
);

const GlobalTypographyForm: React.FC<{
  config: FormattingConfig;
  disabled: boolean;
}> = ({ config, disabled }) => {
  const updateGlobalField = useWorkspaceStore((state) => state.updateGlobalField);
  const global = config.globalTypography;
  return (
    <details open className="rounded-2xl bg-slate-900 p-4">
      <summary className="cursor-pointer text-sm font-semibold text-white">全局排版</summary>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <TextInput label="字体" value={global.fontFamily} disabled={disabled} onChange={(value) => updateGlobalField('fontFamily', value)} placeholder="例如：仿宋" />
        <NumberInput label="字号 pt" value={global.fontSizePt} disabled={disabled} onChange={(value) => updateGlobalField('fontSizePt', value)} />
        <NumberInput label="行距" value={global.lineSpacing} disabled={disabled} step={0.1} onChange={(value) => updateGlobalField('lineSpacing', value)} />
        <NumberInput label="段前 pt" value={global.paragraphBeforePt} disabled={disabled} onChange={(value) => updateGlobalField('paragraphBeforePt', value)} />
        <NumberInput label="段后 pt" value={global.paragraphAfterPt} disabled={disabled} onChange={(value) => updateGlobalField('paragraphAfterPt', value)} />
      </div>
    </details>
  );
};

const HeadingForm: React.FC<{
  heading: keyof FormattingConfig['headings'];
  label: string;
  value: HeadingConfig;
  disabled: boolean;
}> = ({ heading, label, value, disabled }) => {
  const updateHeadingField = useWorkspaceStore((state) => state.updateHeadingField);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
      <div className="mb-3 text-sm font-medium text-slate-100">{label}</div>
      <div className="grid gap-3 md:grid-cols-2">
        <TextInput label="字体" value={value.fontFamily} disabled={disabled} onChange={(next) => updateHeadingField(heading, 'fontFamily', next)} />
        <NumberInput label="字号 pt" value={value.fontSizePt} disabled={disabled} onChange={(next) => updateHeadingField(heading, 'fontSizePt', next)} />
        <SelectInput label="加粗" value={value.bold} disabled={disabled} onChange={(next) => updateHeadingField(heading, 'bold', next)} />
        <TextInput label="编号" value={value.numbering} disabled={disabled} onChange={(next) => updateHeadingField(heading, 'numbering', next)} placeholder="例如：1.1" />
        <NumberInput label="段前 pt" value={value.paragraphBeforePt} disabled={disabled} onChange={(next) => updateHeadingField(heading, 'paragraphBeforePt', next)} />
        <NumberInput label="段后 pt" value={value.paragraphAfterPt} disabled={disabled} onChange={(next) => updateHeadingField(heading, 'paragraphAfterPt', next)} />
      </div>
    </div>
  );
};

const HeadingConfigPanel: React.FC<{ config: FormattingConfig; disabled: boolean }> = ({ config, disabled }) => (
  <details className="rounded-2xl bg-slate-900 p-4">
    <summary className="cursor-pointer text-sm font-semibold text-white">标题层级 H1-H6</summary>
    <div className="mt-4 space-y-3">
      {headingKeys.map((heading, index) => (
        <HeadingForm key={heading} heading={heading} label={`H${index + 1}`} value={config.headings[heading]} disabled={disabled} />
      ))}
    </div>
  </details>
);

const UploadArea: React.FC = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadDocument = useWorkspaceStore((state) => state.uploadDocument);
  const isUploading = useWorkspaceStore((state) => state.isUploading);

  const handleFile = (file: File | undefined) => {
    if (file && !isUploading) {
      void uploadDocument(file);
    }
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    handleFile(event.dataTransfer.files?.[0]);
  };

  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <input
        ref={fileInputRef}
        type="file"
        accept=".docx"
        className="hidden"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          handleFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        disabled={isUploading}
        className="flex min-h-80 w-full max-w-3xl flex-col items-center justify-center rounded-[2rem] border-2 border-dashed border-sky-600 bg-sky-950/30 p-10 text-center transition-colors hover:bg-sky-950/50 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-900"
      >
        <div className="text-5xl">⇧</div>
        <div className="mt-6 text-2xl font-semibold text-white">
          {isUploading ? '正在上传 DOCX...' : '点击或拖拽 DOCX 文件至此'}
        </div>
        <div className="mt-3 text-sm text-slate-400">上传后将进入格式配置工作台。</div>
      </button>
    </div>
  );
};

export const FormatWorkspace: React.FC = () => {
  const {
    document,
    config,
    templates,
    selectedTemplateId,
    commandText,
    customRequirement,
    job,
    isLoadingDefaults,
    isUploading,
    isRunning,
    error,
    initialize,
    replaceDocument,
    resetToDefault,
    clearConfig,
    setCommandText,
    setCustomRequirement,
    setSelectedTemplateId,
    startRun,
    resetTask,
    clearError,
  } = useWorkspaceStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const controlsDisabled = isRunning || job?.status === 'queued' || job?.status === 'running';
  const canStart = Boolean(document && config && !controlsDisabled);
  const downloadUrl = job?.downloadUrl || (job?.status === 'completed' ? getFormattingRunDownloadUrl(job.jobId) : '');

  useEffect(() => {
    void initialize();
  }, [initialize]);

  if (!document) {
    return (
      <main className="flex-1 overflow-y-auto bg-slate-100 text-slate-950">
        <div className="px-8 pt-8">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-sky-700">Format Workspace</p>
          <h1 className="mt-3 text-3xl font-bold">格式化工作台</h1>
          <p className="mt-2 text-sm text-slate-500">上传 DOCX 后，使用结构化 Prompt Builder 配置格式修改任务。</p>
        </div>
        <UploadArea />
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-y-auto bg-slate-100 pb-28 text-slate-950">
      <input
        ref={fileInputRef}
        type="file"
        accept=".docx"
        className="hidden"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void replaceDocument(file);
        }}
      />

      <div className="space-y-6 px-8 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-sky-700">Format Workspace</p>
            <h1 className="mt-3 text-3xl font-bold">格式化工作台</h1>
            <p className="mt-2 text-sm text-slate-500">左侧查看文档上下文，右侧配置格式修改请求。</p>
          </div>
          <button
            type="button"
            onClick={resetTask}
            className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
          >
            新建任务
          </button>
        </div>

        {error && (
          <div className="flex items-start justify-between gap-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{error}</span>
            <button type="button" onClick={clearError} className="font-semibold">关闭</button>
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
          <section className="space-y-4">
            <div className="rounded-3xl bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-400">File Info</div>
                  <div className="mt-2 break-all text-lg font-semibold text-slate-950">{document.fileName}</div>
                  <div className="mt-2 text-xs text-slate-500">{document.sizeBytes ?? 0} bytes</div>
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={controlsDisabled || isUploading}
                  className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:text-slate-400"
                >
                  替换文件
                </button>
              </div>
            </div>

            <div className="rounded-3xl bg-white p-5 shadow-sm">
              <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Format Health Report</div>
              <div className="mt-3 text-lg font-semibold text-slate-950">{document.analysis.health.summary}</div>
              <div className="mt-3 space-y-2">
                {document.analysis.health.issues.length > 0 ? (
                  document.analysis.health.issues.map((issue) => (
                    <div key={`${issue.code}-${issue.message}`} className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
                      {issue.message}
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-500">暂无格式问题摘要。</div>
                )}
              </div>
            </div>

            <div className="rounded-3xl bg-white p-5 shadow-sm">
              <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Document Outline Tree</div>
              <div className="mt-3 space-y-2">
                {document.analysis.outline.length > 0 ? (
                  document.analysis.outline.map((node) => (
                    <div key={node.id} className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-700">
                      H{node.level} · {node.title}
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-500">等待后端补充大纲分析。</div>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-3xl bg-slate-950 p-5 text-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Prompt Builder Panel</div>
                <h2 className="mt-2 text-xl font-semibold">格式配置</h2>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={resetToDefault} disabled={controlsDisabled || isLoadingDefaults} className="rounded-xl bg-slate-800 px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:text-slate-500">
                  恢复默认
                </button>
                <button type="button" onClick={clearConfig} disabled={controlsDisabled} className="rounded-xl bg-slate-800 px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:text-slate-500">
                  清空配置
                </button>
              </div>
            </div>

            <div className="mt-5 space-y-4">
              <input
                value={commandText}
                onChange={(event) => setCommandText(event.target.value)}
                disabled={controlsDisabled}
                className="w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
                placeholder="例如：将所有正文字体改为仿宋..."
              />

              {config && <GlobalTypographyForm config={config} disabled={controlsDisabled} />}
              {config && <HeadingConfigPanel config={config} disabled={controlsDisabled} />}

              <details open className="rounded-2xl bg-slate-900 p-4">
                <summary className="cursor-pointer text-sm font-semibold text-white">快速模板</summary>
                <select
                  value={selectedTemplateId}
                  onChange={(event) => setSelectedTemplateId(event.target.value)}
                  disabled={controlsDisabled}
                  className="mt-4 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
                >
                  <option value="">不使用模板</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>{template.name} · {template.version}</option>
                  ))}
                </select>
              </details>

              <label className="block space-y-2">
                <span className="text-sm font-semibold text-white">自定义需求</span>
                <textarea
                  value={customRequirement}
                  onChange={(event) => setCustomRequirement(event.target.value)}
                  disabled={controlsDisabled}
                  className="min-h-32 w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
                  placeholder="在此输入表单无法覆盖的复杂格式要求..."
                />
              </label>

              {job && (
                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold">任务状态：{job.status}</div>
                      <div className="mt-1 text-xs text-slate-400">{job.summary}</div>
                    </div>
                    {downloadUrl && job.status === 'completed' && (
                      <a href={downloadUrl} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-400">
                        下载完整文档
                      </a>
                    )}
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {job.steps.map((step) => (
                      <div key={step.id} className="rounded-xl bg-slate-950 px-3 py-2 text-xs text-slate-300">
                        <div className="font-semibold text-slate-100">{step.title}</div>
                        <div className="mt-1">{step.status}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 border-t border-slate-200 bg-white/95 px-8 py-4 shadow-2xl backdrop-blur">
        <div className="ml-auto flex max-w-5xl items-center justify-end gap-3">
          <div className="text-sm text-slate-500">
            {controlsDisabled ? '任务执行中，表单已冻结。' : '配置完成后开始执行修改。'}
          </div>
          {job?.status === 'completed' && downloadUrl ? (
            <a href={downloadUrl} className="rounded-2xl bg-emerald-500 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-400">
              下载完整文档
            </a>
          ) : (
            <button
              type="button"
              disabled={!canStart}
              onClick={() => void startRun()}
              className="rounded-2xl bg-sky-500 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isRunning ? '正在执行...' : '开始执行修改'}
            </button>
          )}
        </div>
      </div>
    </main>
  );
};
