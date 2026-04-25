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

    def test_session_list_buttons_disable_inner_focus_outline(self) -> None:
        session_list = Path("src/frontend/components/sidebar/SessionList.tsx").read_text(
            encoding="utf-8"
        )

        self.assertIn("focus:outline-none", session_list)
        self.assertIn("focus-visible:outline-none", session_list)

    def test_sidebar_includes_fixed_template_edit_button(self) -> None:
        sidebar = Path("src/frontend/components/sidebar/Sidebar.tsx").read_text(
            encoding="utf-8"
        )

        self.assertIn("固定模板修改", sidebar)
        self.assertIn("onNavigateTemplates", sidebar)
        self.assertIn("handleFixedTemplateEdit", sidebar)
        self.assertIn("isTemplateRoute", sidebar)
        self.assertIn("onNavigateHome?.()", sidebar)
        self.assertIn("onNavigateTemplates?.()", sidebar)

        expected_classes = (
            "w-full",
            "mt-2",
            "border-gray-600",
            "text-gray-300",
            "hover:bg-gray-700",
        )
        for class_name in expected_classes:
            with self.subTest(class_name=class_name):
                self.assertIn(class_name, sidebar)

        create_index = sidebar.index("+ 新建对话")
        fixed_template_index = sidebar.index("固定模板修改")
        self.assertLess(create_index, fixed_template_index)
        self.assertIn("startDraftSession();", sidebar)

    def test_app_routes_fixed_template_page_without_router_dependency(self) -> None:
        app = Path("src/frontend/App.tsx").read_text(encoding="utf-8")

        self.assertIn("window.history.pushState", app)
        self.assertIn("pathname === '/templates'", app)
        self.assertIn("<TemplateWorkspace />", app)
        self.assertIn("onNavigateTemplates", app)
        self.assertIn("isTemplateRoute={isTemplateRoute}", app)
        self.assertIn("onNavigateHome={() => navigateTo('/')}", app)
        self.assertNotIn("react-router", app)

    def test_session_list_navigates_home_after_selecting_session(self) -> None:
        session_list = Path("src/frontend/components/sidebar/SessionList.tsx").read_text(
            encoding="utf-8"
        )

        self.assertIn("onSelectSession?: () => void;", session_list)
        self.assertIn("const handleSessionSelect = async (sessionId: string) => {", session_list)
        self.assertIn("await setCurrentSession(sessionId);", session_list)
        self.assertIn("onSelectSession?.();", session_list)
        self.assertIn("onClick={() => void handleSessionSelect(session.sessionId)}", session_list)

    def test_template_workspace_contains_required_controls_and_disabled_states(self) -> None:
        workspace = Path("src/frontend/components/templates/TemplateWorkspace.tsx").read_text(
            encoding="utf-8"
        )

        expected_content = (
            'accept=".docx"',
            "导入 DOCX",
            "输出位置",
            "选择 JSON 模板",
            "开始模板修改",
            "ProgressJobCard",
            "disabled:cursor-not-allowed",
            "disabled:bg-gray-800",
            "isJobActive",
            "canStart",
            "→",
        )
        for text in expected_content:
            with self.subTest(text=text):
                self.assertIn(text, workspace)

    def test_progress_job_card_is_reused_by_chat_and_template_workspace(self) -> None:
        card = Path("src/frontend/components/common/ProgressJobCard.tsx").read_text(
            encoding="utf-8"
        )
        feed = Path("src/frontend/components/chat/MessageFeed.tsx").read_text(
            encoding="utf-8"
        )
        workspace = Path("src/frontend/components/templates/TemplateWorkspace.tsx").read_text(
            encoding="utf-8"
        )

        self.assertIn("export const ProgressJobCard", card)
        self.assertIn("statusLabel", card)
        self.assertIn("onToggleCollapse", card)
        self.assertIn("ProgressJobCard", feed)
        self.assertIn("ProgressJobCard", workspace)


if __name__ == "__main__":
    unittest.main()
