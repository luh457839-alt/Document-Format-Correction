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


class TemplateBridgeError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        stage: str | None = None,
        stage_timings_ms: dict[str, Any] | None = None,
        stderr_summary: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.stage_timings_ms = stage_timings_ms
        self.stderr_summary = stderr_summary


class TemplateBridgeTimeout(TemplateBridgeError):
    pass


@dataclass
class TemplateBridgeOptions:
    node_command: str = "node"
    timeout_sec: float | None = 90.0
    project_root: Path = PROJECT_ROOT
    ts_agent_dirname: str = "src/ts"
    cli_rel_path: str = "dist/templates/template-cli.js"

    @property
    def ts_agent_dir(self) -> Path:
        return self.project_root / self.ts_agent_dirname

    @property
    def cli_path(self) -> Path:
        return self.ts_agent_dir / self.cli_rel_path


def run_template_job(
    docx_path: str,
    template_path: str,
    *,
    timeout_sec: float | None | object = _DEFAULT_TIMEOUT,
    options: TemplateBridgeOptions | None = None,
    request_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_docx_path = str(docx_path).strip()
    normalized_template_path = str(template_path).strip()
    if not normalized_docx_path:
        raise TemplateBridgeError("E_TEMPLATE_INPUT_INVALID: docx_path is required.")
    if not normalized_template_path:
        raise TemplateBridgeError("E_TEMPLATE_INPUT_INVALID: template_path is required.")

    opts = options or _load_default_bridge_options()
    effective_timeout = opts.timeout_sec if timeout_sec is _DEFAULT_TIMEOUT else timeout_sec
    request_payload: dict[str, Any] = {
        "docxPath": normalized_docx_path,
        "templatePath": normalized_template_path,
    }
    if isinstance(request_options, dict):
        request_payload.update(request_options)
    return _run_cli_request(request_payload, effective_timeout, opts)


def _run_cli_request(
    request_payload: dict[str, Any],
    effective_timeout: float | None,
    opts: TemplateBridgeOptions,
) -> dict[str, Any]:
    if not opts.cli_path.exists():
        raise TemplateBridgeError(
            f"E_TEMPLATE_CLI_NOT_FOUND: template CLI not found: {opts.cli_path}. "
            "Run `npm run build` in `src/ts` first."
        )

    temp_root = TMP_DIR if opts.project_root == PROJECT_ROOT else opts.project_root / ".tmp"
    temp_root.mkdir(parents=True, exist_ok=True)

    temp_path = temp_root / f"template-bridge-{uuid4().hex}"
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
            timeout_text = "unknown" if effective_timeout is None else f"{float(effective_timeout):.1f}s"
            stderr_summary = _summarize_stderr(_coerce_text(exc.stderr))
            stage = _extract_stderr_phase(_coerce_text(exc.stderr))
            message = _compose_bridge_message(
                "E_TEMPLATE_TIMEOUT",
                f"template execution timed out after {timeout_text}.",
                stage=stage,
                stderr_summary=stderr_summary,
            )
            raise TemplateBridgeTimeout(
                message,
                code="E_TEMPLATE_TIMEOUT",
                stage=stage,
                stderr_summary=stderr_summary,
            ) from exc
        except OSError as exc:
            raise TemplateBridgeError(
                f"E_TEMPLATE_START_FAILED: failed to start template CLI process: {exc}"
            ) from exc

        output_data, output_error = _try_read_output_json(output_json)
        stderr_summary = _summarize_stderr(completed.stderr or "")
        stage = _read_output_stage(output_data) or _extract_stderr_phase(completed.stderr or "")
        stage_timings_ms = _read_output_stage_timings(output_data)
        if completed.returncode != 0:
            err = output_data.get("error") if isinstance(output_data, dict) else None
            if isinstance(err, dict):
                code = str(err.get("code") or "E_TEMPLATE_CLI_EXIT_NONZERO")
                message = str(err.get("message") or "template CLI failed.")
                stage = str(err.get("stage") or stage or "").strip() or None
                if isinstance(err.get("stage_timings_ms"), dict):
                    stage_timings_ms = err.get("stage_timings_ms")
            elif output_error is not None:
                code, message = "E_TEMPLATE_CLI_EXIT_NONZERO", output_error[1]
            else:
                code, message = "E_TEMPLATE_CLI_EXIT_NONZERO", (
                    f"template CLI exited with code {completed.returncode}."
                )
            raise TemplateBridgeError(
                _compose_bridge_message(
                    code,
                    message,
                    stage=stage,
                    stage_timings_ms=stage_timings_ms,
                    stderr_summary=stderr_summary,
                ),
                code=code,
                stage=stage,
                stage_timings_ms=stage_timings_ms,
                stderr_summary=stderr_summary,
            )

        if output_error is not None:
            raise TemplateBridgeError(f"{output_error[0]}: {output_error[1]}")
        if not isinstance(output_data, dict):
            raise TemplateBridgeError("E_TEMPLATE_OUTPUT_INVALID_SHAPE: template output must be a JSON object.")
        return output_data
    finally:
        shutil.rmtree(temp_path, ignore_errors=True)


def _try_read_output_json(output_json: Path) -> tuple[dict[str, Any] | None, tuple[str, str] | None]:
    if not output_json.exists():
        return None, ("E_TEMPLATE_OUTPUT_MISSING", "template CLI did not produce output JSON.")
    try:
        parsed = json.loads(output_json.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, ("E_TEMPLATE_OUTPUT_INVALID_JSON", f"invalid template output JSON: {exc}")
    if not isinstance(parsed, dict):
        return None, ("E_TEMPLATE_OUTPUT_INVALID_SHAPE", "template output JSON root must be object.")
    return parsed, None


def _read_output_stage(payload: dict[str, Any] | None) -> str | None:
    if not isinstance(payload, dict):
        return None
    if isinstance(payload.get("stage"), str) and str(payload.get("stage")).strip():
        return str(payload.get("stage")).strip()
    error = payload.get("error")
    if isinstance(error, dict) and isinstance(error.get("stage"), str) and str(error.get("stage")).strip():
        return str(error.get("stage")).strip()
    return None


def _read_output_stage_timings(payload: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    value = payload.get("stage_timings_ms")
    if isinstance(value, dict):
        return value
    error = payload.get("error")
    if isinstance(error, dict) and isinstance(error.get("stage_timings_ms"), dict):
        return error.get("stage_timings_ms")
    return None


def _compose_bridge_message(
    code: str,
    message: str,
    *,
    stage: str | None = None,
    stage_timings_ms: dict[str, Any] | None = None,
    stderr_summary: str | None = None,
) -> str:
    details: list[str] = []
    if stage:
        details.append(f"stage={stage}")
    timings_text = _format_stage_timings(stage_timings_ms)
    if timings_text:
        details.append(f"stage_timings_ms={timings_text}")
    if stderr_summary:
        details.append(f"stderr={stderr_summary}")
    if details:
        return f"{code}: {message} [{' ; '.join(details)}]"
    return f"{code}: {message}"


def _format_stage_timings(stage_timings_ms: dict[str, Any] | None) -> str | None:
    if not isinstance(stage_timings_ms, dict):
        return None
    ordered_keys = ["observation_ms", "classification_request_ms", "refinement_ms", "validation_ms", "execution_ms"]
    parts: list[str] = []
    for key in ordered_keys:
        value = stage_timings_ms.get(key)
        if isinstance(value, (int, float)):
            parts.append(f"{key}={int(value)}")
    return ", ".join(parts) if parts else None


def _summarize_stderr(stderr_text: str) -> str | None:
    lines = [line.strip() for line in stderr_text.splitlines() if line.strip()]
    if not lines:
        return None
    summary_parts: list[str] = []
    for line in lines[-6:]:
        try:
            parsed = json.loads(line)
        except Exception:
            summary_parts.append(line[:160])
            continue
        if not isinstance(parsed, dict) or parsed.get("type") != "model_request_diagnostic":
            summary_parts.append(line[:160])
            continue
        phase = str(parsed.get("phase") or "model_request")
        endpoint_host = str(parsed.get("endpointHost") or "").strip()
        endpoint_path = str(parsed.get("endpointPath") or "").strip()
        endpoint = f"{endpoint_host}{endpoint_path}".strip()
        model = str(parsed.get("model") or "").strip()
        timeout_ms = parsed.get("timeoutMs")
        json_schema_enabled = parsed.get("jsonSchemaEnabled")
        request_mode = str(parsed.get("requestMode") or "").strip()
        prompt_bytes = parsed.get("promptBytes")
        schema_bytes = parsed.get("schemaBytes")
        paragraph_count = parsed.get("paragraphCount")
        semantic_block_count = parsed.get("semanticBlockCount")
        fallback_attempt = parsed.get("fallbackAttempt")
        batch_type = str(parsed.get("batchType") or "").strip()
        batch_index = parsed.get("batchIndex")
        batch_count = parsed.get("batchCount")
        batch_paragraph_count = parsed.get("batchParagraphCount")
        parts = [phase]
        if endpoint:
            parts.append(f"endpoint={endpoint}")
        if model:
            parts.append(f"model={model}")
        if isinstance(timeout_ms, (int, float)):
            parts.append(f"timeoutMs={int(timeout_ms)}")
        if isinstance(json_schema_enabled, bool):
            parts.append(f"json_schema={str(json_schema_enabled).lower()}")
        if request_mode:
            parts.append(f"request_mode={request_mode}")
        if isinstance(prompt_bytes, (int, float)):
            parts.append(f"promptBytes={int(prompt_bytes)}")
        if isinstance(schema_bytes, (int, float)):
            parts.append(f"schemaBytes={int(schema_bytes)}")
        if isinstance(paragraph_count, (int, float)):
            parts.append(f"paragraphCount={int(paragraph_count)}")
        if isinstance(semantic_block_count, (int, float)):
            parts.append(f"semanticBlockCount={int(semantic_block_count)}")
        if isinstance(fallback_attempt, (int, float)):
            parts.append(f"fallbackAttempt={int(fallback_attempt)}")
        if batch_type:
            parts.append(f"batchType={batch_type}")
        if isinstance(batch_index, (int, float)):
            parts.append(f"batchIndex={int(batch_index)}")
        if isinstance(batch_count, (int, float)):
            parts.append(f"batchCount={int(batch_count)}")
        if isinstance(batch_paragraph_count, (int, float)):
            parts.append(f"batchParagraphCount={int(batch_paragraph_count)}")
        summary_parts.append(" ".join(parts))
    summary = " | ".join(part for part in summary_parts if part)
    return summary[:1000] if summary else None


def _extract_stderr_phase(stderr_text: str) -> str | None:
    lines = [line.strip() for line in stderr_text.splitlines() if line.strip()]
    for line in reversed(lines):
        try:
            parsed = json.loads(line)
        except Exception:
            continue
        if isinstance(parsed, dict) and parsed.get("type") == "model_request_diagnostic":
            phase = str(parsed.get("phase") or "").strip()
            if phase:
                return phase
    return None


def _coerce_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, str):
        return value
    return ""


def _build_subprocess_env() -> dict[str, str]:
    env = dict(os.environ)
    env.update(build_ts_agent_env(load_model_config()))
    return env


def _load_default_bridge_options() -> TemplateBridgeOptions:
    config = load_model_config()
    timeout_ms = config.planner.sync_request_timeout_ms
    timeout_sec = float(timeout_ms) / 1000.0 if timeout_ms is not None else None
    return TemplateBridgeOptions(timeout_sec=timeout_sec)


__all__ = [
    "run_template_job",
    "TemplateBridgeError",
    "TemplateBridgeTimeout",
    "TemplateBridgeOptions",
]
