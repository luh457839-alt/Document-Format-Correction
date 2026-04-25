from __future__ import annotations

import json
import mimetypes
import os
import socket
import subprocess
import sys
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
from ..api.template_bridge import (
    TemplateBridgeError,
    TemplateBridgeTimeout,
    run_template_job,
)
from ..core.model_config import collect_model_config_warnings, load_model_config, save_model_config
from ..core.project_paths import FRONTEND_DIST_DIR, OUTPUT_DIR, PROJECT_ROOT, TMP_DIR


@dataclass(frozen=True)
class WebApiConfig:
    host: str = "127.0.0.1"
    port: int = 0
    front_dist_dir: Path = FRONTEND_DIST_DIR
    upload_dir: Path = TMP_DIR / "web_uploads"
    templates_dir: Path = PROJECT_ROOT / "templates"
    output_dir: Path = OUTPUT_DIR
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


@dataclass
class TemplateJobRecord:
    job_id: str
    document_path: str
    template_path: str
    accepted_at: int
    updated_at: int
    status: str = "queued"
    summary: str = "已创建模板修改任务"
    steps: list[dict[str, Any]] | None = None
    error: dict[str, Any] | None = None
    output_path: str | None = None
    warnings: list[dict[str, Any]] | None = None
    debug: dict[str, Any] | None = None
    worker: threading.Thread | None = None
    lock: threading.Lock | None = None

    def snapshot(self) -> dict[str, Any]:
        payload = {
            "jobId": self.job_id,
            "sessionId": "templates",
            "status": self.status,
            "acceptedAt": self.accepted_at,
            "updatedAt": self.updated_at,
            "summary": self.summary,
            "steps": list(self.steps or []),
            "error": dict(self.error) if isinstance(self.error, dict) else None,
        }
        if self.output_path:
            payload["outputPath"] = self.output_path
        if self.warnings:
            payload["warnings"] = [dict(warning) for warning in self.warnings]
        if self.debug:
            payload["debug"] = json.loads(json.dumps(self.debug))
        return payload


