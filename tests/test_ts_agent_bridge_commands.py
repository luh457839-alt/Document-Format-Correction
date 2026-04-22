from __future__ import annotations

import json
import shutil
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from src.python.api.ts_agent_bridge import (
    TsAgentBridgeError,
    TsAgentBridgeOptions,
    attach_document,
    create_session,
    delete_session,
    get_turn_run_status,
    get_session_state,
    list_sessions,
    submit_agent_turn,
    update_session_title,
)


class TsAgentBridgeCommandsTest(unittest.TestCase):
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

    def test_submit_agent_turn_sends_command_payload(self) -> None:
        with self._tempdir() as tmp:
            root = Path(tmp)
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                cmd = args[0]
                input_path = Path(cmd[3])
                output_path = Path(cmd[5])
                req_payload = json.loads(input_path.read_text(encoding="utf-8"))
                self.assertEqual(req_payload["command"]["type"], "submit_turn")
                self.assertEqual(req_payload["command"]["sessionId"], "chat-main")
                self.assertEqual(req_payload["command"]["userInput"], "你好")
                output_path.write_text(
                    json.dumps({"response": {"content": "世界"}, "session": {"sessionId": "chat-main", "turns": []}}),
                    encoding="utf-8",
                )
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.ts_agent_bridge.subprocess.run", side_effect=fake_run):
                result = submit_agent_turn("chat-main", "你好", options=options)

            self.assertEqual(result["response"]["content"], "世界")

    def test_attach_document_sends_attach_command(self) -> None:
        with self._tempdir() as tmp:
            root = Path(tmp)
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                cmd = args[0]
                input_path = Path(cmd[3])
                output_path = Path(cmd[5])
                req_payload = json.loads(input_path.read_text(encoding="utf-8"))
                self.assertEqual(req_payload["command"]["type"], "attach_document")
                self.assertEqual(req_payload["command"]["docxPath"], "D:/docs/sample.docx")
                output_path.write_text(
                    json.dumps({"session": {"sessionId": "chat-main", "attachedDocument": {"path": "D:/docs/sample.docx"}}}),
                    encoding="utf-8",
                )
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.ts_agent_bridge.subprocess.run", side_effect=fake_run):
                result = attach_document("chat-main", "D:/docs/sample.docx", options=options)

            self.assertEqual(result["session"]["attachedDocument"]["path"], "D:/docs/sample.docx")

    def test_create_session_sends_create_command(self) -> None:
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

    def test_list_sessions_sends_list_command(self) -> None:
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
                    json.dumps({"sessions": [{"sessionId": "chat-main", "updatedAt": 123, "hasAttachedDocument": False}]}),
                    encoding="utf-8",
                )
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.ts_agent_bridge.subprocess.run", side_effect=fake_run):
                result = list_sessions(options=options)

            self.assertEqual(result["sessions"][0]["sessionId"], "chat-main")

    def test_get_session_state_sends_query_command(self) -> None:
        with self._tempdir() as tmp:
            root = Path(tmp)
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                cmd = args[0]
                input_path = Path(cmd[3])
                output_path = Path(cmd[5])
                req_payload = json.loads(input_path.read_text(encoding="utf-8"))
                self.assertEqual(req_payload["command"]["type"], "get_session")
                self.assertEqual(req_payload["command"]["sessionId"], "chat-main")
                output_path.write_text(
                    json.dumps({"session": {"sessionId": "chat-main", "turns": [{"role": "user", "content": "hi"}]}}),
                    encoding="utf-8",
                )
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.ts_agent_bridge.subprocess.run", side_effect=fake_run):
                result = get_session_state("chat-main", options=options)

            self.assertEqual(result["session"]["turns"][0]["content"], "hi")

    def test_get_turn_run_status_sends_query_command(self) -> None:
        with self._tempdir() as tmp:
            root = Path(tmp)
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                cmd = args[0]
                input_path = Path(cmd[3])
                output_path = Path(cmd[5])
                req_payload = json.loads(input_path.read_text(encoding="utf-8"))
                self.assertEqual(req_payload["command"]["type"], "get_turn_run_status")
                self.assertEqual(req_payload["command"]["sessionId"], "chat-main")
                output_path.write_text(
                    json.dumps({"turnRun": {"turnRunId": "turn-1", "sessionId": "chat-main", "status": "running"}}),
                    encoding="utf-8",
                )
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.ts_agent_bridge.subprocess.run", side_effect=fake_run):
                result = get_turn_run_status(session_id="chat-main", options=options)

            self.assertEqual(result["turnRun"]["turnRunId"], "turn-1")

    def test_update_session_title_sends_patch_command(self) -> None:
        with self._tempdir() as tmp:
            root = Path(tmp)
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                cmd = args[0]
                input_path = Path(cmd[3])
                output_path = Path(cmd[5])
                req_payload = json.loads(input_path.read_text(encoding="utf-8"))
                self.assertEqual(req_payload["command"]["type"], "update_session")
                self.assertEqual(req_payload["command"]["sessionId"], "chat-main")
                self.assertEqual(req_payload["command"]["title"], "新的标题")
                output_path.write_text(
                    json.dumps({"session": {"sessionId": "chat-main", "title": "新的标题", "turns": []}}),
                    encoding="utf-8",
                )
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.ts_agent_bridge.subprocess.run", side_effect=fake_run):
                result = update_session_title("chat-main", "新的标题", options=options)

            self.assertEqual(result["session"]["title"], "新的标题")

    def test_delete_session_sends_delete_command(self) -> None:
        with self._tempdir() as tmp:
            root = Path(tmp)
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                cmd = args[0]
                input_path = Path(cmd[3])
                output_path = Path(cmd[5])
                req_payload = json.loads(input_path.read_text(encoding="utf-8"))
                self.assertEqual(req_payload["command"]["type"], "delete_session")
                self.assertEqual(req_payload["command"]["sessionId"], "chat-main")
                output_path.write_text(
                    json.dumps({"deletedSessionId": "chat-main"}),
                    encoding="utf-8",
                )
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.ts_agent_bridge.subprocess.run", side_effect=fake_run):
                result = delete_session("chat-main", options=options)

            self.assertEqual(result["deletedSessionId"], "chat-main")

    def test_submit_agent_turn_surfaces_business_error_from_cli(self) -> None:
        with self._tempdir() as tmp:
            root = Path(tmp)
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                cmd = args[0]
                output_path = Path(cmd[5])
                output_path.write_text(
                    json.dumps(
                        {
                            "error": {
                                "code": "E_TURN_DECISION_INVALID",
                                "message": "turn decision goal is required",
                                "retryable": False,
                            }
                        }
                    ),
                    encoding="utf-8",
                )
                return SimpleNamespace(returncode=1, stderr="")

            with patch("src.python.api.ts_agent_bridge.subprocess.run", side_effect=fake_run):
                with self.assertRaises(TsAgentBridgeError) as ctx:
                    submit_agent_turn("chat-main", "你好", options=options)

            self.assertIn("E_TURN_DECISION_INVALID", str(ctx.exception))
            self.assertIn("turn decision goal is required", str(ctx.exception))
            self.assertNotIn("NOT NULL", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
