from __future__ import annotations

import sys
from dataclasses import dataclass

try:
    from PyQt5.QtCore import Qt
    from PyQt5.QtWidgets import (
        QApplication,
        QComboBox,
        QFormLayout,
        QHBoxLayout,
        QLabel,
        QMessageBox,
        QPushButton,
        QPlainTextEdit,
        QVBoxLayout,
        QWidget,
    )
except ImportError:  # pragma: no cover
    QApplication = None
    QComboBox = None
    QFormLayout = None
    QHBoxLayout = None
    QLabel = None
    QMessageBox = None
    QPushButton = None
    QPlainTextEdit = None
    QVBoxLayout = None
    QWidget = object
    Qt = None


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    placeholder: str
    options: tuple[str, ...]
    prohibition: str


FIELD_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec(
        key="title",
        label="标题",
        placeholder="例如：一级标题改为黑体、三号、居中",
        options=(
            "一级标题改为黑体、三号、居中",
            "各级标题统一编号格式并左对齐",
            "标题仅调整字号层级，不改动文字内容",
        ),
        prohibition="未明确要求的标题禁止修改。",
    ),
    FieldSpec(
        key="body",
        label="正文",
        placeholder="例如：正文改为宋体、小四、1.5 倍行距",
        options=(
            "正文改为宋体、小四、1.5 倍行距",
            "正文首行缩进 2 字符，两端对齐",
            "正文段前段后统一为 0 行",
        ),
        prohibition="未明确要求的正文禁止修改。",
    ),
    FieldSpec(
        key="list",
        label="列表",
        placeholder="例如：项目符号列表统一缩进并与正文对齐",
        options=(
            "项目符号列表统一缩进并与正文对齐",
            "编号列表统一编号样式和层级缩进",
            "列表项之间不额外增加空行",
        ),
        prohibition="未明确要求的列表禁止修改。",
    ),
    FieldSpec(
        key="table",
        label="表格",
        placeholder="例如：表格文字改为五号宋体，单元格内容垂直居中",
        options=(
            "表格文字改为五号宋体，单元格内容垂直居中",
            "表格标题行加粗并居中",
            "表格不调整列宽，只统一单元格内文本格式",
        ),
        prohibition="未明确要求的表格禁止修改。",
    ),
    FieldSpec(
        key="image_caption",
        label="图片标题",
        placeholder="例如：图片标题统一置于图片下方并居中",
        options=(
            "图片标题统一置于图片下方并居中",
            "图片标题改为宋体五号并编号",
            "图片标题与正文间距统一",
        ),
        prohibition="未明确要求的图片标题禁止修改。",
    ),
    FieldSpec(
        key="header_footer",
        label="页眉页脚",
        placeholder="例如：页眉保留文档标题，页脚留空",
        options=(
            "页眉保留文档标题，页脚留空",
            "页眉页脚统一改为宋体小五",
            "首页与其他页页眉页脚保持一致",
        ),
        prohibition="未明确要求的页眉页脚禁止修改。",
    ),
    FieldSpec(
        key="page_number",
        label="页码",
        placeholder="例如：页码置于页脚居中，从正文首页开始连续编号",
        options=(
            "页码置于页脚居中，从正文首页开始连续编号",
            "页码使用阿拉伯数字并右对齐",
            "封面和目录不显示页码",
        ),
        prohibition="未明确要求的页码禁止修改。",
    ),
    FieldSpec(
        key="signature",
        label="落款",
        placeholder="例如：落款右对齐，日期位于署名下一行",
        options=(
            "落款右对齐，日期位于署名下一行",
            "署名和日期统一为宋体四号",
            "落款与正文之间保留两行空白",
        ),
        prohibition="未明确要求的落款禁止修改。",
    ),
    FieldSpec(
        key="global_notes",
        label="全局补充要求",
        placeholder="例如：仅调整格式，不改写任何内容文本",
        options=(
            "仅调整格式，不改写任何内容文本",
            "若要求不明确，则保持原样并避免猜测",
            "所有未提及部分一律维持当前样式",
        ),
        prohibition="未明确要求的全局补充要求禁止擅自推断或追加。",
    ),
)


def _clean_text(value: str | None) -> str:
    if value is None:
        return ""
    return " ".join(value.split()).strip()


def _ensure_sentence(value: str) -> str:
    text = _clean_text(value)
    if not text:
        return ""
    if text.endswith(("。", "！", "？", ".", "!", "?")):
        return text
    return f"{text}。"


def build_prompt(field_values: dict[str, str] | None) -> str:
    normalized_values = {
        field.key: _clean_text((field_values or {}).get(field.key, ""))
        for field in FIELD_SPECS
    }

    positive_items = [
        f"{field.label}：{_ensure_sentence(normalized_values[field.key])}"
        for field in FIELD_SPECS
        if normalized_values[field.key]
    ]
    negative_items = [
        field.prohibition for field in FIELD_SPECS if not normalized_values[field.key]
    ]

    positive_section = (
        "\n".join(f"{index}. {item}" for index, item in enumerate(positive_items, start=1))
        if positive_items
        else "本次未提供任何明确的格式修改要求。"
    )
    negative_section = "\n".join(
        f"{index}. {item}" for index, item in enumerate(negative_items, start=1)
    )

    sections = [
        "任务目标",
        "请根据以下“文档格式修改需求”执行格式调整，只允许修改已明确指定的部分；"
        "未明确指定的部分一律保持原样，不得猜测、补充或扩大修改范围。",
        "",
        "已明确指定的修改项",
        positive_section,
        "",
        "未指定项的禁止修改约束",
        negative_section,
        "",
        "执行原则",
        "1. 仅修改上面已明确指定的部分，不得擅自推断用户意图或延伸解释。",
        "2. 不得改写正文内容、段落语义、数据含义或信息结构，除非要求中已明确写出。",
        "3. 对仍有歧义的地方保持原样，不要自行选择某一种理解后执行。",
        "4. 整体执行应精确、保守、可回溯，避免引入额外格式漂移或重复调整。",
    ]
    return "\n".join(sections)


