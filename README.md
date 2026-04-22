# 文档格式修正 Agent V0.2

文档格式修正 Agent 是一个面向本地桌面场景的 DOCX 处理工具。它把聊天交互、文档观察和格式修改放到同一个界面里，适合需要“用自然语言整理 Word 文档”的用户。

## 适用场景

- 统一正文、标题、列表等段落的字体、字号、颜色、对齐方式。
- 让系统先分析文档结构，再决定如何处理。
- 在本地桌面环境中完成 DOCX 导入、对话和结果导出。

## 你可以直接这样理解它

- 这是一个本地桌面应用，不是在线 SaaS。
- 你可以只发文本、只发文件，或者同时发文本和文件。
- 选择 DOCX 后，文件会先进入待发送状态；点击发送后才会真正导入并开始处理。
- 生成后的文档默认写到根目录 `output/`。

## 主要能力

- 会话管理：创建、切换、重命名、删除对话。
- 文档导入：把当前 DOCX 绑定到会话。
- 文档理解：总结结构、回答关于文档内容或格式的问题。
- 格式执行：按自然语言修改字体、字号、颜色、对齐、加粗、斜体、下划线、删除线、高亮等。
- 结构范围编辑：可按正文、标题、列表项、全文或指定段落范围执行。
- 歧义澄清：当「正文」「这部分」这类描述不够明确时，系统会先追问范围，而不是直接猜测。

## 环境要求

- Python 3.10 或更高版本
- Node.js（用于 TS Agent 和前端构建）
- `python-docx`
- `lxml`
- `PyQt5`
- `PyQtWebEngine`

使用 `pip install -e .` 可安装核心依赖，使用 `pip install -e ".[gui]"` 可补齐桌面 GUI 依赖。

## 快速开始

### Windows 一键安装

仓库根目录新增了 `install_windows.bat`，Windows 用户下载后可直接双击执行，或者在终端中运行：

```powershell
.\install_windows.bat
```

这个安装器会自动完成以下事项：

- 创建项目本地虚拟环境 `.venv`
- 安装 Python 核心依赖和 GUI 依赖
- 安装并构建 `src/ts` 与 `src/frontend`
- 若 `config.json` 不存在，则从 `config.example.json` 自动复制

安装完成后，只需要修改 `config.json` 中的模型配置，再双击 `launch_gui.bat` 即可启动。若希望安装完成后立即尝试启动，可使用：

```powershell
.\install_windows.bat --launch
```

### 1. 安装 Python 依赖

```powershell
pip install -e .
pip install -e ".[gui]"
```

### 2. 构建 TypeScript Agent

```powershell
cd src/ts
npm install
npm run build
```

### 3. 构建桌面前端

```powershell
cd src/frontend
npm install
npm run build
```

### 4. 配置模型

首次运行会自动生成根目录 `config.json`。现在仓库也提供了一个可提交的示例文件 `config.example.json`，建议先复制一份为 `config.json`，再把其中的模型地址、API Key 和模型名改成可用值。当前配置文件包含两个部分：

- `chat`：用于聊天、分析文档和生成回答
- `planner`：用于规划和执行文档修改

推荐命令：

```powershell
Copy-Item config.example.json config.json
```

示例结构：

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
    "runtime_mode": "react_loop"
  }
}
```

### 5. 启动桌面应用

推荐使用带启动前检查的启动器：

```powershell
python scripts/launch_gui.py
```

Windows 下也可以直接双击：

```powershell
launch_gui.bat
```

## 日常使用流程

1. 启动应用并进入主界面。
2. 创建或选择一个会话。
3. 在设置面板中确认聊天模型和规划模型可用。
4. 选择一个 `.docx` 文件。
5. 输入你的目标，例如“把正文改成小四号宋体，标题加粗居中”。
6. 点击发送，系统会在同一轮里完成会话创建、文档绑定和请求提交。
7. 在界面中查看结果，并到 `output/` 查找生成文档。

如果你只选择文件、不输入文本，也可以直接发送。系统会自动补一条内部引导语，先分析文档再开始处理。

## 运行时目录

- `config.json`：模型配置
- `sessions/`：会话状态数据库
- `output/`：生成后的文档
- `agent_workspace/`：运行时工作区
- `.tmp/`：临时文件目录

## 常见问题

### 启动时报缺少依赖

先执行：

```powershell
pip install -e .
pip install -e ".[gui]"
```

如果报的是 `PyQt5` 或 `PyQtWebEngine` 缺失，通常就是 GUI 依赖没有安装完整。

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

### 修改了源码但 GUI 里还是旧版本

桌面应用读取的是构建产物，而不是源码本身。只要改了 `src/ts/src/` 或 `src/frontend/`，都需要重新构建。

### 点击发送后处理失败

优先检查以下几项：

- `config.json` 中的模型地址、密钥和模型名是否可用
- Python 依赖是否齐全，尤其是 `python-docx` 和 `lxml`
- Node.js 是否可用
- 目标文件是否为合法 `.docx`

## 面向开发者的文档

如果你要接手开发、排查链路或扩展能力，请优先阅读：

- [项目详情](docs/项目详情.md)

该文档面向开发者，包含架构、模块职责、关键链路、测试命令和维护建议。