class TemplateJobRegistry:
    def __init__(self, output_dir: Path) -> None:
        self._output_dir = output_dir
        self._jobs: dict[str, TemplateJobRecord] = {}
        self._lock = threading.Lock()

    def create_job(self, document_path: Path, template_path: Path) -> TemplateJobRecord:
        accepted_at = int(time.time() * 1000)
        config_warnings = collect_model_config_warnings(load_model_config())
        record = TemplateJobRecord(
            job_id=f"template-{uuid4().hex[:10]}",
            document_path=str(document_path),
            template_path=str(template_path),
            accepted_at=accepted_at,
            updated_at=accepted_at,
            warnings=config_warnings,
            steps=[
                {"id": "load_inputs", "title": "校验 DOCX 与 JSON 输入", "status": "queued"},
                {
                    "id": "run_template_pipeline",
                    "title": "执行固定模板编排",
                    "status": "queued",
                    **({"detail": _format_config_warnings(config_warnings)} if config_warnings else {}),
                },
                {"id": "validate_result", "title": "归一化模板执行结果", "status": "queued"},
                {"id": "materialize_output", "title": "确认输出 DOCX", "status": "queued"},
            ],
            lock=threading.Lock(),
        )
        with self._lock:
            self._jobs[record.job_id] = record
        return record

    def get_job(self, job_id: str) -> TemplateJobRecord:
        with self._lock:
            record = self._jobs.get(job_id)
        if record is None:
            raise KeyError(job_id)
        self._ensure_started(record)
        return record

    def start_job(self, job_id: str) -> None:
        with self._lock:
            record = self._jobs.get(job_id)
        if record is None:
            raise KeyError(job_id)
        self._ensure_started(record)

    def _ensure_started(self, record: TemplateJobRecord) -> None:
        with (record.lock or threading.Lock()):
            if record.worker is not None:
                return
            worker = threading.Thread(
                target=self._run_job,
                args=(record,),
                daemon=True,
                name=f"template-job-{record.job_id}",
            )
            record.worker = worker
        worker.start()

    def _run_job(self, record: TemplateJobRecord) -> None:
        try:
            self._mark_step(record, "load_inputs", "running", "正在验证输入文件")
            document_path = Path(record.document_path)
            template_path = Path(record.template_path)
            if not document_path.exists() or document_path.suffix.lower() != ".docx":
                raise FileNotFoundError(f"DOCX does not exist: {document_path}")
            if not template_path.exists() or template_path.suffix.lower() != ".json":
                raise FileNotFoundError(f"Template JSON does not exist: {template_path}")
            self._mark_step(record, "load_inputs", "completed")
            pipeline_detail = "正在调用 TS 模板 CLI"
            if record.warnings:
                pipeline_detail = f"{pipeline_detail}\n{_format_config_warnings(record.warnings)}"
            self._mark_step(record, "run_template_pipeline", "running", pipeline_detail)
            report = run_template_job(str(document_path), str(template_path))
            runtime_warnings = _normalize_template_run_warnings(report.get("warnings"))
            if runtime_warnings:
                with (record.lock or threading.Lock()):
                    record.warnings = [*list(record.warnings or []), *runtime_warnings]
            self._mark_step(
                record,
                "run_template_pipeline",
                "completed",
                _format_stage_timings(report.get("stage_timings_ms")),
            )

            self._mark_step(record, "validate_result", "running", "正在归一化执行报告")
            status = str(report.get("status") or "").strip()
            execution_result = report.get("execution_result") if isinstance(report.get("execution_result"), dict) else {}
            validation_result = report.get("validation_result") if isinstance(report.get("validation_result"), dict) else {}
            issues = self._collect_report_issues(validation_result, execution_result)
            first_issue = issues[0] if issues else None
            refinement_summary = _extract_template_refinement_summary(report, first_issue)

            if status == "executed" and bool(execution_result.get("applied")):
                self._mark_step(record, "validate_result", "completed")
                self._mark_step(record, "materialize_output", "running", "正在确认输出文件")
                output_path = str(execution_result.get("output_docx_path") or "").strip()
                if not output_path:
                    raise RuntimeError("E_TEMPLATE_OUTPUT_NOT_FOUND: template run did not provide output_docx_path.")
                output_file = Path(output_path)
                if not output_file.exists():
                    raise FileNotFoundError(f"E_TEMPLATE_OUTPUT_NOT_FOUND: output DOCX does not exist: {output_file}")
                with (record.lock or threading.Lock()):
                    record.output_path = str(output_file)
                self._mark_step(record, "materialize_output", "completed")
                with (record.lock or threading.Lock()):
                    record.status = "completed"
                    record.updated_at = int(time.time() * 1000)
                    record.summary = str(
                        execution_result.get("change_summary") or "模板修改任务已完成"
                    )
                    record.error = None
                return

            failure_message = self._resolve_failure_message(first_issue)
            self._mark_step(
                record,
                "validate_result",
                "failed",
                _format_issue_detail_with_refinement_summary(first_issue, refinement_summary),
            )
            with (record.lock or threading.Lock()):
                record.status = "failed"
                record.updated_at = int(time.time() * 1000)
                record.summary = failure_message
                record.error = {"message": failure_message}
                record.debug = (
                    {"refinementSummary": refinement_summary}
                    if refinement_summary
                    else None
                )
        except (TemplateBridgeError, TemplateBridgeTimeout) as exc:
            self._fail_running_step(record, str(exc), bridge_error=exc)
        except Exception as exc:  # noqa: BLE001
            self._fail_running_step(record, str(exc))

    def _mark_step(
        self,
        record: TemplateJobRecord,
        step_id: str,
        status: str,
        detail: str | None = None,
    ) -> None:
        with (record.lock or threading.Lock()):
            record.status = "running" if status == "running" else record.status
            record.updated_at = int(time.time() * 1000)
            if status == "running":
                record.summary = "模板修改任务正在执行"
            for step in record.steps or []:
                if step.get("id") == step_id:
                    step["status"] = status
                    if detail is not None:
                        step["detail"] = detail
                    elif "detail" in step:
                        del step["detail"]
                    break

    def _fail_running_step(
        self,
        record: TemplateJobRecord,
        message: str,
        *,
        bridge_error: TemplateBridgeError | None = None,
    ) -> None:
        with (record.lock or threading.Lock()):
            record.status = "failed"
            record.updated_at = int(time.time() * 1000)
            record.summary = message
            record.error = {
                "message": message,
                **({"code": bridge_error.code} if bridge_error and bridge_error.code else {}),
                **({"stage": bridge_error.stage} if bridge_error and bridge_error.stage else {}),
                **(
                    {"stageTimingsMs": bridge_error.stage_timings_ms}
                    if bridge_error and bridge_error.stage_timings_ms
                    else {}
                ),
                **(
                    {"stderrSummary": bridge_error.stderr_summary}
                    if bridge_error and bridge_error.stderr_summary
                    else {}
                ),
            }
            for step in record.steps or []:
                if step.get("status") == "running":
                    step["status"] = "failed"
                    detail = message
                    if bridge_error and bridge_error.stage_timings_ms:
                        timing_detail = _format_stage_timings(bridge_error.stage_timings_ms)
                        if timing_detail:
                            detail = f"{detail}\n{timing_detail}"
                    if bridge_error and bridge_error.stderr_summary:
                        detail = f"{detail}\nstderr: {bridge_error.stderr_summary}"
                    step["detail"] = detail
                    break

    def _collect_report_issues(
        self,
        validation_result: dict[str, Any],
        execution_result: dict[str, Any],
    ) -> list[dict[str, Any]]:
        issues: list[dict[str, Any]] = []
        for source in (validation_result.get("issues"), execution_result.get("issues")):
            if isinstance(source, list):
                for issue in source:
                    if isinstance(issue, dict):
                        issues.append(issue)
        return issues

    def _format_issue_detail(self, issue: dict[str, Any] | None) -> str:
        return _format_template_issue_detail(issue)

    def _resolve_failure_message(self, issue: dict[str, Any] | None) -> str:
        if isinstance(issue, dict):
            message = str(issue.get("message") or "").strip()
            if message:
                return message
        return "模板修改任务失败"


