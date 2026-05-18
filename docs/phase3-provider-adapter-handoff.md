# Phase 3 Provider Adapter Handoff（2026-05-13）

## 1. 目标与当前结论

本轮目标是把 `read -> write` 的 provider adapter 正式接入系统，并且用真实 DeepSeek 配置验证，避免再次出现：

```text
400 The reasoning_content in the thinking mode must be passed back to the API.
```

当前已经确认的根因不是 runtime graph，也不是 adapter 内部没有保存 `reasoning_content`，而是底层传输仍然走了：

- `createChatOpenAITransport()`
- `llm.bindTools(...).invoke(messages)`

这条 LangChain 调用链在当前代码里仍然不可控，无法保证把上一轮 assistant message 上的 `additional_kwargs.reasoning_content` 原样回传给 provider。

## 2. 已完成的实现

以下代码已经存在于工作区，并非本次会话虚构：

- [src/langgraph-ts/model/provider-adapter.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/model/provider-adapter.ts:1)
- [src/langgraph-ts/runtime/graph.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/runtime/graph.ts:1)
- [src/langgraph-ts/runtime/contracts.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/runtime/contracts.ts:1)
- [src/langgraph-ts/tests/provider-model-adapter.spec.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tests/provider-model-adapter.spec.ts:1)
- [src/langgraph-ts/tests/phase3-runtime.spec.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tests/phase3-runtime.spec.ts:1)
- [src/langgraph-ts/tests/real-docx-fixtures.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tests/real-docx-fixtures.ts:1)

已经落地的能力：

- 正式 provider compatibility adapter：`createProviderModelAdapter(...)`
- 强约束 system prompt：`PHASE3_STRONG_SYSTEM_PROMPT`
- 更窄的 `write_document` tool schema（显式限制 `semantic_selector` 与受限语义 payload）
- provider 内部 `read -> write` 自循环，默认最多 3 轮
- DeepSeek 类 `reasoning_content` 在 adapter state 内记录，并准备在下一轮 replay
- provider read 回放结果已包含 `chat_projection` / `template_projection` 摘要，而不再只返回旧 paragraph summary
- provider 级诊断分类：
  - `provider_protocol_error`
  - `provider_read_loop_exhausted`
  - `provider_tool_args_unmappable`
  - `provider_reasoning_context_missing`
- runtime graph 默认使用强 prompt，并会把 model 返回的 `phase3_diagnostics` 合并到 runtime diagnostics

## 3. 已确认的关键事实

### 3.1 当前唯一明确失败点

我已经重新跑过聚焦测试，当前红灯是：

```text
provider model adapter > serializes reasoning_content back into provider wire messages for DeepSeek-style replay
TypeError: convertToProviderWireMessages is not a function
```

对应测试位置：

- [src/langgraph-ts/tests/provider-model-adapter.spec.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tests/provider-model-adapter.spec.ts:295)

这说明下一步必须补：

- `convertToProviderWireMessages(...)`
- 明确的 provider wire 序列化逻辑

### 3.2 对 LangChain 现状的再次核实

已检查本地安装的 `@langchain/openai` 代码，确认：

- 入站 converter 会保留 provider 返回的 `reasoning_content`
- 但出站 `convertMessagesToCompletionsMessageParams(...)` 仍未把 assistant message 上的 `additional_kwargs.reasoning_content` 写回请求消息

本地证据位置：

- `node_modules/@langchain/openai/dist/converters/completions.js`
  - 入站保留：`message.reasoning_content -> additional_kwargs.reasoning_content`
  - 出站缺失：`convertMessagesToCompletionsMessageParams(...)` 未写回 `reasoning_content`

也就是说，即便 adapter 已经把 `reasoning_content` 挂回 `AIMessage.additional_kwargs`，只要仍走 `bindTools().invoke()`，DeepSeek 仍可能继续报 400。

### 3.3 当前仓库状态

仓库是脏工作树，且有大量与本任务无关的删除/新增修改。后续实现必须：

- 只改 `src/langgraph-ts/**` 相关文件
- 不要回滚用户现有改动
- 不要碰其他大块脏文件

## 4. 已验证证据

### 4.1 之前已经通过的验证

来自上一轮已完成实现的可用证据：

- `src/ts` 下 `npm run build` 通过
- `npm test -- provider-model-adapter.spec.ts phase3-runtime.spec.ts` 在新增序列化测试之前通过
- `npm test -- phase2-write-tool.spec.ts real-model-smoke.spec.ts` 之前通过

### 4.2 本轮重新验证的证据

我本轮重新执行并确认：

```powershell
npm test -- provider-model-adapter.spec.ts
```

结果：

