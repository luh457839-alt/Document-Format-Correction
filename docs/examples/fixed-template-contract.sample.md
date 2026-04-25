# fixed-template-contract.sample.json 模板编写规范

## 1. 当前标准模板定位

`fixed-template-contract.sample.json` 现在表示“默认放行模板”，不是“默认严格模板”。

它和 `templates/test_1.json` 一样遵循“默认不校验”的运行原则；其中 `templates/test_1.json` 已进一步收敛为仅保留格式设置的纯格式模板：

- 默认不做结构性校验。
- 默认不做格式性校验。
- 默认允许空文本。
- 语义集合主要用于分类、写入映射和未来可选校验，不代表默认拦截条件。

这意味着用户上传任何格式的文档都允许通过，包括：

- 只有标题没有正文。
- 没有主标题。
- 表格空单元格。
- 空白段较多。
- 顺序混乱。
- 编号不匹配。
- 样式不匹配。

只有用户明确要求时，才应切换到启用校验的模板或策略。

## 2. 默认放行与显式校验

统一总开关位于：

- `validation_policy.enforce_validation`

固定语义如下：

- `true`：启用模板校验。
- `false` 或缺失：不启用模板校验。

当 `enforce_validation !== true` 时：

- 不因必填语义缺失失败。
- 不因 occurrence 上下限失败。
- 不因 conflict、unmatched、顺序、编号、样式失败。
- 不生成 `body_paragraph` 编号前缀 warning。

细分开关只在 `enforce_validation=true` 时才有意义：

- `require_all_required_semantics`
- `reject_conflicting_matches`
- `reject_order_violations`
- `reject_style_violations`
- `reject_unmatched_when_required`

旧模板即使把这些字段写成 `true`，只要没有显式设置 `enforce_validation=true`，运行时也不会拦截。

## 3. 当前标准语义集合

标准模板仍保留以下原子语义，用于覆盖解析器当前稳定可见的 paragraph 结构类型：

- `cover_image`
- `document_title`
- `heading_level_1`
- `heading_level_2`
- `heading_level_3`
- `body_paragraph`
- `list_item_level_0`
- `list_item_level_1`
- `table_text`
- `blank_or_unknown`

这里要明确：

- `document_title` 仍属于标准原子语义集合，但默认不要求每个文档实例命中。
- `body_paragraph` 仍可作为正文映射语义存在，但默认不再承担“缺失即失败”的责任。
- `heading_level_n` 表示 DOCX 原生标题层级，不表示固定编号形态。

## 4. 规则字段与示例字段

先固定一个容易误用的边界：

- `examples` / `negative_examples` 是示例字段，用于提供分类参考信号。
- `numbering_patterns` 是规则字段，用于对已完成分类的段落做可选校验。
- `numbering_patterns` 不参与 paragraph owner 决策，不能代替标题、正文、列表的归属判断。

默认放行模式下，即使配置了 `numbering_patterns`，也不会据此拦截文档。只有显式开启 `enforce_validation=true` 后，编号规则才会参与校验。

## 5. 语义层设计

sample 继续区分两层语义：

- `semantic_blocks`：原子语义，负责 paragraph 级单 owner 归属。
- `derived_semantics`：派生语义，负责聚合或细分业务语义。

推荐理解方式：

- 原子语义负责“这段文本在结构上属于什么”。
- 派生语义负责“这段文本在业务上应如何被组合或细分”。

因此，标准模板仍建议先按结构事实建模，再按业务解释做派生，而不是直接用业务章节名替代结构语义。

## 6. `blank_or_unknown` 与空文本

标准模板中的宽松策略还体现在：

- 所有关键 `style_hints` 默认都允许 `allow_empty_text: true`。
- `blank_or_unknown` 继续吸收空白段、装饰段和 `unknown` bucket。
- `blank_or_unknown` 不是万能桶，不能替代表格、列表、正文或图片的结构覆盖。

对 `cover_image` 仍保留这些结构约束：

- `require_image=true`
- `must_not_be_in_table=true`

但它默认不再依赖文首位置约束去拦截文档。

## 7. 给 LLM 或人工编写模板的建议

建议顺序：

1. 先确认目标文档会出现哪些 paragraph 结构类型。
2. 用原子 `semantic_blocks` 覆盖这些结构类型。
3. 为每个原子语义补齐 `semantic_rules` 与 `operation_blocks`。
4. 默认保持放行策略，不把缺失、顺序、编号、样式直接写成失败条件。
5. 只有在业务明确要求拦截时，才设置 `enforce_validation=true` 并补齐严格规则。
6. 再按需要添加 `derived_semantics`。

## 8. 何时切换到严格模式

只有下面这类场景才建议显式启用校验：

- 用户明确要求“必须有标题/正文/固定顺序”。
- 用户明确要求“编号不对就报错”。
- 用户明确要求“样式不符合模板就阻断”。
- 业务确实需要把 unmatched 或 conflict 当成失败。

启用方式：

- 设置 `validation_policy.enforce_validation=true`
- 再按需打开各个细分开关
- 再根据业务补充 occurrence、position、numbering、style 等规则

如果没有这类明确要求，就继续使用默认放行模板。
