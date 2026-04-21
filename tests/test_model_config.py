from __future__ import annotations

import json
import shutil
import unittest
from pathlib import Path
from uuid import uuid4

from src.python.core.model_config import build_ts_agent_env, load_model_config


class ModelConfigCompatibilityTest(unittest.TestCase):
    def test_load_model_config_migrates_legacy_local_defaults_to_auto_compat(self) -> None:
        root = Path(".tmp") / f"model-config-{uuid4().hex}"
        root.mkdir(parents=True, exist_ok=True)
        try:
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "chat": {
                            "base_url": "http://localhost:8080/v1",
                            "api_key": "sk-local",
                            "model": "gemma-4",
                        },
                        "planner": {
                            "base_url": "http://localhost:8080/v1",
                            "api_key": "sk-local",
                            "model": "gemma-4",
                            "timeout_ms": 30000,
                            "max_retries": 0,
                            "temperature": 0.0,
                            "use_json_schema": True,
                            "schema_strict": True,
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )

            loaded = load_model_config(config_path)

            self.assertEqual(loaded.planner.compat_mode, "auto")
            self.assertIsNone(loaded.planner.runtime_mode)
            self.assertIsNone(loaded.planner.timeout_ms)
            self.assertIsNone(loaded.planner.use_json_schema)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_build_ts_agent_env_exports_compatibility_fields(self) -> None:
        root = Path(".tmp") / f"model-config-{uuid4().hex}"
        root.mkdir(parents=True, exist_ok=True)
        try:
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "chat": {
                            "base_url": "https://api.openai.com/v1",
                            "api_key": "sk-remote",
                            "model": "gpt-4o-mini",
                        },
                        "planner": {
                            "base_url": "https://api.openai.com/v1",
                            "api_key": "sk-remote",
                            "model": "gpt-4o-mini",
                            "compat_mode": "strict",
                            "runtime_mode": "react_loop",
                            "timeout_ms": 45000,
                            "max_retries": 1,
                            "temperature": 0.2,
                            "use_json_schema": True,
                            "schema_strict": True,
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )

            loaded = load_model_config(config_path)
            env = build_ts_agent_env(loaded)

            self.assertEqual(env["TS_AGENT_PLANNER_COMPAT_MODE"], "strict")
            self.assertEqual(env["TS_AGENT_PLANNER_RUNTIME_MODE"], "react_loop")
            self.assertEqual(env["TS_AGENT_PLANNER_TIMEOUT_MS"], "45000")
            self.assertEqual(env["TS_AGENT_PLANNER_USE_JSON_SCHEMA"], "true")
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
