# 文档格式修正 Agent LangGraph 重构方案（校准重写版）

## 1. 文档目的与事实基线

本文档不是在原大纲上做措辞微调，而是在核对当前仓库真实实现后，对重构方案做一次校准重写。目标有两个：

- 给 LangGraph 重构提供一份与当前代码现状对齐的正式方案。
- 先消除方案失真，再讨论如何迁移，避免后续实现阶段基于错误前提继续放大偏差。

本轮校准后，以下事实已经确认：

1. 当前系统仍是 Python 宿主 + TypeScript Runtime 的双栈架构，真实 DOCX 物化链路没有完全收敛到单一运行时。
2. 旧版 TypeScript Runtime 中确实沉淀了可继承的核心文档算法资产，但这些资产的接口形状和调用位置并不能原样平移到 LangGraph。
3. 当前共享写入层已经形成一条相对稳定的「目标解析 -> Patch 编译 -> 执行 -> 物化」链路，这是 LangGraph 重构时必须保留的领域主干。
4. 模板链路仍存在已知的写回损坏风险，因此新方案不能把模板模式视为已经与聊天执行链路完全同等成熟。

## 2. 与当前代码对齐后的核心结论

本节用于锁定方案边界。后续实现必须以这些结论为准。

### 2.1 旧资产不是 Graph Node 清单，而是领域能力清单

旧版实现中的 `selector-expander.ts`、`idempotency.ts`、`default-validator.ts`、`template-classifier.ts`、`docx-observation-schema.ts` 等文件，提供的是领域能力，不是可以直接搬进 LangGraph 的节点边界。

当前仓库中的旧资产已经按 legacy 结构归档，后续利用方式默认应是“读旧代码后按新架构重写”，而不是让新主链直接调用这些旧文件。

LangGraph 中应遵守以下总原则：

- 图节点负责控制流、状态流转和分支路由。
- Tool 负责领域副作用和文档突变。
- 深度校验、目标展开、幂等判定、Patch 编译等能力，应作为 Tool 内部责任链的一部分，而不是为了复用旧代码硬拆出多个中间节点。

### 2.2 完整 AST 是唯一真相，压缩视图只是面向消费者的投影

当前方案中最容易失真的点，是把「差异化压缩」误写成底层解析行为。校准后必须明确：

- `document_ast` 必须始终保存完整结构和关系。
- 面向 LLM 的输入不是 AST 本体，而是由序列化层按消费者需求生成的投影。
- Chat 分支和 Template 分支可以使用不同的投影策略，但不能共享一个被破坏过上下文的「压缩 AST」。

### 2.3 幂等必须与 Checkpointer 同生命周期

如果 LangGraph 重构引入 Checkpointer 做断点恢复、回放和审计，就不能继续把写操作幂等建立在进程内 `Set<string>` 上。

新的幂等模型必须满足：

- 幂等键存在于 `AgentState` 中，而不是只存在于 Node.js 进程内存。
- 每一次写操作在执行前检查状态中的历史幂等键。
- 每一次写操作在成功后，把新幂等键写回状态，并由 Checkpointer 持久化。
- 服务重启、恢复执行、时间回溯后，幂等视图仍然一致。

### 2.4 写回节点必须承担 Relationship 调和责任

旧版观测层已经建模了 package metadata 和 relationship graph，但原重构大纲只强调了 `word/document.xml` 的写回与 Schema 校验，遗漏了 `.rels` 一致性。

校准后必须明确：

- `Materialize` 不是单文件 XML 写回器，而是「文档包调和器」。
- 只要文档 AST 中涉及图片、超链接、页眉页脚、样式、编号等跨部件引用，写回阶段就必须进行关系调和。
- 如果某类跨 part 迁移暂不支持，必须在 Tool 层显式拒绝，而不能在物化阶段悄悄忽略。

## 3. 现有实现核对结果

本节用于把方案与当前仓库真实实现对齐，避免后续设计再次漂移。

### 3.1 已核对的旧资产与真实含义

#### 资产 A：选区展开

- 当前 `src/ts/src/runtime/selector-expander.ts` 的核心接口是 `expandPlanSelectors(plan, doc)`。
- 它直接依赖旧版 `Plan / PlanStep / Operation` 结构，并通过 `bindWriteIntentToOperations` 把 selector 展开成具体操作。
- 因此，它不能作为独立的 LangGraph 节点存在于 `Reasoning -> Action` 之间，否则会把 LangChain 的 `tool_calls` 世界和旧 `PlanStep` 世界强行耦合。

结论：

- 保留其领域能力。
- 放弃其原有的图拓扑定位。
- 新架构中将其下沉为 Tool 内部的目标解析前置链。

#### 资产 B：幂等与 Patch Parity

- 当前 `src/ts/src/executor/idempotency.ts` 仍是 `InMemoryIdempotencyStore`。
- 旧执行器通过它跳过重复写步骤，这种机制只对单进程连续运行有效。
- `docx-patch-parity.spec.ts` 提供的是「聊天写操作与模板写操作编译结果一致」的等价性保障，这部分仍然非常有价值。

结论：

- Patch parity 测试思想保留。
- 内存式幂等存储废弃。
- 幂等键迁入 `AgentState`，与 Checkpointer 绑定。

#### 资产 C：默认校验器

- 当前 `src/ts/src/validator/default-validator.ts` 不只是参数格式校验。
- 它已经做了三类关键工作：
  - 目标节点真实性检查。
  - 语义空载荷检查。
  - `compileOperationToPatchSet` 预编译校验。

结论：

- Zod 只能替代浅层类型校验。
- 深层上下文校验必须保留，并放在 Tool 内部执行。

#### 资产 D：观测压缩与正则透镜

- 当前仓库已经存在 observation schema、结构索引和写入目标分析能力。
- 这说明「压缩」应该围绕观测序列化层演进，而不是反过来污染底层 AST。

结论：

- 压缩能力保留。
- 压缩时机后移到 projection / serialization 层。

#### 资产 E：模板语义分类

- 当前 `template-classifier.ts` 明确依赖 `text`、`heading_level`、`bucket_type`、`is_image_dominant` 以及局部上下文。
- 它不是只看单段纯文本的标签器，而是依赖文档邻域信息的结构语义分类器。

结论：

- 模板分类必须读取完整结构上下文。
- 不能先对底层 AST 做激进清洗，再把残缺结果交给分类器。

### 3.2 对原大纲 5 个纰漏的校准结论

