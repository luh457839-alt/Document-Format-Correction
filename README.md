# 文档格式修正 Agent V0.3.0

文档格式修正 Agent 是一个面向本地桌面场景的 DOCX 处理系统。它把对话式交互、文档观察、结构理解、格式修改、模板执行和结果导出收敛到同一条本地主链里，适合需要“用自然语言整理 Word 文档”的场景。

## 当前版本定位

`0.3.0` 版本对应当前仓库的真实形态，而不是历史设想：

- 它是本地桌面应用，不是在线 SaaS。
- 主链是 `React 前端 + Python 宿主 + TypeScript Agent Runtime`。
- TypeScript 负责会话状态、模式判定、规划、执行编排、任务审计和运行预算。
- Python 负责桌面 GUI、本地 Web API、TS CLI 桥接、Python 工具执行和最终 DOCX 物化。
- 文档 observation 已统一到一份共享 schema，Python 路径和 TS 原生 fallback 都向上暴露同一结构。
- 聊天式处理和模板式处理共享同一套宿主与运行时基础设施。

## 能力概览

- 会话管理：创建、切换、重命名、删除会话。
- 文档绑定：将当前 DOCX 附加到会话，并在后续轮次持续复用。
- 文档理解：总结结构、回答关于文档内容或格式的问题。
- 模式判定：自动区分 `chat`、`inspect`、`execute` 以及需要先澄清的场景。
- 格式执行：支持字体、字号、行距、颜色、对齐、加粗、斜体、下划线、删除线、高亮、全大写、段前段后、首行缩进、页面设置等能力。
- 结构操作：支持批量范围写入，也支持段落合并与拆分。
- 语义范围：支持 `正文`、`标题`、`列表项`、`全文` 和 `指定段落` 等范围。
- 模板工作区：支持导入 DOCX、选择 JSON 模板、启动模板任务并打开输出结果。
- 本地 API：支持同步消息、异步消息、任务状态轮询、模板任务轮询和配置读写。

## 仓库结构

- `src/frontend/`：桌面内嵌 Web UI，负责聊天界面、模板工作区、设置面板和会话侧栏。
- `src/python/gui/`：Qt 窗口与本地 Web API。
- `src/python/api/`：TS CLI bridge、模板 bridge、Python tool runner。
- `src/python/core/`：配置、路径和 Python 侧基础能力。
- `src/python/tools/`：Python 工具实现。
- `src/ts/src/runtime/`：会话服务、运行时、审计、状态存储、selector 扩展。
- `src/ts/src/document-tooling/`：observation 收口、策略和 facade。
- `src/ts/src/document-execution/`：执行 facade。
- `src/ts/src/templates/`：模板契约、分类、校验、规划和执行。
- `docs/`：用户与开发者文档。
- `tests/`：Python 侧测试。

## 环境要求

- Python 3.10 或更高版本
- Node.js（建议使用当前 LTS）
- `python-docx`
- `lxml`
- GUI 场景额外需要 `PyQt5` 与 `PyQtWebEngine`

安装 Python 依赖时：

```powershell
pip install -e .
pip install -e ".[gui]"
```

## 快速开始

### Windows 一键安装

仓库根目录提供了 `install_windows.bat`：

```powershell
.\install_windows.bat
```

安装器会自动完成以下事项：

- 创建项目本地虚拟环境 `.venv`
- 安装 Python 核心依赖与 GUI 依赖
- 安装并构建 `src/ts` 与 `src/frontend`
- 若 `config.json` 不存在，则从 `config.example.json` 自动生成

如需安装完成后立即尝试启动：

```powershell
.\install_windows.bat --launch
```

### 手动安装

1. 安装 Python 依赖

```powershell
pip install -e .
pip install -e ".[gui]"
```

2. 构建 TypeScript Agent

```powershell
cd src/ts
npm install
npm run build
```

3. 构建桌面前端

```powershell
cd src/frontend
npm install
npm run build
```

### 配置模型

首次运行会自动生成根目录 `config.json`。也可以手动复制示例配置：

```powershell
Copy-Item config.example.json config.json
```

当前配置分为两组：

- `chat`：负责聊天、问答和非执行型回复
- `planner`：负责规划、执行、模板分类和运行预算

配置示例：

```json
{
  "chat": {
    "base_url": "http://localhost:8080/v1",
    "api_key": "sk-...",
    "model": "model_name"
  },
  "planner": {
    "base_url": "http://localhost:8080/v1",
    "api_key": "sk-...",
    "model": "model_name",
    "timeout_ms": null,
    "step_timeout_ms": 60000,
    "task_timeout_ms": null,
    "python_tool_timeout_ms": null,
    "max_turns": 24,
    "sync_request_timeout_ms": 300000,
    "max_retries": 0,
    "temperature": 0.0,
    "use_json_schema": null,
    "schema_strict": null,
    "compat_mode": "auto",
    "runtime_mode": "react_loop"
  }
}
```

其中最常用的字段是：

