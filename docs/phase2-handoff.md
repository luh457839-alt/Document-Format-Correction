# Phase 2 Handoff

## 本文用途

这份 handoff 只服务于「Phase 2 对齐修复与收口」。下一位实现者无需重新判断范围，直接按本文边界施工即可。

## 当前已落地模块

`src/langgraph-ts/tooling/` 内已经落地的 Phase 2 模块如下：

- `schema`：基于 `zod` 的浅层输入校验。
- `target-resolution`：`selector`、`node_ids`、`patch_targets` 的目标分析。
- `payload-normalization`：写操作 payload 归一化。
- `validation`：目标存在性、可写性、操作兼容性校验。
- `patch-compilation`：Patch 预编译，输出 `patchSet`、`patchTargetIds`、`partPaths`、`targetCount`。
- `idempotency`：稳定幂等键生成与命中判定。
- `write-tool`：统一入口，返回结构化成功 / 失败结果，不做真实 AST 突变和 DOCX 物化。

当前公共合同位于 [src/langgraph-ts/tooling/contracts.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tooling/contracts.ts)。

## 当前已确认偏差

本轮只修已经确认的 2 处「实现 vs 大纲」漂移，不扩展到后续 phase：

1. `patch_targets` 的缺失目标，当前没有在 `target` 阶段失败，而是继续流入 compile。
2. 幂等命中结果的 `skip_reason`，当前实现值与大纲承诺值不一致。

除这 2 处外，Phase 2 现有实现视为对齐，不做额外代码修改。

## 本轮必须修复

### 1. `patch_targets` 缺失目标的阶段对齐

- 保留 `target-resolution.ts` 已产出的 `missing_patch_target_ids`。
- 在 `validation.ts` 中消费该字段。
- 当 `target.kind === "patch_targets"` 且存在缺失 patch target id 时：
  - 返回结构化失败。
  - `stage` 固定为 `target`。
  - 错误码固定为稳定值（本轮计划使用 `E_PATCH_TARGET_NOT_FOUND`）。
  - `details` 中显式带出缺失 target 列表。
- 不再让这类错误落到 compile 阶段。

### 2. 幂等命中结果语义对齐

- 在 `write-tool.ts` 及相关类型、测试中统一 `skip_reason`。
- 幂等命中时，`skip_reason` 必须为 `idempotency_hit`。
- 以下行为保持不变：
  - `ok: true`
  - `executed: false`
  - 不抛异常
  - 显式新 `idempotency_key` 仍允许重放

## 当前明确不修

以下事项属于后续 phase，本轮不得顺手扩做：

- `semantic_selector` 的候选识别与 baseline 推导。
- `executed_patch_keys` 迁入 `AgentState`。
- LangGraph `ToolNode` / `StateGraph` 接入。
- 真实 AST 突变。
- Materialize / Relationship reconcile。

`README.md` 与 `docs/项目详情.md` 的文档漂移，本轮也明确不处理。

## 当前验证基线

本轮验收命令固定为：

```bash
cd src/ts && npm test
cd src/ts && npm run build
```

需要确保：

- Phase 1 的既有 4 个测试继续通过。
- 当前 Phase 2 测试继续通过。
- 不新增对 `README.md` 或 `docs/项目详情.md` 的断言。

## 与后续 Phase 的接缝

Phase 3 接入 LangGraph 主链时，建议直接复用：

- `executeWriteTool(bundle, rawInput, options)`
- `WriteToolInput`
- `ToolValidationMessage`
- `ToolExecutionResult`

后续再补的能力包括：

- 将 `executed_patch_keys` 从显式调用参数迁入 `AgentState`。
- 在 Tool 成功路径中接入真实 AST 突变。
- 在 ToolNode 完成后接入 Materialize / Relationship reconcile。
- 逐步扩展 `semantic_selector` 的候选识别与 baseline 推导。
