from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path


class WriteDocxModuleImportTest(unittest.TestCase):
    def test_writer_module_imports_without_dark_green_enum_member(self) -> None:
        enum_values = {
            "YELLOW": object(),
            "BRIGHT_GREEN": object(),
            "GREEN": object(),
            "TURQUOISE": object(),
            "PINK": object(),
            "BLUE": object(),
            "RED": object(),
            "DARK_BLUE": object(),
            "TEAL": object(),
            "VIOLET": object(),
            "DARK_RED": object(),
            "DARK_YELLOW": object(),
            "GRAY_50": object(),
            "GRAY_25": object(),
            "BLACK": object(),
        }
        writer_module = self._load_writer_module_with_fake_docx(enum_values)

        self.assertIs(writer_module._normalize_highlight_color("#00FF00"), enum_values["BRIGHT_GREEN"])
        self.assertIs(writer_module._normalize_highlight_color("darkGreen"), enum_values["GREEN"])

    def _load_writer_module_with_fake_docx(self, enum_values: dict[str, object]):
        fake_docx = types.ModuleType("docx")
        fake_docx.Document = object()

        fake_document_module = types.ModuleType("docx.document")
        fake_document_module.Document = type("FakeDocument", (), {})

        fake_enum_text_module = types.ModuleType("docx.enum.text")
        fake_enum_text_module.WD_COLOR_INDEX = types.SimpleNamespace(**enum_values)
        fake_enum_text_module.WD_PARAGRAPH_ALIGNMENT = types.SimpleNamespace(
            LEFT=object(),
            CENTER=object(),
            RIGHT=object(),
            JUSTIFY=object(),
        )

        fake_oxml_module = types.ModuleType("docx.oxml")
        fake_oxml_module.OxmlElement = lambda *args, **kwargs: object()

        fake_oxml_ns_module = types.ModuleType("docx.oxml.ns")
        fake_oxml_ns_module.qn = lambda value: value

        fake_shared_module = types.ModuleType("docx.shared")
        fake_shared_module.Pt = lambda value: value

        class _FakeRGBColor:
            @staticmethod
            def from_string(value: str) -> str:
                return value

        fake_shared_module.RGBColor = _FakeRGBColor

        fake_table_module = types.ModuleType("docx.table")
        fake_table_module._Cell = type("FakeCell", (), {})
        fake_table_module.Table = type("FakeTable", (), {})

        fake_text_paragraph_module = types.ModuleType("docx.text.paragraph")
        fake_text_paragraph_module.Paragraph = type("FakeParagraph", (), {})

        fake_text_run_module = types.ModuleType("docx.text.run")
        fake_text_run_module.Run = type("FakeRun", (), {})

        injected_modules = {
            "docx": fake_docx,
            "docx.document": fake_document_module,
            "docx.enum.text": fake_enum_text_module,
            "docx.oxml": fake_oxml_module,
            "docx.oxml.ns": fake_oxml_ns_module,
            "docx.shared": fake_shared_module,
            "docx.table": fake_table_module,
            "docx.text.paragraph": fake_text_paragraph_module,
            "docx.text.run": fake_text_run_module,
        }
        previous_modules = {name: sys.modules.get(name) for name in injected_modules}
        sys.modules.update(injected_modules)

        module_name = "tests._write_docx_from_ir_import_test"
        writer_path = Path(__file__).resolve().parents[1] / "scripts" / "write_docx_from_ir.py"
        spec = importlib.util.spec_from_file_location(module_name, writer_path)
        if spec is None or spec.loader is None:  # pragma: no cover - defensive
            self.fail("failed to load write_docx_from_ir module spec")

        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        finally:
            sys.modules.pop(module_name, None)
            for name, previous in previous_modules.items():
                if previous is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = previous

        return module


if __name__ == "__main__":
    unittest.main()
