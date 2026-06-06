from __future__ import annotations

import unittest
from pathlib import Path


class FrontendBaseStylesTest(unittest.TestCase):
    def test_button_reset_exists_in_base_layer(self) -> None:
        css = Path("src/frontend/index.css").read_text(encoding="utf-8")

        self.assertIn("@layer base", css)
        self.assertIn("button,", css)
        self.assertIn("input[type='button']", css)
        self.assertIn("input[type='submit']", css)
        self.assertIn("input[type='reset']", css)

        expected_rules = (
            "appearance: none;",
            "-webkit-appearance: none;",
            "background-color: transparent;",
            "background-image: none;",
            "border: 0 solid transparent;",
            "color: inherit;",
        )
        for rule in expected_rules:
            with self.subTest(rule=rule):
                self.assertIn(rule, css)

    def test_app_routes_workspace_pages_without_router_dependency(self) -> None:
        app = Path("src/frontend/App.tsx").read_text(encoding="utf-8")

        self.assertIn("window.history.pushState", app)
        self.assertIn("'/templates'", app)
        self.assertIn("'/history'", app)
        self.assertIn("'/settings'", app)
        self.assertIn("<FormatWorkspace />", app)
        self.assertIn("<TemplateLibraryPage />", app)
        self.assertIn("<HistoryPage />", app)
        self.assertIn("<SettingsPage />", app)
        self.assertNotIn("react-router", app)

    def test_sidebar_matches_new_global_navigation(self) -> None:
        sidebar = Path("src/frontend/components/sidebar/Sidebar.tsx").read_text(encoding="utf-8")

        expected_content = (
            "文档格式修改 Agent",
            "+</span>",
            "新建任务",
            "工作台",
            "模板库",
            "历史记录",
            "设置",
            "isCollapsed",
            "onCreateTask",
            "onNavigate('/');",
        )
        for text in expected_content:
            with self.subTest(text=text):
                self.assertIn(text, sidebar)

        self.assertNotIn("+ 新建对话", sidebar)
        self.assertNotIn("固定模板修改", sidebar)
        self.assertNotIn("SessionList", sidebar)

    def test_workspace_contains_prompt_builder_upload_and_action_semantics(self) -> None:
        workspace = Path("src/frontend/components/workspace/FormatWorkspace.tsx").read_text(
            encoding="utf-8"
        )

        expected_content = (
            'accept=".docx"',
            "点击或拖拽 DOCX 文件至此",
            "Format Health Report",
            "Document Outline Tree",
            "Prompt Builder Panel",
            "全局排版",
            "标题层级 H1-H6",
            "快速模板",
            "自定义需求",
            "恢复默认",
            "清空配置",
            "开始执行修改",
            "下载完整文档",
            "controlsDisabled",
            "modeLabel",
        )
        for text in expected_content:
            with self.subTest(text=text):
                self.assertIn(text, workspace)

    def test_workspace_store_preserves_default_vs_no_change_semantics(self) -> None:
        store = Path("src/frontend/store/useWorkspaceStore.ts").read_text(encoding="utf-8")

        expected_content = (
            "fetchWorkspaceDefaultConfig",
            "uploadWorkspaceDocument",
            "startFormattingRun",
            "fetchFormattingRun",
            "fetchFormattingHistory",
            "resetToDefault",
            "clearConfig",
            "mode: 'no_change'",
            "cloneConfig(defaults.config)",
            "getFormattingRunDownloadUrl",
        )
        for text in expected_content:
            with self.subTest(text=text):
                self.assertIn(text, store)

    def test_api_service_exposes_workspace_contract(self) -> None:
        api = Path("src/frontend/services/backendApiClient.ts").read_text(encoding="utf-8")

        expected_content = (
            "uploadWorkspaceDocument",
            "fetchWorkspaceDefaultConfig",
            "startFormattingRun",
            "fetchFormattingRun",
            "getFormattingRunDownloadUrl",
            "fetchFormattingHistory",
            "/api/workspace/documents",
            "/api/workspace/default-config",
            "/api/workspace/format-runs",
            "/api/workspace/history",
            "templates?: TemplateMetaSummary[]",
        )
        for text in expected_content:
            with self.subTest(text=text):
                self.assertIn(text, api)

    def test_contract_types_define_workspace_api_models(self) -> None:
        types = Path("src/frontend/types/apiContracts.ts").read_text(encoding="utf-8")

        expected_content = (
            "export interface WorkspaceDocument",
            "export interface DocumentAnalysisSummary",
            "export type ConfigFieldMode = 'default' | 'custom' | 'no_change'",
            "export interface ConfigValue<T>",
            "export interface FormattingConfig",
            "export interface FormattingRequest",
            "export interface FormattingJobSnapshot",
            "export interface FormattingRunSummary",
            "export interface TemplateMetaSummary",
            "export type TemplateConfigOption = TemplateMetaSummary",
        )
        for text in expected_content:
            with self.subTest(text=text):
                self.assertIn(text, types)

    def test_history_templates_and_settings_pages_use_formal_apis(self) -> None:
        template_page = Path("src/frontend/components/pages/TemplateLibraryPage.tsx").read_text(
            encoding="utf-8"
        )
        history_page = Path("src/frontend/components/pages/HistoryPage.tsx").read_text(encoding="utf-8")
        settings_page = Path("src/frontend/components/pages/SettingsPage.tsx").read_text(encoding="utf-8")

        store = Path("src/frontend/store/useWorkspaceStore.ts").read_text(encoding="utf-8")

        self.assertIn("fetchTemplateConfigs", template_page)
        self.assertIn("TemplateMetaSummary", template_page)
        self.assertIn("refreshHistory", history_page)
        self.assertIn("fetchFormattingHistory", store)
        self.assertIn("getFormattingRunDownloadUrl", history_page)
        self.assertIn("fetchModelConfig", settings_page)
        self.assertIn("saveModelConfig", settings_page)


if __name__ == "__main__":
    unittest.main()
