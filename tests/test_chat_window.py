from __future__ import annotations

import unittest
from pathlib import Path


class GuiEntryPointTest(unittest.TestCase):
    def test_launch_gui_batch_uses_conda_agent_env(self) -> None:
        script = Path("launch_gui.bat").read_text(encoding="utf-8")

        self.assertIn("conda", script.lower())
        self.assertIn("Agent", script)
        self.assertIn("scripts\\launch_gui.py", script)

    def test_run_gui_uses_web_window_entry(self) -> None:
        script = Path("scripts/run_gui.py").read_text(encoding="utf-8")

        self.assertIn("from src.python.gui.web_window import run", script)
        self.assertNotIn("from src.python.gui.chat_window import run", script)

    def test_readme_documents_web_frontend_desktop_flow(self) -> None:
        readme = Path("README.md").read_text(encoding="utf-8")

        self.assertIn("src/python/gui/web_window.py", readme)
        self.assertIn("src/python/gui/web_api.py", readme)
        self.assertNotIn("src/python/gui/chat_window.py", readme)
        self.assertIn("src/frontend/dist", readme)
        self.assertIn("python scripts/launch_gui.py", readme)
        self.assertIn("launch_gui.bat", readme)
        self.assertIn("PyQtWebEngine", readme)


if __name__ == "__main__":
    unittest.main()
