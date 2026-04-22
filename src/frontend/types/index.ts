export interface ChatSession {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  isDraft?: boolean;
  remoteSessionId?: string;
}

export interface FileAttachment {
  fileId: string;
  fileName: string;
  fileType: string;
  previewUrl?: string;
}

export interface AttachedDocument {
  path?: string;
  name?: string;
  [key: string]: unknown;
}

export interface PendingDocument {
  file: File;
  name: string;
}

export interface ChatMessage {
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: FileAttachment[];
  clientCreatedAt?: number;
  isTemporary?: boolean;
}

export interface FrontendSessionState {
  sessionId: string;
  title: string;
  messages: ChatMessage[];
  attachedDocument: AttachedDocument | null;
}

export type TurnProgressStepStatus = 'queued' | 'running' | 'completed' | 'failed';
export type TurnJobStatus = 'queued' | 'running' | 'waiting_user' | 'completed' | 'failed';

export interface TurnProgressStep {
  id: string;
  title: string;
  status: TurnProgressStepStatus;
  detail?: string;
  startedAt?: number;
  updatedAt?: number;
}

export interface TurnJobError {
  message: string;
  code?: string;
  retryable?: boolean;
}

export interface TurnJobSnapshot {
  jobId: string;
  sessionId: string;
  turnRunId?: string;
  status: TurnJobStatus;
  acceptedAt: number;
  updatedAt: number;
  summary: string;
  steps: TurnProgressStep[];
  error?: TurnJobError | null;
  remoteSessionId?: string;
  anchorMessageId?: string;
  isCollapsed?: boolean;
}

export interface PendingChatTurn {
  tempMessage: ChatMessage;
  job: TurnJobSnapshot;
}

export type ChatFeedItem =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'job'; key: string; job: TurnJobSnapshot };

export interface ModelConfigSection {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface PlannerConfigSection extends ModelConfigSection {
  runtimeMode?: 'plan_once' | 'react_loop' | null;
  timeoutMs?: number | null;
  stepTimeoutMs?: number;
  taskTimeoutMs?: number | null;
  pythonToolTimeoutMs?: number | null;
  maxTurns?: number;
  syncRequestTimeoutMs?: number;
}

export interface ModelConfigPayload {
  chat: ModelConfigSection;
  planner: PlannerConfigSection;
}

export interface UserSettings {
  apiBaseUrl: string;
  apiKey: string;
  selectedModel: string;
  plannerModel: string;
  plannerBaseUrl: string;
  plannerApiKey: string;
  plannerTimeoutMs: number | null;
  stepTimeoutMs: number;
  taskTimeoutMs: number | null;
  pythonToolTimeoutMs: number | null;
  maxTurns: number;
  syncRequestTimeoutMs: number;
  runtimeMode: 'plan_once' | 'react_loop';
}