class WebApiServer:
    def __init__(self, config: WebApiConfig | None = None) -> None:
        self.config = config or WebApiConfig()
        self.config.front_dist_dir.mkdir(parents=True, exist_ok=True)
        self.config.upload_dir.mkdir(parents=True, exist_ok=True)
        self.config.templates_dir.mkdir(parents=True, exist_ok=True)
        self.config.output_dir.mkdir(parents=True, exist_ok=True)
        self._sync_request_timeout_sec = _resolve_sync_request_timeout_sec(
            self.config.sync_request_timeout_sec
        )
        self._turn_jobs = TurnJobRegistry(
            self._sync_request_timeout_sec, self._fetch_normalized_session_sync
        )
        self._template_jobs = TemplateJobRegistry(self.config.output_dir)

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
                if path == "/api/templates/configs":
                    self._handle_template_configs()
                    return
                if path.startswith("/api/templates/runs/"):
                    self._handle_get_template_run(path)
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
                if path == "/api/templates/import-document":
                    self._handle_template_import_document()
                    return
                if path == "/api/templates/runs":
                    self._handle_create_template_run()
                    return
                if path == "/api/templates/open-output":
                    self._handle_open_template_output()
                    return
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

            def _handle_template_configs(self) -> None:
                configs: list[dict[str, str]] = []
                if config.templates_dir.exists():
                    for path in sorted(config.templates_dir.glob("*.json"), key=lambda item: item.name.lower()):
                        if path.is_file():
                            configs.append({"fileName": path.name, "path": str(path)})
                self._send_json({"configs": configs})

            def _handle_template_import_document(self) -> None:
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

                original_name = Path(uploaded_file["filename"]).name or "upload.docx"
                if not original_name.lower().endswith(".docx"):
                    self._send_json_error(HTTPStatus.BAD_REQUEST, "Only .docx files are supported.")
                    return

                upload_path = config.upload_dir / f"{uuid4().hex}-{original_name}"
                with upload_path.open("wb") as fh:
                    fh.write(uploaded_file["content"])

                self._send_json(
                    {
                        "document": {
                            "fileName": original_name,
                            "uploadedPath": str(upload_path),
                        }
                    }
                )

            def _handle_create_template_run(self) -> None:
                body = self._read_json_body()
                if body is None:
                    return

                document_path_raw = str(body.get("documentPath") or "").strip()
                template_path_raw = str(body.get("templatePath") or "").strip()
                if not document_path_raw or not template_path_raw:
                    self._send_json_error(HTTPStatus.BAD_REQUEST, "documentPath and templatePath are required.")
                    return
                document_path = Path(document_path_raw)
                template_path = Path(template_path_raw)
                if not document_path.exists() or document_path.suffix.lower() != ".docx":
                    self._send_json_error(HTTPStatus.BAD_REQUEST, "documentPath must point to an existing .docx file.")
                    return
                if not template_path.exists() or template_path.suffix.lower() != ".json":
                    self._send_json_error(HTTPStatus.BAD_REQUEST, "templatePath must point to an existing .json file.")
                    return

                job = server._template_jobs.create_job(document_path, template_path)
                snapshot = job.snapshot()
                server._template_jobs.start_job(job.job_id)
                self._send_json({"job": snapshot}, status=HTTPStatus.ACCEPTED)

            def _handle_get_template_run(self, path: str) -> None:
                job_id = self._extract_template_job_id(path)
                if not job_id:
                    self._send_json_error(HTTPStatus.NOT_FOUND, "Template job route not found.")
                    return
                try:
                    job = server._template_jobs.get_job(job_id)
                except KeyError:
                    self._send_json_error(HTTPStatus.NOT_FOUND, "Template job not found.")
                    return
                snapshot = job.snapshot()
                payload: dict[str, Any] = {"job": snapshot}
                if job.output_path:
                    payload["outputPath"] = job.output_path
                self._send_json(payload)

            def _handle_open_template_output(self) -> None:
                body = self._read_json_body()
                if body is None:
                    return

                output_path_raw = str(body.get("outputPath") or "").strip()
                if not output_path_raw:
                    self._send_json_error(HTTPStatus.BAD_REQUEST, "outputPath is required.")
                    return
                output_path = Path(output_path_raw)
                if not output_path.exists():
                    self._send_json_error(
                        HTTPStatus.CONFLICT,
                        "Output path does not exist.",
                        {"code": "E_OUTPUT_NOT_FOUND", "outputPath": str(output_path)},
                    )
                    return

                try:
                    _open_file_manager(output_path.parent)
                except OSError as exc:
                    self._send_json_error(
                        HTTPStatus.BAD_GATEWAY,
                        str(exc),
                        {"code": "E_OPEN_OUTPUT_FAILED", "outputPath": str(output_path)},
                    )
                    return
                self._send_json({"ok": True})

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
                        "warnings": collect_model_config_warnings(config_data),
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

            def _extract_template_job_id(self, path: str) -> str:
                prefix = "/api/templates/runs/"
                if not path.startswith(prefix):
                    return ""
                return unquote(path[len(prefix):])

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


