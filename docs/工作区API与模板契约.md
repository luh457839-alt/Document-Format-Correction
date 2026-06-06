# 工作区 API 与模板契约（Workspace API / Template v2.0）

## 1. 文档定位

本文档定义新版“文档格式修改 Agent”前端、Python 宿主 Web API、TypeScript runtime/Agent 桥接层、模板作者之间的正式外部契约。

当前决策：

- 新前端以 `docs/前端工作台设计方案.md` 中的格式化工作台为主入口。
- 新前端正式消费 Workspace API，不再把旧 chat/session API 作为主交互接口。
- 旧 `/api/sessions/*`、`/api/sessions/*/messages*` 保留为 legacy/internal compatibility，可供后端内部桥接 Agent 使用。
- Template 外部主契约继续沿用 `TemplateContract`，`schema_version = "2.0"`。
- 前端可见输出采用摘要型、可审计模型；不直接暴露完整内部 AST、patch history、原始 selector 分析或全量 prompt 中间态。

当前代码锚点：

- 新前端：`src/frontend/`
- 前端 API client：`src/frontend/services/backendApiClient.ts`
- 前端契约类型：`src/frontend/types/apiContracts.ts`
- 当前本地 Web API host：`archive/legacy/python-host/python/gui/web_api.py`
- runtime 输入 / 状态契约：`src/langgraph-ts/runtime/contracts.ts`
- runtime graph：`src/langgraph-ts/runtime/graph.ts`
- provider adapter 与强约束 tool schema：`src/langgraph-ts/model/provider-adapter.ts`
- 文档投影类型：`src/langgraph-ts/contracts/document-contracts.ts`
- Template v2.0 参考实现：`archive/legacy/ts-runtime/src/templates/template-contract.ts`

## 2. 可见性边界

前端可以稳定依赖以下信息：

- 文档上传结果、文件元信息、文档分析摘要。
- 格式健康报告、文档大纲、模板元数据。
- 用户可配置的格式字段、默认配置、no-op 配置语义。
- 异步任务状态、步骤、错误、告警、输出路径与下载入口。
- 任务历史摘要、完成时间、输出引用。
- 设置页所需模型配置字段。

前端不能直接依赖以下内部对象：

- 完整 `document_ast` / `DocumentAst`。
- 完整 patch plan、patch set、patch history。
- 原始 `SelectorTargetAnalysis`。
- 完整 `chat_projection` / `template_projection` 原文。
- 全量内部 prompt、classifier 中间态、模型原始诊断。
- 仅在 CLI stderr 中出现的临时诊断格式。

## 3. 统一外部类型

字段名以 JSON 返回为准。前端 TypeScript 类型必须与本节保持一致。

### 3.1 通用类型

```ts
export type JobStatus = "queued" | "running" | "waiting_user" | "completed" | "failed";
export type StepStatus = "queued" | "running" | "completed" | "failed";

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
```

### 3.2 Workspace 文档与分析模型

```ts
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
  status: "unknown" | "good" | "warning" | "problem";
  summary: string;
  issues: FormatHealthIssue[];
}

export interface FormatHealthIssue {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  scope?: string;
}

export interface DocumentOutlineNode {
  id: string;
  title: string;
  level: number;
  children?: DocumentOutlineNode[];
}
```

说明：

- `POST /api/workspace/documents` 上传后必须返回稳定 `analysis` shape。
- 若真实格式分析尚未实现，可以返回 `health.status = "unknown"`、空 `issues`、空 `outline`，但字段必须存在。

### 3.3 Prompt Builder 与格式配置模型

```ts
export type ConfigFieldMode = "default" | "custom" | "no_change";

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
  headings: Record<"h1" | "h2" | "h3" | "h4" | "h5" | "h6", HeadingConfig>;
}

export interface FormattingRequest {
  documentId: string;
  config: FormattingConfig;
  commandText?: string;
  customRequirement?: string;
  templateId?: string;
}
```

`ConfigFieldMode` 语义固定如下：

