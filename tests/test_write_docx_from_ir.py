from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path


class WriteDocxFromIrTest(unittest.TestCase):
    def test_in_place_size_change_preserves_existing_font_name(self) -> None:
        docx = self._import_docx()
        write_docx_from_ir = self._import_writer()

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            source = tmp_path / "source.docx"
            output = tmp_path / "output.docx"
            payload_path = tmp_path / "payload.json"

            document = docx.Document()
            paragraph = document.add_paragraph()
            run = paragraph.add_run("hello")
            run.font.name = "Arial"
            run.font.size = docx.shared.Pt(11)
            document.save(source)

            payload_path.write_text(
                json.dumps(
                    {
                        "id": "doc1",
                        "version": "v1",
                        "nodes": [
                            {
                                "id": "p_0_r_0",
                                "text": "hello",
                                "style": {"font_size_pt": 22},
                            }
                        ],
                        "metadata": {"inputDocxPath": str(source)},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            write_docx_from_ir(payload_path, output)

            result = docx.Document(output)
            written_run = result.paragraphs[0].runs[0]
            self.assertEqual(written_run.font.size.pt, 22.0)
            self.assertEqual(written_run.font.name, "Arial")

    def test_in_place_font_change_preserves_existing_size(self) -> None:
        docx = self._import_docx()
        write_docx_from_ir = self._import_writer()

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            source = tmp_path / "source.docx"
            output = tmp_path / "output.docx"
            payload_path = tmp_path / "payload.json"

            document = docx.Document()
            paragraph = document.add_paragraph()
            run = paragraph.add_run("hello")
            run.font.name = "Arial"
            run.font.size = docx.shared.Pt(11)
            document.save(source)

            payload_path.write_text(
                json.dumps(
                    {
                        "id": "doc1",
                        "version": "v1",
                        "nodes": [
                            {
                                "id": "p_0_r_0",
                                "text": "hello",
                                "style": {"font_name": "SimSun"},
                            }
                        ],
                        "metadata": {"inputDocxPath": str(source)},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            write_docx_from_ir(payload_path, output)

            result = docx.Document(output)
            written_run = result.paragraphs[0].runs[0]
            self.assertEqual(written_run.font.name, "SimSun")
            self.assertEqual(written_run.font.size.pt, 11.0)

    def test_in_place_extended_style_fields_are_written(self) -> None:
        docx = self._import_docx()
        write_docx_from_ir = self._import_writer()

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            source = tmp_path / "source.docx"
            output = tmp_path / "output.docx"
            payload_path = tmp_path / "payload.json"

            document = docx.Document()
            paragraph = document.add_paragraph()
            paragraph.add_run("hello")
            document.save(source)

            payload_path.write_text(
                json.dumps(
                    {
                        "id": "doc1",
                        "version": "v1",
                        "nodes": [
                            {
                                "id": "p_0_r_0",
                                "text": "hello",
                                "style": {
                                    "font_color": "112233",
                                    "is_bold": True,
                                    "is_italic": True,
                                    "is_underline": True,
                                    "is_strike": True,
                                    "highlight_color": "yellow",
                                    "is_all_caps": True,
                                    "paragraph_alignment": "center",
                                },
                            }
                        ],
                        "metadata": {"inputDocxPath": str(source)},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            write_docx_from_ir(payload_path, output)

            result = docx.Document(output)
            written_paragraph = result.paragraphs[0]
            written_run = written_paragraph.runs[0]
            self.assertEqual(str(written_run.font.color.rgb), "112233")
            self.assertTrue(written_run.bold)
            self.assertTrue(written_run.italic)
            self.assertTrue(written_run.underline)
            self.assertTrue(written_run.font.strike)
            self.assertEqual(written_run.font.highlight_color, docx.enum.text.WD_COLOR_INDEX.YELLOW)
            self.assertTrue(written_run.font.all_caps)
            self.assertEqual(written_paragraph.alignment, docx.enum.text.WD_PARAGRAPH_ALIGNMENT.CENTER)

    def test_in_place_hex_highlight_alias_is_supported(self) -> None:
        docx = self._import_docx()
        write_docx_from_ir = self._import_writer()

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            source = tmp_path / "source.docx"
            output = tmp_path / "output.docx"
            payload_path = tmp_path / "payload.json"

            document = docx.Document()
            paragraph = document.add_paragraph()
            paragraph.add_run("hello")
            document.save(source)

            payload_path.write_text(
                json.dumps(
                    {
                        "id": "doc1",
                        "version": "v1",
                        "nodes": [
                            {
                                "id": "p_0_r_0",
                                "text": "hello",
                                "style": {"highlight_color": "#FFFF00"},
                            }
                        ],
                        "metadata": {"inputDocxPath": str(source)},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            write_docx_from_ir(payload_path, output)

            result = docx.Document(output)
            written_run = result.paragraphs[0].runs[0]
            self.assertEqual(written_run.font.highlight_color, docx.enum.text.WD_COLOR_INDEX.YELLOW)

    def test_in_place_bright_green_highlight_alias_is_supported(self) -> None:
        docx = self._import_docx()
        write_docx_from_ir = self._import_writer()

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            source = tmp_path / "source.docx"
            output = tmp_path / "output.docx"
            payload_path = tmp_path / "payload.json"

            document = docx.Document()
            paragraph = document.add_paragraph()
            paragraph.add_run("hello")
            document.save(source)

            payload_path.write_text(
                json.dumps(
                    {
                        "id": "doc1",
                        "version": "v1",
                        "nodes": [
                            {
                                "id": "p_0_r_0",
                                "text": "hello",
                                "style": {"highlight_color": "#00FF00"},
                            }
                        ],
                        "metadata": {"inputDocxPath": str(source)},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            write_docx_from_ir(payload_path, output)

            result = docx.Document(output)
            written_run = result.paragraphs[0].runs[0]
            self.assertEqual(written_run.font.highlight_color, docx.enum.text.WD_COLOR_INDEX.BRIGHT_GREEN)

    def test_in_place_dark_green_highlight_alias_is_supported(self) -> None:
        docx = self._import_docx()
        write_docx_from_ir = self._import_writer()

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            source = tmp_path / "source.docx"
            output = tmp_path / "output.docx"
            payload_path = tmp_path / "payload.json"

            document = docx.Document()
            paragraph = document.add_paragraph()
            paragraph.add_run("hello")
            document.save(source)

            payload_path.write_text(
                json.dumps(
                    {
                        "id": "doc1",
                        "version": "v1",
                        "nodes": [
                            {
                                "id": "p_0_r_0",
                                "text": "hello",
                                "style": {"highlight_color": "#008000"},
                            }
                        ],
                        "metadata": {"inputDocxPath": str(source)},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            write_docx_from_ir(payload_path, output)

            result = docx.Document(output)
            written_run = result.paragraphs[0].runs[0]
            self.assertEqual(written_run.font.highlight_color, docx.enum.text.WD_COLOR_INDEX.GREEN)

    @staticmethod
    def _import_docx():
        try:
            import docx  # type: ignore
        except Exception as exc:  # pragma: no cover
            raise unittest.SkipTest(f"python-docx not available: {exc}") from exc
        return docx

    @staticmethod
    def _import_writer():
        from scripts.write_docx_from_ir import write_docx_from_ir  # type: ignore
        return write_docx_from_ir


if __name__ == "__main__":
    unittest.main()