def _open_file_manager(directory: Path) -> None:
    if sys.platform.startswith("win"):
        os.startfile(str(directory))  # type: ignore[attr-defined]
        return
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(directory)])
        return
    subprocess.Popen(["xdg-open", str(directory)])


__all__ = ["WebApiConfig", "WebApiServer", "find_available_port"]


def _is_session_not_found_error(exc: Exception) -> bool:
    return "E_SESSION_NOT_FOUND" in str(exc)


def _format_config_warnings(warnings: list[dict[str, Any]] | None) -> str:
    if not warnings:
        return ""
    lines = ["配置警告:"]
    for warning in warnings:
        message = str(warning.get("message") or "").strip()
        if message:
            lines.append(f"- {message}")
    return "\n".join(lines)


def _format_stage_timings(stage_timings_ms: Any) -> str | None:
    if not isinstance(stage_timings_ms, dict):
        return None
    labels = [
        ("observation_ms", "observe_docx"),
        ("classification_request_ms", "classification_request"),
        ("refinement_ms", "refinement"),
        ("validation_ms", "validation"),
        ("execution_ms", "execution"),
    ]
    parts: list[str] = []
    for key, label in labels:
        value = stage_timings_ms.get(key)
        if isinstance(value, (int, float)):
            parts.append(f"{label}={int(value)}ms")
    if not parts:
        return None
    return "stage_timings_ms: " + ", ".join(parts)


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


def _normalize_template_run_warnings(raw_warnings: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_warnings, list):
        return []

    normalized: list[dict[str, Any]] = []
    for warning in raw_warnings:
        if not isinstance(warning, dict):
            continue
        code = str(warning.get("code") or "").strip()
        message = str(warning.get("message") or "").strip()
        if not code or not message:
            continue
        item: dict[str, Any] = {
            "code": code,
            "scope": "template_run",
            "message": message,
        }
        paragraph_ids = warning.get("paragraph_ids")
        if isinstance(paragraph_ids, list):
            normalized_ids = [str(paragraph_id).strip() for paragraph_id in paragraph_ids if str(paragraph_id).strip()]
            if normalized_ids:
                item["paragraphIds"] = normalized_ids
        diagnostics = warning.get("diagnostics")
        if isinstance(diagnostics, dict):
            item["diagnostics"] = dict(diagnostics)
        normalized.append(item)
    return normalized