1. 「资产 A 与 LangGraph 拓扑不兼容」结论成立。
2. 「资产 B 与 Checkpointer 生命周期冲突」结论成立。
3. 「资产 C 不能被 Zod 全量替代」结论成立。
4. 「资产 D 与资产 E 存在顺序饥饿」结论成立，但准确表述应为“压缩层与分类层的输入契约冲突”，不是“模板分类不能压缩”。
5. 「写回机制遗漏 Relationship 同步」结论成立，但应补充说明：问题不是旧系统完全没有关系建模，而是新方案没有把关系调和纳入输出责任域。

## 4. 重构目标与非目标

### 4.1 重构目标

1. 收敛控制流：用 LangGraph 统一聊天、模板、澄清三类主链路。
2. 收敛状态：以 `AgentState` 作为唯一状态总线，承载消息、AST、投影、诊断、幂等和输出引用。
3. 收敛副作用：所有文档修改统一经由 Tool 责任链进入共享写入层。
4. 收敛写回：建立 AST 感知、关系感知、可回滚的文档包物化流程。
5. 保留旧资产的领域价值，同时丢弃其不再适配新架构的接口形状和运行假设。

### 4.2 非目标

本方案暂不把以下内容纳入第一阶段实现承诺：

- 一次性完全删除所有 Python 代码。
- 在第一版中支持所有跨 part 的复杂对象迁移。
- 把所有历史 CLI、前端、模板导入流程同步重写完毕。
- 以「先求图完整」为理由引入过度抽象的节点拆分。

## 5. 新架构原则

### 5.1 分层原则

新的 LangGraph 架构分为四层：

1. 接入层：接收前端请求、文档路径、模板载荷和恢复参数。
2. Graph 控制层：负责路由、消息循环、状态汇总、恢复和结束判定。
3. Tool 执行层：负责参数浅校验、目标解析、深校验、Patch 编译、AST 突变和反馈。
4. 文档基建层：负责 DOCX 解析、结构索引、关系图、包级物化与调和。

### 5.2 状态原则

`AgentState` 只承载共享事实，不承载可从其他字段推导出的冗余副本。

推荐状态结构如下：

```ts
import type { BaseMessage } from "@langchain/core/messages";

export interface AgentState {
  messages: BaseMessage[];

  mode?: "chat" | "template" | "clarify";
  document_path?: string;
  output_path?: string;

  document_ast?: DocumentAst;
  document_package?: DocumentPackageModel;

  chat_projection?: ChatDocumentProjection;
  template_projection?: TemplateDocumentProjection;

  template_config?: TemplateConfig;
  semantic_tags?: Record<string, string>;

  executed_patch_keys: string[];
  diagnostics: DiagnosticEvent[];
  artifact_refs: ArtifactRef[];
}
```

字段约束如下：

- `messages`、`executed_patch_keys`、`diagnostics`、`artifact_refs` 使用 reducer 追加。
- `document_ast`、`chat_projection`、`template_projection`、`semantic_tags` 使用覆盖式更新。
- `document_ast` 是唯一可被 Tool 突变的文档真相。
- 投影字段禁止反向写回 AST。

### 5.3 Tool 原则

所有写类 Tool 必须遵守统一责任链：

1. Zod 浅校验。
2. selector / target 解析。
3. AST 上下文深校验。
4. Patch 预编译。
5. 幂等校验。
6. AST 突变。
7. 结果反馈与状态追加。

禁止出现以下设计：

- 在 Graph 节点之间插入只为改写 `tool_calls` 的中间节点。
- 先让 Tool 执行，再靠外围节点补做幂等。
- 只做 schema 校验，不做 AST 真实性预检。

## 6. 图结构设计

### 6.1 总体拓扑

新的图结构定义如下：

`START -> Intent_Router_Node -> Document_Load_And_Parse_Node -> Projection_Builder_Node -> 条件分支 -> Materialize_And_Reconcile_Node -> END`

其中条件分支分为三条主路径：

- Chat 路径：`Reasoning_Node <-> ToolNode`
- Template 路径：`Template_Classifier_Node -> Template_Engine_Node -> ToolNode`
- Clarify 路径：`Direct_Response_Node`

### 6.2 核心节点职责

#### 1. Intent_Router_Node

职责：

- 判断当前任务属于 `chat`、`template` 还是 `clarify`。
- 生成 projection 构建所需的轻量焦点提示，例如正则探针、模板分类模式、上下文优先级。

输出：

- `mode`
- 可选 `focus_regex_probe`
- 可选模板执行意图摘要

注意：

- 该节点只负责意图和路由，不生成具体写操作。

#### 2. Document_Load_And_Parse_Node

职责：

- 加载 DOCX 包。
- 解析完整 XML AST。
- 构建 package model、relationship graph、结构索引和运行时锚点。

输出：

- `document_ast`
- `document_package`

约束：

- 该节点不做破坏性压缩。
- 该节点生成的结构必须足以支持 Tool 执行和模板分类。

#### 3. Projection_Builder_Node

职责：

- 在不破坏 AST 的前提下，生成不同消费者所需的文档投影。

输出：

- `chat_projection`
- `template_projection`

策略：

- Chat 投影可以基于焦点探针做差异化压缩。
- Template 投影必须保留标题层级、段落顺序、局部邻域、图像占比和语义分类所需字段。

#### 4. Reasoning_Node

职责：

- 读取 `messages` 和 `chat_projection`。
- 调用绑定了 Tool 的模型。
- 产出 `AIMessage`，其中可能包含 `tool_calls` 或最终文本回复。

约束：

- 不直接修改 AST。
- 不直接改写已经生成的 `tool_calls`。

#### 5. ToolNode

职责：

- 调用项目自定义 Tool 包装层，而不是把 LangChain 原生 Tool 调用视为黑盒。
- 把 Tool 执行结果回写到 `messages`、`document_ast`、`executed_patch_keys` 和 `diagnostics`。

约束：

- Tool 内部负责目标展开、深校验、Patch 编译和幂等。
- 失败时优先返回结构化 `ToolMessage`，供 ReAct 自纠。

#### 6. Template_Classifier_Node

职责：

- 读取 `template_projection` 和模板规则定义。
- 为候选段落生成语义标签映射。

输出：

- `semantic_tags`
- 可选分类诊断

约束：

- 不执行写操作。
- 不对 AST 做结构修改。

#### 7. Template_Engine_Node

职责：

- 根据模板规则和 `semantic_tags` 生成确定性的 Tool 调用序列。

输出：

