from __future__ import annotations

import unittest

import prompt_generator


class PromptGeneratorPromptTest(unittest.TestCase):
    def test_field_specs_cover_expected_document_parts(self) -> None:
        keys = [field.key for field in prompt_generator.FIELD_SPECS]

        self.assertEqual(
            keys,
            [
                "title",
                "body",
                "list",
                "table",
                "image_caption",
                "header_footer",
                "page_number",
                "signature",
                "global_notes",
            ],
        )

    def test_build_prompt_with_all_fields_empty_adds_only_prohibitions(self) -> None:
        prompt = prompt_generator.build_prompt({})

        self.assertIn("任务目标", prompt)
        self.assertIn("已明确指定的修改项", prompt)
        self.assertIn("本次未提供任何明确的格式修改要求。", prompt)
        self.assertIn("未指定项的禁止修改约束", prompt)
        self.assertIn("未明确要求的标题禁止修改。", prompt)
        self.assertIn("未明确要求的正文禁止修改。", prompt)
        self.assertIn("未明确要求的列表禁止修改。", prompt)
        self.assertIn("未明确要求的表格禁止修改。", prompt)
        self.assertIn("未明确要求的图片标题禁止修改。", prompt)
        self.assertIn("未明确要求的页眉页脚禁止修改。", prompt)
        self.assertIn("未明确要求的页码禁止修改。", prompt)
        self.assertIn("未明确要求的落款禁止修改。", prompt)
        self.assertIn("未明确要求的全局补充要求禁止擅自推断或追加。", prompt)

    def test_build_prompt_with_partial_fields_combines_positive_and_negative_rules(self) -> None:
        prompt = prompt_generator.build_prompt(
            {
                "title": "一级标题改为黑体、三号、居中",
                "body": "正文改为宋体、小四、1.5 倍行距",
                "global_notes": "仅调整格式，不改写任何内容文本",
            }
        )

        self.assertIn("标题：一级标题改为黑体、三号、居中。", prompt)
        self.assertIn("正文：正文改为宋体、小四、1.5 倍行距。", prompt)
        self.assertIn("全局补充要求：仅调整格式，不改写任何内容文本。", prompt)
        self.assertIn("未明确要求的列表禁止修改。", prompt)
        self.assertIn("未明确要求的表格禁止修改。", prompt)
        self.assertIn("未明确要求的页码禁止修改。", prompt)
        self.assertIn("仅修改上面已明确指定的部分", prompt)


if __name__ == "__main__":
    unittest.main()
