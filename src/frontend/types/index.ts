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
}

export interface FrontendSessionState {
  sessionId: string;
  title: string;
  messages: ChatMessage[];
  attachedDocument: AttachedDocument | null;
}

export interface ModelConfigSection {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface PlannerConfigSection extends ModelConfigSection {
  runtimeMode?: 'plan_once' | 'react_loop' | null;
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
  runtimeMode: 'plan_once' | 'react_loop';
}
