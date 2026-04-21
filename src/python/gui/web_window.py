from __future__ import annotations

import sys

from .qt_bootstrap import configure_windows_qt_dll_paths
from .web_api import WebApiConfig, WebApiServer

configure_windows_qt_dll_paths()

from PyQt5.QtCore import QUrl, Qt
from PyQt5.QtWidgets import QApplication, QLabel, QMainWindow, QVBoxLayout, QWidget

try:
    from PyQt5.QtWebEngineWidgets import QWebEnginePage, QWebEngineView
except ImportError:  # pragma: no cover
    QWebEnginePage = None
    QWebEngineView = None


class DebugWebEnginePage(QWebEnginePage):
    def javaScriptConsoleMessage(self, level, message, line_number, source_id):  # noqa: N802
        print(
            f"[webview][console][{level}] {source_id}:{line_number} {message}",
            file=sys.stderr,
        )
        super().javaScriptConsoleMessage(level, message, line_number, source_id)


class FrontendWebWindow(QMainWindow):
    def __init__(self, server: WebApiServer) -> None:
        super().__init__()
        self._server = server
        self._status_label: QLabel | None = None
        self._browser: QWebEngineView | None = None
        self.setWindowTitle("Document Format Correction")
        self.resize(1280, 820)
        self._build_ui()

    def _build_ui(self) -> None:
        if QWebEngineView is None or QWebEnginePage is None:
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
        self._browser.setPage(DebugWebEnginePage(self._browser))
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
    app = QApplication(sys.argv)
    app.setAttribute(Qt.AA_DisableWindowContextHelpButton, True)

    server = WebApiServer(WebApiConfig())
    server.start()

    window = FrontendWebWindow(server)
    window.show()
    return app.exec_()


if __name__ == "__main__":
    raise SystemExit(run())