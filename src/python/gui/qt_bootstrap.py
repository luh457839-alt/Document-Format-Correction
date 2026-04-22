from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, MutableMapping

from src.python.core.project_paths import TMP_DIR

_QT_DLL_DIR_HANDLES: list[object] = []
WEBENGINE_PROFILE_NAME = "document-format-correction"
_WEBENGINE_RUNTIME_DIRNAME = "qtwebengine"
_WEBENGINE_INSTANCES_DIRNAME = "instances"
_WEBENGINE_USER_DATA_DIRNAME = "chromium-user-data"
_WEBENGINE_INSTANCE_METADATA_FILENAME = "instance.json"
_WEBENGINE_STALE_RUNTIME_SECONDS = 24 * 60 * 60
_PREPARED_WEBENGINE_RUNTIME: dict[str, object] | None = None


def configure_windows_qt_dll_paths() -> None:
    if sys.platform != "win32":
        return
    if not hasattr(os, "add_dll_directory"):
        return

    prefix = Path(os.environ.get("CONDA_PREFIX", sys.prefix))
    candidates = [
        prefix / "Library" / "bin",
        prefix / "DLLs",
        prefix / "Lib" / "site-packages" / "PyQt5",
        prefix / "Lib" / "site-packages" / "PyQt5" / "Qt5" / "bin",
        prefix / "Lib" / "site-packages" / "PyQt5" / "Qt" / "bin",
    ]
    for path in candidates:
        if path.exists():
            try:
                handle = os.add_dll_directory(str(path))
                _QT_DLL_DIR_HANDLES.append(handle)
            except OSError:
                pass


def _normalize_now(now: datetime | None = None) -> datetime:
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def _build_instance_id(now: datetime, pid: int) -> str:
    return f"{now.strftime('%Y%m%d-%H%M%S-%f')}-{pid}"


def _fallback_webengine_base_root() -> Path:
    return Path(tempfile.gettempdir()) / "document-format-correction" / _WEBENGINE_RUNTIME_DIRNAME


def _build_webengine_runtime_dirs(
    base_root: Path,
    instance_id: str,
    *,
    used_fallback: bool,
    fallback_root: Path,
    pid: int,
    created_at: datetime,
) -> dict[str, object]:
    instances_root = base_root / _WEBENGINE_INSTANCES_DIRNAME
    root = instances_root / instance_id
    return {
        "base_root": base_root,
        "fallback_root": fallback_root,
        "instances_root": instances_root,
        "instance_id": instance_id,
        "root": root,
        "profile": root / "profile",
        "storage": root / "storage",
        "cache": root / "cache",
        "user_data": root / _WEBENGINE_USER_DATA_DIRNAME,
        "instance_metadata_path": root / _WEBENGINE_INSTANCE_METADATA_FILENAME,
        "used_fallback": used_fallback,
        "pid": pid,
        "created_at": created_at,
    }