- `default`：应用后端提供的系统推荐默认值。
- `custom`：应用用户显式指定的 `value`。
- `no_change`：明确不修改该字段。

按钮行为约束：

- “恢复默认”必须清空 `commandText` 与 `customRequirement`，并将表单恢复到后端 `GET /api/workspace/default-config` 返回的默认配置。
- “清空配置”必须清空 `commandText` 与 `customRequirement`，并将所有可配置字段设为 `mode: "no_change"`。

### 3.4 Workspace 任务模型

```ts
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
```

`FormattingJobSnapshot.steps` 的推荐固定步骤 ID：

- `validate_request`
- `assemble_prompt`
- `run_agent`
- `validate_output`
- `finalize`

完成态约束：

- `status = "completed"` 时，后端必须已经确认输出 DOCX 存在、是文件、非空。
- 完成态应返回 `outputPath` 与 `downloadUrl`。
- 未完成或失败任务不得返回可下载成功结果。

### 3.5 模板模型

```ts
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
  confidenceState: "high" | "medium" | "low" | "unknown";
}

export interface ValidationSummary {
  passed: boolean;
  issueCount: number;
  warningCount: number;
  issues?: DiagnosticSummary[];
}

export interface TemplateJobSnapshot {
  jobId: string;
  sessionId: "templates";
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
  debug?: {
    refinementSummary?: Array<{
      paragraphId: string;
      firstPass?: Record<string, unknown>;
      secondPass?: Record<string, unknown>;
      outcome: string;
    }>;
  };
}
```

说明：

- `GET /api/templates/configs` 的正式返回必须提供 `TemplateMetaSummary`。
- 若模板 JSON 缺少 `template_meta`，后端必须用文件名生成稳定 fallback：`id/name = filename stem`，`version = "unknown"`。
- `debug` 仅保留兼容窗口，不应继续扩成全量内部对象出口。

### 3.6 设置模型

```ts
export interface ModelConfigSection {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface PlannerConfigSection extends ModelConfigSection {
  runtimeMode?: "plan_once" | "react_loop" | null;
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
```

设置页继续使用 `GET /api/model-config` 与 `PUT /api/model-config`。

### 3.7 Legacy 会话与消息模型

旧 chat/session API 保留为兼容模型，不是新前端工作台主接口。若旧组件或内部桥接仍使用这些类型，字段语义保持稳定。

```ts
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
  role: "user" | "assistant" | "system";
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
```

## 4. Web API 契约

### 4.1 通用约束

- Web API 使用同源 `/api`。
- JSON API 统一使用 `application/json; charset=utf-8`。
- 成功响应采用资源 envelope，例如 `{ document }`、`{ job }`、`{ runs }`、`{ templates }`。
- 失败响应统一返回 `{ error: { message, ... } }`。
- 异步创建任务接口返回 `202 Accepted`。
- 轮询接口在 `queued`、`running`、`waiting_user`、`completed`、`failed` 下都必须返回稳定 shape。
- `waiting_user` 仅用于后端明确需要前端补充输入的场景，不能与 `failed` 混用。

`status` 语义固定如下：

- `queued`：任务已受理，尚未进入实际执行。
- `running`：任务已开始执行，允许继续轮询。
- `waiting_user`：任务暂停，等待用户补充信息或确认。
- `completed`：任务完成，结果稳定。
- `failed`：任务终止，返回错误与诊断摘要。

### 4.2 基础与设置接口

#### `GET /api/health`

响应：

```json
{
  "ok": true,
  "baseUrl": "http://127.0.0.1:5173",
  "configReady": true,
  "warnings": []
}
```

#### `GET /api/model-config`

响应：`ModelConfigPayload`。

#### `PUT /api/model-config`

请求体：`ModelConfigPayload`。

响应：保存后的 `ModelConfigPayload`。

### 4.3 Workspace 接口

#### `POST /api/workspace/documents`

上传 DOCX 并返回文档摘要。

- `Content-Type`：`multipart/form-data`
- 表单字段名：`file`
- 仅接受 `.docx`

响应：

