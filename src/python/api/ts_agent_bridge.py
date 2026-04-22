from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from ..core.model_config import build_ts_agent_env, load_model_config
from ..core.project_paths import PROJECT_ROOT, TMP_DIR

_DEFAULT_TIMEOUT = object()

class TsAgentBridgeError(RuntimeError):
    pass


class TsAgentBridgeTimeout(TsAgentBridgeError):
    pass


@dataclass
class TsAgentBridgeOptions:
    node_command: str = "node"
    timeout_sec: float = 90.0
    project_root: Path = PROJECT_ROOT
    ts_agent_dirname: str = "src/ts"
    cli_rel_path: str = "dist/runtime/cli.js"
    default_use_llm_planner: bool = True
    default_runtime_mode: str = "react_loop"

    @property
    def ts_agent_dir(self) -> Path:
        return self.project_root / self.ts_agent_dirname

    @property
    def cli_path(self) -> Path:
        return self.ts_agent_dir / self.cli_rel_path


def _run_ts_agent_command(
    command: dict[str, Any],
    timeout_sec: float | None | object = _DEFAULT_TIMEOUT,
    options: TsAgentBridgeOptions | None = None,
) -> dict[str, Any]:
    if not isinstance(command, dict):
        raise TsAgentBridgeError("command must be a dict.")
    command_type = str(command.get("type", "")).strip()
    if not command_type:
        raise TsAgentBridgeError("command.type must be a non-empty string.")

    opts = options or _load_default_bridge_options()
    effective_timeout = opts.timeout_sec if timeout_sec is _DEFAULT_TIMEOUT else timeout_sec
    return _run_cli_request({"command": dict(command)}, effective_timeout, opts)


def submit_agent_turn(
    session_id: str,
    user_input: str,
    *,
    timeout_sec: float | None | object = _DEFAULT_TIMEOUT,
    options: TsAgentBridgeOptions | None = None,
) -> dict[str, Any]:
    command = {
        "type": "submit_turn",
        "sessionId": str(session_id).strip(),
        "userInput": str(user_input).strip(),
    }
    return _run_ts_agent_command(command, timeout_sec=timeout_sec, options=options)


def create_session(
    session_id: str,
    *,
    timeout_sec: float | None | object = _DEFAULT_TIMEOUT,
    options: TsAgentBridgeOptions | None = None,
) -> dict[str, Any]:
    return _run_ts_agent_command(
        {
            "type": "create_session",
            "sessionId": str(session_id).strip(),
        },
        timeout_sec=timeout_sec,
        options=options,
    )


def list_sessions(
    *,
    timeout_sec: float | None | object = _DEFAULT_TIMEOUT,
    options: TsAgentBridgeOptions | None = None,
) -> dict[str, Any]:
    return _run_ts_agent_command(
        {"type": "list_sessions"},
        timeout_sec=timeout_sec,
        options=options,
    )


def attach_document(
    session_id: str,
    docx_path: str,
    *,
    timeout_sec: float | None | object = _DEFAULT_TIMEOUT,
    options: TsAgentBridgeOptions | None = None,
) -> dict[str, Any]:
    return _run_ts_agent_command(
        {
            "type": "attach_document",
            "sessionId": str(session_id).strip(),
            "docxPath": str(docx_path).strip(),
        },
        timeout_sec=timeout_sec,
        options=options,
    )


def get_session_state(
    session_id: str,
    *,
    timeout_sec: float | None | object = _DEFAULT_TIMEOUT,
    options: TsAgentBridgeOptions | None = None,
) -> dict[str, Any]:
    return _run_ts_agent_command(
        {"type": "get_session", "sessionId": str(session_id).strip()},
        timeout_sec=timeout_sec,
        options=options,
    )


def get_turn_run_status(
    *,
    session_id: str | None = None,
    turn_run_id: str | None = None,
    timeout_sec: float | None | object = _DEFAULT_TIMEOUT,
    options: TsAgentBridgeOptions | None = None,
) -> dict[str, Any]:
    normalized_session_id = str(session_id or "").strip()
    normalized_turn_run_id = str(turn_run_id or "").strip()
    if not normalized_session_id and not normalized_turn_run_id:
        raise TsAgentBridgeError("E_TURN_RUN_QUERY_INVALID: session_id or turn_run_id is required.")
    command: dict[str, Any] = {"type": "get_turn_run_status"}
    if normalized_session_id:
        command["sessionId"] = normalized_session_id
    if normalized_turn_run_id:
        command["turnRunId"] = normalized_turn_run_id
    return _run_ts_agent_command(
        command,
        timeout_sec=timeout_sec,
        options=options,
    )


def update_session_title(
    session_id: str,
    title: str,
    *,
    timeout_sec: float | None | object = _DEFAULT_TIMEOUT,
    options: TsAgentBridgeOptions | None = None,
) -> dict[str, Any]:
    return _run_ts_agent_command(
        {
            "type": "update_session",
            "sessionId": str(session_id).strip(),
            "title": str(title).strip(),
        },
        timeout_sec=timeout_sec,
        options=options,
    )


