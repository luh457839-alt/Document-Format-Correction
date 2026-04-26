# fixed-template-contract.sample.json Patch DSL 示例说明

## 1. 当前 sample 的定位

`fixed-template-contract.sample.json` 现在是一份面向模板子系统 `2.0` 契约的 Patch DSL 示例。

这份示例的目标有两个：

- 说明固定模板在新执行模型下应该怎样写 `patch_blocks`。
- 给模板作者一个可裁剪的结构语义母版，同时保留默认放行策略。

它仍然遵循宽松默认值：

- 默认不做结构性校验。
- 默认不做格式性校验。
- 默认允许空文本。
- 用户上传任何格式的文档都允许通过。

语义集合主要用于分类、写入映射和未来可选校验，而不是默认把所有不规范文档拦下来。

## 2. 主契约已经切到 `patch_blocks`

在 `schema_version = "2.0"` 下，`patch_blocks` 是唯一主写入契约。

每个 block 都由两部分组成：

- `selector`：声明 patch 要落到文档的哪个 part、哪个 scope。
- `operations`：声明要执行的样式 alias 或 XML primitive。

这份 sample 里同时展示了两类 block：

- 段落级 block：例如 `document_title`、`body_paragraph`、`table_text`。
- 文档级 block：例如 `document_page_layout`，通过 `document + section` selector 修改纸张和页边距。

`operation_blocks` 仍然只是兼容输入，不再作为新示例的主断言对象。

## 3. `selector + operations` 怎么理解

模板里的 `selector` 负责定位 patch 作用范围。当前公开契约支持的主路径包括：

- `document / paragraph`
- `document / run`
- `document / section`
- `styles / style`
- `numbering / numbering_level`
- `settings / settings_node`
- `by_part_path / *`

`operations` 则负责描述修改动作。现在可稳定使用的几类改动包括：

- `set_run_style`：修改 run 级字体、字号、颜色、粗斜体等。
- `set_paragraph_style`：修改段落对齐、行距、首行缩进、段前段后间距。
- `set_section_layout`：修改纸张与页边距。
- `set_style_definition`：修改样式定义 part。
- `set_numbering_level`：修改编号级别定义。
- `set_settings_flag`：修改文档 settings 节点。
- `set_attr` / `remove_attr` / `set_text` / `remove_node` / `ensure_node` / `replace_node_xml`：直接做 XML 级 patch。

这也是这次重构真正扩出来的能力边界：不再只停留在“按段落写样式”，而是可以对文档包内多个 part 做稳定 patch。

## 4. 这份 sample 覆盖了哪些文档改动

示例当前直接覆盖的改动类型如下：

- 标题、正文、各级标题、列表、表格文本的段落级样式调整。
- 图片段落的对齐方式调整。
- 文档纸张和页边距调整。
- 业务派生语义的聚合与细分写入视图。

如果继续扩展同一套 DSL，还可以支持：

- 样式表定义更新。
- 编号级别定义更新。
- settings part 开关写入。
- 针对任意 XML 节点的精确属性或节点替换。

## 5. 为什么还保留 `style_reference`

`style_reference` 在这里仍然保留，但它的角色已经收敛为说明性元数据：

- 用来记录页面规格和人工可读的格式说明。
- 用来辅助文档、模板评审和 LLM 生成。
- 不再等同于最终执行真源。

真正参与执行的是 `patch_blocks`。

## 6. `semantic_blocks`、`derived_semantics` 和 `patch_blocks` 的边界

三者的分工现在更清晰：

- `semantic_blocks`：负责 paragraph 级分类覆盖。
- `derived_semantics`：负责业务语义聚合或细分，不改变原子 owner。
- `patch_blocks`：负责真正可执行的 patch DSL。

因此，不要把示例字段当规则，也不要把分类字段和写入字段混写在一起。

这里的边界仍然要明确：

- `examples` / `negative_examples` 是示例字段。
- `position_hints`、`style_hints`、`occurrence` 是规则字段。
- `selector`、`operations` 是执行字段。

## 7. mixed-language 字体覆盖怎么处理

当前主契约已经切到 `patch_blocks`，但 mixed-language run 拆分后的 `language_font_overrides` 仍属于兼容层能力。

这意味着：

- 新模板优先用 `patch_blocks` 表达主路径写入。
- 如果业务必须对中英文 run 分别覆写字体，当前仍可通过兼容输入追加 run 级 patch。
- 这份 public sample 不再把兼容字段当主契约展示。

## 8. 为什么仍然保持默认放行

这份示例是“新契约下的标准写法样板”，不是“默认严格模板”。

因此仍保持：

- 缺主标题允许通过。
- 缺图片段落允许通过。
- 缺表格文本允许通过。
- 存在空白段或未知段落时允许通过。

只有用户明确要求严格模式时，才建议打开 `validation_policy.enforce_validation = true`，再继续补顺序、数量、样式和编号拦截规则。
