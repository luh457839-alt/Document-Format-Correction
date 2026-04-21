from __future__ import annotations

import unittest
from pathlib import Path

from src.python.api.ts_agent_bridge import TsAgentBridgeOptions
from src.python.core.model_config import DEFAULT_CONFIG_PATH


class ProjectPathDefaultsTest(unittest.TestCase):
    def test_model_config_defaults_to_root_config_json(self) -> None:
        project_root = Path(__file__).resolve().parents[1]
        self.assertEqual(DEFAULT_CONFIG_PATH, project_root / "config.json")

    def test_ts_bridge_defaults_to_src_ts_cli(self) -> None:
        project_root = Path(__file__).resolve().parents[1]
        options = TsAgentBridgeOptions()

        self.assertEqual(options.project_root, project_root)
        self.assertEqual(options.ts_agent_dir, project_root / "src" / "ts")
        self.assertEqual(
            options.cli_path,
            project_root / "src" / "ts" / "dist" / "runtime" / "cli.js",
        )


if __name__ == "__main__":
    unittest.main()
