from __future__ import annotations

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]
SRC_ROOT = PROJECT_ROOT / "src"
PYTHON_ROOT = SRC_ROOT / "python"
TS_ROOT = SRC_ROOT / "ts"
FRONTEND_ROOT = SRC_ROOT / "frontend"
FRONTEND_DIST_DIR = FRONTEND_ROOT / "dist"
CONFIG_PATH = PROJECT_ROOT / "config.json"
SESSIONS_DIR = PROJECT_ROOT / "sessions"
OUTPUT_DIR = PROJECT_ROOT / "output"
AGENT_WORKSPACE_DIR = PROJECT_ROOT / "agent_workspace"
AGENT_MEDIA_DIR = AGENT_WORKSPACE_DIR / "media"
TMP_DIR = PROJECT_ROOT / ".tmp"


__all__ = [
    "PROJECT_ROOT",
    "SRC_ROOT",
    "PYTHON_ROOT",
    "TS_ROOT",
    "FRONTEND_ROOT",
    "FRONTEND_DIST_DIR",
    "CONFIG_PATH",
    "SESSIONS_DIR",
    "OUTPUT_DIR",
    "AGENT_WORKSPACE_DIR",
    "AGENT_MEDIA_DIR",
    "TMP_DIR",
]
