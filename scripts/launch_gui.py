from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path
from typing import Iterable


PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.python.core.model_config import load_model_config
from src.python.core.project_paths import CONFIG_PATH, FRONTEND_DIST_DIR, TS_ROOT


class LaunchCheckError(RuntimeError):
    pass


def _require_path(path: Path, description: str, hint: str) -> None:
    if path.exists():
        return
    raise LaunchCheckError(f"{description} 不存在：{path}\n{hint}")


def _require_python_module(module_name: str, package_hint: str) -> None:
    try:
        importlib.import_module(module_name)
    except ImportError as exc:
        raise LaunchCheckError(
            f"缺少 Python 依赖：{module_name}\n请先执行：{package_hint}"
        ) from exc


def _require_node() -> None:
    try:
        completed = subprocess.run(
            ["node", "--version"],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:
        raise LaunchCheckError("未检测到 Node.js，请先安装并确保 `node` 可用。") from exc

    if completed.returncode != 0:
        stderr = (completed.stderr or completed.stdout or "").strip()
        detail = f"\n命令输出：{stderr}" if stderr else ""
        raise LaunchCheckError(f"Node.js 不可用，请检查本机安装与 PATH 配置。{detail}")


def _ensure_model_config() -> None:
    load_model_config()
    _require_path(CONFIG_PATH, "模型配置文件", "启动器已尝试生成默认配置，请检查文件权限或磁盘状态。")


def _iter_files(root: Path) -> Iterable[Path]:
    if not root.exists():
        return ()
    return (path for path in root.rglob("*") if path.is_file())


def _latest_file(root: Path) -> Path | None:
    latest_path: Path | None = None
    latest_mtime = float("-inf")
    for path in _iter_files(root):
        mtime = path.stat().st_mtime
        if mtime > latest_mtime:
            latest_mtime = mtime
            latest_path = path
    return latest_path


def _ensure_ts_dist_is_fresh() -> None:
    ts_src_root = TS_ROOT / "src"
    ts_dist_root = TS_ROOT / "dist"
    latest_src = _latest_file(ts_src_root)
    latest_dist = _latest_file(ts_dist_root)
    if latest_src is None or latest_dist is None:
        return
    if latest_src.stat().st_mtime <= latest_dist.stat().st_mtime:
        return

    raise LaunchCheckError(
        "检测到 `src/ts/src` 比 `src/ts/dist` 更新，当前 TS Agent 构建产物已过期。\n"
        f"较新的源码文件：{latest_src}\n"
        f"较新的构建产物：{latest_dist}\n"
        "请先在 `src/ts` 目录执行：npm run build"
    )


def _run_gui() -> int:
    completed = subprocess.run(
        [sys.executable, str(PROJECT_ROOT / "scripts" / "run_gui.py")],
        cwd=str(PROJECT_ROOT),
        check=False,
    )
    return int(completed.returncode)


def perform_preflight_checks() -> None:
    _require_python_module("PyQt5", 'pip install -e ".[gui]"')
    _require_python_module("PyQt5.QtWebEngineWidgets", 'pip install -e ".[gui]"')
    _require_node()
    _ensure_model_config()

    _require_path(
        TS_ROOT / "package.json",
        "TS Agent 工程目录",
        "请确认仓库结构完整，`src/ts` 未缺失。",
    )
    _require_path(
        TS_ROOT / "dist" / "runtime" / "cli.js",
        "TS Agent 构建产物",
        "请先在 `src/ts` 目录执行：npm install && npm run build",
    )
    _ensure_ts_dist_is_fresh()
    _require_path(
        FRONTEND_DIST_DIR / "index.html",
        "桌面前端构建产物",
        "请先在 `src/frontend` 目录执行：npm install && npm run build",
    )


def main() -> int:
    try:
        perform_preflight_checks()
    except LaunchCheckError as exc:
        print(f"[launch_gui] 启动前检查失败：\n{exc}", file=sys.stderr)
        return 1

    return _run_gui()


if __name__ == "__main__":
    raise SystemExit(main())
