from __future__ import annotations

import sys
from pathlib import Path

# Bootstrap archive modules before importing from _host.*
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import PROJECT_ROOT, load_all

load_all()

from _host.gui.web_window import run


if __name__ == "__main__":
    raise SystemExit(run())