- 标准 Tool 调用消息或等价中间命令

约束：

- 该节点不自行实现 AST 修改逻辑。
- 该节点生成的调用必须复用与 Chat 路径同一套 Tool 责任链。

#### 8. Materialize_And_Reconcile_Node

职责：

- 清理运行时锚点。
- 做 XML 结构预检。
- 做 Relationship 调和。
- 打包输出新的 DOCX。

输出：

- `output_path`
- 物化诊断和输出工件引用

约束：

- 该节点是包级输出节点，不是单独的 `document.xml` 写文件动作。

### 6.3 条件边

图中的关键条件边如下：

1. `route_by_mode`
   - `chat` -> `Reasoning_Node`
   - `template` -> `Template_Classifier_Node`
   - `clarify` -> `Direct_Response_Node`

2. `react_continue_or_finish`
   - 最新消息含 `tool_calls` -> `ToolNode`
   - 最新消息为终态答复 -> `Materialize_And_Reconcile_Node`

3. `template_continue_or_finish`
   - 模板规则仍有待执行动作 -> `ToolNode`
   - 模板动作全部结束 -> `Materialize_And_Reconcile_Node`

## 7. Tool 接口与执行责任链

### 7.1 Tool 输入契约

LangChain Tool 的输入形状不再复用旧 `PlanStep`。推荐统一定义为：

```ts
export type WriteTargetSpec =
  | { kind: "selector"; selector: NodeSelector }
  | {
      kind: "semantic_selector";
      semantic: "semantic_heading" | "title_like_paragraphs" | "body_like_paragraphs";
    }
  | { kind: "node_ids"; node_ids: string[] }
  | { kind: "patch_targets"; patch_target_ids: string[]; patch_part_paths?: string[] };

export interface WriteToolInput {
  request_id: string;
  operation: OperationType;
  target: WriteTargetSpec;
  payload: Record<string, unknown>;
  idempotency_key?: string;
}
```

设计原则：

- Tool 要兼容模糊选择器输入。
- Tool 要兼容语义目标输入，但语义目标只是一类内部算法契约，不直接改变共享写入管线的出口形状。
- Tool 要兼容已经解析好的精确节点输入。
- Tool 要允许模板引擎直接传 patch target，避免重复做高层推断。

与脏文档语义回退相关的内部接口草案如下：

```ts
export interface SemanticParagraphScore {
  paragraph_id: string;
  title_score: number;
  body_score?: number;
  matched_signals: string[];
  confidence: "high" | "medium" | "low";
}

export interface BodyStyleBaseline {
  source_paragraph_ids: string[];
  fields: Partial<{
    font_name: string;
    font_size_pt: number;
    is_bold: boolean;
    is_italic: boolean;
    paragraph_alignment: string;
    line_spacing: number | { mode: "exact"; pt: number };
  }>;
}

export interface SemanticStyleAlignmentPlan {
  target_paragraph_ids: string[];
  baseline: BodyStyleBaseline;
  applied_fields: string[];
}
```

约束：

- 这些接口是算法级内部契约，不要求直接暴露给前端。
- 无论输入是否来自 `semantic_selector`，最终都必须回落到普通写操作，进入共享 `patch` 管线。

### 7.2 Tool 内部责任链

#### 阶段 1：浅层类型校验

使用 Zod 绑定 Tool schema，负责：

- 必填字段检查
- 基本类型和枚举值检查
- 空字符串、非法数值、布尔值等基础形状校验

注意：

- 这一步不能替代文档上下文校验。

#### 阶段 2：目标解析

复用旧共享写入层的目标分析思路：

- selector 输入先通过 `resolveSelectorTargetsWithPipeline` 类能力展开。
- `semantic_selector` 输入先经过候选识别与置信度分层，再回落到标准目标分析输出。
- 对 paragraph 级 selector，需要同步得到：
  - 目标 node ids
  - patch target ids
  - 关联 part paths
  - 不可写段落与跳过原因

这一步是资产 A 的新落点。

#### 阶段 3：深度上下文校验

复用旧 `DefaultValidator.preValidate` 的核心思想，形成 Tool 内部深校验模块，至少包含：

- 目标节点是否真实存在。
- 目标节点是否可写。
- 语义目标是否有足够置信度与清晰边界。
- 载荷是否语义为空。
- 操作是否适用于当前目标类型。
- 操作是否可被编译为有效 Patch。

失败策略：

- Chat 路径返回结构化 `ToolMessage`，例如 `targetNodeId 'p_999' not found in AST`。
- Template 路径记录诊断并按规则跳过或终止当前规则块。

#### 阶段 4：Patch 预编译

通过 `compileOperationToPatchSet` 等价能力完成：

- 可执行性确认
- patch target 集合生成
- 受影响 part path 集合生成
- 语义映射类请求的字段级差异对齐结果固化

这一步是深校验的一部分，也是后续 Materialize 调和的输入前提。

#### 阶段 5：幂等判定

幂等键规则如下：

- 优先使用调用侧传入的 `idempotency_key`。
- 若未传入，则由 Tool 根据 `request_id + normalized_target + normalized_payload` 生成稳定键。
- 执行前先查 `AgentState.executed_patch_keys`。
- 命中历史键则返回「已跳过」结果，不重复突变 AST。

这一步是资产 B 的新落点。

#### 阶段 6：AST 突变

所有写操作必须通过共享写入层落地到完整 AST，不允许直接字符串替换 XML。

允许的突变方式：

- 在现有节点上做局部属性修改。
- 在受控的结构调和器中执行高危操作，例如段落合并、拆分、节点确保。

禁止的突变方式：

- 删除原节点后整体重建同名节点。
- 跳过结构预期，直接拼接 XML 片段替换外层块。

#### 阶段 7：结果反馈

Tool 完成后应返回结构化结果，包含：

- 是否执行
- 命中的目标数量
- 跳过数量和原因
- 新增诊断
- 生成的幂等键
- 可供模型下一轮推理使用的摘要文本

### 7.3 选区展开与目标解析算法规格

本节把资产 A 从“原则描述”细化为可实现算法。

#### 7.3.1 输入形状与优先级

写类 Tool 的目标输入只允许四种形状：

1. `selector`
2. `semantic_selector`
3. `node_ids`
4. `patch_targets`

解析优先级固定如下：

