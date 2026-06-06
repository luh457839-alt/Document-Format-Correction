"""Reusable bootstrap for loading archive modules under fake ``_host`` packages.

Scripts that need the legacy Python host (web_api, web_window, bridges, etc.)
should call :func:`load_all` early — before any ``from _host.xxx import …``
statements.

This replicates the package-registration pattern used in ``e2e_chain_test.py``
but in a single reusable location.
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_PYTHON = PROJECT_ROOT / "archive" / "legacy" / "python-host" / "python"

_LOADED = False


def _load_mod(name: str, path: Path, package: str | None = None):
    """Load a single module from *path* and register it in ``sys.modules``."""
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {name} from {path}")
    mod = importlib.util.module_from_spec(spec)
    if package:
        mod.__package__ = package
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _ensure_packages() -> None:
    """Register ``_host``, ``_host.core``, ``_host.api``, ``_host.gui``."""
    for pkg_name, rel in [
        ("_host", ""),
        ("_host.core", "core"),
        ("_host.api", "api"),
        ("_host.gui", "gui"),
    ]:
        if pkg_name in sys.modules:
            continue
        pkg = types.ModuleType(pkg_name)
        pkg.__path__ = [str(ARCHIVE_PYTHON / rel)] if rel else [str(ARCHIVE_PYTHON)]
        pkg.__package__ = pkg_name
        sys.modules[pkg_name] = pkg


def load_all() -> None:
    """Load all archive modules in dependency order.  Idempotent."""
    global _LOADED
    if _LOADED:
        return

    _ensure_packages()

    # Core
    pp = _load_mod("_host.core.project_paths", ARCHIVE_PYTHON / "core" / "project_paths.py", "_host.core")
    # Override PROJECT_ROOT — the sentinel walk already finds it, but be explicit
    # so that downstream code sees the canonical value even if the walk fails.
    pp.PROJECT_ROOT = PROJECT_ROOT
    pp.SRC_ROOT = PROJECT_ROOT / "src"
    pp.TS_ROOT = PROJECT_ROOT / "src" / "ts"
    pp.FRONTEND_ROOT = PROJECT_ROOT / "src" / "frontend"
    pp.FRONTEND_DIST_DIR = PROJECT_ROOT / "src" / "frontend" / "dist"
    pp.CONFIG_PATH = PROJECT_ROOT / "config.json"
    pp.SESSIONS_DIR = PROJECT_ROOT / "sessions"
    pp.OUTPUT_DIR = PROJECT_ROOT / "output"
    pp.AGENT_WORKSPACE_DIR = PROJECT_ROOT / "agent_workspace"
    pp.AGENT_MEDIA_DIR = PROJECT_ROOT / "agent_workspace" / "media"
    pp.TMP_DIR = PROJECT_ROOT / ".tmp"

    _load_mod("_host.core.model_config", ARCHIVE_PYTHON / "core" / "model_config.py", "_host.core")

    # API bridges
    _load_mod("_host.api.ts_agent_bridge", ARCHIVE_PYTHON / "api" / "ts_agent_bridge.py", "_host.api")
    _load_mod("_host.api.template_bridge", ARCHIVE_PYTHON / "api" / "template_bridge.py", "_host.api")

    # GUI
    _load_mod("_host.gui.qt_bootstrap", ARCHIVE_PYTHON / "gui" / "qt_bootstrap.py", "_host.gui")
    _load_mod("_host.gui.web_api", ARCHIVE_PYTHON / "gui" / "web_api.py", "_host.gui")
    _load_mod("_host.gui.web_window", ARCHIVE_PYTHON / "gui" / "web_window.py", "_host.gui")

    _LOADED = True


# Also make PROJECT_ROOT available as a module-level constant for convenience.
__all__ = ["PROJECT_ROOT", "ARCHIVE_PYTHON", "load_all"]
