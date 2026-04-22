from __future__ import annotations

import importlib
import io
import json
import os
import shutil
import unittest
from uuid import uuid4
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


def _make_workspace_temp_dir(prefix: str) -> Path:
    root = Path("agent_workspace") / f"{prefix}-{uuid4().hex}"
    root.mkdir(parents=True, exist_ok=False)
    return root


class QtBootstrapRuntimeTest(unittest.TestCase):
    def test_resolve_webengine_runtime_dirs_uses_instance_scoped_layout(self) -> None:
        qt_bootstrap = importlib.import_module("src.python.gui.qt_bootstrap")

        runtime = qt_bootstrap.resolve_webengine_runtime_dirs(
            preferred_root=Path("D:/repo/.tmp/qtwebengine"),
            fallback_root=Path("D:/fallback/qtwebengine"),
            instance_id="20260422-120000-4242",
        )

        expected_root = Path("D:/repo/.tmp/qtwebengine/instances/20260422-120000-4242")
        self.assertEqual(runtime["base_root"], Path("D:/repo/.tmp/qtwebengine"))
        self.assertEqual(runtime["root"], expected_root)
        self.assertEqual(runtime["profile"], expected_root / "profile")
        self.assertEqual(runtime["storage"], expected_root / "storage")
        self.assertEqual(runtime["cache"], expected_root / "cache")
        self.assertEqual(runtime["user_data"], expected_root / "chromium-user-data")
        self.assertEqual(runtime["instance_metadata_path"], expected_root / "instance.json")
        self.assertEqual(runtime["instance_id"], "20260422-120000-4242")
        self.assertEqual(runtime["fallback_root"], Path("D:/fallback/qtwebengine"))
        self.assertFalse(runtime["used_fallback"])

    def test_ensure_webengine_runtime_dirs_writes_instance_metadata(self) -> None:
        qt_bootstrap = importlib.import_module("src.python.gui.qt_bootstrap")
        temp_root = _make_workspace_temp_dir("qt-bootstrap")
        preferred_root = temp_root / "preferred"
        fallback_root = temp_root / "fallback"
        now = datetime(2026, 4, 22, 6, 0, tzinfo=timezone.utc)

        try:
            runtime = qt_bootstrap.ensure_webengine_runtime_dirs(
                preferred_root=preferred_root,
                fallback_root=fallback_root,
                instance_id="inst-4242",
                now=now,
                pid=4242,
                command_line=["python", "scripts/run_gui.py"],
            )
            metadata = json.loads(runtime["instance_metadata_path"].read_text(encoding="utf-8"))
        finally:
            shutil.rmtree(temp_root, ignore_errors=True)

        self.assertEqual(runtime["root"], preferred_root / "instances" / "inst-4242")
        self.assertEqual(metadata["instance_id"], "inst-4242")
        self.assertEqual(metadata["pid"], 4242)
        self.assertEqual(metadata["command_line"], ["python", "scripts/run_gui.py"])
        self.assertEqual(metadata["root"], str(runtime["root"]))
        self.assertEqual(metadata["user_data"], str(runtime["user_data"]))
        self.assertEqual(metadata["created_at"], now.isoformat())

    def test_ensure_webengine_runtime_dirs_falls_back_with_instance_scoped_layout(self) -> None:
        qt_bootstrap = importlib.import_module("src.python.gui.qt_bootstrap")
        temp_root = _make_workspace_temp_dir("qt-bootstrap")
        preferred_root = temp_root / "preferred"
        fallback_root = temp_root / "fallback"
        created: list[Path] = []

        def create_dir(path: Path) -> None:
            created.append(path)
            if path == preferred_root:
                raise OSError("permission denied")
            path.mkdir(parents=True, exist_ok=True)

        try:
            runtime = qt_bootstrap.ensure_webengine_runtime_dirs(
                preferred_root=preferred_root,
                fallback_root=fallback_root,
                instance_id="inst-fallback",
                create_dir=create_dir,
                now=datetime(2026, 4, 22, 6, 30, tzinfo=timezone.utc),
            )
        finally:
            shutil.rmtree(temp_root, ignore_errors=True)

        self.assertTrue(runtime["used_fallback"])
        self.assertEqual(runtime["base_root"], fallback_root)
        self.assertEqual(runtime["root"], fallback_root / "instances" / "inst-fallback")
        self.assertIn(preferred_root, created)
        self.assertIn(fallback_root, created)

    def test_cleanup_stale_runtime_dirs_skips_live_and_current_instances(self) -> None:
        qt_bootstrap = importlib.import_module("src.python.gui.qt_bootstrap")
        temp_root = _make_workspace_temp_dir("qt-cleanup")
        base_root = temp_root / "qtwebengine"
        instances_root = base_root / "instances"
        now = datetime(2026, 4, 22, 8, 0, tzinfo=timezone.utc)

        stale_root = instances_root / "stale"
        live_root = instances_root / "live"
        current_root = instances_root / "current"
        for root in (stale_root, live_root, current_root):
            (root / "storage").mkdir(parents=True, exist_ok=True)

        for root, pid in ((stale_root, 1001), (live_root, 1002), (current_root, 1003)):
            metadata = {
                "instance_id": root.name,
                "pid": pid,
                "created_at": (now - timedelta(days=2)).isoformat(),
            }
            (root / "instance.json").write_text(json.dumps(metadata), encoding="utf-8")
            old_timestamp = (now - timedelta(days=2)).timestamp()
            for path in (root, root / "storage", root / "instance.json"):
                path.touch(exist_ok=True)
                os.utime(path, (old_timestamp, old_timestamp))

        try:
            removed = qt_bootstrap.cleanup_stale_webengine_runtime_dirs(
                base_root=base_root,
                current_instance_root=current_root,
                stale_after_seconds=3600,
                pid_checker=lambda pid: pid == 1002,
                now=now,
            )
            self.assertEqual(removed, [stale_root])
            self.assertFalse(stale_root.exists())
            self.assertTrue(live_root.exists())
            self.assertTrue(current_root.exists())
        finally:
            shutil.rmtree(temp_root, ignore_errors=True)

    def test_configure_qtwebengine_chromium_flags_preserves_existing_flags(self) -> None:
        qt_bootstrap = importlib.import_module("src.python.gui.qt_bootstrap")
        env = {"QTWEBENGINE_CHROMIUM_FLAGS": "--foo=1"}

        qt_bootstrap.configure_qtwebengine_chromium_flags(
            Path("D:/repo/.tmp/qtwebengine/instances/inst-9000"),
            env=env,
            platform="win32",
        )

        self.assertIn("--foo=1", env["QTWEBENGINE_CHROMIUM_FLAGS"])
        self.assertIn(
            '--user-data-dir="D:\\repo\\.tmp\\qtwebengine\\instances\\inst-9000\\chromium-user-data"',
            env["QTWEBENGINE_CHROMIUM_FLAGS"],
        )