1. 若目标类型为 `patch_targets`，直接进入 patch target 分析，不再做段落或 run 推断。
2. 若目标类型为 `node_ids`，按显式节点 ID 做精确匹配，不再回退到 selector。
3. 若目标类型为 `selector`，必须先解析结构索引，再展开为段落集合与 run 集合。
4. 若目标类型为 `semantic_selector`，必须先完成语义候选识别，再把候选集合回落为标准段落 / patch target 分析结果。

禁止在同一次 Tool 调用里混合多种目标形状。若调用侧同时传入两种以上目标形状，按输入非法处理。

#### 7.3.2 结构目标与语义目标边界

目标解析固定分为两类：

- `structural selector`
  - 例如 `heading`、`body`、`list_item`、`paragraph_ids`
  - 只依赖结构索引、显式 ID 或既有 patch target
- `semantic selector`
  - 例如 `semantic_heading`、`title_like_paragraphs`、`body_like_paragraphs`
  - 依赖结构信号、视觉信号、语义信号和局部上下文综合判定

边界约束如下：

1. `heading` 仅表示结构标题，不再承担脏文档兜底职责。
2. 当用户请求明确使用“标题 / 正文”这类业务语义，而结构信号不足时，Tool 可以升级到 `semantic selector` 流程。
3. `semantic selector` 的输出必须仍然落回 `SelectorTargetAnalysis`、`targetNodeIds`、`patchTargetIds` 与 `patchPartPaths`，不能绕过共享写入链。
4. 语义目标只作为脏文档回退策略使用，第一版不泛化到全部语义对象。

#### 7.3.3 selector 解析范围

第一版只支持以下 selector scope：

- `body`
- `heading`
- `list_item`
- `paragraph_ids`
- `all_text`

各 scope 的解析规则固定如下：

1. `body`
   - 选择 `structureIndex.paragraphs` 中 `role === "body"` 的段落。
2. `heading`
   - 选择 `role === "heading"` 的段落。
   - 若带 `headingLevel`，进一步按层级过滤。
3. `list_item`
   - 选择 `role === "list_item"` 的段落。
4. `paragraph_ids`
   - 仅选择显式列出的段落。
   - 未命中的段落 ID 进入 `missingParagraphIds`。
5. `all_text`
   - 直接选择 `doc.nodes` 中所有文本节点。
   - 该模式绕过段落级跳过策略，只保留文档已有节点。

语义 selector 的第一版范围固定如下：

1. `semantic_heading`
   - 表示“结构标题 + 高置信标题候选”的合并语义目标。
   - 适用于用户明确说“标题”“章节名”等业务语义，但结构标题信号不完整的场景。
2. `title_like_paragraphs`
   - 只表示高置信语义标题候选集合。
   - 不自动包含低置信或灰区段落。
3. `body_like_paragraphs`
   - 表示适合参与正文 baseline 推导的正文候选集合。
   - 该集合默认排除标题候选、图片段、表格段、列表项和强强调段。

#### 7.3.4 标准分析输出

目标分析的标准输出固定为：

```ts
export interface SelectorTargetAnalysis {
  matchedParagraphIds: string[];
  missingParagraphIds: string[];
  unwritableParagraphIds: string[];
  skippedParagraphIds: string[];
  skipReason?: "no_writable_runs";
  targetNodeIds: string[];
  patchTargetIds: string[];
  patchPartPaths: string[];
  missingNodeIds: string[];
}
```

字段语义固定如下：

- `matchedParagraphIds`
  - 表示结构索引层命中的段落，不代表这些段落一定可写。
- `unwritableParagraphIds`
  - 表示段落命中了，但没有任何可落地的可写 run。
- `skippedParagraphIds`
  - 第一版与 `unwritableParagraphIds` 等价，保留该字段是为了后续支持更多跳过原因。
- `targetNodeIds`
  - 表示最终可执行的 run 级目标。
- `patchTargetIds`
  - 表示可传给 patch 编译层的稳定 target id。
- `patchPartPaths`
  - 表示受影响的 part 路径集合，缺省回落到 `word/document.xml`。

对语义目标，还应补充审计信息：

- 标题候选段列表
- 正文 baseline 来源段列表
- 候选命中的置信度分层结果

这些信息可以作为附加诊断存在，但不能替代标准分析输出。

#### 7.3.5 执行性判断

目标分析结束后，必须进入执行性判断：

1. `set_page_layout`
   - 跳过普通目标校验，直接进入 section 级 patch target 推导。
2. `patch_targets`
   - 若 `patchTargetIds` 为空，返回 `E_INVALID_TARGET`。
3. `selector` / `node_ids`
   - 若存在 `missingParagraphIds` 或 `missingNodeIds`，返回 `E_INVALID_TARGET`。
   - 若 `targetNodeIds` 为空且存在命中段落，但这些段落全部不可写，返回 `E_SELECTOR_TARGETS_EMPTY`。
   - 若 `targetNodeIds` 为空且没有命中段落，返回 `E_SELECTOR_TARGETS_EMPTY`。
4. `semantic_selector`
   - 若高置信候选为空，返回语义目标失败类错误，而不是静默回退到普通 `heading`。
   - 若只有灰区候选，返回需要澄清的 `ToolMessage`。

#### 7.3.6 批量与拆分规则

目标解析后，操作是否批量执行固定由操作类型决定：

1. `merge_paragraph` 和 `split_paragraph`
   - 不允许批量 patch 编译。
   - 必须按目标逐一拆分为独立操作。
2. 其他可批量操作
   - 若存在多个 `targetNodeIds`，优先生成单个批量操作。
   - 仅在 patch 编译层要求逐目标拆分时，才向下分裂。

拆分时必须遵守：

- 新操作 ID 使用 `原 request_id + "__序号"`。
- 若上层传入显式 `idempotency_key`，拆分后追加稳定后缀，而不是重新生成无关 key。
- 原始 selector 必须保存在 `sourceTargetSelector` 或等价字段中，供审计与回显使用。

#### 7.3.7 目标解析默认假设

若 `structureIndex` 缺失：

- `selector` 与 `paragraph_ids` 分析返回空命中。
- `semantic_selector` 不得绕过结构缺失自行临时重建完整索引，只能返回前置数据不足诊断。
- 不尝试临时扫描 AST 自建结构索引。
- 将该情形视为系统级前置数据缺失，而不是模型级输入错误。

这是为了防止 Tool 在执行期偷偷引入第二套结构推导逻辑。

### 7.4 语义映射类请求处理流程

当用户请求属于以下类型时，Tool 不应直接走静态 selector，而应进入固定的语义映射执行链：

