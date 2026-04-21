from __future__ import annotations

import json
import shutil
import unittest
from pathlib import Path
from urllib import error, request
from unittest.mock import patch
from uuid import uuid4

from src.python.api.ts_agent_bridge import TsAgentBridgeError
from src.python.gui.web_api import WebApiConfig, WebApiServer


class WebApiHttpRegressionTest(unittest.TestCase):
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
