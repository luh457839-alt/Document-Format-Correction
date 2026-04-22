from __future__ import annotations

import sys

from .qt_bootstrap import (
    WEBENGINE_PROFILE_NAME,
    configure_windows_qt_dll_paths,
    prepare_webengine_runtime,
)
from .web_api import WebApiConfig, WebApiServer

configure_windows_qt_dll_paths()

try:
    from PyQt5.QtCore import QUrl, Qt
    from PyQt5.QtWidgets import QApplication, QLabel, QMainWindow, QVBoxLayout, QWidget
except ImportError:  # pragma: no cover
    QApplication = None
    QLabel = None
    QMainWindow = object
    QUrl = None
    Qt = None
    QVBoxLayout = None
    QWidget = None

try:
    from PyQt5.QtWebEngineWidgets import QWebEnginePage, QWebEngineProfile, QWebEngineView
except ImportError:  # pragma: no cover
    QWebEnginePage = None
    QWebEngineProfile = None
    QWebEngineView = None


class DebugWebEnginePage(QWebEnginePage if QWebEnginePage is not None else object):
    def javaScriptConsoleMessage(self, level, message, line_number, source_id):  # noqa: N802
        print(
            f"[webview][console][{level}] {source_id}:{line_number} {message}",
            file=sys.stderr,
        )
        if QWebEnginePage is not None:
            super().javaScriptConsoleMessage(level, message, line_number, source_id)


def _log_webengine_message(runtime_dirs: dict[str, object] | None, message: str) -> None:
    if runtime_dirs is None:
        print(f"[webview] {message}", file=sys.stderr)
        return

    print(
        "[webview] "
        f"instance={runtime_dirs['instance_id']} root={runtime_dirs['root']} "
        f"{message}",
        file=sys.stderr,
    )


def _configure_profile_cache(profile, runtime_dirs: dict[str, object], *, disk_cache: bool) -> None:
    profile.setPersistentStoragePath(str(runtime_dirs["storage"]))
    if disk_cache:
        profile.setCachePath(str(runtime_dirs["cache"]))
        if hasattr(QWebEngineProfile, "DiskHttpCache"):
            profile.setHttpCacheType(QWebEngineProfile.DiskHttpCache)
        return

    if hasattr(QWebEngineProfile, "MemoryHttpCache"):
        profile.setHttpCacheType(QWebEngineProfile.MemoryHttpCache)
    elif hasattr(QWebEngineProfile, "NoCache"):
        profile.setHttpCacheType(QWebEngineProfile.NoCache)


def _create_webengine_page(parent, runtime_dirs: dict[str, object], *, disk_cache: bool):
    profile = QWebEngineProfile(WEBENGINE_PROFILE_NAME, parent)
    _configure_profile_cache(profile, runtime_dirs, disk_cache=disk_cache)
    mode = "disk" if disk_cache else "memory"
    _log_webengine_message(
        runtime_dirs,
        "profile-ready "
        f"mode={mode} storage={runtime_dirs['storage']} cache={runtime_dirs['cache']} "
        f"user_data={runtime_dirs['user_data']} fallback={runtime_dirs['used_fallback']}",
    )
    return DebugWebEnginePage(profile, parent), profile


def build_custom_webengine_page(parent=None):
    if QWebEnginePage is None or QWebEngineProfile is None:
        raise RuntimeError("Qt WebEngine 不可用，无法创建自定义 profile。")

    runtime_dirs = prepare_webengine_runtime(logger=lambda message: _log_webengine_message(None, message))
    _log_webengine_message(
        runtime_dirs,
        "runtime-ready "
        f"base_root={runtime_dirs['base_root']} storage={runtime_dirs['storage']} "
        f"cache={runtime_dirs['cache']} user_data={runtime_dirs['user_data']} "
        f"fallback={runtime_dirs['used_fallback']}",
    )

    try:
        return _create_webengine_page(parent, runtime_dirs, disk_cache=True)
    except Exception as exc:
        _log_webengine_message(
            runtime_dirs,
            f"disk-cache-init-failed error={exc}; retrying with memory cache",
        )

    try:
        return _create_webengine_page(parent, runtime_dirs, disk_cache=False)
    except Exception as exc:
        _log_webengine_message(
            runtime_dirs,
            f"memory-cache-init-failed error={exc}",
        )
        raise RuntimeError(
            "Qt WebEngine profile 初始化失败，磁盘缓存与内存缓存模式均不可用。"
        ) from exc


