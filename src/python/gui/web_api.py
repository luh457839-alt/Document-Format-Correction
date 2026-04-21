from __future__ import annotations

import json
import mimetypes
import socket
import threading
from dataclasses import dataclass
from email import policy
from email.message import Message
from email.parser import BytesParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse
from uuid import uuid4

from ..api.ts_agent_bridge import (
    TsAgentBridgeError,
    TsAgentBridgeTimeout,
    attach_document,
    create_session,
    delete_session,
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
    ts_agent_timeout_sec: float = 90.0


class WebApiServer:
    def __init__(self, config: WebApiConfig | None = None) -> None:
        self.config = config or WebApiConfig()
        self.config.front_dist_dir.mkdir(parents=True, exist_ok=True)
        self.config.upload_dir.mkdir(parents=True, exist_ok=True)

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
                    result = list_sessions(timeout_sec=config.ts_agent_timeout_sec)
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
                    create_session(session_id, timeout_sec=config.ts_agent_timeout_sec)
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
                        timeout_sec=config.ts_agent_timeout_sec,
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
                    submit_agent_turn(
                        session_id,
                        content,
                        timeout_sec=config.ts_agent_timeout_sec,
                    )
                    session_payload = self._fetch_normalized_session(session_id)
                    self._send_json({"session": session_payload})
                except (TsAgentBridgeError, TsAgentBridgeTimeout) as exc:
                    self._send_bridge_error(exc)

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
                        timeout_sec=config.ts_agent_timeout_sec,
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
                    result = delete_session(session_id, timeout_sec=config.ts_agent_timeout_sec)
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
                state = get_session_state(session_id, timeout_sec=config.ts_agent_timeout_sec)
                session = state.get("session")
                if not isinstance(session, dict):
                    return {
                        "sessionId": session_id,
                        "title": session_id,
                        "messages": [],
                        "attachedDocument": None,
                    }

                return self._normalize_session_payload(session, session_id)

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

            def _send_json_error(self, status: HTTPStatus, message: str) -> None:
                self._send_json({"error": {"message": message}}, status=status)

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
