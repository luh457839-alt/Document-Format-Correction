from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from src.python.api.ts_agent_bridge import (
    TsAgentBridgeError,
    TsAgentBridgeOptions,
    TsAgentBridgeTimeout,
    create_session,
    list_sessions,
)


class TsAgentBridgeCommandHelpersTest(unittest.TestCase):
    @contextmanager
    def _tempdir(self):
        root = Path(".tmp") / f"ts-agent-bridge-{uuid4().hex}"
        root.mkdir(parents=True, exist_ok=True)
        try:
            yield str(root)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def _make_options(self, root: Path) -> TsAgentBridgeOptions:
        cli = root / "src" / "ts" / "dist" / "runtime"
        cli.mkdir(parents=True, exist_ok=True)
        (cli / "cli.js").write_text("// mock", encoding="utf-8")
        return TsAgentBridgeOptions(project_root=root)

    def test_create_session_sends_command_payload(self) -> None:
        with self._tempdir() as tmp:
            root = Path(tmp)
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                cmd = args[0]
                input_path = Path(cmd[3])
                output_path = Path(cmd[5])
                req_payload = json.loads(input_path.read_text(encoding="utf-8"))
                self.assertEqual(req_payload["command"]["type"], "create_session")
                self.assertEqual(req_payload["command"]["sessionId"], "chat-main")
                output_path.write_text(
                    json.dumps({"session": {"sessionId": "chat-main", "turns": []}}),
                    encoding="utf-8",
                )
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.ts_agent_bridge.subprocess.run", side_effect=fake_run):
                result = create_session("chat-main", options=options)

            self.assertEqual(result["session"]["sessionId"], "chat-main")
            self.assertEqual(result["session"]["turns"], [])

    def test_list_sessions_sends_command_payload(self) -> None:
        with self._tempdir() as tmp:
            root = Path(tmp)
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                cmd = args[0]
                input_path = Path(cmd[3])
                output_path = Path(cmd[5])
                req_payload = json.loads(input_path.read_text(encoding="utf-8"))
                self.assertEqual(req_payload["command"]["type"], "list_sessions")
                output_path.write_text(
                    json.dumps(
                        {
                            "sessions": [
                                {
                                    "sessionId": "chat-main",
                                    "updatedAt": 1234567890,
                                    "hasAttachedDocument": False,
                                }
                            ]
                        }
                    ),
                    encoding="utf-8",
                )
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.ts_agent_bridge.subprocess.run", side_effect=fake_run):
                result = list_sessions(options=options)

            self.assertEqual(result["sessions"][0]["sessionId"], "chat-main")

    def test_command_helpers_nonzero_exit_without_output_preserves_stderr(self) -> None:
        with self._tempdir() as tmp:
            root = Path(tmp)
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                return SimpleNamespace(returncode=1, stderr="boom from cli")

            with patch("src.python.api.ts_agent_bridge.subprocess.run", side_effect=fake_run):
                with self.assertRaises(TsAgentBridgeError) as ctx:
                    list_sessions(options=options)

            self.assertIn("E_TS_AGENT_CLI_EXIT_NONZERO", str(ctx.exception))
            self.assertIn("boom from cli", str(ctx.exception))

    def test_command_helpers_timeout_raises(self) -> None:
        with self._tempdir() as tmp:
            root = Path(tmp)
            options = self._make_options(root)

            with patch(
                "src.python.api.ts_agent_bridge.subprocess.run",
                side_effect=subprocess.TimeoutExpired(cmd="node", timeout=1),
            ):
                with self.assertRaises(TsAgentBridgeTimeout):
                    create_session("chat-main", options=options, timeout_sec=1)

    def test_command_helpers_allow_background_call_without_timeout(self) -> None:
        with self._tempdir() as tmp:
            root = Path(tmp)
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                self.assertIsNone(kwargs.get("timeout"))
                cmd = args[0]
                output_path = Path(cmd[5])
                output_path.write_text(
                    json.dumps({"session": {"sessionId": "chat-main", "turns": []}}),
                    encoding="utf-8",
                )
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.ts_agent_bridge.subprocess.run", side_effect=fake_run):
                result = create_session("chat-main", options=options, timeout_sec=None)

            self.assertEqual(result["session"]["sessionId"], "chat-main")


if __name__ == "__main__":
    unittest.main()
