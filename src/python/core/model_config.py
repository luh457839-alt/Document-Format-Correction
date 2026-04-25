from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .project_paths import CONFIG_PATH

DEFAULT_CONFIG_PATH = CONFIG_PATH


@dataclass
class ChatModelConfig:
    base_url: str = "http://localhost:8080/v1"
    api_key: str = "sk-local-gemma4"
    model: str = "gemma-4"


@dataclass
class PlannerModelConfig:
    base_url: str = "http://localhost:8080/v1"
    api_key: str = "sk-local-gemma4"
    model: str = "gemma-4"
    timeout_ms: int | None = None
    step_timeout_ms: int = 60000
    task_timeout_ms: int | None = None
    python_tool_timeout_ms: int | None = None
    max_turns: int = 24
    sync_request_timeout_ms: int = 300000
    max_retries: int = 0
    temperature: float = 0.0
    use_json_schema: bool | None = None
    schema_strict: bool | None = None
    compat_mode: str = "auto"
    runtime_mode: str | None = None


@dataclass
class AppModelConfig:
    chat: ChatModelConfig
    planner: PlannerModelConfig

    def to_dict(self) -> dict[str, Any]:
        return {"chat": asdict(self.chat), "planner": asdict(self.planner)}


def default_model_config() -> AppModelConfig:
    return AppModelConfig(chat=ChatModelConfig(), planner=PlannerModelConfig())


def load_model_config(path: str | Path | None = None) -> AppModelConfig:
    config_path = Path(path) if path is not None else DEFAULT_CONFIG_PATH
    config_path.parent.mkdir(parents=True, exist_ok=True)
    defaults = default_model_config()

    if not config_path.exists():
        save_model_config(defaults, config_path)
        return defaults

    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        save_model_config(defaults, config_path)
        return defaults

    config = _config_from_raw(raw, defaults)
    normalized = config.to_dict()
    if raw != normalized:
        save_model_config(config, config_path)
    return config