- “标题字体改成正文”
- “正文样式对齐一级标题”
- “所有章节名改成和正文一致”

固定流程如下：

1. 解析语义目标。
2. 识别目标候选集合。
3. 推导来源 baseline 样式。
4. 生成字段级差异对齐操作。
5. 深校验。
6. Patch 编译。
7. AST 突变。

流程约束如下：

1. 只同步用户明确要求的样式字段。
2. 不因为“标题像正文”就自动同步段前段后、缩进、编号等结构性样式，除非用户明确提出。
3. 语义目标识别、baseline 推导和字段级对齐结果，都必须可审计并可回传给 Chat / Template 路径。
4. 该流程第一版只服务于“标题 / 正文”这类高频脏文档语义映射。

## 8. 校验体系设计

### 8.1 双层校验模型

新的校验体系固定为双层：

1. 浅层校验：Zod schema
2. 深层校验：AST 感知的执行前预检

两层职责不可混用：

- 浅层校验负责「数据长得对不对」。
- 深层校验负责「这份数据在当前文档里能不能执行」。

### 8.2 深层校验最少能力集

深层校验必须覆盖以下能力：

1. 目标存在性校验
2. 目标可写性校验
3. 空操作和伪操作识别
4. Patch 可编译性校验
5. 高危操作的前置限制校验
6. 暂不支持能力的显式拒绝

### 8.3 失败语义

为保证 ReAct 自纠闭环，执行失败不应一律升级为硬异常。

推荐失败分层：

- 用户级 / 模型级错误：返回 `ToolMessage`
- 当前规则块不可执行：写入 `diagnostics`
- 系统级错误：抛出异常并终止图

系统级错误示例：

- AST 丢失
- DOCX 包结构损坏
- 物化前置数据不完整
- Relationship 调和失败且无法安全回滚

### 8.4 深校验算法与错误代码规格

深校验阶段固定拆成 5 个顺序步骤，任何实现都不得重排：

1. 目标真实性校验
2. 目标可写性校验
3. 语义载荷校验
4. 操作适用性校验
5. Patch 可编译性校验

#### 8.4.1 目标真实性校验

校验内容：

- `targetNodeId` 是否存在于当前 `document_ast` 或 `DocumentIR.nodes`。
- `targetNodeIds` 中是否存在占位符、空值或未命中节点。
- `paragraph_ids` 是否全部能映射到结构索引段落。

错误代码：

- `E_INVALID_TARGET`
  - 输入引用了未知 paragraph / node / patch target。
- `E_PLACEHOLDER_TARGET`
  - 输入目标仍然是 `placeholder`、`todo`、`tbd` 等伪目标。

失败语义：

- Chat 路径返回 `ToolMessage`。
- Template 路径记录诊断并将当前规则标记为 `rejected_invalid_target`。

#### 8.4.2 目标可写性校验

校验内容：

- 命中段落是否存在至少一个可写 run。
- 目标是否全部被过滤为不可写节点。
- 目标是否落在当前版本暂不允许修改的 part 或节点类型上。

错误代码：

- `E_SELECTOR_TARGETS_EMPTY`
  - selector 命中后被全部过滤为空。
- `E_TARGET_UNWRITABLE`
  - 节点存在，但不可写。

失败语义：

- 若只是部分段落不可写，则允许继续执行，并将这些段落写入 `skippedParagraphIds`。
- 若所有命中目标都不可写，则终止当前操作。

#### 8.4.3 语义载荷校验

校验内容：

- payload 是否为空。
- payload 是否只包含语义上无效的默认值。
- 操作特定字段是否满足最小语义要求。

示例：

- `set_font` 至少提供 `font_name`
- `set_size` 至少提供正数尺寸
- `set_line_spacing` 必须是正数或合法 `exact` 结构
- `ensure_node` 至少提供 `path` 与 `xml_tag`

错误代码：

- `E_EMPTY_PAYLOAD`
- `E_INVALID_PAYLOAD`

#### 8.4.4 操作适用性校验

校验内容：

- 操作是否适用于当前目标层级。
- 段落级样式操作是否错误落在纯 inline target 上。
- 高危操作是否跨越当前版本不支持的边界。

第一版明确拒绝以下情形：

- 通过 patch 编译去处理 `merge_paragraph`
- 通过 patch 编译去处理 `split_paragraph`
- 未显式声明支持的跨 part 结构迁移

错误代码：

- `E_UNSUPPORTED_OPERATION`
- `E_UNSUPPORTED_CROSS_PART_MOVE`

#### 8.4.5 Patch 可编译性校验

校验内容：

- `compileOperationToPatchSet` 能否成功执行。
- 编译结果是否解析出至少一个稳定 patch target。
- 编译后 patch operation 集合是否为空。

错误代码：

- `E_PATCH_COMPILE_FAILED`
- `E_PATCH_TARGET_EMPTY`
- `E_PATCHSET_EMPTY`

#### 8.4.6 语义目标失败分层

当目标类型来自 `semantic_selector`，或普通请求被升级为语义映射流程时，深校验还必须额外处理以下失败类型：

- `E_SEMANTIC_TARGET_LOW_CONFIDENCE`
  - 找到了候选，但整体置信度过低，不应静默执行。
- `E_SEMANTIC_TARGET_AMBIGUOUS`
  - 标题候选与正文候选存在显著重叠，或边界不清。
- `E_BODY_BASELINE_UNDERDETERMINED`
  - 无法稳定推导正文样式 baseline，例如全文几乎都像标题，或样式极度混乱。

失败语义固定如下：

1. Chat 路径
   - 返回结构化 `ToolMessage`，提示模型改写目标描述，或先做识别 / 确认。
2. Template 路径
   - 记录阻塞诊断，不默认猜测，不偷偷回退到宽泛 selector。
3. 编译门槛
   - 只有候选集合与 baseline 都足够稳定时，才允许继续进入 Patch 编译。

#### 8.4.7 ToolMessage 载荷格式

为保证 ReAct 可自纠，用户级 / 模型级失败统一返回如下结构：

