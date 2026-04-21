from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

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
    if config.planner.use_json_schema is not None:
        env["TS_AGENT_PLANNER_USE_JSON_SCHEMA"] = (
            "true" if config.planner.use_json_schema else "false"
        )
    if config.planner.schema_strict is not None:
        env["TS_AGENT_PLANNER_SCHEMA_STRICT"] = (
            "true" if config.planner.schema_strict else "false"
        )
    return env


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
    return _as_int(value, 0)


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


__all__ = [
    "AppModelConfig",
    "ChatModelConfig",
    "PlannerModelConfig",
    "DEFAULT_CONFIG_PATH",
    "build_ts_agent_env",
    "default_model_config",
    "load_model_config",
    "save_model_config",
]
