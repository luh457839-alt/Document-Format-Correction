# Phase 4 Handoff

## 范围

Phase 4 现在把 Phase 2 已能稳定编译的主要 patch type 真正落到了 `package_snapshot`，并在 `materialize` 前新增了显式的 relationship reconcile。`archive/legacy/` 在本阶段只保留迁移参考价值，不再参与当前 relationship 或 materialize 行为定义。

保留边界：

- `Phase 1` 继续负责解析、projection、patch target locator 基线
- `Phase 2` 继续负责 schema、target analysis、payload normalize、compile
- `Phase 3` 继续负责 graph、checkpoint、tool 调度与“仅实际写入后 materialize”

## 已支持矩阵

真实物化：

- 文本写入：`set_text`
- 行内样式：`set_font`、`set_size`、`set_font_color`、`set_bold`、`set_italic`、`set_underline`、`set_strike`、`set_highlight_color`、`set_all_caps`
- 段落样式：`set_alignment`、`set_line_spacing`、`set_paragraph_spacing`、`set_paragraph_indent`
- 通用 XML：`set_attr`、`remove_attr`、`ensure_node`、`remove_node`、`replace_node_xml`
- 静态 config/style/numbering：`set_page_layout`、`set_style_definition`、`set_numbering_level`、`set_settings_flag`

relationship reconcile 当前覆盖：

- 新增 `word/settings.xml` 时补 `document.xml.rels` 的 settings 关系与 `[Content_Types].xml` override
- 新增 header/footer 引用且 bundle 中只有一个可唯一推断的新 part 时，补 `.rels` 与 content type
- 新增 image `r:embed` 且 bundle 中只有一个可唯一推断的新 media part 时，补 `.rels`
- 已删除的受管关系引用会被清理，避免遗留悬挂 `r:id`

## 结构化拒绝

- `semantic_selector`：已接入 `title_like_paragraphs` / `body_like_paragraphs` 的真实候选解析与受限样式同步；脏样本或低置信场景返回 `E_SEMANTIC_TARGET_*` / `E_BODY_BASELINE_UNDERDETERMINED`
- `merge_paragraph` / `split_paragraph`：继续 compile 阶段失败
- 无法唯一推断目标的关系新增：`E_UNSUPPORTED_REFERENCE_KIND`
  - 当前最典型的是没有现成关系目标信息的 hyperlink
  - 多个候选 header/footer/media part 同时存在时，也会拒绝自动猜测

## 运行时收口

- `write_document` 仍是唯一写入口；语义 selector 也只在该责任链内部回落为普通 patch 编译/执行
- `materialize_and_reconcile` 现在改成：
  1. `reconcileBundleRelationships()`
  2. `materializeBundle()`
- `Phase3Diagnostic` 新增了 `reconcile` 阶段字段：
  - `reconciled_part_count`
  - `added_relationship_count`
  - `removed_relationship_count`
  - `unsupported_reference_kind`

## 已补测试

- `phase4-bundle-mutation.spec.ts`
  - 行内/段落样式同步到 XML、`document_ast`、`structure_index`
  - style/numbering/settings 静态目标真实落地
  - unresolved XML path 结构化失败
- `phase4-relationship-reconcile.spec.ts`
  - settings 关系补齐
  - header 引用补齐
  - hyperlink 无法推断时结构化失败
- `phase3-runtime.spec.ts`
  - chat 模式真实样式写入 + reconcile + materialize
  - template 模式创建 settings 关系后 materialize
- `phase2-write-tool.spec.ts`
  - synthetic static target 不再被分析阶段错误拦截

## Phase 5 接缝

- hyperlink 若要真正支持“新增外链”，需要引入显式 target 元数据，而不是依赖 reconcile 猜测
- media/header/footer 目前只支持“唯一候选 part”场景，复杂资源建模仍需下一阶段扩展
- 当前突变层仍是定向同步，不是全量 AST 重建；如果后续要支持更深的结构改写，应考虑引入更系统的局部重建或 in-memory reparse

## 一句话结论

Phase 4 已把当前主链的真实物化与 relationship reconcile 边界写实到位；后续新增写入能力仍应建立在 `src/langgraph-ts` 的现行合同、handoff 与测试之上，而不是回到 `archive/legacy/` 查找当前正确行为定义。