```json
{
  "document": {
    "documentId": "doc-1234abcd",
    "fileName": "input.docx",
    "uploadedPath": "D:/.../input.docx",
    "sizeBytes": 12345,
    "uploadedAt": 1710000000000,
    "analysis": {
      "health": {
        "status": "unknown",
        "summary": "已上传，等待格式分析",
        "issues": []
      },
      "outline": [],
      "metadata": {}
    }
  }
}
```

#### `GET /api/workspace/default-config`

返回后端推荐默认格式配置与可选模板列表。

响应：

```json
{
  "config": { "...": "FormattingConfig" },
  "templates": [{ "...": "TemplateMetaSummary" }]
}
```

#### `POST /api/workspace/format-runs`

创建格式修改任务。

请求体：`FormattingRequest`。

响应：

```json
{
  "job": { "...": "FormattingJobSnapshot" }
}
```

状态码：`202 Accepted`。

说明：

- 前端提交结构化配置、快捷指令与自定义需求；不提交 chat transcript。
- 后端可以在内部把请求转换成 Agent 指令，但不得把旧 chat/session 结构暴露给新前端。

#### `GET /api/workspace/format-runs/{jobId}`

轮询格式修改任务。

响应：

```json
{
  "job": { "...": "FormattingJobSnapshot" }
}
```

#### `GET /api/workspace/format-runs/{jobId}/download`

下载完成后的 DOCX。

约束：

- `jobId` 必须存在。
- job 必须为 `completed`。
- 输出 DOCX 必须存在、是文件、非空。
- 不满足条件时返回结构化错误。

成功响应：二进制 DOCX，`Content-Type = application/vnd.openxmlformats-officedocument.wordprocessingml.document`。

#### `GET /api/workspace/history`

返回格式修改历史。

响应：

```json
{
  "runs": [{ "...": "FormattingRunSummary" }]
}
```

### 4.4 模板接口

#### `GET /api/templates/configs`

正式响应：

```json
{
  "templates": [
    {
      "id": "thesis-v1",
      "name": "论文模板",
      "version": "1.0.0",
      "description": "本科论文模板",
      "tags": ["thesis", "cn"],
      "path": "D:/.../templates/论文模板.json"
    }
  ]
}
```

兼容说明：

- 旧前端过渡期曾消费 `{ configs: [{ fileName, path }] }`。
- 新前端必须消费正式 `{ templates: TemplateMetaSummary[] }`。

#### `POST /api/templates/import-document`

- `Content-Type`：`multipart/form-data`
- 表单字段名：`file`（仅接受 `.docx`）
- 响应：`{ document: TemplateDocumentSummary }`

#### `POST /api/templates/runs`

请求体：

```json
{
  "documentPath": "D:/.../input.docx",
  "templatePath": "D:/.../templates/sample.json"
}
```

响应：`{ job: TemplateJobSnapshot }`。

任务步骤 ID 固定为：

- `load_inputs`
- `run_template_pipeline`
- `validate_result`
- `materialize_output`

#### `GET /api/templates/runs/{jobId}`

响应：

```json
{
  "job": { "...": "TemplateJobSnapshot" },
  "outputPath": "D:/.../output.docx"
}
```

说明：

- `outputPath` 可以与 `job.outputPath` 同时存在，供兼容层使用。
- 长期目标以内嵌 `job.outputPath` 为主。

#### `POST /api/templates/open-output`

请求体：

```json
{ "outputPath": "D:/.../output.docx" }
```

响应：

```json
{ "ok": true }
```

### 4.5 Legacy 会话接口

以下接口保留为 legacy/internal compatibility，不是新前端工作台主接口：

- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/{sessionId}`
- `PATCH /api/sessions/{sessionId}`
- `DELETE /api/sessions/{sessionId}`
- `POST /api/sessions/{sessionId}/attach-document`
- `POST /api/sessions/{sessionId}/messages`
- `POST /api/sessions/{sessionId}/messages/async`
- `GET /api/sessions/{sessionId}/message-jobs/{jobId}`

新前端不得依赖这些接口完成主工作台流程。

## 5. Template v2.0 外部合同

Template 外部主契约继续使用 `TemplateContract`，`schema_version = "2.0"`。

当前对外锁定字段为：

- `template_meta`
- `semantic_blocks`
- `derived_semantics`
- `layout_rules`
- `patch_blocks`
- `classification_contract`
- `validation_policy`
- `style_reference`

字段责任边界：

- `patch_blocks`：执行主契约，是模板真正的写入来源。
- `style_reference`：说明性与审阅辅助元数据，不是执行真源。
- `classification_contract`：模板行为约束，属于模板输入，不属于任务结果对象。
- `validation_policy`：模板校验策略，属于模板输入，不属于运行态诊断快照。

模板 JSON 只承载作者输入契约，不承载运行态输出。运行态分类命中、冲突段、低置信摘要、refinement summary、执行结果、runtime warnings、artifacts 与审计摘要不能写回模板 JSON。

## 6. 脏文档语义回退的外部摘要

内部算法可以继续使用 `semantic_heading`、`title_like_paragraphs`、`body_style_baseline` 等机制，但前端只消费摘要对象。

正式摘要类型为 `SemanticClassificationSummary`、`SemanticAlignmentSummary` 与 `DiagnosticSummary`。

这层摘要必须满足：

- 能支撑前端做冲突提示与人工复核。
- 能支撑审计输出 `appliedFields` 与 baseline 来源。
- 不泄漏完整内部分类 prompt 或完整结构观察对象。

## 7. 契约测试目标

接口定义阶段锁定以下测试目标：

1. `POST /api/workspace/documents` 接受 `.docx`、拒绝非 `.docx`，并返回稳定 `WorkspaceDocument` shape。
2. `GET /api/workspace/default-config` 返回包含 `ConfigFieldMode` 的默认配置。
3. `POST /api/workspace/format-runs` 返回 `202` 与稳定 `FormattingJobSnapshot`。
4. `GET /api/workspace/format-runs/{jobId}` 在各状态下返回稳定 shape。
5. `GET /api/workspace/format-runs/{jobId}/download` 只允许完成且输出可读非空的任务下载。
6. `GET /api/workspace/history` 返回稳定 `FormattingRunSummary[]`。
7. `GET /api/templates/configs` 返回的模板元数据与 JSON 模板中的 `template_meta` 一致；缺省时有稳定 fallback。
8. 新前端不读取内部 TS 对象，只依赖正式 API 类型即可完成渲染。
9. “恢复默认”与“清空配置”分别产生 `default` 与 `no_change` 语义。
10. `TemplateContract v2.0` 示例模板与接口规格保持一致，不出现“文档支持但校验器不支持”的分叉。

## 8. 当前实现与目标契约的对齐状态

已落地或保留：

- 当前本地 Web API host 仍由 `archive/legacy/python-host/python/gui/web_api.py` 承载。
- 模板任务步骤 ID 已固定为 `load_inputs`、`run_template_pipeline`、`validate_result`、`materialize_output`。
- `TemplateJobSnapshot` 当前已返回 `jobId`、`status`、`summary`、`steps`、`error`、`warnings`、`outputPath`。
- 设置接口 `GET /api/model-config` 与 `PUT /api/model-config` 已存在，可由新设置页复用。
- legacy chat/session API 已存在，但仅作为兼容/内部桥接层。

本轮需要补齐：

- Workspace API：上传、默认配置、format run 创建/轮询/下载/history。
- `ConfigFieldMode` 与 `ConfigValue<T>` 在前端类型和请求体中的落地。
- 新前端工作台 UI、模板页、历史页、设置页。
- 模板列表正式元数据返回：`id`、`name`、`version`、`description`、`tags`、`path`。
- `docs/工作区API与模板契约.md`、`src/frontend/types/apiContracts.ts`、`src/frontend/services/backendApiClient.ts` 的字段和 endpoint 一致性。

实现可以分步补齐真实格式健康检查和文档大纲提取，但 API shape 从本文件起固定。
