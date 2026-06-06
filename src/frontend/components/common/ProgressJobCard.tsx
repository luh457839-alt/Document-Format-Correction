import React from 'react';
import { TemplateJobRefinementPass, TemplateJobSnapshot, FrontendJobSnapshot } from '../../types/apiContracts';
import { openOutput } from '../../services/backendApiClient';

interface ProgressJobCardProps {
  job: FrontendJobSnapshot | TemplateJobSnapshot;
  titlePrefix?: string;
  onToggleCollapse?: () => void;
}

function statusLabel(status: FrontendJobSnapshot['status']): string {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '处理中';
  if (status === 'waiting_user') return '等待确认';
  if (status === 'completed') return '已完成';
  return '失败';
}

function statusTone(status: FrontendJobSnapshot['status']): string {
  if (status === 'completed') return 'border-emerald-700 bg-emerald-950/30 text-emerald-200';
  if (status === 'waiting_user') return 'border-amber-700 bg-amber-950/30 text-amber-200';
  if (status === 'failed') return 'border-red-700 bg-red-950/30 text-red-200';
  return 'border-sky-700 bg-sky-950/30 text-sky-200';
}

function stepStatusLabel(status: string): string {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '进行中';
  if (status === 'completed') return '已完成';
  return '失败';
}

const semanticLabelMap: Record<string, string> = {
  cover_image: '图片段落',
};

function formatSemanticLabel(semanticKey: string): string {
  return semanticLabelMap[semanticKey] ?? semanticKey;
}

function formatSemanticKeys(pass: TemplateJobRefinementPass | undefined): string {
  if (!pass) return '';
  if (Array.isArray(pass.semanticKeys) && pass.semanticKeys.length > 0) {
    return pass.semanticKeys.map(formatSemanticLabel).join(', ');
  }
  if (typeof pass.semanticKey === 'string' && pass.semanticKey.trim()) {
    return formatSemanticLabel(pass.semanticKey.trim());
  }
  return '';
}

function formatPassDetail(label: string, pass: TemplateJobRefinementPass | undefined): string {
  if (!pass) {
    return `${label}: -`;
  }
  const parts: string[] = [];
  const semanticKeys = formatSemanticKeys(pass);
  parts.push(semanticKeys || '-');
  if (Array.isArray(pass.candidateSemanticKeys) && pass.candidateSemanticKeys.length > 0) {
    parts.push(`candidates: ${pass.candidateSemanticKeys.map(formatSemanticLabel).join(', ')}`);
  }
  if (typeof pass.confidence === 'number') {
    parts.push(`confidence: ${pass.confidence.toFixed(2)}`);
  }
  if (typeof pass.reason === 'string' && pass.reason.trim()) {
    parts.push(`reason: ${pass.reason.trim()}`);
  }
  if (typeof pass.source === 'string' && pass.source.trim()) {
    parts.push(`source: ${pass.source.trim()}`);
  }
  return `${label}: ${parts.join(' | ')}`;
}

function formatRefinementOutcome(outcome: string): string {
  if (outcome === 'rejected_conflict') return '二次判定后仍冲突';
  if (outcome === 'rejected_invalid') return '二次判定返回非法语义';
  if (outcome === 'rejected_low_confidence') return '二次判定置信度仍不足';
  if (outcome === 'rejected_unmatched') return '二次判定仍未归类';
  return outcome;
}

function getRefinementSummary(job: FrontendJobSnapshot | TemplateJobSnapshot) {
  if (!('debug' in job)) {
    return [];
  }
  const debug = job.debug;
  if (!debug || !Array.isArray(debug.refinementSummary)) {
    return [];
  }
  return debug.refinementSummary.filter(
    (item) => item && typeof item.paragraphId === 'string' && item.paragraphId.trim()
  );
}

function getOutputPath(job: FrontendJobSnapshot | TemplateJobSnapshot): string | undefined {
  return 'outputPath' in job ? (job as TemplateJobSnapshot).outputPath : undefined;
}

export const ProgressJobCard: React.FC<ProgressJobCardProps> = ({
  job,
  titlePrefix = 'TS Agent',
  onToggleCollapse,
}) => {
  const refinementSummary = job.status === 'failed' ? getRefinementSummary(job) : [];

  return (
    <div className={`max-w-3xl rounded-lg border rounded-bl-none px-4 py-3 text-sm ${statusTone(job.status)}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">
            {titlePrefix} {statusLabel(job.status)}
          </div>
          <div className="mt-1 text-xs opacity-80">{job.summary || '正在处理当前请求'}</div>
        </div>
        {onToggleCollapse && (
          <button
            type="button"
            className="text-xs opacity-80 hover:opacity-100 transition-opacity"
            onClick={onToggleCollapse}
          >
            {job.isCollapsed ? '展开' : '折叠'}
          </button>
        )}
      </div>

      {!job.isCollapsed && job.steps.length > 0 && (
        <div className="mt-3 space-y-2">
          {job.steps.map((step) => (
            <div key={step.id} className="rounded-md border border-white/10 bg-black/10 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span>{step.title}</span>
                <span className="text-xs opacity-80">{stepStatusLabel(step.status)}</span>
              </div>
              {step.detail && <div className="mt-1 text-xs opacity-75 whitespace-pre-wrap">{step.detail}</div>}
            </div>
          ))}
        </div>
      )}

      {!job.isCollapsed && refinementSummary.length > 0 && (
        <div className="mt-3 rounded-md border border-white/10 bg-black/10 px-3 py-3">
          <div className="text-xs font-medium uppercase tracking-[0.2em] opacity-80">诊断摘要</div>
          <div className="mt-2 space-y-2">
            {refinementSummary.map((item) => (
              <div key={item.paragraphId} className="rounded-md border border-white/10 bg-white/5 px-3 py-2">
                <div className="font-medium">段落 {item.paragraphId}</div>
                <div className="mt-1 text-xs opacity-80">{formatPassDetail('first pass', item.firstPass)}</div>
                <div className="mt-1 text-xs opacity-80">{formatPassDetail('second pass', item.secondPass)}</div>
                <div className="mt-1 text-xs opacity-90">outcome: {formatRefinementOutcome(item.outcome)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {job.error?.message && (
        <div className="mt-3 text-xs whitespace-pre-wrap opacity-90">{job.error.message}</div>
      )}

      {job.status === 'completed' && getOutputPath(job) && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs opacity-75 truncate flex-1">
            输出文件：{getOutputPath(job)}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-emerald-600 px-2 py-1 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-800/40"
            onClick={() => {
              const path = getOutputPath(job);
              if (path) void openOutput(path);
            }}
          >
            打开文件
          </button>
        </div>
      )}
    </div>
  );
};
