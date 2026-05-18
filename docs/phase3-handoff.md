# Phase 3 Handoff

## 本文用途

这份 handoff 只服务于「Phase 3：LangChain / LangGraph 主链接管实现」的留档与交接。下一位实现者无需重新梳理本阶段范围，可直接基于本文判断当前落点、已知边界与 Phase 4 接缝。

## 本阶段已落地结果

Phase 3 已在 `src/langgraph-ts` 内完成新的 LangGraph 主链最小闭环，且未回接旧 `AgentRuntime` 主链。`archive/legacy/` 目录在本阶段只保留迁移参考价值，不再作为当前 runtime 行为定义来源。

当前已落地内容如下：

- `runtime/graph.ts`：新的 LangGraph runtime 入口。
- `runtime/contracts.ts`：Phase 3 runtime 的状态、依赖、输入输出合同。
- `runtime/bundle-mutation.ts`：基于稳定 patch target 的最小 bundle 突变层。
- `runtime/materialize.ts`：基于 package snapshot 的最小 DOCX 物化层。
- `runtime/sqlite-checkpointer.ts`：LangGraph 专用 SQLite checkpointer 适配。
- `document-core/parse-document-bundle.ts`：`ParsedDocumentBundle` 现在会补齐 package snapshot。
- `contracts/document-contracts.ts`：`ParsedDocumentBundle` 增加 `package_snapshot`，成为图内可物化的文档真相。

相关测试如下：

- [src/langgraph-ts/tests/phase3-runtime.spec.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tests/phase3-runtime.spec.ts)
- [src/langgraph-ts/tests/phase3-sqlite-checkpointer.spec.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tests/phase3-sqlite-checkpointer.spec.ts)

## 当前图架构

当前 `runtime/graph.ts` 中已实现的主链拓扑为：

- `START -> intent_router -> document_load_and_parse -> projection_builder`
- `chat -> reasoning -> tools -> reasoning / materialize_and_reconcile`
- `template -> template_classifier -> template_engine -> tools -> materialize_and_reconcile`
- `clarify -> direct_response -> END`

当前 `AgentState` 已覆盖以下字段：

- `messages`
- `mode`
- `document_path`
- `output_path`
- `document_bundle`
- `chat_projection`
- `template_projection`
- `template_config`
- `semantic_tags`
- `executed_patch_keys`
- `diagnostics`
- `artifact_refs`

当前 reducer 语义与 Phase 3 计划保持一致：

- `messages` / `executed_patch_keys` / `diagnostics` / `artifact_refs` 为追加。
- `document_bundle` / projections / `semantic_tags` / `mode` 等为覆盖。

## Phase 2 Tool 内核接入现状

Phase 3 没有拆散 Phase 2 的责任链，仍统一通过 `write_document` tool 复用：

- `executeWriteTool(bundle, rawInput, { executed_patch_keys })`
- `analyzeWriteTarget(...)`
- `compileWriteToolPatchSet(...)`

当前 `write_document` tool 的行为如下：

- 成功执行时：
  - 追加 `executed_patch_keys`
  - 追加 `diagnostics`
  - 将 `patchSet.operations` 应用到 `document_bundle`
  - 通过 `ToolMessage.artifact.state_update` 回写图状态
- 幂等命中时：
  - 保持 `ok: true`
  - 不重复突变 `document_bundle`
  - 通过诊断返回 `skip_reason: "idempotency_hit"`
- 结构化失败时：
  - 不抛宿主异常
  - 仍返回 `ToolMessage`
  - 错误以 `diagnostics` 形式进入图状态

`semantic_selector` 已收敛为受限系统能力：

- 仅支持 `title_like_paragraphs` / `body_like_paragraphs`
- 通过 `template_projection` 做真实候选识别、正文 baseline 推导与受限字段同步
- 低置信、歧义或 baseline 不稳定时返回结构化 `E_SEMANTIC_TARGET_*` / `E_BODY_BASELINE_UNDERDETERMINED`

## 文档真相与物化边界

当前图内唯一文档真相是 `ParsedDocumentBundle`，并且已经补齐 package snapshot，可支撑真实物化。

Phase 3 当前已支持：

- 基于稳定 patch target 的 `set_text` 真实突变
- 共享 `document_bundle` 的图内回写
- 从 `package_snapshot` 重新打包并输出 DOCX

当前明确未支持：

- 全面的 relationship reconcile
- 新增复杂关系对象时的自动建模
- `.rels` 泛化增删与跨 part 重建
- `set_text` 以外 patch type 的真实物化

如果后续写操作需要新增复杂关系对象，当前实现不应被视为可直接扩展；需要在 Phase 4 专门补 relationship 层。

## 三条主路径当前状态

### 1. Chat 路径

已打通：

