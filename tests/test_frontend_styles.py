from __future__ import annotations

import unittest
from pathlib import Path


class FrontendBaseStylesTest(unittest.TestCase):
    def test_button_reset_exists_in_base_layer(self) -> None:
        css = Path("src/frontend/index.css").read_text(encoding="utf-8")

        self.assertIn("@layer base", css)
        self.assertIn("button,", css)
        self.assertIn("input[type='button']", css)
        self.assertIn("input[type='submit']", css)
        self.assertIn("input[type='reset']", css)

        expected_rules = (
            "appearance: none;",
            "-webkit-appearance: none;",
            "background-color: transparent;",
            "background-image: none;",
            "border: 0 solid transparent;",
            "color: inherit;",
        )
        for rule in expected_rules:
            with self.subTest(rule=rule):
                self.assertIn(rule, css)

    def test_session_list_buttons_disable_inner_focus_outline(self) -> None:
        session_list = Path("src/frontend/components/sidebar/SessionList.tsx").read_text(
            encoding="utf-8"
        )

        self.assertIn("focus:outline-none", session_list)
        self.assertIn("focus-visible:outline-none", session_list)


if __name__ == "__main__":
    unittest.main()