- 5 个测试通过
- 1 个测试失败
- 失败点仅为 `convertToProviderWireMessages is not a function`

说明当前最小修复边界明确，不需要重新怀疑 adapter 主循环逻辑。

## 5. 尚未完成的工作

### 5.1 必做

1. 在 [src/langgraph-ts/model/provider-adapter.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/model/provider-adapter.ts:1) 中补：
   - `convertToProviderWireMessages(messages, model)`
   - 从 provider 原始响应恢复 `AIMessage` 的逻辑
   - 显式把 `reasoning_content` 序列化回 assistant wire message

2. 替换 `createChatOpenAITransport(llm)` 的实现：
   - 不再使用 `llm.bindTools(...).invoke(messages)`
   - 改成直接调用底层 OpenAI-compatible `chat.completions.create(...)`
   - 请求消息使用自定义 serializer
   - 响应使用自定义 parser，保留：
     - `tool_calls`
     - `reasoning_content`
     - 基础 response metadata

3. 新增正式模型工厂，不再只在测试 helper 里临时拼装：
   - 建议新增：`src/langgraph-ts/model/model-factory.ts`
   - 支持从 `config.json` 读取 `chat` 或 `planner` 配置
   - 返回正式 `Phase3ModelAdapter`
   - 内部统一走：
     - `new ChatOpenAI(...)`
     - `createProviderModelAdapter(...)`
     - 新的 raw transport

4. 让真实 smoke 也走正式模型工厂，而不是测试专用 env helper。

### 5.2 必做验证

1. 先跑聚焦单测：

```powershell
npm test -- provider-model-adapter.spec.ts
```

2. 再跑 runtime 相关：

```powershell
npm test -- provider-model-adapter.spec.ts phase3-runtime.spec.ts
```

3. 再跑构建：

```powershell
npm run build
```

4. 最后跑真实 DeepSeek smoke：

```powershell
npm test -- real-model-smoke.spec.ts
```

如果沙箱继续异常，直接用提权命令执行，不要在沙箱假失败上浪费时间。

## 6. 建议的实现顺序

### 第一步：先把红灯变绿

先只做最小闭环：

- 实现 `convertToProviderWireMessages(...)`
- 让 [provider-model-adapter.spec.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tests/provider-model-adapter.spec.ts:1) 新增的序列化测试通过

### 第二步：替换 transport

在 `provider-adapter.ts` 内完成：

- 请求序列化
- 原始 completions 调用
- 响应反序列化

然后补一条 transport 级测试，确认第二轮请求中 assistant wire message 带上：

```json
{
  "role": "assistant",
  "reasoning_content": "...",
  "tool_calls": [...]
}
```

### 第三步：正式接入系统入口

新增模型工厂，并把真实 smoke helper 改成：

- 读 `config.json`
- 自动识别 provider 为 `deepseek`
- 自动开启 `supportsReasoningContextReplay`

### 第四步：真实验证

重点验证 3 个样本：

- `标准正文样本`
- `样式与编号差异样本`
- `settings敏感样本`

目标不是只看测试绿，而是确认不再出现 `reasoning_content` 400。

## 7. 真实配置说明

真实配置文件：

- [config.json](/D:/Document%20Format%20Correction/config.json:1)

当前已知：

- `base_url`: `https://api.deepseek.com/v1`
- `model`: `deepseek-v4-flash`
- 文件中存在真实 API Key

注意：

- 新会话里不要把 API Key 回显到答案或日志中
- 读取配置即可，避免把秘钥写入新增文件

## 8. 建议下个会话直接做的事

新会话可直接按下面顺序执行：

1. 阅读本文件。
2. 打开 [src/langgraph-ts/model/provider-adapter.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/model/provider-adapter.ts:1) 和 [src/langgraph-ts/tests/provider-model-adapter.spec.ts](/D:/Document%20Format%20Correction/src/langgraph-ts/tests/provider-model-adapter.spec.ts:1)。
3. 实现 `convertToProviderWireMessages(...)`。
4. 重写 `createChatOpenAITransport(...)`，绕开 `bindTools().invoke()`。
5. 跑 `npm test -- provider-model-adapter.spec.ts`。
6. 补正式模型工厂，接入 `config.json`。
7. 跑 build 和真实 DeepSeek smoke。

## 9. 额外说明

- 本次被用户中断前，我没有提交新的生产代码修改。
- 当前工作区中最重要的现存未完成点，就是 transport 仍未替换。
- 如果下个会话看到 `@langchain/openai` changelog 中有“preserve reasoning_content”之类字样，不要据此假设问题已经自动解决，必须以本地实际 converter 代码和真实 DeepSeek 冒烟结果为准。