- `reasoning -> ToolNode -> reasoning`
- 模型可发出 `write_document` tool call
- tool 成功后会更新 `document_bundle`
- 仅当最近一次 `write_tool` 实际执行了写入时才进入 `materialize_and_reconcile`
- `idempotency_hit`、未执行写入和结构化失败都不会触发新的 DOCX 物化
- 终态可物化输出 DOCX

### 2. Template 路径

已打通：

- `template_classifier` 产出 `semantic_tags`
- `template_engine` 生成确定性 `write_document` tool call
- 与 chat 路径复用同一个 `ToolNode`
- tool 成功后直接进入 `materialize_and_reconcile`

补充说明：

- `template_classifier` 现在真实消费 `template_projection.batches`
- `template_config.semantic_tags` 不再被视作可信输入
- 投影预算失败或分类字段缺失会返回结构化 diagnostics，并阻断模板执行

### 3. Clarify 路径

已打通：

- 只生成自然语言回复
- 不触发 tool
- 不触发 materialize
- 不生成输出 DOCX

## SQLite checkpoint 现状

当前 Phase 3 已接入新的 SQLite checkpoint 适配层 [src/langgraph-ts/runtime/sqlite-checkpointer.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/runtime/sqlite-checkpointer.ts)。

当前行为如下：

- `messages` 会以 stored message 形式持久化，并在恢复时还原为 LangChain `BaseMessage` 实例。
- `executed_patch_keys` 会进入 checkpoint 状态，不再依赖进程内存。
- 恢复后重复 tool call 会继续命中幂等保护。

注意事项：

- 当前 `Phase3SqliteCheckpointer` 提供 `close()`，Windows 下测试或脚本使用完后应显式关闭 DB 句柄。

## 依赖与构建约束

本阶段已在 `src/ts/package.json` 中新增并验证以下依赖：

- `@langchain/core`
- `@langchain/langgraph`
- `@langchain/langgraph-checkpoint-sqlite`
- `@langchain/openai`

同时已调整：

- `src/ts/tsconfig.json`
- `src/ts/vitest.config.ts`

使 `src/langgraph-ts/**/*.ts` 成为实际编译与测试源，并补齐 `@langchain/*`、`better-sqlite3`、`jszip`、`@xmldom/xmldom` 的本地解析映射。

当前仍遵守以下约束：

- 不手改 `src/ts/dist/*`
- 不规划任何回接旧 `src/ts/dist/runtime/*` 的兼容桥
- 新 Graph 入口固定在 `src/langgraph-ts`

## 当前验证证据

本轮已实际执行并通过：

```bash
cd src/ts && npm test
cd src/ts && npm run build
```

当前验证结果：

- `npm test`：7 个测试文件，15 个测试全部通过。
- `npm run build`：TypeScript 编译通过。

其中 Phase 3 相关新增覆盖包括：

- 模板载荷路由到 `template`
- 文档修改请求路由到 `chat`
- 解释类请求路由到 `clarify`
- `ToolNode` 成功 / 失败路径的状态更新
- `document_bundle` 成功更新与失败不污染
- `clarify` 不 materialize
- `chat` 路径在 checkpoint 恢复后的幂等重放不会重复 materialize，也不会再次返回新的 `output_docx_path`
- checkpoint 持久化与消息恢复

## 当前明确未做

以下内容不属于本阶段已完成范围，后续实现者不要误判为已具备：

- LangChain 原生 `ChatOpenAI` 生产接线与真实模型参数装配
- 全 patch type 的真实 XML 物化
- relationship 泛化调和器
- 更复杂的语义 selector 扩展（当前仍限定两类 selector）
- 复杂新增节点场景下的 `.rels` 自动维护

## 对 Phase 4 的建议接缝

Phase 4 建议从以下位置继续：

1. 扩展 [src/langgraph-ts/runtime/bundle-mutation.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/runtime/bundle-mutation.ts)，将当前仅支持的 `set_text` 逐步扩成更多 patch type 的真实突变。
2. 在 `materialize` 前补充 relationship reconcile 层，统一处理 `.rels`、新资源与跨 part 引用。
3. 将当前测试中的注入式 `Phase3ModelAdapter` 替换为正式的 LangChain `ChatModel` 适配与配置装配。
4. 在保持 Phase 2 tool 内核不回退的前提下，扩展 template / chat 的可写操作覆盖面。

## 一句话结论

Phase 3 已完成「LangGraph 主链接管 + Phase 2 Tool 内核复用 + 最小真实文档写入闭环」，当前系统已经能以新的图执行架构真实完成 `chat` / `template` / `clarify` 三条路径，但真实物化能力仍刻意收敛在最小可用范围，全面 relationship 调和仍属于 Phase 4；现行行为应继续以 `src/langgraph-ts` 合同、handoff 与测试断言为准，而不是以 `archive/legacy/` 中的旧实现为准。
