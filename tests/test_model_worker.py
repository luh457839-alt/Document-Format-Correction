from __future__ import annotations

import sys
import types
import unittest


class ModelWorkerTsRuntimeTest(unittest.TestCase):
    def tearDown(self) -> None:
        sys.modules.pop("api.ts_agent_bridge", None)
        sys.modules.pop("src.python.api.ts_agent_bridge", None)

    def test_worker_submits_latest_user_turn_to_ts_runtime(self) -> None:
        bridge = self._install_ts_agent_bridge(
            {
                "response": {"content": "TS 已处理该请求。"},
                "session": {
                    "sessionId": "chat-main",
                    "attachedDocument": {"path": "D:/docs/sample.docx"},
                    "turns": [
                        {"role": "user", "content": "把字号改成22"},
                        {"role": "assistant", "content": "TS 已处理该请求。"},
                    ],
                },
            }
        )

        from src.python.gui.model_worker import ModelCallWorker

        worker = ModelCallWorker(
            base_url="http://localhost:8080/v1",
            api_key="sk-test",
            model="gemma-4",
            messages=[{"role": "user", "content": "把字号改成22"}],
            temperature=0.2,
            max_tokens=512,
            enable_tools=True,
            imported_doc={"path": "D:/docs/sample.docx"},
            task_id="chat-main",
        )
        finished: list[str] = []
        failed: list[str] = []
        state_changes: list[dict] = []
        worker.finished.connect(finished.append)
        worker.failed.connect(failed.append)
        worker.tool_state_changed.connect(state_changes.append)

        worker.run()

        self.assertEqual(failed, [])
        self.assertEqual(finished[-1], "TS 已处理该请求。")
        self.assertEqual(bridge.calls, [("chat-main", "把字号改成22")])
        self.assertEqual(state_changes[-1]["path"], "D:/docs/sample.docx")

    def test_worker_requires_user_input(self) -> None:
        self._install_ts_agent_bridge({})

        from src.python.gui.model_worker import ModelCallWorker

        worker = ModelCallWorker(
            base_url="http://localhost:8080/v1",
            api_key="sk-test",
            model="gemma-4",
            messages=[],
            temperature=0.2,
            max_tokens=512,
            enable_tools=True,
            task_id="chat-main",
        )
        failed: list[str] = []
        worker.failed.connect(failed.append)

        worker.run()

        self.assertIn("No user input available", failed[-1])

    def _install_ts_agent_bridge(self, result: dict):
        fake_module = types.ModuleType("src.python.api.ts_agent_bridge")

        class TsAgentBridgeError(Exception):
            pass

        class TsAgentBridgeTimeout(Exception):
            pass

        calls: list[tuple[str, str]] = []

        def submit_agent_turn(session_id: str, user_input: str, *, timeout_sec=None, options=None):
            _ = timeout_sec, options
            calls.append((session_id, user_input))
            return result

        fake_module.TsAgentBridgeError = TsAgentBridgeError
        fake_module.TsAgentBridgeTimeout = TsAgentBridgeTimeout
        fake_module.submit_agent_turn = submit_agent_turn
        fake_module.calls = calls
        sys.modules["src.python.api.ts_agent_bridge"] = fake_module
        return fake_module


if __name__ == "__main__":
    unittest.main()
