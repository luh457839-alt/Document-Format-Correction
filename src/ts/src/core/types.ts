export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "completed"
  | "failed"
  | "rolled_back";

export type OperationType =
  | "set_font"
  | "set_size"
  | "set_line_spacing"
  | "set_alignment"
  | "set_font_color"
  | "set_bold"
  | "set_italic"
  | "set_underline"
  | "set_strike"
  | "set_highlight_color"
  | "set_all_caps"
  | "merge_paragraph"
  | "split_paragraph";

export type PlannerCompatMode = "auto" | "strict";
export type PlannerRuntimeMode = "plan_once" | "react_loop";

export interface ChatModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
}

export interface PlannerModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  stepTimeoutMs?: number;
  taskTimeoutMs?: number | null;
  pythonToolTimeoutMs?: number;
  maxTurns?: number;
  syncRequestTimeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  useJsonSchema?: boolean;
  schemaStrict?: boolean;
  compatMode?: PlannerCompatMode;
  runtimeMode?: PlannerRuntimeMode;
}

export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface DocumentNode {
  id: string;
  text: string;
  style?: DocumentNodeStyle;
}

export type NodeSelectorScope = "body" | "heading" | "list_item" | "all_text" | "paragraph_ids";

export interface NodeSelector {
  scope: NodeSelectorScope;
  headingLevel?: number;
  paragraphIds?: string[];
}

export interface DocumentIR {
  id: string;
  version: string;
  nodes: DocumentNode[];
  metadata?: Record<string, unknown>;
}

export interface ExactLineSpacing {
  mode: "exact";
  pt: number;
}

export type LineSpacingValue = number | ExactLineSpacing;

export interface DocumentNodeStyle extends Record<string, unknown> {
  font_name?: string;
  font_size_pt?: number;
  line_spacing?: LineSpacingValue;
  font_color?: string;
  is_bold?: boolean;
  is_italic?: boolean;
  is_underline?: boolean;
  is_strike?: boolean;
  highlight_color?: string;
  is_all_caps?: boolean;
  paragraph_alignment?: string;
  operation?: OperationType;
}

export interface Operation {
  id: string;
  type: OperationType;
  targetNodeId?: string;
  targetNodeIds?: string[];
  targetSelector?: NodeSelector;
  sourceTargetSelector?: NodeSelector;
  payload: Record<string, unknown>;
}

export interface PlanStep {
  id: string;
  toolName: string;
  readOnly: boolean;
  timeoutMs?: number;
  retryLimit?: number;
  idempotencyKey: string;
  operation?: Operation;
}

export interface Plan {
  taskId: string;
  goal: string;
  steps: PlanStep[];
}

export interface AppError {
  code: string;
  message: string;
  retryable: boolean;
  cause?: unknown;
}

export interface ToolExecutionContext {
  taskId: string;
  stepId: string;
  dryRun: boolean;
}

export interface ToolExecutionInput {
  doc: DocumentIR;
  operation?: Operation;
  context: ToolExecutionContext;
}

export interface ToolExecutionOutput {
  doc: DocumentIR;
  summary: string;
  rollbackToken?: string;
  artifacts?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  readOnly: boolean;
  validate(input: ToolExecutionInput): Promise<void> | void;
  execute(input: ToolExecutionInput): Promise<ToolExecutionOutput>;
  rollback?(rollbackToken: string, doc: DocumentIR): Promise<DocumentIR>;
}

export interface ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool;
  list(): Tool[];
}

export interface Planner {
  createPlan(goal: string, doc: DocumentIR, options?: { timeoutMs?: number }): Promise<Plan>;
}

export interface ReActTurnInput {
  taskId: string;
  goal: string;
  turnIndex: number;
  doc: DocumentIR;
  history: ReActTraceItem[];
  sessionContext?: ConversationMessage[];
  requestTimeoutMs?: number;
}