class WebWindowProfileTest(unittest.TestCase):
    def test_build_custom_webengine_page_uses_instance_scoped_profile_paths(self) -> None:
        web_window = importlib.import_module("src.python.gui.web_window")

        runtime_dirs = {
            "instance_id": "inst-100",
            "base_root": Path("D:/repo/.tmp/qtwebengine"),
            "root": Path("D:/repo/.tmp/qtwebengine/instances/inst-100"),
            "profile": Path("D:/repo/.tmp/qtwebengine/instances/inst-100/profile"),
            "storage": Path("D:/repo/.tmp/qtwebengine/instances/inst-100/storage"),
            "cache": Path("D:/repo/.tmp/qtwebengine/instances/inst-100/cache"),
            "user_data": Path("D:/repo/.tmp/qtwebengine/instances/inst-100/chromium-user-data"),
            "used_fallback": False,
        }

        class FakeProfile:
            DiskHttpCache = "disk"
            MemoryHttpCache = "memory"

            def __init__(self, name: str, parent) -> None:
                self.name = name
                self.parent = parent
                self.storage_path = None
                self.cache_path = None
                self.cache_type = None

            def setPersistentStoragePath(self, path: str) -> None:  # noqa: N802
                self.storage_path = path

            def setCachePath(self, path: str) -> None:  # noqa: N802
                self.cache_path = path

            def setHttpCacheType(self, cache_type) -> None:  # noqa: N802
                self.cache_type = cache_type

        class FakePage:
            def __init__(self, profile, parent) -> None:
                self.profile = profile
                self.parent = parent

        with (
            patch.object(web_window, "QWebEnginePage", object),
            patch.object(web_window, "QWebEngineProfile", FakeProfile),
            patch.object(web_window, "DebugWebEnginePage", FakePage),
            patch.object(web_window, "prepare_webengine_runtime", return_value=runtime_dirs),
        ):
            page, profile = web_window.build_custom_webengine_page(parent=object())

        self.assertIs(page.profile, profile)
        self.assertEqual(profile.name, web_window.WEBENGINE_PROFILE_NAME)
        self.assertEqual(profile.storage_path, str(runtime_dirs["storage"]))
        self.assertEqual(profile.cache_path, str(runtime_dirs["cache"]))
        self.assertEqual(profile.cache_type, FakeProfile.DiskHttpCache)

    def test_build_custom_webengine_page_retries_with_memory_cache(self) -> None:
        web_window = importlib.import_module("src.python.gui.web_window")

        runtime_dirs = {
            "instance_id": "inst-200",
            "base_root": Path("D:/repo/.tmp/qtwebengine"),
            "root": Path("D:/repo/.tmp/qtwebengine/instances/inst-200"),
            "profile": Path("D:/repo/.tmp/qtwebengine/instances/inst-200/profile"),
            "storage": Path("D:/repo/.tmp/qtwebengine/instances/inst-200/storage"),
            "cache": Path("D:/repo/.tmp/qtwebengine/instances/inst-200/cache"),
            "user_data": Path("D:/repo/.tmp/qtwebengine/instances/inst-200/chromium-user-data"),
            "used_fallback": False,
        }

        class FakeProfile:
            DiskHttpCache = "disk"
            MemoryHttpCache = "memory"
            instances: list["FakeProfile"] = []

            def __init__(self, name: str, parent) -> None:
                self.name = name
                self.parent = parent
                self.storage_path = None
                self.cache_path = None
                self.cache_type = None
                self.fail_cache_path = len(FakeProfile.instances) == 0
                FakeProfile.instances.append(self)

            def setPersistentStoragePath(self, path: str) -> None:  # noqa: N802
                self.storage_path = path

            def setCachePath(self, path: str) -> None:  # noqa: N802
                if self.fail_cache_path:
                    raise OSError("cache path unavailable")
                self.cache_path = path

            def setHttpCacheType(self, cache_type) -> None:  # noqa: N802
                self.cache_type = cache_type

        class FakePage:
            def __init__(self, profile, parent) -> None:
                self.profile = profile
                self.parent = parent

        with (
            patch.object(web_window, "QWebEnginePage", object),
            patch.object(web_window, "QWebEngineProfile", FakeProfile),
            patch.object(web_window, "DebugWebEnginePage", FakePage),
            patch.object(web_window, "prepare_webengine_runtime", return_value=runtime_dirs),
        ):
            page, profile = web_window.build_custom_webengine_page(parent=object())

        self.assertEqual(len(FakeProfile.instances), 2)
        self.assertIs(page.profile, profile)
        self.assertEqual(profile.storage_path, str(runtime_dirs["storage"]))
        self.assertIsNone(profile.cache_path)
        self.assertEqual(profile.cache_type, FakeProfile.MemoryHttpCache)

    def test_build_custom_webengine_page_logs_runtime_context(self) -> None:
        web_window = importlib.import_module("src.python.gui.web_window")

        runtime_dirs = {
            "instance_id": "inst-300",
            "base_root": Path("D:/repo/.tmp/qtwebengine"),
            "root": Path("D:/repo/.tmp/qtwebengine/instances/inst-300"),
            "profile": Path("D:/repo/.tmp/qtwebengine/instances/inst-300/profile"),
            "storage": Path("D:/repo/.tmp/qtwebengine/instances/inst-300/storage"),
            "cache": Path("D:/repo/.tmp/qtwebengine/instances/inst-300/cache"),
            "user_data": Path("D:/repo/.tmp/qtwebengine/instances/inst-300/chromium-user-data"),
            "used_fallback": True,
        }

        class FakeProfile:
            DiskHttpCache = "disk"
            MemoryHttpCache = "memory"

            def __init__(self, name: str, parent) -> None:
                self.name = name
                self.parent = parent

            def setPersistentStoragePath(self, path: str) -> None:  # noqa: N802
                return None

            def setCachePath(self, path: str) -> None:  # noqa: N802
                return None

            def setHttpCacheType(self, cache_type) -> None:  # noqa: N802
                return None

        class FakePage:
            def __init__(self, profile, parent) -> None:
                self.profile = profile
                self.parent = parent

        stderr = io.StringIO()
        with (
            patch.object(web_window, "QWebEnginePage", object),
            patch.object(web_window, "QWebEngineProfile", FakeProfile),
            patch.object(web_window, "DebugWebEnginePage", FakePage),
            patch.object(web_window, "prepare_webengine_runtime", return_value=runtime_dirs),
            patch("sys.stderr", stderr),
        ):
            web_window.build_custom_webengine_page(parent=object())

        log_output = stderr.getvalue()
        self.assertIn("inst-300", log_output)
        self.assertIn("root=D:\\repo\\.tmp\\qtwebengine\\instances\\inst-300", log_output)
        self.assertIn("storage=D:\\repo\\.tmp\\qtwebengine\\instances\\inst-300\\storage", log_output)
        self.assertIn("cache=D:\\repo\\.tmp\\qtwebengine\\instances\\inst-300\\cache", log_output)
        self.assertIn("fallback=True", log_output)


if __name__ == "__main__":
    unittest.main()
