from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from src.python.api.template_bridge import (
    TemplateBridgeError,
    TemplateBridgeOptions,
    TemplateBridgeTimeout,
    run_template_job,
)


class TemplateBridgeTest(unittest.TestCase):
    @contextmanager
    def _tempdir(self):
        root = Path(".tmp") / f"template-bridge-{uuid4().hex}"
        root.mkdir(parents=True, exist_ok=True)
        try:
            yield root
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def _make_options(self, root: Path) -> TemplateBridgeOptions:
        cli = root / "src" / "ts" / "dist" / "templates"
        cli.mkdir(parents=True, exist_ok=True)
        (cli / "template-cli.js").write_text("// mock", encoding="utf-8")
        return TemplateBridgeOptions(project_root=root)

    def test_run_template_job_returns_report_on_success(self) -> None:
        with self._tempdir() as root:
            options = self._make_options(root)
            docx_path = root / "input.docx"
            template_path = root / "template.json"
            docx_path.write_bytes(b"PK\x03\x04docx")
            template_path.write_text("{}", encoding="utf-8")

            def fake_run(*args, **kwargs):  # noqa: ANN001
                _ = kwargs
                cmd = args[0]
                input_path = Path(cmd[3])
                output_path = Path(cmd[5])
                req_payload = json.loads(input_path.read_text(encoding="utf-8"))
                self.assertEqual(req_payload["docxPath"], str(docx_path))
                self.assertEqual(req_payload["templatePath"], str(template_path))
                output_path.write_text(
                    json.dumps(
                        {
                            "status": "executed",
                            "template_meta": {
                                "id": "official_doc_body",
                                "name": "公文正文模板",
                                "version": "1.0.0",
                                "schema_version": "1.0",
                            },
                            "observation_summary": {
                                "document_meta": {"total_paragraphs": 1, "total_tables": 0},
                                "paragraph_count": 1,
                                "classifiable_paragraphs": [],
                                "evidence_summary": {
                                    "table_count": 0,
                                    "image_count": 0,
                                    "seal_detection": {"supported": False, "detected": False},
                                },
                            },
                            "classification_result": {
                                "template_id": "official_doc_body",
                                "matches": [],
                                "unmatched_paragraph_ids": [],
                                "conflicts": [],
                            },
                            "validation_result": {"passed": True, "issues": []},
                            "warnings": [
                                {
                                    "code": "body_paragraph_suspicious_numbering_prefix",
                                    "message": "Paragraph matched body_paragraph but still starts with numbering prefix '2.'; output was generated with a warning.",
                                    "paragraph_ids": ["p2"],
                                    "diagnostics": {
                                        "semantic_key": "body_paragraph",
                                        "text_excerpt": "2. 现将有关事项通知如下。",
                                        "numbering_prefix": "2.",
                                        "detected_prefix": "2.",
                                        "warning_kind": "body_paragraph_numbering_prefix",
                                    },
                                }
                            ],
                            "execution_plan": [],
                            "write_plan": [],
                            "execution_result": {
                                "applied": True,
                                "output_docx_path": str(root / "output.docx"),
                                "change_summary": "已完成模板套用",
                                "issues": [],
                            },
                        }
                    ),
                    encoding="utf-8",
                )
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.template_bridge.subprocess.run", side_effect=fake_run):
                result = run_template_job(str(docx_path), str(template_path), options=options)

            self.assertEqual(result["status"], "executed")
            self.assertEqual(result["execution_result"]["output_docx_path"], str(root / "output.docx"))
            self.assertEqual(result["warnings"][0]["code"], "body_paragraph_suspicious_numbering_prefix")
            self.assertEqual(result["warnings"][0]["diagnostics"]["numbering_prefix"], "2.")

    def test_run_template_job_raises_structured_error_from_cli(self) -> None:
        with self._tempdir() as root:
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                _ = kwargs
                cmd = args[0]
                output_path = Path(cmd[5])
                output_path.write_text(
                    json.dumps(
                        {
                            "error": {
                                "code": "E_TEMPLATE_VALIDATION_FAILED",
                                "message": "模板校验失败",
                                "retryable": False,
                                "stage": "classification_request_failed",
                                "stage_timings_ms": {
                                    "observation_ms": 7,
                                    "classification_request_ms": 1000,
                                    "validation_ms": 0,
                                    "execution_ms": 0,
                                },
                            }
                        }
                    ),
                    encoding="utf-8",
                )
                return SimpleNamespace(
                    returncode=1,
                    stderr=json.dumps(
                        {
                            "type": "model_request_diagnostic",
                            "phase": "classification_request_abort",
                            "endpointHost": "mock.example",
                            "endpointPath": "/v1/chat/completions",
                            "model": "gpt-test",
                            "timeoutMs": 1000,
                            "jsonSchemaEnabled": True,
                            "requestMode": "json_schema",
                            "promptBytes": 2048,
                            "schemaBytes": 512,
                            "paragraphCount": 3,
                            "semanticBlockCount": 2,
                            "fallbackAttempt": 0,
                            "batchType": "body",
                            "batchIndex": 2,
                            "batchCount": 3,
                            "batchParagraphCount": 4,
                        }
                    ),
                )

            with patch("src.python.api.template_bridge.subprocess.run", side_effect=fake_run):
                with self.assertRaises(TemplateBridgeError) as ctx:
                    run_template_job("D:/docs/input.docx", "D:/docs/template.json", options=options)

            self.assertIn("E_TEMPLATE_VALIDATION_FAILED", str(ctx.exception))
            self.assertIn("模板校验失败", str(ctx.exception))
            self.assertEqual(ctx.exception.code, "E_TEMPLATE_VALIDATION_FAILED")
            self.assertEqual(ctx.exception.stage, "classification_request_failed")
            self.assertIn("classification_request_abort", ctx.exception.stderr_summary or "")
            self.assertIn("mock.example/v1/chat/completions", ctx.exception.stderr_summary or "")
            self.assertIn("request_mode=json_schema", ctx.exception.stderr_summary or "")
            self.assertIn("promptBytes=2048", ctx.exception.stderr_summary or "")
            self.assertIn("schemaBytes=512", ctx.exception.stderr_summary or "")
            self.assertIn("paragraphCount=3", ctx.exception.stderr_summary or "")
            self.assertIn("semanticBlockCount=2", ctx.exception.stderr_summary or "")
            self.assertIn("fallbackAttempt=0", ctx.exception.stderr_summary or "")
            self.assertIn("batchType=body", ctx.exception.stderr_summary or "")
            self.assertIn("batchIndex=2", ctx.exception.stderr_summary or "")
            self.assertIn("batchCount=3", ctx.exception.stderr_summary or "")
            self.assertIn("batchParagraphCount=4", ctx.exception.stderr_summary or "")
            self.assertNotIn("api_key", str(ctx.exception).lower())

    def test_run_template_job_raises_missing_output_error(self) -> None:
        with self._tempdir() as root:
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                _ = args, kwargs
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.template_bridge.subprocess.run", side_effect=fake_run):
                with self.assertRaises(TemplateBridgeError) as ctx:
                    run_template_job("D:/docs/input.docx", "D:/docs/template.json", options=options)

            self.assertIn("E_TEMPLATE_OUTPUT_MISSING", str(ctx.exception))

    def test_run_template_job_raises_invalid_json_error(self) -> None:
        with self._tempdir() as root:
            options = self._make_options(root)

            def fake_run(*args, **kwargs):  # noqa: ANN001
                _ = kwargs
                cmd = args[0]
                output_path = Path(cmd[5])
                output_path.write_text("{not-json", encoding="utf-8")
                return SimpleNamespace(returncode=0, stderr="")

            with patch("src.python.api.template_bridge.subprocess.run", side_effect=fake_run):
                with self.assertRaises(TemplateBridgeError) as ctx:
                    run_template_job("D:/docs/input.docx", "D:/docs/template.json", options=options)

            self.assertIn("E_TEMPLATE_OUTPUT_INVALID_JSON", str(ctx.exception))

    def test_run_template_job_timeout_raises(self) -> None:
        with self._tempdir() as root:
            options = self._make_options(root)

            with patch(
                "src.python.api.template_bridge.subprocess.run",
                side_effect=subprocess.TimeoutExpired(cmd="node", timeout=1),
            ):
                with self.assertRaises(TemplateBridgeTimeout):
                    run_template_job("D:/docs/input.docx", "D:/docs/template.json", options=options, timeout_sec=1)

    def test_run_template_job_start_failure_raises_stable_code(self) -> None:
        with self._tempdir() as root:
            options = self._make_options(root)

            with patch(
                "src.python.api.template_bridge.subprocess.run",
                side_effect=OSError("node not found"),
            ):
                with self.assertRaises(TemplateBridgeError) as ctx:
                    run_template_job("D:/docs/input.docx", "D:/docs/template.json", options=options)

            self.assertIn("E_TEMPLATE_START_FAILED", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
