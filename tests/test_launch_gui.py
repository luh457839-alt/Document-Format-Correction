from __future__ import annotations

import importlib
import os
import shutil
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4


class LaunchGuiPreflightTest(unittest.TestCase):
    def test_preflight_rejects_stale_ts_dist(self) -> None:
        launch_gui = importlib.import_module("scripts.launch_gui")

        root = Path(".tmp") / f"launch-gui-{uuid4().hex}"
        try:
            ts_root = root / "src" / "ts"
            frontend_dist = root / "src" / "frontend" / "dist"
            src_file = ts_root / "src" / "runtime" / "model-gateway.ts"
            dist_file = ts_root / "dist" / "runtime" / "model-gateway.js"
            cli_file = ts_root / "dist" / "runtime" / "cli.js"

            (ts_root / "src" / "runtime").mkdir(parents=True, exist_ok=True)
            (ts_root / "dist" / "runtime").mkdir(parents=True, exist_ok=True)
            frontend_dist.mkdir(parents=True, exist_ok=True)

            (ts_root / "package.json").write_text("{}", encoding="utf-8")
            src_file.write_text("// newer source", encoding="utf-8")
            dist_file.write_text("// older dist", encoding="utf-8")
            cli_file.write_text("// cli", encoding="utf-8")
            (frontend_dist / "index.html").write_text("<html></html>", encoding="utf-8")

            src_mtime = dist_file.stat().st_mtime + 5
            dist_mtime = dist_file.stat().st_mtime
            os.utime(src_file, (src_mtime, src_mtime))
            os.utime(dist_file, (dist_mtime, dist_mtime))

            with (
                patch.object(launch_gui, "TS_ROOT", ts_root),
                patch.object(launch_gui, "FRONTEND_DIST_DIR", frontend_dist),
                patch.object(launch_gui, "_require_python_module"),
                patch.object(launch_gui, "_require_node"),
                patch.object(launch_gui, "_ensure_model_config"),
            ):
                with self.assertRaises(launch_gui.LaunchCheckError) as ctx:
                    launch_gui.perform_preflight_checks()
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertIn("npm run build", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
