// ============================================================
// 后端契约类型 — 对应 docs/工作区API与模板契约.md
// ============================================================

// --- 通用类型 ---

export type JobStatus = 'queued' | 'running' | 'waiting_user' | 'completed' | 'failed';
export type StepStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ProgressStep {
  id: string;
  title: string;
  status: StepStatus;
  detail?: string;
  startedAt?: number;
  updatedAt?: number;
}

export interface Warning {
  code: string;
  scope: string;
  message: string;
  paragraphIds?: string[];
  diagnostics?: Record<string, unknown>;
}

export interface DiagnosticSummary {
  errorCode?: string;
  message: string;
  retryable?: boolean;
  paragraphIds?: string[];
  semanticKey?: string;
  reason?: string;
}

export interface ArtifactRef {
  kind: string;
  label: string;
  path?: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
}

export interface StandardError {
  code?: string;
  message: string;
  stage?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface ApiErrorBody {
  error: StandardError & {
    jobId?: string;
    turnRunId?: string;
    outputPath?: string;
    status?: JobStatus;
  };
}

export interface ProjectionIntent {
  focus_regex_probe?: string;
  chat_text_budget?: number;
  template_text_budget?: number;
  template_batch_budget?: number;
  chat_neighbor_window?: number;
  template_local_context_window?: number;
}

// --- Workspace 文档、配置与任务模型 ---

export interface WorkspaceDocument {
  documentId: string;
  fileName: string;
  uploadedPath: string;
  sizeBytes?: number;
  uploadedAt: number;
  analysis: DocumentAnalysisSummary;
}

export interface DocumentAnalysisSummary {
  health: FormatHealthReport;
  outline: DocumentOutlineNode[];
  metadata?: {
    paragraphCount?: number;
    tableCount?: number;
    imageCount?: number;
  };
}

export interface FormatHealthReport {
  status: 'unknown' | 'good' | 'warning' | 'problem';
  summary: string;
  issues: FormatHealthIssue[];
}

export interface FormatHealthIssue {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  scope?: string;
}

export interface DocumentOutlineNode {
  id: string;
  title: string;
  level: number;
  children?: DocumentOutlineNode[];
}

export type ConfigFieldMode = 'default' | 'custom' | 'no_change';

export interface ConfigValue<T> {
  mode: ConfigFieldMode;
  value?: T;
}

export interface GlobalTypographyConfig {
  fontFamily: ConfigValue<string>;
  fontSizePt: ConfigValue<number>;
  lineSpacing: ConfigValue<number>;
  paragraphBeforePt: ConfigValue<number>;
  paragraphAfterPt: ConfigValue<number>;
}

export interface HeadingConfig {
  fontFamily: ConfigValue<string>;
  fontSizePt: ConfigValue<number>;
  bold: ConfigValue<boolean>;
  numbering: ConfigValue<string>;
  paragraphBeforePt: ConfigValue<number>;
  paragraphAfterPt: ConfigValue<number>;
}

export interface FormattingConfig {
  globalTypography: GlobalTypographyConfig;
  headings: Record<'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', HeadingConfig>;
}

export interface FormattingRequest {
  documentId: string;
  config: FormattingConfig;
  commandText?: string;
  customRequirement?: string;
  templateId?: string;
}

export interface FormattingJobSnapshot {
  jobId: string;
  status: JobStatus;
  acceptedAt: number;
  updatedAt: number;
  summary: string;
  steps: ProgressStep[];
  error?: StandardError | null;
  warnings?: Warning[];
  document?: WorkspaceDocument;
  outputPath?: string;
  downloadUrl?: string;
}

export interface FormattingRunSummary {
  jobId: string;
  fileName: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  summary: string;
  outputPath?: string;
  downloadUrl?: string;
}

// --- 会话与消息模型（legacy/internal compatibility） ---

export interface SessionSummary {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface AttachedDocumentSummary {
  path?: string;
  name?: string;
}

export interface FileAttachment {
  fileId: string;
  fileName: string;
  fileType: string;
  previewUrl?: string;
}

export interface ChatMessage {
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: FileAttachment[];
  clientCreatedAt?: number;
}

export interface SessionDetail {
  sessionId: string;
  title: string;
  messages: ChatMessage[];
  attachedDocument: AttachedDocumentSummary | null;
}

export interface MessageJobSnapshot {
  jobId: string;
  sessionId: string;
  turnRunId?: string;
  status: JobStatus;
  acceptedAt: number;
  updatedAt: number;
  summary: string;
  steps: ProgressStep[];
  error?: StandardError | null;
  warnings?: Warning[];
  outputPath?: string;
}

// --- 模板相关模型 ---

export interface TemplateMetaSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  tags?: string[];
  path: string;
}

export interface TemplateDocumentSummary {
  fileName: string;
  uploadedPath: string;
}

export interface TemplateDocumentMeta {
  fileName?: string;
  uploadedPath?: string;
  paragraphCount?: number;
  tableCount?: number;
  imageCount?: number;
}

export interface SemanticClassificationSummary {
  matchedSemanticKeys: string[];
  unmatchedParagraphIds: string[];
  conflictParagraphIds: string[];
  overallConfidence?: number;
}

export interface SemanticAlignmentSummary {
  targetParagraphIds: string[];
  baselineSourceParagraphIds: string[];
  appliedFields: string[];
  confidenceState: 'high' | 'medium' | 'low' | 'unknown';
}

export interface ValidationSummary {
  passed: boolean;
  issueCount: number;
  warningCount: number;
  issues?: DiagnosticSummary[];
}

export interface TemplateJobRefinementPass {
  semanticKeys?: string[];
  semanticKey?: string;
  candidateSemanticKeys?: string[];
  confidence?: number;
  reason?: string;
  source?: string;
}

export interface TemplateJobRefinementSummaryItem {
  paragraphId: string;
  firstPass?: TemplateJobRefinementPass;
  secondPass?: TemplateJobRefinementPass;
  outcome: string;
}

export interface TemplateJobSnapshot {
  jobId: string;
  sessionId: 'templates';
  status: JobStatus;
  acceptedAt: number;
  updatedAt: number;
  summary: string;
  steps: ProgressStep[];
  error?: StandardError | null;
  warnings?: Warning[];
  outputPath?: string;
  templateMeta?: TemplateMetaSummary;
  documentMeta?: TemplateDocumentMeta;
  classificationSummary?: SemanticClassificationSummary;
  validationSummary?: ValidationSummary;
  alignmentSummary?: SemanticAlignmentSummary;
  diagnostics?: DiagnosticSummary[];
  artifacts?: ArtifactRef[];
  isCollapsed?: boolean;
  debug?: {
    refinementSummary?: TemplateJobRefinementSummaryItem[];
  };
}

// --- 模型配置 ---

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
  warnings?: Warning[];
}