def resolve_webengine_runtime_dirs(
    preferred_root: Path | None = None,
    fallback_root: Path | None = None,
    *,
    instance_id: str | None = None,
    pid: int | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    resolved_now = _normalize_now(now)
    resolved_pid = pid or os.getpid()
    resolved_instance_id = instance_id or _build_instance_id(resolved_now, resolved_pid)
    base_root = preferred_root or (TMP_DIR / _WEBENGINE_RUNTIME_DIRNAME)
    resolved_fallback_root = fallback_root or _fallback_webengine_base_root()
    return _build_webengine_runtime_dirs(
        base_root,
        resolved_instance_id,
        used_fallback=False,
        fallback_root=resolved_fallback_root,
        pid=resolved_pid,
        created_at=resolved_now,
    )


def _write_instance_metadata(
    runtime: dict[str, object],
    *,
    command_line: Iterable[str] | None = None,
) -> None:
    metadata = {
        "instance_id": runtime["instance_id"],
        "pid": runtime["pid"],
        "created_at": _normalize_now(runtime["created_at"]).isoformat(),
        "command_line": list(command_line or sys.argv),
        "base_root": str(runtime["base_root"]),
        "root": str(runtime["root"]),
        "profile": str(runtime["profile"]),
        "storage": str(runtime["storage"]),
        "cache": str(runtime["cache"]),
        "user_data": str(runtime["user_data"]),
        "used_fallback": bool(runtime["used_fallback"]),
    }
    metadata_path = Path(runtime["instance_metadata_path"])
    metadata_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _read_instance_metadata(instance_root: Path) -> dict[str, object] | None:
    metadata_path = instance_root / _WEBENGINE_INSTANCE_METADATA_FILENAME
    if not metadata_path.exists():
        return None
    try:
        return json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def _runtime_instance_markers(instance_root: Path) -> tuple[list[str], list[str], list[str]]:
    gpu_cache_dirs: list[str] = []
    old_gpu_cache_dirs: list[str] = []
    lock_files: list[str] = []
    try:
        paths = instance_root.rglob("*")
        for path in paths:
            if path.name == "GPUCache":
                gpu_cache_dirs.append(str(path))
            elif path.name.startswith("old_GPUCache"):
                old_gpu_cache_dirs.append(str(path))
            elif path.name == "LOCK" or path.suffix.lower() == ".lock":
                lock_files.append(str(path))
    except OSError:
        return gpu_cache_dirs, old_gpu_cache_dirs, lock_files
    return gpu_cache_dirs, old_gpu_cache_dirs, lock_files


def scan_webengine_runtime_dirs(base_root: Path) -> list[str]:
    instances_root = base_root / _WEBENGINE_INSTANCES_DIRNAME
    if not instances_root.exists():
        return []

    summaries: list[str] = []
    try:
        instance_roots = sorted(path for path in instances_root.iterdir() if path.is_dir())
    except OSError:
        return summaries

    for instance_root in instance_roots:
        metadata = _read_instance_metadata(instance_root) or {}
        pid = metadata.get("pid", "unknown")
        gpu_cache_dirs, old_gpu_cache_dirs, lock_files = _runtime_instance_markers(instance_root)
        summaries.append(
            "existing-instance "
            f"id={instance_root.name} pid={pid} "
            f"gpu_cache={len(gpu_cache_dirs)} old_gpu_cache={len(old_gpu_cache_dirs)} "
            f"locks={len(lock_files)} root={instance_root}"
        )
    return summaries


def _path_recent_timestamp(path: Path) -> float:
    try:
        latest = path.stat().st_mtime
    except OSError:
        return 0.0
    try:
        children = list(path.iterdir())
    except OSError:
        children = []
    for child in children:
        try:
            latest = max(latest, child.stat().st_mtime)
        except OSError:
            continue
    return latest


def _pid_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def cleanup_stale_webengine_runtime_dirs(
    base_root: Path,
    *,
    current_instance_root: Path | None = None,
    stale_after_seconds: int = _WEBENGINE_STALE_RUNTIME_SECONDS,
    pid_checker: Callable[[int], bool] | None = None,
    now: datetime | None = None,
    remove_tree: Callable[[Path], None] | None = None,
    logger: Callable[[str], None] | None = None,
) -> list[Path]:
    instances_root = base_root / _WEBENGINE_INSTANCES_DIRNAME
    if not instances_root.exists():
        return []

    pid_checker = pid_checker or _pid_exists
    remove_tree = remove_tree or shutil.rmtree
    threshold = _normalize_now(now).timestamp() - stale_after_seconds
    removed: list[Path] = []

    try:
        instance_roots = sorted(path for path in instances_root.iterdir() if path.is_dir())
    except OSError:
        return removed

    for instance_root in instance_roots:
        if current_instance_root is not None and instance_root == current_instance_root:
            continue

        metadata = _read_instance_metadata(instance_root) or {}
        pid = metadata.get("pid")
        if isinstance(pid, int) and pid_checker(pid):
            continue

        last_touched = _path_recent_timestamp(instance_root)
        created_at = metadata.get("created_at")
        if isinstance(created_at, str):
            try:
                last_touched = max(last_touched, _normalize_now(datetime.fromisoformat(created_at)).timestamp())
            except ValueError:
                pass

        if last_touched > threshold:
            continue

        try:
            remove_tree(instance_root)
            removed.append(instance_root)
            if logger is not None:
                logger(f"cleanup removed stale instance root={instance_root}")
        except OSError as exc:
            if logger is not None:
                logger(f"cleanup failed root={instance_root} error={exc}")
    return removed


def _create_runtime_dirs(
    runtime: dict[str, object],
    *,
    create_dir: Callable[[Path], None],
) -> None:
    for key in (
        "base_root",
        "instances_root",
        "root",
        "profile",
        "storage",
        "cache",
        "user_data",
    ):
        create_dir(Path(runtime[key]))


def _prepare_runtime_root(
    base_root: Path,
    fallback_root: Path,
    *,
    used_fallback: bool,
    create_dir: Callable[[Path], None],
    instance_id: str,
    now: datetime,
    pid: int,
    command_line: Iterable[str] | None,
    stale_after_seconds: int,
    pid_checker: Callable[[int], bool] | None,
    remove_tree: Callable[[Path], None] | None,
    logger: Callable[[str], None] | None,
) -> dict[str, object]:
    runtime = _build_webengine_runtime_dirs(
        base_root,
        instance_id,
        used_fallback=used_fallback,
        fallback_root=fallback_root,
        pid=pid,
        created_at=now,
    )

    create_dir(Path(runtime["base_root"]))
    create_dir(Path(runtime["instances_root"]))

    if logger is not None:
        try:
            summaries = scan_webengine_runtime_dirs(Path(runtime["base_root"]))
            if summaries:
                for summary in summaries:
                    logger(summary)
            else:
                logger(f"existing-instance none base_root={runtime['base_root']}")
        except OSError as exc:
            logger(f"existing-instance scan-failed base_root={runtime['base_root']} error={exc}")

    try:
        cleanup_stale_webengine_runtime_dirs(
            Path(runtime["base_root"]),
            current_instance_root=Path(runtime["root"]),
            stale_after_seconds=stale_after_seconds,
            pid_checker=pid_checker,
            now=now,
            remove_tree=remove_tree,
            logger=logger,
        )
    except OSError as exc:
        if logger is not None:
            logger(f"cleanup scan-failed base_root={runtime['base_root']} error={exc}")

    _create_runtime_dirs(runtime, create_dir=create_dir)
    _write_instance_metadata(runtime, command_line=command_line)
    return runtime


def ensure_webengine_runtime_dirs(
    preferred_root: Path | None = None,
    fallback_root: Path | None = None,
    *,
    create_dir: Callable[[Path], None] | None = None,
    instance_id: str | None = None,
    now: datetime | None = None,
    pid: int | None = None,
    command_line: Iterable[str] | None = None,
    stale_after_seconds: int = _WEBENGINE_STALE_RUNTIME_SECONDS,
    pid_checker: Callable[[int], bool] | None = None,
    remove_tree: Callable[[Path], None] | None = None,
    logger: Callable[[str], None] | None = None,
) -> dict[str, object]:
    create_dir = create_dir or (lambda path: path.mkdir(parents=True, exist_ok=True))
    resolved_now = _normalize_now(now)
    resolved_pid = pid or os.getpid()
    resolved_fallback_root = fallback_root or _fallback_webengine_base_root()
    resolved_instance_id = instance_id or _build_instance_id(resolved_now, resolved_pid)
    preferred_base_root = preferred_root or (TMP_DIR / _WEBENGINE_RUNTIME_DIRNAME)

    try:
        return _prepare_runtime_root(
            preferred_base_root,
            resolved_fallback_root,
            used_fallback=False,
            create_dir=create_dir,
            instance_id=resolved_instance_id,
            now=resolved_now,
            pid=resolved_pid,
            command_line=command_line,
            stale_after_seconds=stale_after_seconds,
            pid_checker=pid_checker,
            remove_tree=remove_tree,
            logger=logger,
        )
    except OSError as exc:
        if logger is not None:
            logger(
                "preferred runtime unavailable "
                f"base_root={preferred_base_root} error={exc}; switching to fallback root={resolved_fallback_root}"
            )

    try:
        return _prepare_runtime_root(
            resolved_fallback_root,
            resolved_fallback_root,
            used_fallback=True,
            create_dir=create_dir,
            instance_id=resolved_instance_id,
            now=resolved_now,
            pid=resolved_pid,
            command_line=command_line,
            stale_after_seconds=stale_after_seconds,
            pid_checker=pid_checker,
            remove_tree=remove_tree,
            logger=logger,
        )
    except OSError as fallback_exc:
        raise RuntimeError(
            "无法初始化 Qt WebEngine 运行目录。"
            f" 首选目录：{preferred_base_root}；回退目录：{resolved_fallback_root}"
        ) from fallback_exc


def configure_qtwebengine_chromium_flags(
    runtime_root: Path,
    *,
    env: MutableMapping[str, str] | None = None,
    platform: str | None = None,
) -> str:
    target_env = os.environ if env is None else env
    resolved_platform = platform or sys.platform
    current = target_env.get("QTWEBENGINE_CHROMIUM_FLAGS", "").strip()
    if resolved_platform != "win32" or "--user-data-dir=" in current:
        return current

    user_data_dir = runtime_root / _WEBENGINE_USER_DATA_DIRNAME
    extra_flag = f'--user-data-dir="{user_data_dir}"'
    merged = f"{current} {extra_flag}".strip()
    target_env["QTWEBENGINE_CHROMIUM_FLAGS"] = merged
    return merged


def prepare_webengine_runtime(
    *,
    preferred_root: Path | None = None,
    fallback_root: Path | None = None,
    env: MutableMapping[str, str] | None = None,
    platform: str | None = None,
    logger: Callable[[str], None] | None = None,
    force_refresh: bool = False,
) -> dict[str, object]:
    global _PREPARED_WEBENGINE_RUNTIME

    if _PREPARED_WEBENGINE_RUNTIME is not None and not force_refresh:
        return _PREPARED_WEBENGINE_RUNTIME

    runtime = ensure_webengine_runtime_dirs(
        preferred_root=preferred_root,
        fallback_root=fallback_root,
        logger=logger,
    )
    runtime["chromium_flags"] = configure_qtwebengine_chromium_flags(
        Path(runtime["root"]),
        env=env,
        platform=platform,
    )
    _PREPARED_WEBENGINE_RUNTIME = runtime
    return runtime