- `planner.step_timeout_ms`：默认单步执行预算
- `planner.task_timeout_ms`：整轮任务总预算
- `planner.python_tool_timeout_ms`：单次 Python 工具调用预算
- `planner.max_turns`：`react_loop` 的最大轮数
- `planner.sync_request_timeout_ms`：同步 HTTP 等待上限
- `planner.runtime_mode`：`plan_once` 或 `react_loop`

## 启动方式

推荐使用带启动前检查的启动器：

```powershell
python scripts/launch_gui.py
```

Windows 下也可以直接运行：

```powershell
launch_gui.bat
```

启动器会检查：

- `PyQt5` 与 `PyQtWebEngine`
- `node` 是否可用
- `config.json` 是否存在
- `src/ts/dist/runtime/cli.js` 是否存在
- `src/frontend/dist/index.html` 是否存在
- `src/ts/src` 是否比 `src/ts/dist` 更新

## 典型使用流程

1. 启动桌面应用。
2. 创建新会话或切换到已有会话。
3. 在设置面板确认 `chat` 和 `planner` 模型配置可用。
4. 选择一个 `.docx` 文件。
5. 输入需求，例如“把正文改成宋体、小四、1.5 倍行距，标题加粗居中”。
6. 点击发送。
7. 在消息区查看进度和结果，并到 `output/` 查找生成文档。

需要特别注意两点：

- 选中文件后，前端会先把文件保存在“待发送”状态，真正导入发生在点击发送时。
- 即使只选文件、不输入文本，也可以发送；前端会自动补一条内部引导语。

## 模板工作区

当前前端内置 `/templates` 工作区，面向固定格式或模板化改写场景。

模板链路支持：

- 扫描根目录 `templates/` 下的 JSON 模板
- 导入待处理 DOCX
- 发起模板任务
- 轮询模板任务状态
- 打开模板输出目录

如果你处理的是“合同模板套用”“指定语义块统一样式”这类稳定场景，优先考虑模板工作区而不是自由对话。

## 独立提示词生成器

仓库根目录保留了一个独立工具：

```powershell
python prompt_generator.py
```

它不会接入主程序后端，也不会修改已有会话或文档，只负责收集格式要求并生成一段可直接复制的中文提示词。

## 本地 API 概览

当前宿主层提供的主要接口包括：

- `GET /api/health`
- `GET/POST /api/sessions`
- `GET/PATCH/DELETE /api/sessions/{sessionId}`
- `POST /api/sessions/{sessionId}/attach-document`
- `POST /api/sessions/{sessionId}/messages`
- `POST /api/sessions/{sessionId}/messages/async`
- `GET /api/sessions/{sessionId}/message-jobs/{jobId}`
- `GET/PUT /api/model-config`
- `GET /api/templates/configs`
- `POST /api/templates/import-document`
- `POST /api/templates/runs`
- `GET /api/templates/runs/{jobId}`
- `POST /api/templates/open-output`

同步入口和异步入口的区别：

- `/messages` 会在 `sync_request_timeout_ms` 内等待结果
- `/messages/async` 会立即返回 job，再由调用方轮询
- 同步返回超时不等于后台任务失败

## 运行时目录

- `config.json`：模型配置
- `sessions/`：会话状态数据库
- `output/`：生成后的 DOCX
- `agent_workspace/`：运行时工作区
- `.tmp/`：临时目录
- `.tmp/qtwebengine/`：Qt WebEngine 运行时目录

## 常见问题

### 启动时报缺少 GUI 依赖

执行：

```powershell
pip install -e .
pip install -e ".[gui]"
```

### 启动器提示 `src/ts/dist` 或 `src/frontend/dist` 不存在

说明构建产物缺失，重新执行：

```powershell
cd src/ts
npm install
npm run build
```

```powershell
cd src/frontend
npm install
npm run build
```

### 修改源码后，GUI 里仍是旧版本

桌面应用读取的是构建产物，不是源码目录。只要改了 `src/ts/src/` 或 `src/frontend/`，就需要重新构建。

### 同步请求超时，是不是已经失败了

不一定。

- `/messages` 只保证“这一跳最多等多久”
- 到达 `sync_request_timeout_ms` 后，返回的可能是 `E_SYNC_REQUEST_TIMEOUT`
- 这表示同步等待结束，不表示后台执行已经失败
- 是否真的失败，要以后续 job 状态为准

### 文档 observation 为什么有时不是同一路径

当前 observation 的设计是：

- 优先走 Python 工具链
- 允许在特定依赖缺失或解析失败场景下退到 TS 原生 fallback
- 两条路径都会输出同一份 schema，所以上层不需要区分两种 observation 类型

## 面向开发者

如果你要接手开发、排查主链或扩展能力，请优先阅读：

- [docs/项目详情.md](docs/项目详情.md)

建议先看这些入口：

- `scripts/launch_gui.py`
- `src/python/gui/web_window.py`
- `src/python/gui/web_api.py`
- `src/frontend/store/useChatStore.ts`
- `src/ts/src/runtime/session-service.ts`
- `src/ts/src/runtime/engine.ts`
