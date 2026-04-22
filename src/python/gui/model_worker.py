from __future__ import annotations

from typing import Any

from PyQt5.QtCore import QObject, pyqtSignal


class ModelCallWorker(QObject):
    chunk = pyqtSignal(str)
    finished = pyqtSignal(str)
    tool_state_changed = pyqtSignal(dict)
    failed = pyqtSignal(str)

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        messages: list[dict[str, str]],
        temperature: float,
        max_tokens: int,
        stop: list[str] | None = None,
        enable_tools: bool = False,
        imported_doc: dict[str, Any] | None = None,
        task_id: str = "chat-main",
        ts_agent_timeout_sec: float | None = None,
    ):
        super().__init__()
        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self.messages = messages
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.stop = stop
        self.enable_tools = enable_tools
        self.imported_doc = imported_doc or {}
        self.task_id = task_id
        self.ts_agent_timeout_sec = ts_agent_timeout_sec

    def run(self) -> None:
        try:
            from ..api.ts_agent_bridge import (
                TsAgentBridgeError,
                TsAgentBridgeTimeout,
                submit_agent_turn,
            )

            user_input = self._latest_user_message()
            if not user_input:
                self.failed.emit("No user input available for TS runtime.")
                return

            try:
                result = submit_agent_turn(
                    self.task_id,
                    user_input,
                    timeout_sec=self.ts_agent_timeout_sec,
                )
            except (TsAgentBridgeError, TsAgentBridgeTimeout) as exc:
                self.failed.emit(str(exc))
                return

            session = result.get("session")
            if isinstance(session, dict):
                attached = session.get("attachedDocument")
                if isinstance(attached, dict):
                    self.imported_doc = dict(attached)
                    self.tool_state_changed.emit(dict(attached))

            response = result.get("response")
            if isinstance(response, dict):
                content = str(response.get("content", "")).strip()
                if content:
                    self.finished.emit(content)
                    return

            assistant_text = self._extract_latest_assistant_text(session)
            if assistant_text:
                self.finished.emit(assistant_text)
                return

            self.failed.emit("TS runtime returned no assistant response.")
        except Exception as exc:  # pragma: no cover
            self.failed.emit(str(exc))

    def _latest_user_message(self) -> str:
        for message in reversed(self.messages):
            if str(message.get("role", "")).strip() == "user":
                content = str(message.get("content", "")).strip()
                if content:
                    return content
        return ""

    @staticmethod
    def _extract_latest_assistant_text(session: Any) -> str:
        if not isinstance(session, dict):
            return ""
        turns = session.get("turns")
        if not isinstance(turns, list):
            return ""
        for turn in reversed(turns):
            if not isinstance(turn, dict):
                continue
            if str(turn.get("role", "")).strip() != "assistant":
                continue
            content = str(turn.get("content", "")).strip()
            if content:
                return content
        return ""
