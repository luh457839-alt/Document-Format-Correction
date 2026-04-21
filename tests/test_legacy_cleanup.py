from __future__ import annotations

import importlib
import unittest
from pathlib import Path


class LegacyCleanupTest(unittest.TestCase):
    def test_api_package_only_exposes_ts_bridge_chain(self) -> None:
        api_module = importlib.import_module("src.python.api")

        self.assertFalse(hasattr(api_module, "AgentMemoryAPI"))
        self.assertFalse(hasattr(api_module, "LocalChatAPI"))
        self.assertFalse(hasattr(api_module, "run_ts_agent"))
        self.assertFalse(hasattr(api_module, "run_ts_agent_command"))
        self.assertTrue(hasattr(api_module, "create_session"))
        self.assertTrue(hasattr(api_module, "list_sessions"))
        self.assertTrue(hasattr(api_module, "submit_agent_turn"))
        self.assertTrue(hasattr(api_module, "attach_document"))
        self.assertTrue(hasattr(api_module, "get_session_state"))
        self.assertTrue(hasattr(api_module, "update_session_title"))
        self.assertTrue(hasattr(api_module, "delete_session"))

    def test_core_package_no_longer_exports_legacy_context_chain(self) -> None:
        core_module = importlib.import_module("src.python.core")

        self.assertFalse(hasattr(core_module, "AgentRuntime"))
        self.assertFalse(hasattr(core_module, "ContextAssembler"))
        self.assertFalse(hasattr(core_module, "StateSynchronizer"))
        self.assertTrue(hasattr(core_module, "UniversalDocxParser"))

    def test_legacy_python_modules_are_removed(self) -> None:
        legacy_modules = [
            "api.agent_memory_api",
            "api.local_chat_api",
            "core.agent_runtime",
            "core.context_assembler",
            "core.state_synchronizer",
            "src.python.api.agent_memory_api",
            "src.python.api.local_chat_api",
            "src.python.core.agent_runtime",
            "src.python.core.context_assembler",
            "src.python.core.state_synchronizer",
            "memory",
            "memory.loader",
            "memory.manager",
        ]

        for module_name in legacy_modules:
            with self.assertRaises(ModuleNotFoundError, msg=module_name):
                importlib.import_module(module_name)

    def test_readme_describes_ts_single_core_architecture(self) -> None:
        readme = Path("README.md").read_text(encoding="utf-8")

        self.assertIn("TS 单核 Agent + Python 宿主层", readme)
        self.assertIn("update_session", readme)
        self.assertIn("delete_session", readme)
        self.assertNotIn("api/agent_memory_api.py", readme)
        self.assertNotIn("api/local_chat_api.py", readme)
        self.assertNotIn("memory/", readme)
        self.assertNotIn("scripts/init_db.py", readme)

    def test_legacy_chat_window_entry_is_removed(self) -> None:
        self.assertFalse(Path("src/python/gui/chat_window.py").exists())


if __name__ == "__main__":
    unittest.main()