export type ReActDecision =
  | {
      kind: "act";
      thought?: string;
      step: PlanStep;
    }
  | {
      kind: "finish";
      thought?: string;
      summary: string;
    };

export interface ReActTraceItem {
  turnIndex: number;
  thought?: string;
  action?: PlanStep;
  observation: string;
  status: TaskStatus | StepResult["status"];
}

export interface ReActPlanner {
  decideNext(input: ReActTurnInput): Promise<ReActDecision>;
}

export interface ReActTurnRecord {
  runId: string;
  taskId: string;
  turnIndex: number;
  thought?: string;
  action?: PlanStep;
  observation: string;
  status: TaskStatus | StepResult["status"];
  createdAt: number;
}

export interface ReActTraceQuery {
  taskId?: string;
  runId?: string;
  limit?: number;
  offset?: number;
}

export interface StepResult {
  stepId: string;
  status: "success" | "failed" | "skipped" | "waiting_user";
  durationMs: number;
  retries: number;
  summary?: string;
  error?: AppError;
  rollbackToken?: string;
}

export interface AppliedChange {
  stepId: string;
  operation?: Operation;
  summary: string;
  rollbackToken?: string;
}

export interface ChangeSet {
  taskId: string;
  changes: AppliedChange[];
  rolledBack: boolean;
}

export interface ExecutorOptions {
  dryRun?: boolean;
  maxConcurrentReadOnly?: number;
  defaultTimeoutMs?: number;
  budgetDeadlineMs?: number;
  defaultRetryLimit?: number;
  retryBackoffMs?: number;
  confirmStep?: (step: PlanStep) => Promise<ConfirmationDecision>;
  onExecutionEvent?: (event: ExecutionEvent) => Promise<void> | void;
}

export type ConfirmationDecision = "approved" | "rejected" | "pending";

export interface PendingConfirmation {
  step: PlanStep;
  reason: string;
  resumeMode: "single_step";
}

export interface ExecutionResult {
  status: TaskStatus;
  finalDoc: DocumentIR;
  changeSet: ChangeSet;
  steps: StepResult[];
  summary: string;
  pendingConfirmation?: PendingConfirmation;
  reactTrace?: ReActTraceItem[];
  turnCount?: number;
}

export type ExecutionEventType =
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "run_rolled_back"
  | "run_waiting_user"
  | "step_started"
  | "step_succeeded"
  | "step_failed"
  | "step_skipped"
  | "step_waiting_user";

export interface ExecutionEvent {
  type: ExecutionEventType;
  taskId: string;
  stepId?: string;
  status?: TaskStatus | StepResult["status"];
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface PersistentPendingTask {
  taskId: string;
  runId: string;
  pendingConfirmation: PendingConfirmation;
  docSnapshot: DocumentIR;
  updatedAt: number;
}

export interface AuditStoreConfig {
  dbPath: string;
  busyTimeoutMs?: number;
}

export interface TaskAuditStore {
  startRun(plan: Plan, initialDoc: DocumentIR): Promise<string>;
  appendEvent(runId: string, event: ExecutionEvent): Promise<void>;
  finalizeRun(runId: string, plan: Plan, result: ExecutionResult): Promise<void>;
  getPendingTask(taskId: string): Promise<PersistentPendingTask | null>;
  listReActTurns(query: ReActTraceQuery): Promise<ReActTurnRecord[]>;
  resolvePendingTask(taskId: string): Promise<void>;
}

export interface Executor {
  execute(plan: Plan, doc: DocumentIR, opts?: ExecutorOptions): Promise<ExecutionResult>;
  rollback(changeSet: ChangeSet, doc: DocumentIR): Promise<DocumentIR>;
}

export interface Validator {
  preValidate(plan: Plan, doc: DocumentIR): Promise<void>;
  postValidate(changeSet: ChangeSet, doc: DocumentIR): Promise<void>;
}

export interface RiskPolicy {
  requiresConfirmation(step: PlanStep): boolean;
}
