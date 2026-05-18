# Phase 1 Handoff

## 本文用途

这份 handoff 只服务于「Phase 1：文档解析基线、projection 基线与 legacy 边界归档」的留档与交接。下一位实现者无需重新回看旧目录迁移过程，可直接基于本文判断：

- Phase 1 当前真正产出了什么；
- 哪些合同应视为后续 phase 的稳定输入；
- 哪些能力明确不属于 Phase 1。

## 本阶段已落地结果

Phase 1 在 `src/langgraph-ts` 中已经完成新的文档解析与观察模型基线，同时把旧运行时资产迁入 `archive/legacy`，明确了新旧边界。

当前已落地内容如下：

- `document-core/legacy-docx-parser.ts`
  - 负责从 DOCX 解析结构、样式、编号、关系、媒体和 legacy observation state。
- `document-core/mappers.ts`
  - 负责把 legacy observation state 映射为新的 `ParsedDocumentBundle`。
- `document-core/parse-document-bundle.ts`
  - 负责提供统一入口 `parseDocumentBundle()`。
- `contracts/document-contracts.ts`
  - 定义新的 bundle、projection 与 package model 合同。
- `projections/build-chat-projection.ts`
  - 负责构建面向 chat 场景的轻量 projection。
- `projections/build-template-projection.ts`
  - 负责构建面向 template 场景的结构化 projection。
- `compat/legacy-observation-adapter.ts`
  - 负责把新的 bundle 回转为 legacy 兼容观察结果，作为 parity 基线。

归档边界已落地如下：

- `archive/legacy/python-host`
- `archive/legacy/frontend`
- `archive/legacy/ts-runtime/src`
- `archive/legacy/ts-runtime/tests`

这些归档目录只保留迁移参考价值，用于回看旧实现拆分过程与历史结构；当前行为定义、开发入口和验收口径均不再以 `archive/legacy/` 为准。

同时，以下旧目录已从新主链移除：

- `src/python`
- `src/frontend`
- `src/ts/src`

## Phase 1 核心合同

Phase 1 的核心输出是 `ParsedDocumentBundle`。后续 phase 可以在此基础上追加字段或使用新字段，但不应破坏以下基线语义：

### 1. 解析真相

`parseDocumentBundle()` 返回的 bundle 至少稳定覆盖以下信息：

- `document_ast`
  - 段落、表格、文本 run、图片、公式
  - 样式投影
  - 编号投影
  - patch target 基线
- `document_package`
  - package meta
  - part 列表
- `structure_index`
  - 段落列表
  - `paragraphMap`
  - `roleCounts`
- `relationship_graph`
  - 扁平 `edges`
  - 按 source part 聚合的 `bySource`

当前实现还能补齐 `package_snapshot`。这是后续 Phase 3 / Phase 4 为真实物化追加的能力，但它是向后兼容扩展，不改变 Phase 1 的核心解析合同。

### 2. projection 语义

Phase 1 明确提供两类只读 projection：

- `buildChatProjection(bundle)`
  - 输出按段落展开的 chat 视图；
  - 输出有限数量的强调 run 信息；
  - 不修改原始 `document_ast`。
- `buildTemplateProjection(bundle, options)`
  - 输出面向模板分类与模板写入规划的段落视图；
  - 提供 `bucketType`、局部上下文、图片证据和编号模式摘要；
  - 不修改原始 `document_ast`。

后续 phase 可以消费这些 projection，但不应把 projection 当成文档真相回写。

### 3. compat 基线

`bundleToLegacyObservation(bundle)` 的职责不是引入新行为，而是维持关键结构字段的兼容映射，确保迁移后仍能对齐 legacy 观察结果的核心字段，包括：

- `package_model.package_meta`
- `relationship_graph`
- `structure_index`
- `document_meta`
- `styles`
- `numbering`
- `patch_targets`

如果后续 phase 扩展 bundle 字段，除非确有必要，不应反向污染 Phase 1 的 compat 口径。

## 当前测试基线

Phase 1 当前对应 4 个基线测试文件：

- [src/langgraph-ts/tests/phase1-archive-layout.spec.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tests/phase1-archive-layout.spec.ts)
- [src/langgraph-ts/tests/parse-document-bundle.spec.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tests/parse-document-bundle.spec.ts)
- [src/langgraph-ts/tests/projections.spec.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tests/projections.spec.ts)
- [src/langgraph-ts/tests/compat-parity.spec.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tests/compat-parity.spec.ts)

这 4 组测试当前共同锁定了以下事实：

- legacy 资产已归档，新运行时不再依赖旧目录；
- `parseDocumentBundle()` 能稳定解析：
  - 段落 / 表格
  - header / footer
  - footnote / endnote
  - 样式与编号
  - 关系图
  - 图片与公式
- chat/template projection 能从同一 bundle 构建不同视图，且不污染 AST；
- 新 bundle 到 legacy observation 的关键字段映射仍保持对齐。

## 当前明确不属于 Phase 1 的内容

以下能力不要误判为 Phase 1 已完成范围：

- 写工具 schema、target analysis、payload normalize、compile
- 幂等执行语义
- LangGraph / ToolNode / checkpoint
- 真实 bundle mutation
- materialize 与 relationship reconcile
- `semantic_selector` 真实算法

这些分别属于 Phase 2、Phase 3、Phase 4 及后续阶段。

## 对后续 Phase 的稳定输入

后续 phase 如需继续扩展，建议把以下接口视为稳定输入面：

- `parseDocumentBundle({ docxPath, mediaDir? })`
- `ParsedDocumentBundle`
- `buildChatProjection(bundle, options?)`
- `buildTemplateProjection(bundle, options?)`
- `bundleToLegacyObservation(bundle)`

尤其是以下字段，已经成为后续链路的默认依赖：

- `document_ast.patchTargets`
- `structure_index.paragraphs`
- `structure_index.paragraphMap`
- `document_package.packageMeta`
- `relationship_graph`

## 一句话结论

Phase 1 已完成「新解析基线 + projection 基线 + legacy 归档边界」三件事。后续所有写入、编排和物化能力，都应建立在这套 bundle / projection / compat 基线之上，而不是重新回接旧运行时目录；`archive/legacy/` 只用于迁移参考，不再承担当前正确行为的解释职责。