class FrontendWebWindow(QMainWindow):
    def __init__(self, server: WebApiServer) -> None:
        if QApplication is None or QLabel is None or QVBoxLayout is None or QWidget is None or Qt is None:
            raise RuntimeError("缺少 PyQt5 依赖，无法创建桌面窗口。")
        super().__init__()
        self._server = server
        self._status_label: QLabel | None = None
        self._browser: QWebEngineView | None = None
        self._profile: QWebEngineProfile | None = None
        self.setWindowTitle("Document Format Correction")
        self.resize(1280, 820)
        self._build_ui()

    def _build_ui(self) -> None:
        if QWebEngineView is None or QWebEnginePage is None or QWebEngineProfile is None:
            self._show_fallback_message(
                "缺少 PyQt WebEngine 依赖，无法加载新前端页面。\n"
                "请安装 `PyQtWebEngine` 后重新启动。"
            )
            return

        container = QWidget()
        layout = QVBoxLayout(container)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self._status_label = QLabel("正在加载桌面前端页面...", container)
        self._status_label.setAlignment(Qt.AlignCenter)
        self._status_label.setWordWrap(True)
        self._status_label.setStyleSheet(
            "background:#111827;color:#d1d5db;padding:16px;font-size:13px;"
        )

        self._browser = QWebEngineView(container)
        try:
            page, self._profile = build_custom_webengine_page(parent=self._browser)
        except Exception as exc:
            print(f"[webview] failed to initialize custom WebEngine profile: {exc}", file=sys.stderr)
            page = DebugWebEnginePage(self._browser)
        self._browser.setPage(page)
        self._browser.loadStarted.connect(self._handle_load_started)
        self._browser.loadFinished.connect(self._handle_load_finished)

        layout.addWidget(self._status_label)
        layout.addWidget(self._browser, 1)
        self.setCentralWidget(container)

        target_url = QUrl(f"{self._server.base_url}/")
        print(f"[webview] loading {target_url.toString()}", file=sys.stderr)
        self._browser.setUrl(target_url)

    def _show_fallback_message(self, message: str) -> None:
        fallback = QWidget()
        layout = QVBoxLayout(fallback)
        label = QLabel(message)
        label.setAlignment(Qt.AlignCenter)
        label.setWordWrap(True)
        layout.addWidget(label, 1)
        self.setCentralWidget(fallback)

    def _handle_load_started(self) -> None:
        if self._status_label is not None:
            self._status_label.setText("正在加载桌面前端页面...")

    def _handle_load_finished(self, ok: bool) -> None:
        if ok:
            if self._status_label is not None:
                self._status_label.hide()
            print("[webview] page load finished successfully", file=sys.stderr)
            return

        current_url = self._browser.url().toString() if self._browser is not None else ""
        error_message = (
            "桌面前端页面加载失败。\n"
            f"URL: {current_url}\n"
            "请检查控制台输出中的 [webview] / [webview][console] 日志。"
        )
        if self._status_label is not None:
            self._status_label.setText(error_message)
            self._status_label.show()
        print(f"[webview] page load failed: {current_url}", file=sys.stderr)

    def closeEvent(self, event):  # noqa: N802
        try:
            self._server.stop()
        finally:
            super().closeEvent(event)


def run() -> int:
    if QApplication is None or Qt is None:
        print("[webview] 缺少 PyQt5 依赖，无法启动桌面窗口。", file=sys.stderr)
        return 1

    try:
        prepare_webengine_runtime(logger=lambda message: _log_webengine_message(None, message))
    except Exception as exc:
        print(f"[webview] prepare runtime before QApplication failed: {exc}", file=sys.stderr)

    app = QApplication(sys.argv)
    app.setAttribute(Qt.AA_DisableWindowContextHelpButton, True)

    server = WebApiServer(WebApiConfig())
    server.start()

    window = FrontendWebWindow(server)
    window.show()
    return app.exec_()


if __name__ == "__main__":
    raise SystemExit(run())