// ============================================================
// 前端本地扩展类型 — 不由后端 API 返回
// ============================================================

export interface FrontendSession extends SessionSummary {
  isDraft?: boolean;
  remoteSessionId?: string;
}

export interface FrontendChatMessage extends ChatMessage {
  isTemporary?: boolean;
}

export interface FrontendJobSnapshot extends MessageJobSnapshot {
  remoteSessionId?: string;
  anchorMessageId?: string;
  isCollapsed?: boolean;
}

export interface PendingDocument {
  file: File;
  name: string;
}

export type ChatFeedItem =
  | { kind: 'message'; key: string; message: FrontendChatMessage }
  | { kind: 'job'; key: string; job: FrontendJobSnapshot };

export interface PendingChatTurn {
  tempMessage: FrontendChatMessage;
  job: FrontendJobSnapshot;
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

// ============================================================
// 向后兼容别名 — @deprecated，后续逐步迁移
// ============================================================

/** @deprecated 使用 FrontendSession */
export type ChatSession = FrontendSession;

/** @deprecated 使用 FrontendJobSnapshot */
export type TurnJobSnapshot = FrontendJobSnapshot;

/** @deprecated 使用 ProgressStep */
export type TurnProgressStep = ProgressStep;

/** @deprecated 使用 JobStatus */
export type TurnJobStatus = JobStatus;

/** @deprecated 使用 StepStatus */
export type TurnProgressStepStatus = StepStatus;

/** @deprecated 使用 SessionDetail */
export type FrontendSessionState = SessionDetail;

/** @deprecated 使用 AttachedDocumentSummary */
export type AttachedDocument = AttachedDocumentSummary;

/** @deprecated 使用 StandardError */
export type MessageJobError = StandardError;

/** @deprecated 使用 StandardError */
export type TurnJobError = StandardError;

/** @deprecated 使用 Warning */
export type ModelConfigWarning = Warning;

/** @deprecated 使用 TemplateDocumentSummary */
export type TemplateDocument = TemplateDocumentSummary;

/** @deprecated 使用 TemplateMetaSummary */
export type TemplateConfigOption = TemplateMetaSummary;

/** @deprecated 使用 TemplateJobSnapshot 的 debug 字段 */
export type TemplateJobDebug = TemplateJobSnapshot['debug'];

/** @deprecated 使用 ProgressStep */
export type TemplateProgressStep = ProgressStep;