class PromptGeneratorWindow(QWidget):
    def __init__(self) -> None:
        if (
            QApplication is None
            or QComboBox is None
            or QFormLayout is None
            or QHBoxLayout is None
            or QLabel is None
            or QPushButton is None
            or QPlainTextEdit is None
            or QVBoxLayout is None
            or Qt is None
        ):
            raise RuntimeError("缺少 PyQt5 依赖，无法启动提示词生成器。")

        super().__init__()
        self._combos: dict[str, QComboBox] = {}
        self._result_box: QPlainTextEdit | None = None
        self._status_label: QLabel | None = None
        self.setWindowTitle("格式修改需求描述生成器")
        self.resize(980, 760)
        self._build_ui()

    def _build_ui(self) -> None:
        root_layout = QVBoxLayout(self)
        root_layout.setContentsMargins(20, 20, 20, 20)
        root_layout.setSpacing(16)

        title_label = QLabel("格式修改需求描述生成器", self)
        title_label.setStyleSheet("font-size: 22px; font-weight: 600;")
        root_layout.addWidget(title_label)

        intro_label = QLabel(
            "填写或选择各项文档格式要求后，页面会生成一段可直接复制给模型的中文长提示词。"
            "未填写的字段会自动转成“禁止修改”约束，以减少模型擅自扩展修改范围。",
            self,
        )
        intro_label.setWordWrap(True)
        intro_label.setStyleSheet("color: #374151; font-size: 13px; line-height: 1.5;")
        root_layout.addWidget(intro_label)

        form_layout = QFormLayout()
        form_layout.setLabelAlignment(Qt.AlignTop)
        form_layout.setFormAlignment(Qt.AlignTop)
        form_layout.setVerticalSpacing(12)
        form_layout.setHorizontalSpacing(14)

        for field in FIELD_SPECS:
            combo = QComboBox(self)
            combo.setEditable(True)
            combo.addItems(field.options)
            combo.setCurrentText("")
            combo.setInsertPolicy(QComboBox.NoInsert)
            if combo.lineEdit() is not None:
                combo.lineEdit().setPlaceholderText(field.placeholder)
            combo.setMinimumHeight(34)
            self._combos[field.key] = combo
            form_layout.addRow(f"{field.label}：", combo)

        root_layout.addLayout(form_layout)

        button_layout = QHBoxLayout()
        button_layout.setSpacing(10)

        generate_button = QPushButton("生成提示词", self)
        generate_button.clicked.connect(self.generate_prompt)
        button_layout.addWidget(generate_button)

        copy_button = QPushButton("复制结果", self)
        copy_button.clicked.connect(self.copy_prompt)
        button_layout.addWidget(copy_button)

        button_layout.addStretch(1)
        root_layout.addLayout(button_layout)

        self._status_label = QLabel("结果文本框支持继续手动编辑。", self)
        self._status_label.setStyleSheet("color: #4b5563; font-size: 12px;")
        root_layout.addWidget(self._status_label)

        self._result_box = QPlainTextEdit(self)
        self._result_box.setPlaceholderText("点击“生成提示词”后，这里会出现可直接复制给模型的完整提示词。")
        self._result_box.setLineWrapMode(QPlainTextEdit.WidgetWidth)
        self._result_box.setMinimumHeight(280)
        root_layout.addWidget(self._result_box, 1)

    def _collect_values(self) -> dict[str, str]:
        return {
            key: combo.currentText()
            for key, combo in self._combos.items()
        }

    def generate_prompt(self) -> None:
        if self._result_box is None:
            return

        prompt = build_prompt(self._collect_values())
        self._result_box.setPlainText(prompt)
        if self._status_label is not None:
            self._status_label.setText("提示词已生成，可直接复制或继续手动编辑。")

    def copy_prompt(self) -> None:
        if QApplication is None or self._result_box is None:
            return

        prompt = _clean_text(self._result_box.toPlainText())
        if not prompt:
            if self._status_label is not None:
                self._status_label.setText("当前没有可复制的内容，请先生成提示词。")
            return

        clipboard = QApplication.clipboard()
        try:
            clipboard.setText(self._result_box.toPlainText())
        except Exception as exc:  # pragma: no cover
            if self._status_label is not None:
                self._status_label.setText("复制失败，请手动选中文本框内容复制。")
            if QMessageBox is not None:
                QMessageBox.warning(
                    self,
                    "复制失败",
                    f"写入系统剪贴板失败：{exc}\n请手动选中文本框内容复制。",
                )
            return

        if self._status_label is not None:
            self._status_label.setText("提示词已复制到剪贴板。")


def run() -> int:
    if QApplication is None:
        print("缺少 PyQt5 依赖，无法启动提示词生成器。", file=sys.stderr)
        return 1

    app = QApplication(sys.argv)
    window = PromptGeneratorWindow()
    window.show()
    return app.exec_()


if __name__ == "__main__":
    raise SystemExit(run())
