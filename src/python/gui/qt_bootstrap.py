from __future__ import annotations

import os
import sys
from pathlib import Path

_QT_DLL_DIR_HANDLES: list[object] = []


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

