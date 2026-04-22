from __future__ import annotations

import json
import mimetypes
import socket
import threading
import time
from dataclasses import dataclass
from email import policy
from email.message import Message
from email.parser import BytesParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, unquote, urlparse
from uuid import uuid4

from ..api.ts_agent_bridge import (
    TsAgentBridgeError,
    TsAgentBridgeTimeout,
    attach_document,
    create_session,
    delete_session,
    get_turn_run_status,
    get_session_state,
    list_sessions,
    submit_agent_turn,
    update_session_title,
)
from ..core.model_config import load_model_config, save_model_config
from ..core.project_paths import FRONTEND_DIST_DIR, TMP_DIR


@dataclass(frozen=True)
class WebApiConfig:
    host: str = "127.0.0.1"
    port: int = 0
    front_dist_dir: Path = FRONTEND_DIST_DIR
    upload_dir: Path = TMP_DIR / "web_uploads"
    sync_request_timeout_sec: float | None = None


@dataclass
class TurnJobRecord:
    job_id: str
    session_id: str
    content: str
    accepted_at: int
    updated_at: int
    status: str = "queued"
    summary: str = "已受理，等待 TS Agent 开始处理"
    steps: list[dict[str, Any]] | None = None
    error: dict[str, Any] | None = None
    turn_run_id: str | None = None
    session_payload: dict[str, Any] | None = None
    worker: threading.Thread | None = None
    lock: threading.Lock | None = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "sessionId": self.session_id,
            "turnRunId": self.turn_run_id,
            "status": self.status,
            "acceptedAt": self.accepted_at,
            "updatedAt": self.updated_at,
            "summary": self.summary,
            "steps": list(self.steps or []),
            "error": dict(self.error) if isinstance(self.error, dict) else None,
        }


