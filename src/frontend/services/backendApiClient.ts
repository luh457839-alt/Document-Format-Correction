import {
  ChatMessage,
  SessionSummary,
  SessionDetail,
  MessageJobSnapshot,
  ModelConfigPayload,
  TemplateMetaSummary,
  TemplateDocumentSummary,
  TemplateJobSnapshot,
  WorkspaceDocument,
  FormattingConfig,
  FormattingRequest,
  FormattingJobSnapshot,
  FormattingRunSummary,
} from '../types/apiContracts';

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      payload.error &&
      typeof payload.error === 'object' &&
      'message' in payload.error &&
      typeof payload.error.message === 'string'
        ? payload.error.message
        : `请求失败: ${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload as T;
}

export async function fetchHealth(): Promise<{ ok: boolean; baseUrl: string }> {
  const response = await fetch('/api/health');
  return parseJsonResponse(response);
}

export async function uploadWorkspaceDocument(file: File): Promise<WorkspaceDocument> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/workspace/documents', {
    method: 'POST',
    body: formData,
  });
  const result = await parseJsonResponse<{ document: WorkspaceDocument }>(response);
  return result.document;
}

export async function fetchWorkspaceDefaultConfig(): Promise<{
  config: FormattingConfig;
  templates: TemplateMetaSummary[];
}> {
  const response = await fetch('/api/workspace/default-config');
  const result = await parseJsonResponse<{
    config: FormattingConfig;
    templates?: TemplateMetaSummary[];
  }>(response);
  return {
    config: result.config,
    templates: Array.isArray(result.templates) ? result.templates : [],
  };
}

export async function startFormattingRun(requestPayload: FormattingRequest): Promise<{
  job: FormattingJobSnapshot;
}> {
  const response = await fetch('/api/workspace/format-runs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestPayload),
  });
  return parseJsonResponse<{ job: FormattingJobSnapshot }>(response);
}

export async function fetchFormattingRun(jobId: string): Promise<{ job: FormattingJobSnapshot }> {
  const response = await fetch(`/api/workspace/format-runs/${encodeURIComponent(jobId)}`);
  return parseJsonResponse<{ job: FormattingJobSnapshot }>(response);
}

export function getFormattingRunDownloadUrl(jobId: string): string {
  return `/api/workspace/format-runs/${encodeURIComponent(jobId)}/download`;
}

export async function fetchFormattingHistory(): Promise<FormattingRunSummary[]> {
  const response = await fetch('/api/workspace/history');
  const result = await parseJsonResponse<{ runs: FormattingRunSummary[] }>(response);
  return Array.isArray(result.runs) ? result.runs : [];
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  const response = await fetch('/api/sessions');
  const result = await parseJsonResponse<{ sessions: SessionSummary[] }>(response);
  return Array.isArray(result.sessions) ? result.sessions : [];
}

export async function createSession(sessionId?: string): Promise<SessionDetail> {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sessionId }),
  });
  const result = await parseJsonResponse<{ session: SessionDetail }>(response);
  return result.session;
}

export async function fetchSessionState(sessionId: string): Promise<SessionDetail> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  const result = await parseJsonResponse<{ session: SessionDetail }>(response);
  return result.session;
}

export async function updateSessionTitle(
  sessionId: string,
  title: string
): Promise<SessionDetail> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  });
  const result = await parseJsonResponse<{ session: SessionDetail }>(response);
  return result.session;
}

export async function deleteSession(sessionId: string): Promise<{ deletedSessionId: string }> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  return parseJsonResponse<{ deletedSessionId: string }>(response);
}

export async function submitTurn(
  sessionId: string,
  content: string
): Promise<SessionDetail> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  const result = await parseJsonResponse<{ session: SessionDetail }>(response);
  return result.session;
}

export async function submitTurnAsync(
  sessionId: string,
  content: string
): Promise<{ job: MessageJobSnapshot }> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages/async`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  return parseJsonResponse<{ job: MessageJobSnapshot }>(response);
}

export async function fetchMessageJob(
  sessionId: string,
  jobId: string
): Promise<{ job: MessageJobSnapshot; session?: SessionDetail | null }> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/message-jobs/${encodeURIComponent(jobId)}`
  );
  return parseJsonResponse<{ job: MessageJobSnapshot; session?: SessionDetail | null }>(response);
}

export async function attachDocument(
  sessionId: string,
  file: File
): Promise<SessionDetail> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attach-document`, {
    method: 'POST',
    body: formData,
  });
  const result = await parseJsonResponse<{ session: SessionDetail }>(response);
  return result.session;
}

export async function fetchModelConfig(): Promise<ModelConfigPayload> {
  const response = await fetch('/api/model-config');
  return parseJsonResponse<ModelConfigPayload>(response);
}

export async function saveModelConfig(config: ModelConfigPayload): Promise<ModelConfigPayload> {
  const response = await fetch('/api/model-config', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  });
  return parseJsonResponse<ModelConfigPayload>(response);
}

export async function fetchTemplateConfigs(): Promise<TemplateMetaSummary[]> {
  const response = await fetch('/api/templates/configs');
  const result = await parseJsonResponse<{
    templates?: TemplateMetaSummary[];
    configs?: Array<Partial<TemplateMetaSummary> & { fileName?: string; path: string }>;
  }>(response);
  if (Array.isArray(result.templates)) {
    return result.templates;
  }
  return Array.isArray(result.configs)
    ? result.configs.map((config) => ({
        id: config.id || config.fileName || config.path,
        name: config.name || config.fileName || config.path,
        version: config.version || 'unknown',
        description: config.description,
        tags: Array.isArray(config.tags) ? config.tags : [],
        path: config.path,
      }))
    : [];
}

export async function importTemplateDocument(file: File): Promise<TemplateDocumentSummary> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/templates/import-document', {
    method: 'POST',
    body: formData,
  });
  const result = await parseJsonResponse<{ document: TemplateDocumentSummary }>(response);
  return result.document;
}

export async function startTemplateRun(
  documentPath: string,
  templatePath: string
): Promise<{ job: TemplateJobSnapshot }> {
  const response = await fetch('/api/templates/runs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ documentPath, templatePath }),
  });
  return parseJsonResponse<{ job: TemplateJobSnapshot }>(response);
}

export async function fetchTemplateRun(
  jobId: string
): Promise<{ job: TemplateJobSnapshot; outputPath?: string }> {
  const response = await fetch(`/api/templates/runs/${encodeURIComponent(jobId)}`);
  return parseJsonResponse<{ job: TemplateJobSnapshot; outputPath?: string }>(response);
}

export async function openTemplateOutput(outputPath: string): Promise<{ ok: boolean }> {
  const response = await fetch('/api/templates/open-output', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ outputPath }),
  });
  return parseJsonResponse<{ ok: boolean }>(response);
}

export async function openOutput(outputPath: string): Promise<{ ok: boolean }> {
  const response = await fetch('/api/templates/open-output', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ outputPath }),
  });
  return parseJsonResponse<{ ok: boolean }>(response);
}

export function normalizeMessages(messages: ChatMessage[] | undefined): ChatMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.map((message, index) => ({
    messageId: message.messageId || `message-${index}`,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    attachments: Array.isArray(message.attachments) ? message.attachments : undefined,
  }));
}