def delete_session(
    session_id: str,
    *,
    timeout_sec: float | None | object = _DEFAULT_TIMEOUT,
    options: TsAgentBridgeOptions | None = None,
) -> dict[str, Any]:
    return _run_ts_agent_command(
        {"type": "delete_session", "sessionId": str(session_id).strip()},
        timeout_sec=timeout_sec,
        options=options,
    )


def _run_cli_request(
    request_payload: dict[str, Any],
    effective_timeout: float | None,
    opts: TsAgentBridgeOptions,
) -> dict[str, Any]:
    if not opts.cli_path.exists():
        raise TsAgentBridgeError(
            f"ts runtime CLI not found: {opts.cli_path}. Run `npm run build` in src/ts first."
        )

    temp_root = TMP_DIR if opts.project_root == PROJECT_ROOT else opts.project_root / ".tmp"
    temp_root.mkdir(parents=True, exist_ok=True)

    temp_path = temp_root / f"ts-agent-bridge-{uuid4().hex}"
    temp_path.mkdir(parents=True, exist_ok=False)
    try:
        input_json = temp_path / "input.json"
        output_json = temp_path / "output.json"
        input_json.write_text(json.dumps(request_payload, ensure_ascii=False), encoding="utf-8")

        cmd = [
            opts.node_command,
            str(opts.cli_path),
            "--input-json",
            str(input_json),
            "--output-json",
            str(output_json),
        ]
        try:
            completed = subprocess.run(
                cmd,
                cwd=str(opts.ts_agent_dir),
                env=_build_subprocess_env(),
                text=True,
                capture_output=True,
                timeout=effective_timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise TsAgentBridgeTimeout(
                f"ts_agent execution timed out after {float(effective_timeout):.1f}s."
            ) from exc
        except OSError as exc:
            raise _bridge_error("E_TS_AGENT_START_FAILED", f"failed to start ts_agent process: {exc}") from exc

        output_data, output_error = _try_read_output_json(output_json)
        if completed.returncode != 0:
            err = output_data.get("error") if isinstance(output_data, dict) else None
            if isinstance(err, dict):
                err_code = str(err.get("code") or "E_TS_AGENT_CLI_EXIT_NONZERO")
                err_message = str(err.get("message") or "ts_agent failed.")
            elif output_error is not None:
                err_code = "E_TS_AGENT_CLI_EXIT_NONZERO"
                _, output_error_message = output_error
                err_message = f"ts_agent exited with code {completed.returncode}. {output_error_message}"
            else:
                err_code, err_message = "E_TS_AGENT_CLI_EXIT_NONZERO", (
                    f"ts_agent exited with code {completed.returncode}."
                )
            stderr_preview = (completed.stderr or "").strip()[:300]
            if stderr_preview:
                err_message = f"{err_message} stderr={stderr_preview}"
            raise _bridge_error(err_code, err_message)

        if output_error is not None:
            raise _bridge_error(*output_error)
        if not isinstance(output_data, dict):
            raise _bridge_error("E_TS_AGENT_OUTPUT_INVALID_SHAPE", "ts_agent output must be a JSON object.")
        return output_data
    finally:
        shutil.rmtree(temp_path, ignore_errors=True)


def _try_read_output_json(output_json: Path) -> tuple[dict[str, Any] | None, tuple[str, str] | None]:
    if not output_json.exists():
        return None, ("E_TS_AGENT_OUTPUT_MISSING", "ts_agent did not produce output JSON.")
    try:
        parsed = json.loads(output_json.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, ("E_TS_AGENT_OUTPUT_INVALID_JSON", f"invalid ts_agent output JSON: {exc}")
    if not isinstance(parsed, dict):
        return None, ("E_TS_AGENT_OUTPUT_INVALID_SHAPE", "ts_agent output JSON root must be object.")
    return parsed, None


def _build_subprocess_env() -> dict[str, str]:
    env = dict(os.environ)
    env.update(build_ts_agent_env(load_model_config()))
    return env


def _load_default_bridge_options() -> TsAgentBridgeOptions:
    config = load_model_config()
    timeout_ms = config.planner.sync_request_timeout_ms
    timeout_sec = float(timeout_ms) / 1000.0 if timeout_ms is not None else None
    return TsAgentBridgeOptions(timeout_sec=timeout_sec)


def _bridge_error(code: str, message: str) -> TsAgentBridgeError:
    return TsAgentBridgeError(f"{code}: {message}")


__all__ = [
    "create_session",
    "list_sessions",
    "submit_agent_turn",
    "attach_document",
    "get_session_state",
    "get_turn_run_status",
    "update_session_title",
    "delete_session",
    "TsAgentBridgeError",
    "TsAgentBridgeTimeout",
    "TsAgentBridgeOptions",
]