class TurnJobRegistry:
    def __init__(self, status_timeout_sec: float, fetch_session: Callable[[str], dict[str, Any]]) -> None:
        self._status_timeout_sec = status_timeout_sec
        self._fetch_session = fetch_session
        self._jobs: dict[str, TurnJobRecord] = {}
        self._lock = threading.Lock()

    def create_job(self, session_id: str, content: str) -> TurnJobRecord:
        now = int(threading.get_native_id() or 0)
        accepted_at = int(time.time() * 1000)
        record = TurnJobRecord(
            job_id=f"job-{uuid4().hex[:10]}",
            session_id=session_id,
            content=content,
            accepted_at=accepted_at,
            updated_at=accepted_at,
            steps=[{"id": "submit_turn", "title": "提交 TS Agent", "status": "queued"}],
            lock=threading.Lock(),
        )
        worker = threading.Thread(target=self._run_job, args=(record,), daemon=True, name=f"turn-job-{now}")
        record.worker = worker
        with self._lock:
            self._jobs[record.job_id] = record
        worker.start()
        return record

    def get_job(self, session_id: str, job_id: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
        with self._lock:
            record = self._jobs.get(job_id)
        if record is None or record.session_id != session_id:
            raise KeyError(job_id)
        turn_run = self._refresh_from_turn_run(record)
        with (record.lock or threading.Lock()):
            snapshot = record.snapshot()
            if isinstance(turn_run, dict):
                snapshot["turnRunId"] = str(turn_run.get("turnRunId") or snapshot.get("turnRunId") or "")
                snapshot["status"] = str(turn_run.get("status") or snapshot["status"])
                snapshot["updatedAt"] = int(turn_run.get("updatedAt") or snapshot["updatedAt"])
                snapshot["summary"] = str(turn_run.get("summary") or snapshot["summary"])
                steps = turn_run.get("steps")
                if isinstance(steps, list):
                    snapshot["steps"] = [dict(step) for step in steps if isinstance(step, dict)]
                if isinstance(turn_run.get("error"), dict):
                    snapshot["error"] = dict(turn_run.get("error"))
            return snapshot, record.session_payload

    def wait_for_job(
        self, session_id: str, job_id: str, timeout_sec: float
    ) -> tuple[dict[str, Any], dict[str, Any] | None, bool]:
        deadline = time.monotonic() + max(timeout_sec, 0.0)
        while True:
            snapshot, session_payload = self.get_job(session_id, job_id)
            if snapshot.get("status") in {"completed", "failed", "waiting_user"}:
                return snapshot, session_payload, True
            if time.monotonic() >= deadline:
                return snapshot, session_payload, False
            time.sleep(min(0.2, max(0.01, deadline - time.monotonic())))

    def _run_job(self, record: TurnJobRecord) -> None:
        with (record.lock or threading.Lock()):
            record.status = "running"
            record.updated_at = int(time.time() * 1000)
            record.summary = "已提交，等待 TS Agent 执行"
            record.steps = [{"id": "submit_turn", "title": "提交 TS Agent", "status": "running"}]
        try:
            submit_agent_turn(
                record.session_id,
                record.content,
                timeout_sec=None,
            )
            session_payload = self._fetch_session(record.session_id)
            with (record.lock or threading.Lock()):
                record.session_payload = session_payload
                if record.status not in {"completed", "failed", "waiting_user"}:
                    record.status = "completed"
                record.updated_at = int(time.time() * 1000)
                if record.steps:
                    record.steps[-1]["status"] = "completed"
                if not record.summary:
                    record.summary = "本轮处理已完成"
        except (TsAgentBridgeError, TsAgentBridgeTimeout) as exc:
            with (record.lock or threading.Lock()):
                record.status = "failed"
                record.updated_at = int(time.time() * 1000)
                record.summary = str(exc)
                record.error = {"message": str(exc)}
                if record.steps:
                    record.steps[-1]["status"] = "failed"

    def _refresh_from_turn_run(self, record: TurnJobRecord) -> dict[str, Any] | None:
        if record.status in {"completed", "failed", "waiting_user"} and record.turn_run_id:
            return None
        try:
            result = get_turn_run_status(
                session_id=record.session_id,
                timeout_sec=self._status_timeout_sec,
            )
        except (TsAgentBridgeError, TsAgentBridgeTimeout):
            return None
        turn_run = result.get("turnRun") if isinstance(result, dict) else None
        if not isinstance(turn_run, dict):
            return None
        with (record.lock or threading.Lock()):
            record.turn_run_id = str(turn_run.get("turnRunId") or "") or record.turn_run_id
            record.status = str(turn_run.get("status") or record.status)
            record.updated_at = int(turn_run.get("updatedAt") or record.updated_at)
            record.summary = str(turn_run.get("summary") or record.summary)
            record.error = dict(turn_run.get("error")) if isinstance(turn_run.get("error"), dict) else record.error
            steps = turn_run.get("steps")
            if isinstance(steps, list):
                record.steps = [dict(step) for step in steps if isinstance(step, dict)]
        return turn_run


class WebApiServer:
    def __init__(self, config: WebApiConfig | None = None) -> None:
        self.config = config or WebApiConfig()
        self.config.front_dist_dir.mkdir(parents=True, exist_ok=True)
        self.config.upload_dir.mkdir(parents=True, exist_ok=True)
        self._sync_request_timeout_sec = _resolve_sync_request_timeout_sec(
            self.config.sync_request_timeout_sec
        )
        self._turn_jobs = TurnJobRegistry(
            self._sync_request_timeout_sec, self._fetch_normalized_session_sync
        )

        handler_cls = self._build_handler()
        self._httpd = ThreadingHTTPServer((self.config.host, self.config.port), handler_cls)
        self._thread: threading.Thread | None = None

    @property
    def server_address(self) -> tuple[str, int]:
        host, port = self._httpd.server_address[:2]
        return str(host), int(port)

    @property
    def base_url(self) -> str:
        host, port = self.server_address
        return f"http://{host}:{port}"

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def _fetch_normalized_session_sync(self, session_id: str) -> dict[str, Any]:
        state = get_session_state(session_id, timeout_sec=self._sync_request_timeout_sec)
        session = state.get("session") if isinstance(state, dict) else None
        if not isinstance(session, dict):
            return {
                "sessionId": session_id,
                "title": session_id,
                "messages": [],
                "attachedDocument": None,
            }
        turns = session.get("turns", [])
        messages: list[dict[str, Any]] = []
        if isinstance(turns, list):
            for index, turn in enumerate(turns):
                if not isinstance(turn, dict):
                    continue
                role = str(turn.get("role", "")).strip()
                content = str(turn.get("content", "")).strip()
                if not role:
                    continue
                messages.append(
                    {
                        "messageId": f"{session_id}-{index}",
                        "sessionId": session_id,
                        "role": role,
                        "content": content,
                    }
                )
        attached = session.get("attachedDocument")
        return {
            "sessionId": str(session.get("sessionId") or session_id),
            "title": str(session.get("title") or session.get("sessionId") or session_id),
            "messages": messages,
            "attachedDocument": dict(attached) if isinstance(attached, dict) else None,
        }

    def _build_handler(self) -> type[BaseHTTPRequestHandler]:
        config = self.config

        class RequestHandler(BaseHTTPRequestHandler):
            server_version = "DocumentFormatCorrectionWebApi/1.0"

            def do_GET(self) -> None:  # noqa: N802
                parsed = urlparse(self.path)
                path = parsed.path
                if path == "/api/health":
                    self._send_json({"ok": True, "baseUrl": server.base_url})
                    return
                if path == "/api/sessions":
                    self._handle_list_sessions()
                    return
                if path.startswith("/api/sessions/") and "/message-jobs/" in path:
                    self._handle_get_message_job(path)
                    return
                if path.startswith("/api/sessions/"):
                    self._handle_get_session(path)
                    return
                if path == "/api/model-config":
                    self._handle_get_model_config()
                    return
                self._serve_front_asset(path)

            def do_POST(self) -> None:  # noqa: N802
                parsed = urlparse(self.path)
                path = parsed.path
                if path == "/api/sessions":
                    self._handle_create_session()
                    return
                if path.startswith("/api/sessions/") and path.endswith("/messages/async"):
                    self._handle_submit_turn_async(path)
                    return
                if path.startswith("/api/sessions/") and path.endswith("/messages"):
                    self._handle_submit_turn(path)
                    return
                if path.startswith("/api/sessions/") and path.endswith("/attach-document"):
                    self._handle_attach_document(path)
                    return
                self._send_json_error(HTTPStatus.NOT_FOUND, "API route not found.")

            def do_PATCH(self) -> None:  # noqa: N802
                parsed = urlparse(self.path)
                path = parsed.path
                if path.startswith("/api/sessions/"):
                    self._handle_update_session(path)
                    return
                self._send_json_error(HTTPStatus.NOT_FOUND, "API route not found.")

            def do_PUT(self) -> None:  # noqa: N802
                parsed = urlparse(self.path)
                if parsed.path == "/api/model-config":
                    self._handle_save_model_config()
                    return
                self._send_json_error(HTTPStatus.NOT_FOUND, "API route not found.")

            def do_DELETE(self) -> None:  # noqa: N802
                parsed = urlparse(self.path)
                path = parsed.path
                if path.startswith("/api/sessions/"):
                    self._handle_delete_session(path)
                    return
                self._send_json_error(HTTPStatus.NOT_FOUND, "API route not found.")

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
                return

            def _handle_list_sessions(self) -> None:
                try:
                    result = list_sessions(timeout_sec=server._sync_request_timeout_sec)
                    sessions = result.get("sessions", [])
                    payload = []
                    for session in sessions:
                        if not isinstance(session, dict):
                            continue
                        session_id = str(session.get("sessionId", "")).strip()
                        if not session_id:
                            continue
                        payload.append(
                            {
                                "sessionId": session_id,
                                "title": str(session.get("title") or session_id),
                                "createdAt": 0,
                                "updatedAt": int(session.get("updatedAt") or 0),
                            }
                        )
                    self._send_json({"sessions": payload})
                except (TsAgentBridgeError, TsAgentBridgeTimeout) as exc:
                    self._send_bridge_error(exc)

            def _handle_create_session(self) -> None:
                body = self._read_json_body()
                session_id = str((body or {}).get("sessionId") or "").strip() or f"chat-{uuid4().hex[:8]}"
                try:
                    create_session(session_id, timeout_sec=server._sync_request_timeout_sec)
                    session_payload = self._fetch_normalized_session(session_id)
                    self._send_json({"session": session_payload}, status=HTTPStatus.CREATED)
                except (TsAgentBridgeError, TsAgentBridgeTimeout) as exc:
                    self._send_bridge_error(exc)

            def _handle_get_session(self, path: str) -> None:
                session_id, suffix = self._extract_session_path(path)
                if not session_id or suffix:
                    self._send_json_error(HTTPStatus.NOT_FOUND, "Session route not found.")
                    return
                try:
                    session_payload = self._fetch_normalized_session(session_id)
                    self._send_json({"session": session_payload})
                except (TsAgentBridgeError, TsAgentBridgeTimeout) as exc:
                    self._send_bridge_error(exc)

            def _handle_update_session(self, path: str) -> None:
                session_id, suffix = self._extract_session_path(path)
                if not session_id or suffix:
                    self._send_json_error(HTTPStatus.NOT_FOUND, "Session route not found.")
                    return

                body = self._read_json_body()
                if body is None:
                    return
                title = str(body.get("title") or "").strip()
                if not title:
                    self._send_json_error(HTTPStatus.BAD_REQUEST, "title is required.")
                    return

                try:
                    result = update_session_title(
                        session_id,
                        title,
                        timeout_sec=server._sync_request_timeout_sec,
                    )
                    session_payload = result.get("session") if isinstance(result, dict) else None
                    if isinstance(session_payload, dict):
                        self._send_json({"session": self._normalize_session_payload(session_payload, session_id)})
                    else:
                        self._send_json({"session": self._fetch_normalized_session(session_id)})
                except (TsAgentBridgeError, TsAgentBridgeTimeout) as exc:
                    self._send_bridge_error(exc)

            def _handle_submit_turn(self, path: str) -> None:
                session_id, suffix = self._extract_session_path(path)
                if not session_id or suffix != "/messages":
                    self._send_json_error(HTTPStatus.NOT_FOUND, "Session message route not found.")
                    return

                body = self._read_json_body()
                content = str((body or {}).get("content") or "").strip()
                if not content:
                    self._send_json_error(HTTPStatus.BAD_REQUEST, "content is required.")
                    return

                try:
                    job = server._turn_jobs.create_job(session_id, content)
                    snapshot, session_payload, finished = server._turn_jobs.wait_for_job(
                        session_id,
                        job.job_id,
                        server._sync_request_timeout_sec,
                    )
                    if finished:
                        if snapshot.get("status") == "failed":
                            self._send_json_error(
                                HTTPStatus.BAD_GATEWAY,
                                str(snapshot.get("summary") or "TS Agent 执行失败。"),
                                {
                                    "code": "E_TURN_FAILED",
                                    "jobId": snapshot.get("jobId"),
                                    "turnRunId": snapshot.get("turnRunId"),
                                },
                            )
                            return
                        self._send_json({"session": session_payload or self._fetch_normalized_session(session_id)})
                        return
                    self._send_json_error(
                        HTTPStatus.GATEWAY_TIMEOUT,
                        "同步等待超时，任务仍在后台执行。请改用异步接口或继续轮询当前 job 状态。",
                        {
                            "code": "E_SYNC_REQUEST_TIMEOUT",
                            "retryable": True,
                            "jobId": snapshot.get("jobId"),
                            "turnRunId": snapshot.get("turnRunId"),
                            "status": snapshot.get("status"),
                        },
                    )
                except (TsAgentBridgeError, TsAgentBridgeTimeout) as exc:
                    self._send_bridge_error(exc)

            def _handle_submit_turn_async(self, path: str) -> None:
                session_id, suffix = self._extract_session_path(path)
                if not session_id or suffix != "/messages/async":
                    self._send_json_error(HTTPStatus.NOT_FOUND, "Async session message route not found.")
                    return

                body = self._read_json_body()
                content = str((body or {}).get("content") or "").strip()
                if not content:
                    self._send_json_error(HTTPStatus.BAD_REQUEST, "content is required.")
                    return

                job = server._turn_jobs.create_job(session_id, content)
                self._send_json({"job": job.snapshot()}, status=HTTPStatus.ACCEPTED)

            def _handle_get_message_job(self, path: str) -> None:
                session_id, job_id = self._extract_message_job_path(path)
                if not session_id or not job_id:
                    self._send_json_error(HTTPStatus.NOT_FOUND, "Message job route not found.")
                    return
                try:
                    job, session_payload = server._turn_jobs.get_job(session_id, job_id)
                except KeyError:
                    self._send_json_error(HTTPStatus.NOT_FOUND, "Message job not found.")
                    return
                payload: dict[str, Any] = {"job": job}
                if session_payload is not None:
                    payload["session"] = session_payload
                self._send_json(payload)

            def _handle_attach_document(self, path: str) -> None:
                session_id, suffix = self._extract_session_path(path)
                if not session_id or suffix != "/attach-document":
                    self._send_json_error(HTTPStatus.NOT_FOUND, "Attach document route not found.")
                    return

                content_type = self.headers.get("Content-Type", "")
                if _get_content_type(content_type) != "multipart/form-data":
                    self._send_json_error(
                        HTTPStatus.BAD_REQUEST,
                        "Content-Type must be multipart/form-data.",
                    )
                    return

                raw_body = self._read_raw_body()
                try:
                    uploaded_file = _parse_uploaded_file(content_type, raw_body)
                except ValueError as exc:
                    self._send_json_error(HTTPStatus.BAD_REQUEST, str(exc))
                    return

                original_name = Path(uploaded_file["filename"]).name
                if not original_name:
                    original_name = "upload.docx"
                if not original_name.lower().endswith(".docx"):
                    self._send_json_error(HTTPStatus.BAD_REQUEST, "Only .docx files are supported.")
                    return

                upload_path = config.upload_dir / f"{uuid4().hex}-{original_name}"
                with upload_path.open("wb") as fh:
                    fh.write(uploaded_file["content"])

                try:
                    attach_document(
                        session_id,
                        str(upload_path),
                        timeout_sec=server._sync_request_timeout_sec,
                    )
                    session_payload = self._fetch_normalized_session(session_id)
                    self._send_json(
                        {
                            "session": session_payload,
                            "uploadedPath": str(upload_path),
                        }
                    )
                except (TsAgentBridgeError, TsAgentBridgeTimeout) as exc:
                    self._send_bridge_error(exc)

            def _handle_delete_session(self, path: str) -> None:
                session_id, suffix = self._extract_session_path(path)
                if not session_id or suffix:
                    self._send_json_error(HTTPStatus.NOT_FOUND, "Session route not found.")
                    return

                try:
                    result = delete_session(session_id, timeout_sec=server._sync_request_timeout_sec)
                    deleted_session_id = (
                        str(result.get("deletedSessionId") or session_id)
                        if isinstance(result, dict)
                        else session_id
                    )
                    self._send_json({"deletedSessionId": deleted_session_id})
                except (TsAgentBridgeError, TsAgentBridgeTimeout) as exc:
                    self._send_bridge_error(exc)

            def _handle_get_model_config(self) -> None:
                config_data = load_model_config()
                self._send_json(
                    {
                        "chat": {
                            "baseUrl": config_data.chat.base_url,
                            "apiKey": config_data.chat.api_key,
                            "model": config_data.chat.model,
                        },
                        "planner": {
                            "baseUrl": config_data.planner.base_url,
                            "apiKey": config_data.planner.api_key,
                            "model": config_data.planner.model,
                            "timeoutMs": config_data.planner.timeout_ms,
                            "stepTimeoutMs": config_data.planner.step_timeout_ms,
                            "taskTimeoutMs": config_data.planner.task_timeout_ms,
                            "pythonToolTimeoutMs": config_data.planner.python_tool_timeout_ms,
                            "maxTurns": config_data.planner.max_turns,
                            "syncRequestTimeoutMs": config_data.planner.sync_request_timeout_ms,
                            "runtimeMode": config_data.planner.runtime_mode,
                        },
                    }
                )

            def _handle_save_model_config(self) -> None:
                body = self._read_json_body() or {}
                config_data = load_model_config()

                chat_body = body.get("chat") if isinstance(body.get("chat"), dict) else {}
                planner_body = body.get("planner") if isinstance(body.get("planner"), dict) else {}

                config_data.chat.base_url = str(chat_body.get("baseUrl") or config_data.chat.base_url).strip()
                config_data.chat.api_key = str(chat_body.get("apiKey") or config_data.chat.api_key).strip()
                config_data.chat.model = str(chat_body.get("model") or config_data.chat.model).strip()

                config_data.planner.base_url = str(
                    planner_body.get("baseUrl") or config_data.chat.base_url
                ).strip()
                config_data.planner.api_key = str(
                    planner_body.get("apiKey") or config_data.chat.api_key
                ).strip()
                config_data.planner.model = str(
                    planner_body.get("model") or config_data.chat.model
                ).strip()
                if "timeoutMs" in planner_body:
                    config_data.planner.timeout_ms = _read_optional_non_negative_int(
                        planner_body.get("timeoutMs"),
                        config_data.planner.timeout_ms,
                    )
                if "stepTimeoutMs" in planner_body:
                    config_data.planner.step_timeout_ms = _read_required_non_negative_int(
                        planner_body.get("stepTimeoutMs"),
                        config_data.planner.step_timeout_ms,
                    )
                if "taskTimeoutMs" in planner_body:
                    config_data.planner.task_timeout_ms = _read_optional_non_negative_int(
                        planner_body.get("taskTimeoutMs"),
                        config_data.planner.task_timeout_ms,
                    )
                if "pythonToolTimeoutMs" in planner_body:
                    config_data.planner.python_tool_timeout_ms = _read_optional_non_negative_int(
                        planner_body.get("pythonToolTimeoutMs"),
                        config_data.planner.python_tool_timeout_ms,
                    )
                if "maxTurns" in planner_body:
                    config_data.planner.max_turns = _read_required_non_negative_int(
                        planner_body.get("maxTurns"),
                        config_data.planner.max_turns,
                    )
                if "syncRequestTimeoutMs" in planner_body:
                    config_data.planner.sync_request_timeout_ms = _read_required_non_negative_int(
                        planner_body.get("syncRequestTimeoutMs"),
                        config_data.planner.sync_request_timeout_ms,
                    )

                runtime_mode = planner_body.get("runtimeMode")
                if isinstance(runtime_mode, str) and runtime_mode.strip() in {"plan_once", "react_loop"}:
                    config_data.planner.runtime_mode = runtime_mode.strip()
                elif runtime_mode is None:
                    config_data.planner.runtime_mode = config_data.planner.runtime_mode
                else:
                    config_data.planner.runtime_mode = None

                save_model_config(config_data)
                self._handle_get_model_config()

            def _fetch_normalized_session(self, session_id: str) -> dict[str, Any]:
                return server._fetch_normalized_session_sync(session_id)

            def _normalize_session_payload(self, session: dict[str, Any], session_id: str) -> dict[str, Any]:
                turns = session.get("turns", [])
                messages: list[dict[str, Any]] = []
                if isinstance(turns, list):
                    for index, turn in enumerate(turns):
                        if not isinstance(turn, dict):
                            continue
                        role = str(turn.get("role", "")).strip()
                        content = str(turn.get("content", "")).strip()
                        if not role:
                            continue
                        messages.append(
                            {
                                "messageId": f"{session_id}-{index}",
                                "sessionId": session_id,
                                "role": role,
                                "content": content,
                            }
                        )

                attached = session.get("attachedDocument")
                attached_document = dict(attached) if isinstance(attached, dict) else None

                return {
                    "sessionId": str(session.get("sessionId") or session_id),
                    "title": str(session.get("title") or session.get("sessionId") or session_id),
                    "messages": messages,
                    "attachedDocument": attached_document,
                }

            def _serve_front_asset(self, path: str) -> None:
                requested = path or "/"
                if requested == "/":
                    target = config.front_dist_dir / "index.html"
                else:
                    safe_relative = requested.lstrip("/")
                    target = (config.front_dist_dir / safe_relative).resolve()
                    try:
                        target.relative_to(config.front_dist_dir.resolve())
                    except ValueError:
                        self._send_text(HTTPStatus.FORBIDDEN, "Forbidden")
                        return

                if not target.exists() or target.is_dir():
                    target = config.front_dist_dir / "index.html"

                if not target.exists():
                    self._send_text(
                        HTTPStatus.SERVICE_UNAVAILABLE,
                        "src/frontend/dist is missing. Run `npm run build` inside `src/frontend` first.",
                    )
                    return

                content_type, _ = mimetypes.guess_type(str(target))
                body = target.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type or "application/octet-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _extract_session_path(self, path: str) -> tuple[str, str]:
                prefix = "/api/sessions/"
                if not path.startswith(prefix):
                    return "", ""
                remainder = path[len(prefix):]
                if "/" not in remainder:
                    return unquote(remainder), ""
                session_id, suffix = remainder.split("/", 1)
                return unquote(session_id), "/" + suffix

            def _extract_message_job_path(self, path: str) -> tuple[str, str]:
                prefix = "/api/sessions/"
                if not path.startswith(prefix):
                    return "", ""
                remainder = path[len(prefix):]
                if "/message-jobs/" not in remainder:
                    return "", ""
                session_id, job_id = remainder.split("/message-jobs/", 1)
                return unquote(session_id), unquote(job_id)

            def _read_json_body(self) -> dict[str, Any] | None:
                raw = self._read_raw_body(default=b"{}")
                try:
                    parsed = json.loads(raw.decode("utf-8"))
                except Exception:
                    self._send_json_error(HTTPStatus.BAD_REQUEST, "Invalid JSON body.")
                    return None
                if not isinstance(parsed, dict):
                    self._send_json_error(HTTPStatus.BAD_REQUEST, "JSON body must be an object.")
                    return None
                return parsed

            def _read_raw_body(self, default: bytes = b"") -> bytes:
                length = int(self.headers.get("Content-Length", "0") or "0")
                return self.rfile.read(length) if length > 0 else default

            def _send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def _send_json_error(
                self,
                status: HTTPStatus,
                message: str,
                extra: dict[str, Any] | None = None,
            ) -> None:
                payload: dict[str, Any] = {"message": message}
                if isinstance(extra, dict):
                    payload.update(extra)
                self._send_json({"error": payload}, status=status)

            def _send_bridge_error(self, exc: Exception) -> None:
                status = HTTPStatus.NOT_FOUND if _is_session_not_found_error(exc) else HTTPStatus.BAD_GATEWAY
                self._send_json_error(status, str(exc))

            def _send_text(self, status: HTTPStatus, text: str) -> None:
                body = text.encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = self
        return RequestHandler


def find_available_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def _get_content_type(content_type_header: str) -> str:
    message = Message()
    message["Content-Type"] = content_type_header
    return message.get_content_type()


def _parse_uploaded_file(content_type_header: str, body: bytes) -> dict[str, bytes | str]:
    if not body:
        raise ValueError("file upload is required.")

    parser_input = (
        f"Content-Type: {content_type_header}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + body
    )
    message = BytesParser(policy=policy.default).parsebytes(parser_input)
    if not message.is_multipart():
        raise ValueError("file upload is required.")

    for part in message.iter_parts():
        if part.get_content_disposition() != "form-data":
            continue
        if part.get_param("name", header="content-disposition") != "file":
            continue
        filename = str(part.get_filename() or "upload.docx")
        content = part.get_payload(decode=True) or b""
        return {"filename": filename, "content": content}

    raise ValueError("file upload is required.")


__all__ = ["WebApiConfig", "WebApiServer", "find_available_port"]


def _is_session_not_found_error(exc: Exception) -> bool:
    return "E_SESSION_NOT_FOUND" in str(exc)


def _resolve_sync_request_timeout_sec(configured: float | None) -> float:
    if configured is not None:
        return max(float(configured), 0.0)
    timeout_ms = load_model_config().planner.sync_request_timeout_ms
    if timeout_ms is None:
        return 300.0
    return max(float(timeout_ms) / 1000.0, 0.0)


def _read_optional_non_negative_int(value: Any, fallback: int | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed >= 0 else fallback


def _read_required_non_negative_int(value: Any, fallback: int) -> int:
    if value is None:
        return fallback
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed >= 0 else fallback
