import {
  ChatMessage,
  ChatSession,
  FrontendSessionState,
  ModelConfigPayload,
  TemplateConfigOption,
  TemplateDocument,
  TemplateJobSnapshot,
  TurnJobSnapshot,
} from '../types';

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

export async function fetchSessions(): Promise<ChatSession[]> {
  const response = await fetch('/api/sessions');
  const result = await parseJsonResponse<{ sessions: ChatSession[] }>(response);
  return Array.isArray(result.sessions) ? result.sessions : [];
}

export async function createSession(sessionId?: string): Promise<FrontendSessionState> {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sessionId }),
  });
  const result = await parseJsonResponse<{ session: FrontendSessionState }>(response);
  return result.session;
}

export async function fetchSessionState(sessionId: string): Promise<FrontendSessionState> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  const result = await parseJsonResponse<{ session: FrontendSessionState }>(response);
  return result.session;
}

export async function updateSessionTitle(
  sessionId: string,
  title: string
): Promise<FrontendSessionState> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  });
  const result = await parseJsonResponse<{ session: FrontendSessionState }>(response);
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
): Promise<FrontendSessionState> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  const result = await parseJsonResponse<{ session: FrontendSessionState }>(response);
  return result.session;
}

export async function submitTurnAsync(
  sessionId: string,
  content: string
): Promise<{ job: TurnJobSnapshot }> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages/async`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  return parseJsonResponse<{ job: TurnJobSnapshot }>(response);
}

export async function fetchMessageJob(
  sessionId: string,
  jobId: string
): Promise<{ job: TurnJobSnapshot; session?: FrontendSessionState | null }> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/message-jobs/${encodeURIComponent(jobId)}`
  );
  return parseJsonResponse<{ job: TurnJobSnapshot; session?: FrontendSessionState | null }>(response);
}

export async function attachDocument(
  sessionId: string,
  file: File
): Promise<FrontendSessionState> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attach-document`, {
    method: 'POST',
    body: formData,
  });
  const result = await parseJsonResponse<{ session: FrontendSessionState }>(response);
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

export async function fetchTemplateConfigs(): Promise<TemplateConfigOption[]> {
  const response = await fetch('/api/templates/configs');
  const result = await parseJsonResponse<{ configs: TemplateConfigOption[] }>(response);
  return Array.isArray(result.configs) ? result.configs : [];
}

export async function importTemplateDocument(file: File): Promise<TemplateDocument> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/templates/import-document', {
    method: 'POST',
    body: formData,
  });
  const result = await parseJsonResponse<{ document: TemplateDocument }>(response);
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