def save_model_config(config: AppModelConfig, path: str | Path | None = None) -> Path:
    config_path = Path(path) if path is not None else DEFAULT_CONFIG_PATH
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        json.dumps(config.to_dict(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return config_path


def build_ts_agent_env(config: AppModelConfig) -> dict[str, str]:
    env = {
        "TS_AGENT_CHAT_API_KEY": config.chat.api_key,
        "TS_AGENT_CHAT_BASE_URL": config.chat.base_url,
        "TS_AGENT_CHAT_MODEL": config.chat.model,
        "TS_AGENT_PLANNER_API_KEY": config.planner.api_key,
        "TS_AGENT_PLANNER_BASE_URL": config.planner.base_url,
        "TS_AGENT_PLANNER_MODEL": config.planner.model,
        "TS_AGENT_PLANNER_MAX_RETRIES": str(int(config.planner.max_retries)),
        "TS_AGENT_PLANNER_TEMPERATURE": _format_float(config.planner.temperature),
        "TS_AGENT_PLANNER_COMPAT_MODE": config.planner.compat_mode,
    }
    if config.planner.runtime_mode:
        env["TS_AGENT_PLANNER_RUNTIME_MODE"] = config.planner.runtime_mode
    if config.planner.timeout_ms is not None:
        env["TS_AGENT_PLANNER_TIMEOUT_MS"] = str(int(config.planner.timeout_ms))
    env["TS_AGENT_STEP_TIMEOUT_MS"] = str(int(config.planner.step_timeout_ms))
    env["TS_AGENT_MAX_TURNS"] = str(int(config.planner.max_turns))
    env["TS_AGENT_SYNC_REQUEST_TIMEOUT_MS"] = str(int(config.planner.sync_request_timeout_ms))
    if config.planner.task_timeout_ms is not None:
        env["TS_AGENT_TASK_TIMEOUT_MS"] = str(int(config.planner.task_timeout_ms))
    if config.planner.python_tool_timeout_ms is not None:
        env["TS_AGENT_PYTHON_TOOL_TIMEOUT_MS"] = str(int(config.planner.python_tool_timeout_ms))
    if config.planner.use_json_schema is not None:
        env["TS_AGENT_PLANNER_USE_JSON_SCHEMA"] = (
            "true" if config.planner.use_json_schema else "false"
        )
    if config.planner.schema_strict is not None:
        env["TS_AGENT_PLANNER_SCHEMA_STRICT"] = (
            "true" if config.planner.schema_strict else "false"
        )
    return env


def collect_model_config_warnings(config: AppModelConfig) -> list[dict[str, str]]:
    warnings: list[dict[str, str]] = []
    warnings.extend(_collect_endpoint_format_warnings("chat", "Chat", config.chat.base_url))
    warnings.extend(_collect_endpoint_format_warnings("planner", "Planner", config.planner.base_url))

    chat_host = _read_endpoint_host(config.chat.base_url)
    planner_host = _read_endpoint_host(config.planner.base_url)
    if chat_host and planner_host and chat_host != planner_host:
        warnings.append(
            {
                "code": "planner_chat_host_mismatch",
                "scope": "planner",
                "message": (
                    f"Planner Base URL host '{planner_host}' differs from Chat Base URL host '{chat_host}'. "
                    "模板分类请求会走 planner 配置，可能命中与聊天不同的上游地址。"
                ),
            }
        )
    return warnings


def _config_from_raw(raw: Any, defaults: AppModelConfig) -> AppModelConfig:
    data = raw if isinstance(raw, dict) else {}
    chat_raw = data.get("chat") if isinstance(data.get("chat"), dict) else {}
    planner_raw = data.get("planner") if isinstance(data.get("planner"), dict) else {}

    chat = ChatModelConfig(
        base_url=_as_str(chat_raw.get("base_url"), defaults.chat.base_url),
        api_key=_as_str(chat_raw.get("api_key"), defaults.chat.api_key),
        model=_as_str(chat_raw.get("model"), defaults.chat.model),
    )
    planner = PlannerModelConfig(
        base_url=_as_str(planner_raw.get("base_url"), chat.base_url),
        api_key=_as_str(planner_raw.get("api_key"), chat.api_key),
        model=_as_str(planner_raw.get("model"), chat.model),
        timeout_ms=_resolve_planner_timeout(planner_raw, defaults.planner.timeout_ms),
        step_timeout_ms=_as_non_negative_int(
            planner_raw.get("step_timeout_ms"), defaults.planner.step_timeout_ms
        ),
        task_timeout_ms=_resolve_optional_int(
            planner_raw, "task_timeout_ms", defaults.planner.task_timeout_ms
        ),
        python_tool_timeout_ms=_resolve_optional_int(
            planner_raw, "python_tool_timeout_ms", defaults.planner.python_tool_timeout_ms
        ),
        max_turns=_as_non_negative_int(planner_raw.get("max_turns"), defaults.planner.max_turns),
        sync_request_timeout_ms=_as_non_negative_int(
            planner_raw.get("sync_request_timeout_ms"), defaults.planner.sync_request_timeout_ms
        ),
        max_retries=_as_int(planner_raw.get("max_retries"), defaults.planner.max_retries),
        temperature=_as_float(planner_raw.get("temperature"), defaults.planner.temperature),
        use_json_schema=_resolve_optional_bool(
            planner_raw, "use_json_schema", defaults.planner.use_json_schema
        ),
        schema_strict=_resolve_optional_bool(
            planner_raw, "schema_strict", defaults.planner.schema_strict
        ),
        compat_mode=_as_str(planner_raw.get("compat_mode"), defaults.planner.compat_mode),
        runtime_mode=_resolve_runtime_mode(planner_raw.get("runtime_mode")),
    )
    if (
        "compat_mode" not in planner_raw
        and planner.compat_mode != "strict"
        and _looks_like_local_backend(planner.base_url, planner.model)
    ):
        if planner.timeout_ms == 30000:
            planner.timeout_ms = None
        if planner.use_json_schema is True:
            planner.use_json_schema = None
        if planner.schema_strict is True:
            planner.schema_strict = None
    return AppModelConfig(chat=chat, planner=planner)


def _as_str(value: Any, default: str) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return default


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_non_negative_int(value: Any, default: int) -> int:
    resolved = _as_int(value, default)
    return resolved if resolved >= 0 else default


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            return True
        if lowered in {"false", "0", "no", "off"}:
            return False
    return default


def _resolve_optional_bool(
    source: dict[str, Any], key: str, default: bool | None
) -> bool | None:
    if key not in source:
        return default
    value = source.get(key)
    if value is None:
        return None
    return _as_bool(value, False)


def _resolve_planner_timeout(source: dict[str, Any], default: int | None) -> int | None:
    if "timeout_ms" not in source:
        return default
    value = source.get("timeout_ms")
    if value is None:
        return None
    return _as_non_negative_int(value, 0)


def _resolve_optional_int(source: dict[str, Any], key: str, default: int | None) -> int | None:
    if key not in source:
        return default
    value = source.get(key)
    if value is None:
        return None
    resolved = _as_int(value, -1)
    return resolved if resolved >= 0 else default


def _resolve_runtime_mode(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        normalized = value.strip()
        if normalized in {"plan_once", "react_loop"}:
            return normalized
    return None


def _looks_like_local_backend(base_url: str, model: str) -> bool:
    lowered = base_url.strip().lower()
    is_local_host = (
        lowered.startswith("http://localhost")
        or lowered.startswith("https://localhost")
        or lowered.startswith("http://127.0.0.1")
        or lowered.startswith("https://127.0.0.1")
        or lowered.startswith("http://0.0.0.0")
        or lowered.startswith("https://0.0.0.0")
    )
    if is_local_host:
        return True
    return bool(model and any(token in model.lower() for token in ("gemma", "llama", "qwen", "mistral", "phi", "glm", "local")))


def _format_float(value: float) -> str:
    text = f"{float(value):.6f}".rstrip("0").rstrip(".")
    return text or "0"


def _collect_endpoint_format_warnings(scope: str, label: str, base_url: str) -> list[dict[str, str]]:
    raw = base_url.strip()
    if not raw:
        return [
            {
                "code": "base_url_missing",
                "scope": scope,
                "message": f"{label} Base URL 为空。应配置为 OpenAI-compatible 端点，例如 http://localhost:8080/v1。",
            }
        ]

    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return [
            {
                "code": "base_url_invalid",
                "scope": scope,
                "message": (
                    f"{label} Base URL '{raw}' 不是有效的 http(s) 地址。"
                    "应配置为 OpenAI-compatible 端点，例如 http://localhost:8080/v1。"
                ),
            }
        ]

    normalized_path = parsed.path.rstrip("/")
    if normalized_path and normalized_path.endswith("/v1"):
        return []

    if not normalized_path:
        return [
            {
                "code": "base_url_missing_v1",
                "scope": scope,
                "message": (
                    f"{label} Base URL '{raw}' 缺少 /v1 路径。"
                    "OpenAI-compatible 接口通常应指向 http(s)://<host>/.../v1。"
                ),
            }
        ]

    return [
        {
            "code": "base_url_not_openai_compatible",
            "scope": scope,
            "message": (
                f"{label} Base URL '{raw}' 看起来不像 OpenAI-compatible /v1 端点。"
                "请确认网关路径是否正确。"
            ),
        }
    ]


def _read_endpoint_host(base_url: str) -> str:
    try:
        parsed = urlparse(base_url.strip())
    except Exception:
        return ""
    return parsed.netloc.strip()


__all__ = [
    "AppModelConfig",
    "ChatModelConfig",
    "PlannerModelConfig",
    "DEFAULT_CONFIG_PATH",
    "collect_model_config_warnings",
    "build_ts_agent_env",
    "default_model_config",
    "load_model_config",
    "save_model_config",
]
