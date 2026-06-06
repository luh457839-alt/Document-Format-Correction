# Review 问题与缺陷记录

本文档用于记录本项目 review 中发现的问题、缺陷、风险和处理状态。所有有效 review finding 都应追加记录；无阻塞问题时也应记录残余风险。

## 记录规则

- 每次 review 后追加记录。
- Findings 按严重程度记录，避免只写结论不写证据。
- 状态变化通过追加“状态更新”记录，不删除原始 finding。

## 严重程度

- `critical`：会导致数据损坏、安全问题、生产不可用或核心流程失败。
- `high`：重要功能错误、明显行为回归或验证缺失。
- `medium`：边界问题、可恢复错误、重要但不阻塞的质量问题。
- `low`：可维护性、诊断、文档或轻微一致性问题。
- `none`：未发现阻塞问题，仅记录残余风险。

## 状态

- `open`
- `accepted`
- `fixed`
- `deferred`
- `won't-fix`

## 记录模板

```markdown
### YYYY-MM-DD HH:mm - Review 标题

- Review 对象：
- 严重程度：critical | high | medium | low | none
- 问题：
- 证据：
- 影响：
- 建议：
- 状态：open | accepted | fixed | deferred | won't-fix
```

## Review 记录

### 2026-06-06 施工工作流 Skill 初始化 Review

- Review 对象：项目级施工/review 留档流程。
- 严重程度：none
- 问题：未发现阻塞问题。
- 证据：流程已明确施工记录、review 记录和 handoff 读取要求。
- 影响：无。
- 建议：后续可根据实际使用情况补充 `AGENTS.md`，提高 repo-local Skill 的自动发现概率。
- 状态：open

### 2026-06-06 18:24 - 工程文件命名与历史文档清理 Review

- Review 对象：前端/测试/文档重命名与历史文档删除结果。
- 严重程度：medium
- 问题：重命名后的目标文件仍未被 Git 跟踪，提交前存在只提交删除旧文件、遗漏新增文件的风险。
- 证据：`git status --short -- src/frontend tests/test_workspace_web_api_contracts.py tests/test_frontend_workspace_contracts.py docs/工作区API与模板契约.md docs/前端工作台设计方案.md docs/施工目标与变更记录.md docs/review问题与缺陷记录.md` 显示上述目标路径均为 `??`；`git ls-files -- ...` 对这些路径无输出。
- 影响：当前工作区验证可通过，但若后续提交未显式纳入这些未跟踪文件，会导致前端入口、重命名后的契约测试、迁移后的契约/设计文档和审计记录在版本库中缺失。
- 建议：提交前明确版本管理策略；若接受本次重命名结果，应将上述新路径加入 Git，并确认 `src/frontend/node_modules/` 与构建产物仍保持忽略。
- 状态：open

### 2026-06-06 18:27 - Review 状态更新

- Review 对象：工程文件命名与历史文档清理 Review。
- 严重程度：none
- 问题：状态更新。
- 证据：已执行 `git add -A` 暂存非忽略变更；`git diff --cached --name-only` 未命中 `node_modules`、`dist` 或 tsbuildinfo；`src/node_modules/` 已加入 `.gitignore`。
- 影响：重命名后的前端、测试、文档和审计记录会随本次提交进入版本库。
- 建议：保持依赖目录和构建产物忽略；后续提交前继续检查 staged 清单。
- 状态：fixed
