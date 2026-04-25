from __future__ import annotations

import json
import shutil
import time
import unittest
from pathlib import Path
from urllib import error, request
from unittest.mock import patch
from uuid import uuid4

from src.python.api.template_bridge import TemplateBridgeError
from src.python.api.ts_agent_bridge import TsAgentBridgeError
from src.python.gui.web_api import WebApiConfig, WebApiServer


class WebApiHttpRegressionTest(unittest.TestCase):
    def test_template_configs_scan_root_templates_json_files(self) -> None:
        root = Path(".tmp") / f"web-api-template-configs-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        templates_dir = root / "templates"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        upload_dir.mkdir(parents=True, exist_ok=True)
        templates_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        (templates_dir / "contract.json").write_text("{}", encoding="utf-8")
        (templates_dir / "notes.txt").write_text("ignored", encoding="utf-8")

        try:
            server = WebApiServer(
                WebApiConfig(
                    port=0,
                    front_dist_dir=front_dist_dir,
                    upload_dir=upload_dir,
                    templates_dir=templates_dir,
                )
            )
            server.start()
            try:
                response = self._get_json(f"{server.base_url}/api/templates/configs")
            finally:
                server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual(response["status"], 200)
        self.assertEqual(response["json"]["configs"][0]["fileName"], "contract.json")
        self.assertEqual(response["json"]["configs"][0]["path"], str(templates_dir / "contract.json"))

    def test_template_import_document_saves_docx_and_rejects_non_docx(self) -> None:
        root = Path(".tmp") / f"web-api-template-import-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        templates_dir = root / "templates"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        upload_dir.mkdir(parents=True, exist_ok=True)
        templates_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        docx_path = root / "input.docx"
        txt_path = root / "input.txt"
        docx_path.write_bytes(b"PK\x03\x04docx")
        txt_path.write_text("nope", encoding="utf-8")

        try:
            server = WebApiServer(
                WebApiConfig(
                    port=0,
                    front_dist_dir=front_dist_dir,
                    upload_dir=upload_dir,
                    templates_dir=templates_dir,
                )
            )
            server.start()
            try:
                accepted = self._post_multipart(
                    f"{server.base_url}/api/templates/import-document",
                    docx_path,
                )
                rejected = self._post_multipart(
                    f"{server.base_url}/api/templates/import-document",
                    txt_path,
                )
            finally:
                server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual(accepted["status"], 200)
        self.assertEqual(accepted["json"]["document"]["fileName"], "input.docx")
        self.assertTrue(Path(accepted["json"]["document"]["uploadedPath"]).name.endswith("-input.docx"))
        self.assertEqual(rejected["status"], 400)
        self.assertIn(".docx", rejected["json"]["error"]["message"])

    def test_template_runs_validate_inputs_and_return_real_bridge_job_snapshot(self) -> None:
        root = Path(".tmp") / f"web-api-template-runs-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        templates_dir = root / "templates"
        output_dir = root / "output"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        upload_dir.mkdir(parents=True, exist_ok=True)
        templates_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        document_path = upload_dir / "input.docx"
        template_path = templates_dir / "template.json"
        output_path = output_dir / "formatted.docx"
        document_path.write_bytes(b"PK\x03\x04docx")
        template_path.write_text("{}", encoding="utf-8")
        output_path.write_bytes(b"PK\x03\x04result")

        try:
            with patch(
                "src.python.gui.web_api.run_template_job",
                return_value={
                    "status": "executed",
                    "validation_result": {"passed": True, "issues": []},
                    "execution_result": {
                        "applied": True,
                        "output_docx_path": str(output_path),
                        "change_summary": "模板已套用到正文样式",
                        "issues": [],
                    },
                },
            ):
                server = WebApiServer(
                    WebApiConfig(
                        port=0,
                        front_dist_dir=front_dist_dir,
                        upload_dir=upload_dir,
                        templates_dir=templates_dir,
                        output_dir=output_dir,
                    )
                )
                server.start()
                try:
                    missing = self._post_json(f"{server.base_url}/api/templates/runs", {})
                    created = self._post_json(
                        f"{server.base_url}/api/templates/runs",
                        {
                            "documentPath": str(document_path),
                            "templatePath": str(template_path),
                        },
                    )
                    job_id = created["json"]["job"]["jobId"]
                    polled = self._get_json(f"{server.base_url}/api/templates/runs/{job_id}")
                    time.sleep(0.2)
                    completed = self._get_json(f"{server.base_url}/api/templates/runs/{job_id}")
                finally:
                    server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual(missing["status"], 400)
        self.assertEqual(created["status"], 202)
        self.assertEqual(created["json"]["job"]["status"], "queued")
        self.assertEqual(polled["status"], 200)
        self.assertIn(polled["json"]["job"]["status"], {"queued", "running", "completed"})
        self.assertEqual(completed["status"], 200)
        self.assertEqual(completed["json"]["job"]["status"], "completed")
        self.assertEqual(completed["json"]["job"]["summary"], "模板已套用到正文样式")
        self.assertEqual(completed["json"]["job"]["outputPath"], str(output_path))
        self.assertEqual(completed["json"]["outputPath"], str(output_path))
        self.assertNotIn("debug", completed["json"]["job"])
        self.assertEqual(
            [step["id"] for step in completed["json"]["job"]["steps"]],
            ["load_inputs", "run_template_pipeline", "validate_result", "materialize_output"],
        )

    def test_template_run_poll_returns_failed_validation_issue(self) -> None:
        root = Path(".tmp") / f"web-api-template-run-failed-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        templates_dir = root / "templates"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        upload_dir.mkdir(parents=True, exist_ok=True)
        templates_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        document_path = upload_dir / "input.docx"
        template_path = templates_dir / "template.json"
        document_path.write_bytes(b"PK\x03\x04docx")
        template_path.write_text("{}", encoding="utf-8")
        report = {
            "status": "failed",
            "validation_result": {
                "passed": False,
                "issues": [{"error_code": "missing_heading", "message": "缺少一级标题"}],
            },
            "execution_result": {
                "applied": False,
                "issues": [{"error_code": "missing_heading", "message": "缺少一级标题"}],
            },
        }

        try:
            with patch("src.python.gui.web_api.run_template_job", return_value=report):
                server = WebApiServer(
                    WebApiConfig(
                        port=0,
                        front_dist_dir=front_dist_dir,
                        upload_dir=upload_dir,
                        templates_dir=templates_dir,
                    )
                )
                server.start()
                try:
                    created = self._post_json(
                        f"{server.base_url}/api/templates/runs",
                        {
                            "documentPath": str(document_path),
                            "templatePath": str(template_path),
                        },
                    )
                    job_id = created["json"]["job"]["jobId"]
                    time.sleep(0.2)
                    failed = self._get_json(f"{server.base_url}/api/templates/runs/{job_id}")
                finally:
                    server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual(failed["status"], 200)
        self.assertEqual(failed["json"]["job"]["status"], "failed")
        self.assertNotIn("outputPath", failed["json"])
        self.assertEqual(failed["json"]["job"]["summary"], "缺少一级标题")
        self.assertEqual(failed["json"]["job"]["error"]["message"], "缺少一级标题")
        validate_step = next(step for step in failed["json"]["job"]["steps"] if step["id"] == "validate_result")
        self.assertEqual(validate_step["status"], "failed")
        self.assertEqual(validate_step["detail"], "missing_heading: 缺少一级标题")

    def test_template_run_poll_returns_refinement_summary_for_failed_conflict(self) -> None:
        root = Path(".tmp") / f"web-api-template-run-refinement-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        templates_dir = root / "templates"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        upload_dir.mkdir(parents=True, exist_ok=True)
        templates_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        document_path = upload_dir / "input.docx"
        template_path = templates_dir / "template.json"
        document_path.write_bytes(b"PK\x03\x04docx")
        template_path.write_text("{}", encoding="utf-8")
        report = {
            "status": "failed",
            "classification_result": {
                "conflicts": [
                    {
                        "paragraph_id": "p_0",
                        "candidate_semantic_keys": ["title", "body"],
                        "reason": "first pass conflict",
                    }
                ],
                "diagnostics": {
                    "refined_paragraphs": [
                        {
                            "paragraph_id": "p_0",
                            "first_pass": {
                                "semantic_keys": ["title", "body"],
                                "candidate_semantic_keys": ["title", "body", "blank_or_unknown"],
                                "confidence": 0.52,
                                "reason": "标题和正文特征都命中",
                                "source": "conflict",
                            },
                            "second_pass": {
                                "semantic_key": "title",
                                "candidate_semantic_keys": ["title", "body"],
                                "confidence": 0.48,
                                "reason": "上下文仍不足以收敛",
                            },
                            "outcome": "rejected_conflict",
                        }
                    ]
                },
            },
            "validation_result": {
                "passed": False,
                "issues": [
                    {
                        "error_code": "classification_conflict",
                        "message": "段落分类仍然冲突",
                        "paragraph_ids": ["p_0"],
                    }
                ],
            },
            "execution_result": {
                "applied": False,
                "issues": [],
            },
        }

        try:
            with patch("src.python.gui.web_api.run_template_job", return_value=report):
                server = WebApiServer(
                    WebApiConfig(
                        port=0,
                        front_dist_dir=front_dist_dir,
                        upload_dir=upload_dir,
                        templates_dir=templates_dir,
                    )
                )
                server.start()
                try:
                    created = self._post_json(
                        f"{server.base_url}/api/templates/runs",
                        {
                            "documentPath": str(document_path),
                            "templatePath": str(template_path),
                        },
                    )
                    job_id = created["json"]["job"]["jobId"]
                    time.sleep(0.2)
                    failed = self._get_json(f"{server.base_url}/api/templates/runs/{job_id}")
                finally:
                    server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual(failed["status"], 200)
        self.assertEqual(failed["json"]["job"]["status"], "failed")
        self.assertEqual(
            failed["json"]["job"]["debug"]["refinementSummary"],
            [
                {
                    "paragraphId": "p_0",
                    "firstPass": {
                        "semanticKeys": ["title", "body"],
                        "candidateSemanticKeys": ["title", "body", "blank_or_unknown"],
                        "confidence": 0.52,
                        "reason": "标题和正文特征都命中",
                        "source": "conflict",
                    },
                    "secondPass": {
                        "semanticKey": "title",
                        "candidateSemanticKeys": ["title", "body"],
                        "confidence": 0.48,
                        "reason": "上下文仍不足以收敛",
                    },
                    "outcome": "rejected_conflict",
                }
            ],
        )
        validate_step = next(step for step in failed["json"]["job"]["steps"] if step["id"] == "validate_result")
        self.assertEqual(validate_step["status"], "failed")
        self.assertIn("classification_conflict: 段落分类仍然冲突", validate_step["detail"])
        self.assertIn("paragraph=p_0", validate_step["detail"])
        self.assertIn("first_pass=title, body", validate_step["detail"])
        self.assertIn("second_pass=title", validate_step["detail"])
        self.assertIn("outcome=rejected_conflict", validate_step["detail"])

    def test_template_run_poll_falls_back_to_conflict_candidates_when_refinement_missing(self) -> None:
        root = Path(".tmp") / f"web-api-template-run-conflict-fallback-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        templates_dir = root / "templates"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        upload_dir.mkdir(parents=True, exist_ok=True)
        templates_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        document_path = upload_dir / "input.docx"
        template_path = templates_dir / "template.json"
        document_path.write_bytes(b"PK\x03\x04docx")
        template_path.write_text("{}", encoding="utf-8")
        report = {
            "status": "failed",
            "classification_result": {
                "conflicts": [
                    {
                        "paragraph_id": "p_9",
                        "candidate_semantic_keys": ["title", "body"],
                        "reason": "raw conflict",
                    }
                ]
            },
            "validation_result": {
                "passed": False,
                "issues": [
                    {
                        "error_code": "classification_conflict",
                        "message": "段落分类仍然冲突",
                        "paragraph_ids": ["p_9"],
                    }
                ],
            },
            "execution_result": {
                "applied": False,
                "issues": [],
            },
        }

        try:
            with patch("src.python.gui.web_api.run_template_job", return_value=report):
                server = WebApiServer(
                    WebApiConfig(
                        port=0,
                        front_dist_dir=front_dist_dir,
                        upload_dir=upload_dir,
                        templates_dir=templates_dir,
                    )
                )
                server.start()
                try:
                    created = self._post_json(
                        f"{server.base_url}/api/templates/runs",
                        {
                            "documentPath": str(document_path),
                            "templatePath": str(template_path),
                        },
                    )
                    job_id = created["json"]["job"]["jobId"]
                    time.sleep(0.2)
                    failed = self._get_json(f"{server.base_url}/api/templates/runs/{job_id}")
                finally:
                    server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual(failed["status"], 200)
        self.assertEqual(
            failed["json"]["job"]["debug"]["refinementSummary"],
            [
                {
                    "paragraphId": "p_9",
                    "firstPass": {
                        "candidateSemanticKeys": ["title", "body"],
                        "reason": "raw conflict",
                        "source": "conflict",
                    },
                    "outcome": "rejected_conflict",
                }
            ],
        )
        validate_step = next(step for step in failed["json"]["job"]["steps"] if step["id"] == "validate_result")
        self.assertIn("candidate_keys=title, body", validate_step["detail"])

    def test_template_run_poll_formats_numbering_issue_diagnostics(self) -> None:
        root = Path(".tmp") / f"web-api-template-run-numbering-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        templates_dir = root / "templates"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        upload_dir.mkdir(parents=True, exist_ok=True)
        templates_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        document_path = upload_dir / "input.docx"
        template_path = templates_dir / "template.json"
        document_path.write_bytes(b"PK\x03\x04docx")
        template_path.write_text("{}", encoding="utf-8")
        report = {
            "status": "failed",
            "validation_result": {
                "passed": False,
                "issues": [
                    {
                        "error_code": "numbering_pattern_not_allowed",
                        "message": "paragraph 'p_29' numbering prefix '3.1' is not allowed by template",
                        "semantic_key": "body_paragraph",
                        "paragraph_ids": ["p_29"],
                        "diagnostics": {
                            "semantic_key": "body_paragraph",
                            "numbering_prefix": "3.1",
                            "rule_source": "semantic_rule",
                            "allowed_patterns": ["^\\d+\\.\\d+(?:\\.\\d+)*[)）、．。、]?$"],
                        },
                    }
                ],
            },
            "execution_result": {
                "applied": False,
                "issues": [],
            },
        }

        try:
            with patch("src.python.gui.web_api.run_template_job", return_value=report):
                server = WebApiServer(
                    WebApiConfig(
                        port=0,
                        front_dist_dir=front_dist_dir,
                        upload_dir=upload_dir,
                        templates_dir=templates_dir,
                    )
                )
                server.start()
                try:
                    created = self._post_json(
                        f"{server.base_url}/api/templates/runs",
                        {
                            "documentPath": str(document_path),
                            "templatePath": str(template_path),
                        },
                    )
                    job_id = created["json"]["job"]["jobId"]
                    time.sleep(0.2)
                    failed = self._get_json(f"{server.base_url}/api/templates/runs/{job_id}")
                finally:
                    server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual(failed["status"], 200)
        self.assertEqual(failed["json"]["job"]["status"], "failed")
        validate_step = next(step for step in failed["json"]["job"]["steps"] if step["id"] == "validate_result")
        self.assertEqual(
            validate_step["detail"],
            "numbering_pattern_not_allowed: paragraph 'p_29' numbering prefix '3.1' is not allowed by template "
            "[semantic=body_paragraph; prefix=3.1; rule=semantic_rule; "
            "allowed=^\\d+\\.\\d+(?:\\.\\d+)*[)）、．。、]?$]",
        )

    def test_template_run_poll_returns_bridge_stage_failure_detail(self) -> None:
        root = Path(".tmp") / f"web-api-template-run-bridge-error-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        templates_dir = root / "templates"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        upload_dir.mkdir(parents=True, exist_ok=True)
        templates_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        document_path = upload_dir / "input.docx"
        template_path = templates_dir / "template.json"
        document_path.write_bytes(b"PK\x03\x04docx")
        template_path.write_text("{}", encoding="utf-8")

        try:
            config_warnings = [
                {
                    "code": "planner_chat_host_mismatch",
                    "scope": "planner",
                    "message": "Planner Base URL host differs from Chat Base URL host.",
                }
            ]
            bridge_error = TemplateBridgeError(
                "E_TEMPLATE_CLASSIFICATION_REQUEST: request timed out",
                code="E_TEMPLATE_CLASSIFICATION_REQUEST",
                stage="classification_request_failed",
                stage_timings_ms={
                    "observation_ms": 12,
                    "classification_request_ms": 300000,
                    "validation_ms": 0,
                    "execution_ms": 0,
                },
                stderr_summary=(
                    "classification_request_start endpoint=mock.example/v1/chat/completions model=gpt timeoutMs=300000"
                ),
            )
            with patch(
                "src.python.gui.web_api.run_template_job",
                side_effect=bridge_error,
            ), patch(
                "src.python.gui.web_api.collect_model_config_warnings",
                return_value=config_warnings,
            ):
                server = WebApiServer(
                    WebApiConfig(
                        port=0,
                        front_dist_dir=front_dist_dir,
                        upload_dir=upload_dir,
                        templates_dir=templates_dir,
                    )
                )
                server.start()
                try:
                    created = self._post_json(
                        f"{server.base_url}/api/templates/runs",
                        {
                            "documentPath": str(document_path),
                            "templatePath": str(template_path),
                        },
                    )
                    job_id = created["json"]["job"]["jobId"]
                    time.sleep(0.2)
                    failed = self._get_json(f"{server.base_url}/api/templates/runs/{job_id}")
                finally:
                    server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual(failed["status"], 200)
        self.assertEqual(failed["json"]["job"]["status"], "failed")
        self.assertEqual(failed["json"]["job"]["warnings"], config_warnings)
        self.assertEqual(failed["json"]["job"]["error"]["code"], "E_TEMPLATE_CLASSIFICATION_REQUEST")
        self.assertEqual(failed["json"]["job"]["error"]["stage"], "classification_request_failed")
        self.assertIn("classification_request_start", failed["json"]["job"]["error"]["stderrSummary"])
        pipeline_step = next(
            step for step in failed["json"]["job"]["steps"] if step["id"] == "run_template_pipeline"
        )
        self.assertEqual(pipeline_step["status"], "failed")
        self.assertIn("stage_timings_ms", pipeline_step["detail"])
        self.assertIn("classification_request=300000ms", pipeline_step["detail"])
        self.assertIn("stderr:", pipeline_step["detail"])

    def test_template_run_poll_merges_runtime_warnings_into_job_warnings(self) -> None:
        root = Path(".tmp") / f"web-api-template-run-warnings-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        templates_dir = root / "templates"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        upload_dir.mkdir(parents=True, exist_ok=True)
        templates_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        document_path = upload_dir / "input.docx"
        template_path = templates_dir / "template.json"
        output_path = upload_dir / "output.docx"
        document_path.write_bytes(b"PK\x03\x04docx")
        template_path.write_text("{}", encoding="utf-8")
        output_path.write_bytes(b"PK\x03\x04docx")
        config_warnings = [
            {
                "code": "planner_chat_host_mismatch",
                "scope": "planner",
                "message": "Planner Base URL host differs from Chat Base URL host.",
            }
        ]
        report = {
            "status": "executed",
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
            "validation_result": {
                "passed": True,
                "issues": [],
            },
            "execution_result": {
                "applied": True,
                "output_docx_path": str(output_path),
                "change_summary": "模板已套用到正文样式",
                "issues": [],
            },
        }

        try:
            with patch("src.python.gui.web_api.run_template_job", return_value=report), patch(
                "src.python.gui.web_api.collect_model_config_warnings",
                return_value=config_warnings,
            ):
                server = WebApiServer(
                    WebApiConfig(
                        port=0,
                        front_dist_dir=front_dist_dir,
                        upload_dir=upload_dir,
                        templates_dir=templates_dir,
                    )
                )
                server.start()
                try:
                    created = self._post_json(
                        f"{server.base_url}/api/templates/runs",
                        {
                            "documentPath": str(document_path),
                            "templatePath": str(template_path),
                        },
                    )
                    job_id = created["json"]["job"]["jobId"]
                    time.sleep(0.2)
                    completed = self._get_json(f"{server.base_url}/api/templates/runs/{job_id}")
                finally:
                    server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual(completed["status"], 200)
        self.assertEqual(completed["json"]["job"]["status"], "completed")
        self.assertEqual(
            completed["json"]["job"]["warnings"],
            [
                {
                    "code": "planner_chat_host_mismatch",
                    "scope": "planner",
                    "message": "Planner Base URL host differs from Chat Base URL host.",
                },
                {
                    "code": "body_paragraph_suspicious_numbering_prefix",
                    "scope": "template_run",
                    "message": "Paragraph matched body_paragraph but still starts with numbering prefix '2.'; output was generated with a warning.",
                    "paragraphIds": ["p2"],
                    "diagnostics": {
                        "semantic_key": "body_paragraph",
                        "text_excerpt": "2. 现将有关事项通知如下。",
                        "numbering_prefix": "2.",
                        "detected_prefix": "2.",
                        "warning_kind": "body_paragraph_numbering_prefix",
                    },
                },
            ],
        )

    def test_template_open_output_returns_structured_error_for_missing_path(self) -> None:
        root = Path(".tmp") / f"web-api-template-open-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        templates_dir = root / "templates"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        upload_dir.mkdir(parents=True, exist_ok=True)
        templates_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")

        try:
            server = WebApiServer(
                WebApiConfig(
                    port=0,
                    front_dist_dir=front_dist_dir,
                    upload_dir=upload_dir,
                    templates_dir=templates_dir,
                )
            )
            server.start()
            try:
                response = self._post_json(
                    f"{server.base_url}/api/templates/open-output",
                    {"outputPath": str(root / "missing.docx")},
                )
            finally:
                server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual(response["status"], 409)
        self.assertEqual(response["json"]["error"]["code"], "E_OUTPUT_NOT_FOUND")

    def test_web_api_updates_titles_and_deletes_sessions(self) -> None:
        bridge_state = {
            "sessions": {
                "chat-main": {
                    "sessionId": "chat-main",
                    "title": "chat-main",
                    "attachedDocument": None,
                    "turns": [],
                },
                "chat-second": {
                    "sessionId": "chat-second",
                    "title": "第二个会话",
                    "attachedDocument": None,
                    "turns": [],
                },
            }
        }

        def fake_list_sessions(*, timeout_sec=None, options=None):  # noqa: ANN001
            _ = timeout_sec, options
            return {
                "sessions": [
                    {
                        "sessionId": session["sessionId"],
                        "title": session.get("title") or session["sessionId"],
                        "updatedAt": 0,
                        "hasAttachedDocument": False,
                    }
                    for session in bridge_state["sessions"].values()
                ]
            }

        def fake_get_session_state(session_id: str, *, timeout_sec=None, options=None):  # noqa: ANN001
            _ = timeout_sec, options
            session = bridge_state["sessions"].get(session_id)
            if session is None:
                raise TsAgentBridgeError("E_SESSION_NOT_FOUND: session does not exist")
            return {"session": dict(session)}

        def fake_update_session_title(session_id: str, title: str, *, timeout_sec=None, options=None):  # noqa: ANN001
            _ = timeout_sec, options
            session = bridge_state["sessions"].get(session_id)
            if session is None:
                raise TsAgentBridgeError("E_SESSION_NOT_FOUND: session does not exist")
            session["title"] = title
            return {"session": dict(session)}

        def fake_delete_session(session_id: str, *, timeout_sec=None, options=None):  # noqa: ANN001
            _ = timeout_sec, options
            if session_id not in bridge_state["sessions"]:
                raise TsAgentBridgeError("E_SESSION_NOT_FOUND: session does not exist")
            del bridge_state["sessions"][session_id]
            return {"deletedSessionId": session_id}

        root = Path(".tmp") / f"web-api-session-mutate-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        upload_dir.mkdir(parents=True, exist_ok=True)

        try:
            with (
                patch("src.python.gui.web_api.list_sessions", side_effect=fake_list_sessions),
                patch("src.python.gui.web_api.get_session_state", side_effect=fake_get_session_state),
                patch("src.python.gui.web_api.update_session_title", side_effect=fake_update_session_title),
                patch("src.python.gui.web_api.delete_session", side_effect=fake_delete_session),
            ):
                server = WebApiServer(
                    WebApiConfig(
                        port=0,
                        front_dist_dir=front_dist_dir,
                        upload_dir=upload_dir,
                    )
                )
                server.start()
                try:
                    rename_response = self._patch_json(
                        f"{server.base_url}/api/sessions/chat-main",
                        {"title": "项目周报"},
                    )
                    self.assertEqual(rename_response["status"], 200)
                    self.assertEqual(rename_response["json"]["session"]["title"], "项目周报")

                    list_response = self._get_json(f"{server.base_url}/api/sessions")
                    self.assertEqual(list_response["status"], 200)
                    self.assertEqual(
                        list_response["json"]["sessions"][0]["title"],
                        "项目周报",
                    )

                    get_response = self._get_json(f"{server.base_url}/api/sessions/chat-main")
                    self.assertEqual(get_response["status"], 200)
                    self.assertEqual(get_response["json"]["session"]["title"], "项目周报")

                    delete_response = self._delete(f"{server.base_url}/api/sessions/chat-main")
                    self.assertEqual(delete_response["status"], 200)
                    self.assertEqual(delete_response["json"]["deletedSessionId"], "chat-main")

                    missing_response = self._get_json(f"{server.base_url}/api/sessions/chat-main")
                    self.assertEqual(missing_response["status"], 404)
                finally:
                    server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_web_api_submit_turn_surfaces_python_runner_start_failure(self) -> None:
        bridge_state = {
            "sessionId": "",
            "attachedDocument": None,
            "turns": [],
        }

        def fake_create_session(session_id: str, *, timeout_sec=None, options=None):  # noqa: ANN001
            _ = timeout_sec, options
            bridge_state["sessionId"] = session_id
            bridge_state["attachedDocument"] = None
            bridge_state["turns"] = []
            return {"session": self._session_snapshot(bridge_state)}

        def fake_attach_document(session_id: str, docx_path: str, *, timeout_sec=None, options=None):  # noqa: ANN001
            _ = timeout_sec, options
            self.assertEqual(session_id, bridge_state["sessionId"])
            bridge_state["attachedDocument"] = {
                "path": docx_path,
                "name": Path(docx_path).name,
            }
            return {"session": self._session_snapshot(bridge_state)}

        def fake_submit_agent_turn(session_id: str, user_input: str, *, timeout_sec=None, options=None):  # noqa: ANN001
            _ = timeout_sec, options
            self.assertEqual(session_id, bridge_state["sessionId"])
            self.assertEqual(user_input, "请开始处理文档")
            raise TsAgentBridgeError(
                "E_PYTHON_TOOL_START_FAILED: No module named 'src' while starting python tool runner"
            )

        def fake_get_session_state(session_id: str, *, timeout_sec=None, options=None):  # noqa: ANN001
            _ = timeout_sec, options
            self.assertEqual(session_id, bridge_state["sessionId"])
            return {"session": self._session_snapshot(bridge_state)}

        root = Path(".tmp") / f"web-api-http-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        upload_dir.mkdir(parents=True, exist_ok=True)

        try:
            with (
                patch("src.python.gui.web_api.create_session", side_effect=fake_create_session),
                patch("src.python.gui.web_api.attach_document", side_effect=fake_attach_document),
                patch("src.python.gui.web_api.submit_agent_turn", side_effect=fake_submit_agent_turn),
                patch("src.python.gui.web_api.get_session_state", side_effect=fake_get_session_state),
            ):
                server = WebApiServer(
                    WebApiConfig(
                        port=0,
                        front_dist_dir=front_dist_dir,
                        upload_dir=upload_dir,
                    )
                )
                server.start()
                try:
                    create_response = self._post_json(f"{server.base_url}/api/sessions", {})
                    self.assertEqual(create_response["status"], 201)
                    session_id = create_response["json"]["session"]["sessionId"]
                    self.assertTrue(session_id.startswith("chat-"))

                    docx_path = root / "sample.docx"
                    docx_path.write_bytes(b"PK\x03\x04test-docx")
                    attach_response = self._post_multipart(
                        f"{server.base_url}/api/sessions/{session_id}/attach-document",
                        docx_path,
                    )
                    self.assertEqual(attach_response["status"], 200)
                    self.assertEqual(
                        attach_response["json"]["session"]["attachedDocument"]["path"],
                        attach_response["json"]["uploadedPath"],
                    )

                    submit_response = self._post_json(
                        f"{server.base_url}/api/sessions/{session_id}/messages",
                        {"content": "请开始处理文档"},
                    )
                finally:
                    server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

        self.assertEqual(submit_response["status"], 502)
        self.assertEqual(set(submit_response["json"].keys()), {"error"})
        self.assertIn("message", submit_response["json"]["error"])
        self.assertIn("E_PYTHON_TOOL_START_FAILED", submit_response["json"]["error"]["message"])
        self.assertIn("No module named 'src'", submit_response["json"]["error"]["message"])

    def test_web_api_async_submit_returns_job_and_poll_snapshot(self) -> None:
        bridge_state = {
            "sessionId": "chat-main",
            "attachedDocument": None,
            "turns": [],
        }
        queried_states: list[str] = []

        def fake_submit_agent_turn(session_id: str, user_input: str, *, timeout_sec=None, options=None):  # noqa: ANN001
            self.assertIsNone(timeout_sec)
            _ = options
            self.assertEqual(session_id, "chat-main")
            self.assertEqual(user_input, "请开始处理")
            bridge_state["turns"] = [
                {"role": "user", "content": "请开始处理"},
                {"role": "assistant", "content": "处理完成"},
            ]
            return {
                "session": self._session_snapshot(bridge_state),
                "response": {"content": "处理完成"},
            }

        def fake_get_turn_run_status(*, session_id=None, turn_run_id=None, timeout_sec=None, options=None):  # noqa: ANN001
            _ = timeout_sec, options, turn_run_id
            self.assertEqual(session_id, "chat-main")
            queried_states.append("queried")
            status = "running" if len(queried_states) == 1 else "completed"
            return {
                "turnRun": {
                    "turnRunId": "turn-run-1",
                    "sessionId": "chat-main",
                    "status": status,
                    "mode": "chat",
                    "summary": "正在生成回复" if status == "running" else "已完成",
                    "steps": [
                        {"id": "decide_mode", "title": "判定模式", "status": "completed"},
                        {
                            "id": "generate_reply",
                            "title": "生成回复",
                            "status": "running" if status == "running" else "completed",
                        },
                    ],
                    "createdAt": 1,
                    "updatedAt": 2,
                }
            }

        def fake_get_session_state(session_id: str, *, timeout_sec=None, options=None):  # noqa: ANN001
            _ = timeout_sec, options
            self.assertEqual(session_id, "chat-main")
            return {"session": self._session_snapshot(bridge_state)}

        root = Path(".tmp") / f"web-api-async-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        upload_dir.mkdir(parents=True, exist_ok=True)

        try:
            with (
                patch("src.python.gui.web_api.submit_agent_turn", side_effect=fake_submit_agent_turn),
                patch("src.python.gui.web_api.get_turn_run_status", side_effect=fake_get_turn_run_status),
                patch("src.python.gui.web_api.get_session_state", side_effect=fake_get_session_state),
            ):
                server = WebApiServer(
                    WebApiConfig(
                        port=0,
                        front_dist_dir=front_dist_dir,
                        upload_dir=upload_dir,
                    )
                )
                server.start()
                try:
                    submit_response = self._post_json(
                        f"{server.base_url}/api/sessions/chat-main/messages/async",
                        {"content": "请开始处理"},
                    )
                    self.assertEqual(submit_response["status"], 202)
                    job_id = submit_response["json"]["job"]["jobId"]

                    first_poll = self._get_json(
                        f"{server.base_url}/api/sessions/chat-main/message-jobs/{job_id}"
                    )
                    self.assertEqual(first_poll["status"], 200)
                    self.assertEqual(first_poll["json"]["job"]["status"], "running")
                    self.assertEqual(first_poll["json"]["job"]["turnRunId"], "turn-run-1")

                    second_poll = self._get_json(
                        f"{server.base_url}/api/sessions/chat-main/message-jobs/{job_id}"
                    )
                    self.assertEqual(second_poll["status"], 200)
                    self.assertEqual(second_poll["json"]["job"]["status"], "completed")
                    self.assertEqual(
                        second_poll["json"]["session"]["messages"][-1]["content"],
                        "处理完成",
                    )
                finally:
                    server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_web_api_sync_submit_times_out_but_job_continues(self) -> None:
        bridge_state = {
            "sessionId": "chat-main",
            "attachedDocument": None,
            "turns": [],
        }

        def fake_submit_agent_turn(session_id: str, user_input: str, *, timeout_sec=None, options=None):  # noqa: ANN001
            self.assertIsNone(timeout_sec)
            _ = options
            self.assertEqual(session_id, "chat-main")
            self.assertEqual(user_input, "请继续处理")
            time.sleep(0.15)
            bridge_state["turns"] = [
                {"role": "user", "content": "请继续处理"},
                {"role": "assistant", "content": "后台任务已完成"},
            ]
            return {
                "session": self._session_snapshot(bridge_state),
                "response": {"content": "后台任务已完成"},
            }

        def fake_get_turn_run_status(*, session_id=None, turn_run_id=None, timeout_sec=None, options=None):  # noqa: ANN001
            _ = turn_run_id, timeout_sec, options
            return {
                "turnRun": {
                    "turnRunId": "turn-run-sync-1",
                    "sessionId": session_id,
                    "status": "running",
                    "summary": "仍在执行",
                    "steps": [{"id": "execute_runtime", "title": "规划并执行步骤", "status": "running"}],
                    "createdAt": 1,
                    "updatedAt": 2,
                }
            }

        def fake_get_session_state(session_id: str, *, timeout_sec=None, options=None):  # noqa: ANN001
            _ = timeout_sec, options
            self.assertEqual(session_id, "chat-main")
            return {"session": self._session_snapshot(bridge_state)}

        root = Path(".tmp") / f"web-api-sync-timeout-{uuid4().hex}"
        front_dist_dir = root / "front"
        upload_dir = root / "uploads"
        front_dist_dir.mkdir(parents=True, exist_ok=True)
        (front_dist_dir / "index.html").write_text("<!doctype html><title>test</title>", encoding="utf-8")
        upload_dir.mkdir(parents=True, exist_ok=True)

        try:
            with (
                patch("src.python.gui.web_api.submit_agent_turn", side_effect=fake_submit_agent_turn),
                patch("src.python.gui.web_api.get_turn_run_status", side_effect=fake_get_turn_run_status),
                patch("src.python.gui.web_api.get_session_state", side_effect=fake_get_session_state),
            ):
                server = WebApiServer(
                    WebApiConfig(
                        port=0,
                        front_dist_dir=front_dist_dir,
                        upload_dir=upload_dir,
                        sync_request_timeout_sec=0.05,
                    )
                )
                server.start()
                try:
                    submit_response = self._post_json(
                        f"{server.base_url}/api/sessions/chat-main/messages",
                        {"content": "请继续处理"},
                    )
                    self.assertEqual(submit_response["status"], 504)
                    self.assertEqual(submit_response["json"]["error"]["code"], "E_SYNC_REQUEST_TIMEOUT")
                    job_id = submit_response["json"]["error"]["jobId"]

                    time.sleep(0.2)
                    follow_up = self._get_json(
                        f"{server.base_url}/api/sessions/chat-main/message-jobs/{job_id}"
                    )
                    self.assertEqual(follow_up["status"], 200)
                    self.assertEqual(follow_up["json"]["job"]["status"], "completed")
                    self.assertEqual(
                        follow_up["json"]["session"]["messages"][-1]["content"],
                        "后台任务已完成",
                    )
                finally:
                    server.stop()
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def _session_snapshot(self, state: dict[str, object]) -> dict[str, object]:
        attached_document = state["attachedDocument"]
        return {
            "sessionId": state["sessionId"],
            "turns": list(state["turns"]),
            "attachedDocument": dict(attached_document) if isinstance(attached_document, dict) else None,
        }

    def _post_json(self, url: str, payload: dict[str, object]) -> dict[str, object]:
        data = json.dumps(payload).encode("utf-8")
        req = request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return self._perform_request(req)

    def _post_multipart(self, url: str, file_path: Path) -> dict[str, object]:
        boundary = f"----CodexBoundary{uuid4().hex}"
        body = b"".join(
            [
                f"--{boundary}\r\n".encode("ascii"),
                (
                    f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'
                ).encode("utf-8"),
                (
                    "Content-Type: "
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n"
                ).encode("ascii"),
                file_path.read_bytes(),
                b"\r\n",
                f"--{boundary}--\r\n".encode("ascii"),
            ]
        )
        req = request.Request(
            url,
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        return self._perform_request(req)

    def _perform_request(self, req: request.Request) -> dict[str, object]:
        try:
            with request.urlopen(req, timeout=5) as response:
                status = response.status
                body = response.read()
        except error.HTTPError as exc:
            status = exc.code
            body = exc.read()

        return {
            "status": status,
            "json": json.loads(body.decode("utf-8")),
        }

    def _get_json(self, url: str) -> dict[str, object]:
        req = request.Request(url, method="GET")
        return self._perform_request(req)

    def _patch_json(self, url: str, payload: dict[str, object]) -> dict[str, object]:
        data = json.dumps(payload).encode("utf-8")
        req = request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="PATCH",
        )
        return self._perform_request(req)

    def _delete(self, url: str) -> dict[str, object]:
        req = request.Request(url, method="DELETE")
        return self._perform_request(req)


if __name__ == "__main__":
    unittest.main()