def _extract_template_refinement_summary(
    report: dict[str, Any],
    issue: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    if not isinstance(report, dict):
        return []

    classification_result = report.get("classification_result")
    if not isinstance(classification_result, dict):
        return []

    target_paragraph_ids = _normalize_issue_paragraph_ids(issue)
    diagnostics = (
        classification_result.get("diagnostics")
        if isinstance(classification_result.get("diagnostics"), dict)
        else {}
    )
    refined_paragraphs = diagnostics.get("refined_paragraphs") if isinstance(diagnostics, dict) else None

    refinement_summary: list[dict[str, Any]] = []
    if isinstance(refined_paragraphs, list):
        for item in refined_paragraphs:
            normalized = _normalize_refined_paragraph_summary(item)
            paragraph_id = str(normalized.get("paragraphId") or "").strip()
            if not paragraph_id:
                continue
            if target_paragraph_ids and paragraph_id not in target_paragraph_ids:
                continue
            refinement_summary.append(normalized)

    if refinement_summary:
        return refinement_summary

    conflicts = classification_result.get("conflicts")
    if not isinstance(conflicts, list):
        return []

    for conflict in conflicts:
        if not isinstance(conflict, dict):
            continue
        paragraph_id = str(conflict.get("paragraph_id") or "").strip()
        if not paragraph_id:
            continue
        if target_paragraph_ids and paragraph_id not in target_paragraph_ids:
            continue
        candidate_semantic_keys = _normalize_string_list(conflict.get("candidate_semantic_keys"))
        first_pass: dict[str, Any] = {"source": "conflict"}
        if candidate_semantic_keys:
            first_pass["candidateSemanticKeys"] = candidate_semantic_keys
        reason = str(conflict.get("reason") or "").strip()
        if reason:
            first_pass["reason"] = reason
        refinement_summary.append(
            {
                "paragraphId": paragraph_id,
                "firstPass": first_pass,
                "outcome": "rejected_conflict",
            }
        )

    return refinement_summary


def _normalize_issue_paragraph_ids(issue: dict[str, Any] | None) -> set[str]:
    if not isinstance(issue, dict):
        return set()
    return set(_normalize_string_list(issue.get("paragraph_ids")))


def _normalize_refined_paragraph_summary(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        return {}
    summary: dict[str, Any] = {}
    paragraph_id = str(item.get("paragraph_id") or "").strip()
    if paragraph_id:
        summary["paragraphId"] = paragraph_id

    first_pass = item.get("first_pass") if isinstance(item.get("first_pass"), dict) else {}
    normalized_first_pass = _normalize_refinement_pass(first_pass, is_first_pass=True)
    if normalized_first_pass:
        summary["firstPass"] = normalized_first_pass

    second_pass = item.get("second_pass") if isinstance(item.get("second_pass"), dict) else {}
    normalized_second_pass = _normalize_refinement_pass(second_pass, is_first_pass=False)
    if normalized_second_pass:
        summary["secondPass"] = normalized_second_pass

    outcome = str(item.get("outcome") or "").strip()
    if outcome:
        summary["outcome"] = outcome
    return summary


def _normalize_refinement_pass(
    raw_pass: dict[str, Any],
    *,
    is_first_pass: bool,
) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    semantic_keys = _normalize_string_list(raw_pass.get("semantic_keys"))
    if semantic_keys:
        normalized["semanticKeys"] = semantic_keys

    semantic_key = str(raw_pass.get("semantic_key") or "").strip()
    if semantic_key:
        normalized["semanticKey"] = semantic_key

    candidate_semantic_keys = _normalize_string_list(raw_pass.get("candidate_semantic_keys"))
    if candidate_semantic_keys:
        normalized["candidateSemanticKeys"] = candidate_semantic_keys

    confidence = raw_pass.get("confidence")
    if isinstance(confidence, (int, float)):
        normalized["confidence"] = float(confidence)

    reason = str(raw_pass.get("reason") or "").strip()
    if reason:
        normalized["reason"] = reason

    if is_first_pass:
        source = str(raw_pass.get("source") or "").strip()
        if source:
            normalized["source"] = source

    return normalized


def _normalize_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    normalized: list[str] = []
    for item in value:
        text = str(item).strip()
        if text:
            normalized.append(text)
    return normalized


def _format_template_issue_detail(issue: dict[str, Any] | None) -> str:
    if not isinstance(issue, dict):
        return "模板执行失败"
    code = str(issue.get("error_code") or "").strip()
    message = str(issue.get("message") or "模板执行失败").strip()
    diagnostics = issue.get("diagnostics") if isinstance(issue.get("diagnostics"), dict) else {}
    diagnostic_parts: list[str] = []
    semantic_key = str(diagnostics.get("semantic_key") or "").strip()
    numbering_prefix = str(diagnostics.get("numbering_prefix") or "").strip()
    rule_source = str(diagnostics.get("rule_source") or "").strip()
    allowed_patterns = diagnostics.get("allowed_patterns")
    if semantic_key:
        diagnostic_parts.append(f"semantic={semantic_key}")
    if numbering_prefix:
        diagnostic_parts.append(f"prefix={numbering_prefix}")
    if rule_source:
        diagnostic_parts.append(f"rule={rule_source}")
    if isinstance(allowed_patterns, list):
        normalized_patterns = [
            str(pattern).strip()
            for pattern in allowed_patterns
            if isinstance(pattern, str) and str(pattern).strip()
        ]
        if normalized_patterns:
            diagnostic_parts.append(f"allowed={', '.join(normalized_patterns)}")
    detail = f"{code}: {message}" if code else message
    if diagnostic_parts:
        return f"{detail} [{'; '.join(diagnostic_parts)}]"
    return detail


def _format_issue_detail_with_refinement_summary(
    issue: dict[str, Any] | None,
    refinement_summary: list[dict[str, Any]],
) -> str:
    detail = _format_template_issue_detail(issue)
    if not refinement_summary:
        return detail
    return f"{detail}\n{_format_refinement_summary_detail(refinement_summary)}"


def _format_refinement_summary_detail(refinement_summary: list[dict[str, Any]]) -> str:
    lines = ["诊断摘要:"]
    for item in refinement_summary:
        paragraph_id = str(item.get("paragraphId") or "").strip()
        parts: list[str] = []
        if paragraph_id:
            parts.append(f"paragraph={paragraph_id}")

        first_pass = item.get("firstPass") if isinstance(item.get("firstPass"), dict) else {}
        first_pass_text = _format_refinement_pass_summary(first_pass, include_second_pass_label=False)
        if first_pass_text:
            parts.append(f"first_pass={first_pass_text}")

        second_pass = item.get("secondPass") if isinstance(item.get("secondPass"), dict) else {}
        second_pass_text = _format_refinement_pass_summary(second_pass, include_second_pass_label=True)
        if second_pass_text:
            parts.append(f"second_pass={second_pass_text}")

        outcome = str(item.get("outcome") or "").strip()
        if outcome:
            parts.append(f"outcome={outcome}")

        if parts:
            lines.append("- " + "; ".join(parts))
    return "\n".join(lines)


def _format_refinement_pass_summary(
    refinement_pass: dict[str, Any],
    *,
    include_second_pass_label: bool,
) -> str:
    parts: list[str] = []
    semantic_keys = refinement_pass.get("semanticKeys")
    if isinstance(semantic_keys, list) and semantic_keys:
        parts.append(", ".join(str(item) for item in semantic_keys))

    semantic_key = str(refinement_pass.get("semanticKey") or "").strip()
    if semantic_key:
        parts.append(semantic_key)

    candidate_semantic_keys = refinement_pass.get("candidateSemanticKeys")
    if isinstance(candidate_semantic_keys, list) and candidate_semantic_keys:
        parts.append("candidate_keys=" + ", ".join(str(item) for item in candidate_semantic_keys))

    confidence = refinement_pass.get("confidence")
    if isinstance(confidence, (int, float)):
        parts.append(f"confidence={confidence:.2f}")

    reason = str(refinement_pass.get("reason") or "").strip()
    if reason:
        parts.append(f"reason={reason}")

    if not include_second_pass_label:
        source = str(refinement_pass.get("source") or "").strip()
        if source:
            parts.append(f"source={source}")

    return "; ".join(parts)