```ts
export interface ToolValidationMessage {
  ok: false;
  stage: "target" | "writable" | "payload" | "compatibility" | "compile";
  error_code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

其中：

- `retryable: true`
  - 表示 LLM 重新选择目标或调整参数后可继续尝试。
- `retryable: false`
  - 表示当前请求违反系统硬约束，例如暂不支持的跨 part 迁移。

## 9. 投影与模板分类设计

### 9.1 完整 AST 与消费者投影解耦

新的解析节点只负责完整结构，不负责替 LLM 做最终输入优化。

因此，投影层必须独立存在，并生成至少两类视图：

#### Chat 投影

面向自由推理，允许做差异化压缩：

- 高价值命中段落保留更完整的 run、样式和定位信息。
- 低价值背景段落只保留大纲或摘要。
- 投影中必须保留足够的可追踪目标标识，避免 LLM 输出无法回溯。

#### Template 投影

面向模板语义分类，必须保留：

- 段落顺序
- 标题层级
- bucket type
- 文本内容
- 邻域上下文
- 图像占比等分类特征

### 9.2 Template_Classifier 输入契约

分类器的输入至少应包含：

```ts
export interface TemplateParagraphProjection {
  paragraph_id: string;
  paragraph_index: number;
  text: string;
  heading_level?: number;
  bucket_type: "heading" | "title" | "list_item" | "body" | "table_text" | "unknown";
  is_image_dominant?: boolean;
  local_context: Array<{
    paragraph_id: string;
    relative_offset: number;
    text: string;
    heading_level?: number;
    bucket_type: string;
    is_image_dominant?: boolean;
  }>;
}
```

这是资产 E 的输入下限，不允许缩水。

### 9.3 Template_Engine 生成策略

模板执行节点不做发散推理，只做确定性映射：

1. 读取模板规则。
2. 读取 `semantic_tags`。
3. 生成标准 Tool 输入。
4. 统一交给 ToolNode 执行。

这样可以确保：

- 聊天模式和模板模式共用同一底层写入链。
- Patch parity 可以继续作为回归保障。
- 所有跳过、诊断、幂等语义保持一致。

### 9.4 双投影压缩算法规格

投影层必须显式声明预算、保留字段和降级策略。禁止“按感觉压缩”。

#### 9.4.1 Chat 投影

Chat 投影的目标是让模型做局部推理，因此采用焦点优先压缩。

默认策略：

1. 先构建完整段落清单。
2. 用 `focus_regex_probe` 为每个段落打分：
   - 正则命中：高优先级
   - 与命中段落相邻：中优先级
   - 其他段落：低优先级
3. 序列化时按优先级分配预算：
   - 高优先级段落保留段落文本、run 列表、run 样式摘要、定位 ID。
   - 中优先级段落保留段落文本、段落角色、少量 run 摘要。
   - 低优先级段落只保留段落摘要、大纲角色、位置编号。

默认预算：

- 单次 Chat 投影目标预算为 12 KB 到 18 KB 文本载荷。
- 若超预算，先裁剪低优先级段落细节，再裁剪中优先级段落细节，最后才裁剪高优先级之外的背景段。

#### 9.4.2 Template 投影

Template 投影的目标不是极限压缩，而是保持分类所需结构信号完整。

默认策略：

1. 以 paragraph 为主单位。
2. 每个段落保留以下字段：
   - `paragraph_id`
   - `paragraph_index`
   - `text`
   - `role`
   - `heading_level`
   - `list_level`
   - `style_name`
   - `in_table`
   - `bucket_type`
   - `has_image_evidence`
   - `image_count`
   - `is_image_dominant`
3. 为每个段落补充局部上下文窗口。

默认上下文窗口：

- 以前后各 1 段为最小窗口。
- 若段落位于标题边界、图像密集区或列表区，可扩展到前后各 2 段。

默认预算：

- Template 投影优先按批次拆分，而不是对单段做激进字段裁剪。
- 每批默认上限维持与现有分类器一致：
  - 最多 12 段
  - 最多约 16 KB prompt bytes

#### 9.4.3 降级顺序

若投影超预算，降级顺序固定如下：

1. Chat 投影
   - 去掉低优先级段落的 run 细节
   - 压缩低优先级段落文本为摘要
   - 缩小中优先级邻域窗口
2. Template 投影
   - 优先拆批
   - 再压缩非关键说明字段
   - 不得删除 `text`、`heading_level`、`bucket_type`、`paragraph_index`、`is_image_dominant`

#### 9.4.4 失败条件

出现以下任一情况，视为投影算法失败：

- Chat 投影丢失所有可追踪目标 ID。
- Template 投影删除分类器必需字段。
- 为了控预算直接删除高优先级目标段落。
- 投影与原 AST 的段落顺序失配。

### 9.5 标题候选识别与正文 baseline 推导

在脏文档场景下，投影层还必须为语义映射类请求提供两套辅助算法：标题候选识别与正文 baseline 推导。

#### 9.5.1 标题候选识别（`title_like_paragraphs`）

目标：

- 找出“语义上像标题”的段落，即使其 `style_name`、`heading_level`、`role` 都退化成正文。

信号来源固定分三类：

1. 结构信号
   - 段落位置
   - 编号模式
   - 是否位于章节边界
   - 是否紧邻正文块之前
2. 视觉信号
   - 字号显著偏大
   - 加粗
   - 居中
   - 独占一行
   - 上下留白明显
3. 语义信号
   - 文本短
   - 更像标题短语而不是陈述句
   - 与相邻段形成“标题 -> 正文”关系

算法形式固定如下：

1. 为每个段落生成 `title_score`。
2. 输出 `SemanticParagraphScore`，记录命中的信号集合。
3. 按分数和证据强度分为三档：
   - 高置信
   - 灰区
   - 低置信
4. 只有高置信集合可直接进入执行。
5. 灰区集合必须回传给模型做澄清，或在模板路径中阻塞等待确认。

补充约束：

- `heading` 结构标签可以作为正向信号，但不能成为语义标题识别的唯一前提。
- 若标题与正文样式完全相同，仍允许依靠位置、短文本、编号模式和邻域关系形成高置信候选。

#### 9.5.2 正文 baseline 推导（`body_style_baseline`）

目标：

- 从正文候选段中抽取稳定的正文样式基线，用于“标题改成正文”“标题字体设置为正文”等语义映射请求。

候选过滤规则固定如下：

- 排除图片段
- 排除表格段
- 排除列表项
- 排除明显强调段
- 排除封面样式段
- 排除标题候选段

样式字段第一版只考虑：

- `font_name`
- `font_size_pt`
- `is_bold`
- `is_italic`
- `paragraph_alignment`
- `line_spacing`

聚合方式固定如下：

1. 使用众数或主簇，不使用简单平均。
2. 只输出稳定字段，不强行补全所有样式属性。
3. 若来源段数量过少，或同一字段分布过于分散，则该字段留空。
4. 若整体无法稳定推导，返回 `E_BODY_BASELINE_UNDERDETERMINED`。

#### 9.5.3 字段级差异对齐

当标题候选与正文 baseline 都已稳定后，语义映射请求必须生成 `SemanticStyleAlignmentPlan`，并遵守以下约束：

1. 只同步用户明确要求的样式字段，例如“字体”只允许落到 `font_name`、`font_size_pt`、`is_bold`、`is_italic` 等字体相关字段。
2. 不因 baseline 中存在其他字段，就自动把段前段后、缩进、编号等结构样式带过去。
3. `applied_fields` 必须可审计，供 Tool 结果反馈、诊断输出和回归测试使用。

### 9.6 Template 分类批处理算法约束

当前模板分类器已经采用按 bucket 分组、再按 prompt budget 拆批的策略，新方案应保留这一思想。

第一版固定约束如下：

1. 批处理顺序按 bucket type 执行：
   - `heading`
   - `title`
   - `list_item`
   - `body`
   - `table_text`
   - `unknown`
2. 每批必须带：
   - 批次类型
   - 批次序号
   - 批次数量
   - 当前批 paragraph ids
3. 分类结果聚合时必须保留：
   - `matches`
   - `unmatched_paragraph_ids`
   - `conflicts`
   - `overall_confidence`
4. 对低置信度或冲突结果，可进入第二轮 refine；但 refine 只能在局部上下文上做重判，不得重写原始 paragraph 顺序。

## 10. Materialize 与 Relationship 调和

### 10.1 新节点定位

原方案中的 `XML_Materialize_Node` 需要升级为 `Materialize_And_Reconcile_Node`，并承担四项责任：

1. 清洗运行时临时标识。
2. 做 XML 结构预检。
3. 做 package relationship 调和。
4. 原子打包输出。

### 10.2 XML 结构预检

预检至少覆盖：

- `w:pPr`、`w:rPr` 等关键属性块位置是否合法。
- 关键容器是否为空。
- 必需子元素顺序是否被破坏。
- Tool 引入的 ensure / replace / merge 操作是否造成非法结构。

### 10.3 Relationship 调和器

Relationship 调和器必须扫描 AST 与 patch history，确认所有引用一致：

- `w:drawing` 引用的图片 `rId`
- `w:hyperlink` 引用的关系
- header / footer 绑定关系
- 样式、编号、settings 等受影响 part 的引用一致性

调和动作包括：

- 确认引用存在于对应 `.rels`
- 移除失效关系
- 在允许的场景下补充缺失关系
- 输出无法自动修复的阻塞诊断

### 10.4 输出策略

物化输出必须满足：

- 先写入临时包
- 通过预检和调和后再原子替换目标文件
- 输出诊断记录受影响 part 路径

如果某次修改触发了暂不支持的跨 part 迁移，系统应：

- 在 Tool 深校验阶段优先拒绝
- 不进入危险的物化阶段

### 10.5 Relationship 调和算法规格

Relationship 调和器必须按固定顺序执行，避免输出阶段出现隐式补救逻辑。

#### 10.5.1 调和输入

调和输入由 4 部分构成：

1. `document_ast`
2. `document_package.relationship_graph`
3. `docxPatchHistory`
4. 受影响 `partPaths`

#### 10.5.2 调和扫描顺序

扫描顺序固定如下：

1. 主文档 `word/document.xml`
2. 主文档关系 `word/_rels/document.xml.rels`
3. header / footer parts 及其 `.rels`
4. styles / numbering / settings 等特殊 parts
5. media target 引用完整性

#### 10.5.3 引用抽取范围

第一版至少抽取以下引用：

- `w:drawing` 中的图片 embed / link `rId`
- `w:hyperlink` 中的 `rId`
- `sectPr` 中的 `headerReference` / `footerReference`
- patch target 指向 `styles`、`numbering`、`settings` 时的 part 级引用

#### 10.5.4 调和输出

调和结果标准结构如下：

```ts
export interface RelationshipReconcileReport {
  ok: boolean;
  scanned_parts: string[];
  referenced_relationship_ids: Array<{
    source_part: string;
    relationship_id: string;
    target?: string;
    kind: "drawing" | "hyperlink" | "header" | "footer" | "style" | "numbering" | "settings";
  }>;
  missing_relationships: Array<{
    source_part: string;
    relationship_id: string;
    reason: string;
  }>;
  dangling_relationships: Array<{
    source_part: string;
    relationship_id: string;
    target: string;
  }>;
  repaired_relationships: Array<{
    source_part: string;
    relationship_id: string;
    action: "added" | "removed" | "rewritten";
  }>;
  blocking_diagnostics: string[];
}
```

#### 10.5.5 自动修复范围

第一版允许自动修复的场景：

- 删除节点后遗留的失效 relationship 可安全移除。
- 引用存在但 target path 仅需做相对路径归一化时，可安全改写。

第一版不自动修复的场景：

- 缺失 media 文件本体
- 跨 part 迁移导致的 relationship 重挂接
- 无法确认 target 类型的悬挂 `rId`

这些情况必须生成阻塞诊断并终止物化。

#### 10.5.6 Materialize 的最终通过条件

只有同时满足以下条件，物化才可继续输出：

1. XML 结构预检通过
2. Relationship 调和报告 `ok === true`
3. 不存在 `blocking_diagnostics`
4. 所有受影响 part 都能在原始包中定位

否则：

- 保留输入文件不变
- 返回失败诊断
- 不生成半成品输出包

## 11. 幂等与恢复语义算法

### 11.1 状态字段定义

幂等记录统一落在：

```ts
executed_patch_keys: string[];
```

该字段只记录“已成功提交语义效果”的写操作 key，不记录失败操作。

### 11.2 幂等键生成规则

若调用侧未传入 `idempotency_key`，系统按以下顺序生成稳定 key：

1. 归一化操作类型
2. 归一化目标
3. 归一化 payload
4. 可选文档线程上下文

推荐归一化规则：

- 操作类型转小写
- `node_ids`、`patch_targets` 按字典序去重排序
- `selector` 转为稳定字符串表示，例如 `heading(level=1)`、`paragraph_ids(p1,p2)`
- payload 先做键名排序，再剔除 `undefined`

推荐格式：

`write:{operation}:{normalized_target}:{payload_hash}`

### 11.3 写入时机

幂等键只有在以下条件全部满足后才可追加到状态：

1. 深校验通过
2. Patch 编译成功
3. AST 突变成功
4. Tool 返回成功或成功跳过结果

以下情况不得写入 key：

- Zod 校验失败
- 深校验失败
- Patch 编译失败
- AST 突变异常
- dry-run

### 11.4 恢复与时间回溯语义

恢复规则如下：

1. resume
   - 继续读取当前 checkpoint 中已有的 `executed_patch_keys`
   - 同 key 写操作必须直接跳过
2. replay / time-travel
   - 以目标 checkpoint 的 `executed_patch_keys` 为准
   - 不允许引用未来状态中的 key
3. 手动重试
   - 若用户显式要求强制重试，必须提供新的 `request_id` 或新的显式 `idempotency_key`

### 11.5 幂等命中结果

幂等命中不是异常，而是标准 Tool 成功结果的一种：

```ts
export interface ToolIdempotentSkipResult {
  ok: true;
  executed: false;
  skip_reason: "idempotency_hit";
  idempotency_key: string;
  summary: string;
}
```

这样可以保证：

- ReAct 看到的不是硬错误
- 图恢复后不会重复突变
- 审计时可区分“真的执行了”和“因幂等被跳过”

## 12. 渐进式迁移计划

### Phase 1：文档基建收口

目标：

- 独立出完整 AST、结构索引、package model 和 relationship graph 的统一解析入口。
- 明确投影层与 AST 层边界。

重点任务：

- 封装完整解析与 package model 构建。
- 抽离 Chat 投影和 Template 投影生成器。
- 保留现有 patch parity 回归样例。

### Phase 2：Tool 责任链重构

目标：

- 用 LangChain Tool 输入契约替代旧 `PlanStep` 驱动模式。

当前仓库事实同步：

- `src/langgraph-ts/tooling/` 已落地 Phase 2 最小闭环。
- 当前已具备 `schema -> target-resolution -> validation -> patch-compilation -> idempotency -> write-tool` 的独立编译链。
- 当前仍未接入 LangGraph `ToolNode`、真实 AST 突变与 Materialize 主链，这些继续留给后续阶段。

重点任务：

- 建立 Zod 浅校验。
- 将 selector 展开、深校验、Patch 编译、幂等迁入 Tool 内部。
- 把 Tool 反馈改为可被 ReAct 循环消费的结构化消息。

### Phase 3：LangGraph 主链接管

目标：

- 跑通 Chat、Template、Clarify 三条主路径。

重点任务：

- 接入 Router、Projection、Reasoning、Classifier、Engine、ToolNode 和 Materialize 节点。
- 用 Checkpointer 接管恢复和审计。
- 删除对旧双 SQLite 审计心智模型的依赖。

### Phase 4：写回调和与系统收敛

目标：

- 把物化输出升级为包级调和输出。

重点任务：

- 落地 Relationship 调和器。
- 追加含图片、超链接、页眉页脚样本的回归集。
- 在稳定后再推进更大范围的 Python 剥离。

## 13. 验收标准与回归测试

### 13.1 功能验收

以下场景必须通过：

1. Chat 模式下，LLM 传入模糊 selector，Tool 内部能展开为精确目标，并保持消息历史与执行事实一致。
2. 同一写操作在恢复执行、服务重启、时间回溯后，不会因进程内存丢失而重复执行。
3. 伪造不存在的 `targetNodeId` 时，系统返回可供模型自纠的 `ToolMessage`，而不是直接崩溃。
4. 模板分类在保留上下文的前提下稳定读取标题层级、邻域和图像特征，不因投影压缩失真。
5. 含图片和超链接的文档在修改后，`document.xml` 与 `.rels` 保持一致，可正常打开。
6. 当文档视觉上存在标题，但 `heading_level` 与 `style_name` 都退化成正文时，系统仍能识别高置信标题候选。
7. 当用户请求“把标题字体设置为正文”时，系统先推导 `body_style_baseline`，再只同步字体相关字段。
8. 当全文结构混乱、标题候选和正文候选置信度都低时，系统不会盲改，而是返回澄清请求或结构化 `ToolMessage`。
9. 语义候选识别与 baseline 推导结果必须可审计，至少可见：
   - 标题候选段列表
   - 正文 baseline 来源段列表
   - 最终同步字段集合

### 13.2 回归测试方向

至少保留以下回归维度：

1. selector expansion 等价性
2. patch parity 等价性
3. 默认校验器深校验语义等价性
4. 模板分类输入特征完整性
5. materialize 后包结构完整性
6. relationship 调和一致性
7. Checkpointer 恢复后的幂等一致性
8. 结构标题缺失时，仍可通过短文本、编号模式、加粗和段落位置识别标题候选
9. 标题与正文样式完全相同时，仍可通过语义 / 位置识别标题
10. 正文 baseline 推导会自动排除表格、图片段、列表项和强强调段
11. “标题改成正文字体”只修改字体相关字段，不误改编号、缩进、段前段后
12. 语义候选置信度不足时返回 `E_SEMANTIC_TARGET_LOW_CONFIDENCE`
13. 标题候选与正文候选冲突时返回 `E_SEMANTIC_TARGET_AMBIGUOUS`
14. baseline 来源不足或样式过散时返回 `E_BODY_BASELINE_UNDERDETERMINED`

### 13.3 明确的失败判定

出现以下任一情况，视为重构失败，不得对外宣称完成：

- Tool 仍然依赖旧 `PlanStep` 作为 LangChain 的输入接口。
- 幂等仍然只存在于内存 `Set`。
- 模板分类输入被裁剪到无法提供局部结构上下文。
- Materialize 仍然只回写 `word/document.xml` 而不校验 `.rels`。
- Graph 中存在专门为了改写 `tool_calls` 而硬插的中间节点。
- 脏文档中的“标题 / 正文”语义映射仍然直接依赖静态 `heading` selector，缺少候选识别与 baseline 推导。

## 14. 最终决策摘要

为了避免后续实现再次走偏，最终决策锁定如下：

1. 不再把资产 A 设计为独立 Graph Node，而是内嵌到 Tool 责任链。
2. 不再保留基于进程内存的幂等存储，幂等键正式进入 `AgentState`。
3. 不再把 Zod 视为完整校验方案，深校验必须保留 AST 感知能力。
4. 不再在底层解析阶段做破坏性压缩，压缩只存在于投影层。
5. 不再把写回理解为 `document.xml` 单文件输出，物化节点必须承担 package relationship 调和责任。

以上 5 条是本次 LangGraph 重构方案的硬约束。后续实施、拆任务和代码评审，均以此文档为准。
