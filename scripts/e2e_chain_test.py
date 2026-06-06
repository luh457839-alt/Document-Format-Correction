"""端到端全链路检测脚本 v2

覆盖两条链路：
  A) 模板管线：导入文档 → 列出模板 → 创建模板任务 → 轮询进度 → 检查输出
  B) 对话+文档：创建会话 → 绑定文档 → 发送消息 → 轮询 → 检查结果

不依赖 PyQt5 GUI，直接启动 WebApiServer 并通过 HTTP 调用测试。
"""
from __future__ import annotations

import io
import json
import mimetypes
import sys
import time
import uuid
from pathlib import Path

# Bootstrap archive modules
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bootstrap import PROJECT_ROOT, load_all

load_all()

from _host.gui.web_api import WebApiConfig, WebApiServer

import urllib.request
import urllib.error


# ── 日志 ──────────────────────────────────────────────

PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"
WARN = "\033[33m!\033[0m"


def log(phase: str, message: str, data: dict | None = None, mark: str = ""):
    ts = time.strftime("%H:%M:%S")
    tag = f"{mark} " if mark else ""
    print(f"[{ts}] [{phase}] {tag}{message}")
    if data:
        txt = json.dumps(data, ensure_ascii=False, indent=2)
        for line in txt.split("\n"):
            print(f"[{ts}] [{phase}]   {line}")


# ── HTTP 工具 ─────────────────────────────────────────

def api_call(base_url: str, method: str, path: str, body: dict | None = None, timeout: float = 30) -> dict:
    url = f"{base_url}{path}"
    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return {"status": resp.status, "body": json.loads(resp.read().decode("utf-8"))}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = {"raw": raw}
        return {"status": exc.code, "body": body}
    except Exception as exc:
        return {"status": 0, "body": {"error": {"message": str(exc)}}}


def multipart_upload(base_url: str, path: str, file_path: Path, field_name: str = "file", timeout: float = 60) -> dict:
    """发送 multipart/form-data 文件上传请求"""
    boundary = uuid.uuid4().hex
    url = f"{base_url}{path}"

    body = io.BytesIO()
    # 文件部分
    body.write(f"--{boundary}\r\n".encode())
    body.write(
        f'Content-Disposition: form-data; name="{field_name}"; filename="{file_path.name}"\r\n'.encode()
    )
    body.write(f"Content-Type: {mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream'}\r\n\r\n".encode())
    body.write(file_path.read_bytes())
    body.write(f"\r\n--{boundary}--\r\n".encode())

    data = body.getvalue()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return {"status": resp.status, "body": json.loads(resp.read().decode("utf-8"))}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            b = json.loads(raw)
        except json.JSONDecodeError:
            b = {"raw": raw}
        return {"status": exc.code, "body": b}
    except Exception as exc:
        return {"status": 0, "body": {"error": {"message": str(exc)}}}


def poll_job(base_url: str, sid: str, jid: str, phase: str, timeout_sec: int = 240) -> dict:
    """轮询任务直至终态，返回最终 job 对象"""
    for i in range(timeout_sec // 2):
        time.sleep(2.0)
        r = api_call(base_url, "GET", f"/api/sessions/{sid}/message-jobs/{jid}", timeout=60)
        job = r["body"].get("job", {})
        st = job.get("status", "?")
        sm = job.get("summary", "")
        steps = job.get("steps", [])
        err = job.get("error")
        warns = job.get("warnings")

        lines = [f"轮询 #{i+1}: status={st} | {sm}"]
        for s in steps:
            lines.append(f"  [{s.get('status','?')}] {s.get('title','?')}")
        if err:
            lines.append(f"  ERROR: {json.dumps(err, ensure_ascii=False)}")
        if warns:
            lines.append(f"  WARNINGS: {json.dumps(warns, ensure_ascii=False)}")
        for line in lines:
            log(phase, line)

        if st in ("completed", "failed", "waiting_user"):
            return job
    return {"status": "timeout"}


def poll_template_job(base_url: str, tid: str, phase: str, timeout_sec: int = 300) -> dict:
    """轮询模板任务直至终态"""
    for i in range(timeout_sec // 2):
        time.sleep(2.0)
        r = api_call(base_url, "GET", f"/api/templates/runs/{tid}", timeout=60)
        job = r["body"].get("job", {})
        st = job.get("status", "?")
        sm = job.get("summary", "")
        steps = job.get("steps", [])
        err = job.get("error")
        warns = job.get("warnings")
        out = r["body"].get("outputPath")

        lines = [f"轮询 #{i+1}: status={st} | {sm}"]
        for s in steps:
            lines.append(f"  [{s.get('status','?')}] {s.get('title','?')}")
        if err:
            lines.append(f"  ERROR: {json.dumps(err, ensure_ascii=False)}")
        if warns:
            lines.append(f"  WARNINGS: {json.dumps(warns, ensure_ascii=False)}")
        if out:
            lines.append(f"  outputPath: {out}")
        for line in lines:
            log(phase, line)

        if st in ("completed", "failed"):
            return job
    return {"status": "timeout"}


# ── 主流程 ─────────────────────────────────────────────

def main():
    log("INIT", "WebApiServer 启动中 ...")
    server = WebApiServer(WebApiConfig(host="127.0.0.1", port=0))
    host, port = server.server_address
    base_url = f"http://{host}:{port}"
    server.start()
    log("INIT", f"已启动: {base_url}")

    errors: list[str] = []

    try:
        # ================================================================
        #  链路 A: 模板管线
        # ================================================================
        log("A", "=" * 60)
        log("A", "链路 A: 模板管线（导入文档 → 运行模板 → 轮询 → 检查输出）")
        log("A", "=" * 60)

        # ── A1: 列出模板 ──
        log("A1", "=== 列出可用模板 ===")
        r = api_call(base_url, "GET", "/api/templates/configs")
        log("A1", f"GET /templates/configs -> {r['status']}", r["body"])
        configs = r["body"].get("configs", [])
        if not configs:
            log("A1", "FATAL: 无可用模板", mark=FAIL)
            errors.append("A1: 无可用模板")
            return 1
        template_path = configs[0]["path"]
        log("A1", f"选用模板: {configs[0].get('fileName', '?')} -> {template_path}", mark=PASS)

        # ── A2: 选择测试文档 ──
        log("A2", "=== 选择测试文档 ===")
        test_doc = PROJECT_ROOT / "docs" / "标准正文样本.docx"
        if not test_doc.exists():
            log("A2", f"FATAL: 测试文档不存在: {test_doc}", mark=FAIL)
            errors.append(f"A2: 文档不存在 {test_doc}")
            return 1
        log("A2", f"选用文档: {test_doc}", mark=PASS)

        # ── A3: 导入文档（multipart 上传）──
        log("A3", "=== 导入模板文档（multipart 上传）===")
        r = multipart_upload(base_url, "/api/templates/import-document", test_doc)
        log("A3", f"POST /templates/import-document -> {r['status']}", r["body"])
        imported_doc = r["body"].get("document", {}).get("uploadedPath", "")
        if not imported_doc:
            log("A3", "FATAL: 导入失败，无 uploadedPath", mark=FAIL)
            errors.append("A3: 文档导入失败")
            return 1
        log("A3", f"导入路径: {imported_doc}", mark=PASS)

        # ── A4: 创建模板任务 ──
        log("A4", "=== 创建模板任务 ===")
        r = api_call(base_url, "POST", "/api/templates/runs", {
            "documentPath": imported_doc,
            "templatePath": template_path,
        })
        log("A4", f"POST /templates/runs -> {r['status']}", r["body"])
        tid = r["body"].get("job", {}).get("jobId", "")
        if not tid:
            log("A4", "FATAL: 无 template jobId", mark=FAIL)
            errors.append("A4: 模板任务创建失败")
            return 1
        log("A4", f"template jobId = {tid}", mark=PASS)

        # ── A5: 轮询模板任务 ──
        log("A5", "=== 轮询模板任务 ===")
        tjob = poll_template_job(base_url, tid, "A5")
        tstatus = tjob.get("status", "?")
        if tstatus == "completed":
            log("A5", f"模板任务完成", mark=PASS)
            out_path = tjob.get("outputPath", "")
            if out_path and Path(out_path).exists():
                size = Path(out_path).stat().st_size
                log("A5", f"输出文件: {out_path} ({size} bytes)", mark=PASS)
            else:
                log("A5", f"输出文件不存在: {out_path}", mark=WARN)
                errors.append("A5: 输出文件缺失")
        elif tstatus == "failed":
            err = tjob.get("error", {})
            log("A5", f"模板任务失败: {json.dumps(err, ensure_ascii=False)}", mark=FAIL)
            errors.append(f"A5: 模板任务失败 - {err.get('message', '?')}")
        else:
            log("A5", f"模板任务状态异常: {tstatus}", mark=FAIL)
            errors.append(f"A5: 模板任务超时/异常 - {tstatus}")

        # ── A6: 检查模板任务详情 ──
        log("A6", "=== 检查模板任务详情 ===")
        r = api_call(base_url, "GET", f"/api/templates/runs/{tid}")
        job_detail = r["body"].get("job", {})
        # 契约字段检查
        contract_fields = ["jobId", "sessionId", "status", "acceptedAt", "updatedAt", "summary", "steps"]
        missing = [f for f in contract_fields if f not in job_detail]
        if missing:
            log("A6", f"契约字段缺失: {missing}", mark=FAIL)
            errors.append(f"A6: 契约字段缺失 {missing}")
        else:
            log("A6", f"契约字段完整: {contract_fields}", mark=PASS)

        # 警告 / 诊断
        warns = job_detail.get("warnings", [])
        if warns:
            log("A6", f"警告数: {len(warns)}")
            for w in warns[:5]:
                log("A6", f"  [{w.get('code','?')}] {w.get('message','')}")

        # ================================================================
        #  链路 B: 对话 + 文档绑定
        # ================================================================
        log("B", "=" * 60)
        log("B", "链路 B: 对话+文档（创建会话 → 绑定文档 → 发送消息 → 轮询）")
        log("B", "=" * 60)

        # ── B1: 创建会话 ──
        log("B1", "=== 创建会话 ===")
        r = api_call(base_url, "POST", "/api/sessions", {})
        log("B1", f"POST /sessions -> {r['status']}", r["body"])
        sid = r["body"].get("session", {}).get("sessionId", "")
        if not sid:
            log("B1", "FATAL: 无 sessionId", mark=FAIL)
            errors.append("B1: 会话创建失败")
            return 1
        log("B1", f"sessionId = {sid}", mark=PASS)

        # ── B2: 绑定文档（multipart 上传）──
        log("B2", "=== 绑定文档到会话 ===")
        r = multipart_upload(base_url, f"/api/sessions/{sid}/attach-document", test_doc)
        log("B2", f"POST /sessions/{sid}/attach-document -> {r['status']}", r["body"])
        attached = r["body"].get("session", {}).get("attachedDocument")
        if attached:
            log("B2", f"文档已绑定: {attached}", mark=PASS)
        else:
            log("B2", "文档绑定返回无 attachedDocument", mark=WARN)

        # ── B3: 发送异步消息（触发真实模型调用）──
        log("B3", "=== 发送异步消息（附带文档上下文）===")
        r = api_call(base_url, "POST", f"/api/sessions/{sid}/messages/async", {
            "content": "请分析这个文档的整体结构，列出主要章节标题和层级关系。"
        })
        log("B3", f"POST /messages/async -> {r['status']}", r["body"])
        jid = r["body"].get("job", {}).get("jobId", "")
        if not jid:
            log("B3", "FATAL: 无 jobId", mark=FAIL)
            errors.append("B3: 异步消息提交失败")
            return 1
        log("B3", f"jobId = {jid}", mark=PASS)

        # ── B4: 轮询消息任务 ──
        log("B4", "=== 轮询消息任务 ===")
        mjob = poll_job(base_url, sid, jid, "B4")
        mstatus = mjob.get("status", "?")
        if mstatus == "completed":
            log("B4", "消息任务完成", mark=PASS)
        elif mstatus == "failed":
            err = mjob.get("error", {})
            log("B4", f"消息任务失败: {json.dumps(err, ensure_ascii=False)}", mark=FAIL)
            errors.append(f"B4: 消息任务失败 - {err.get('message', '?')}")
        elif mstatus == "waiting_user":
            log("B4", "消息任务等待用户输入（模型需要澄清）", mark=WARN)
        else:
            log("B4", f"消息任务状态异常: {mstatus}", mark=FAIL)
            errors.append(f"B4: 消息任务超时 - {mstatus}")

        # ── B5: 获取最终会话状态 ──
        log("B5", "=== 最终会话状态 ===")
        r = api_call(base_url, "GET", f"/api/sessions/{sid}")
        session = r["body"].get("session", {})
        msgs = session.get("messages", [])
        log("B5", f"消息数: {len(msgs)}")
        for m in msgs:
            role = m.get("role", "?")
            content = m.get("content", "")[:300]
            log("B5", f"  [{role}] {content}")

        # 消息任务契约字段检查
        msg_job_fields = ["jobId", "sessionId", "status", "acceptedAt", "updatedAt", "summary", "steps"]
        missing_m = [f for f in msg_job_fields if f not in mjob]
        if missing_m:
            log("B5", f"消息任务契约字段缺失: {missing_m}", mark=FAIL)
            errors.append(f"B5: 契约字段缺失 {missing_m}")
        else:
            log("B5", f"消息任务契约字段完整", mark=PASS)

        # ================================================================
        #  通用检查
        # ================================================================
        log("C", "=" * 60)
        log("C", "通用检查")
        log("C", "=" * 60)

        # ── C1: 列出会话（createdAt 检查）──
        log("C1", "=== 列出会话 ===")
        r = api_call(base_url, "GET", "/api/sessions")
        sessions = r["body"].get("sessions", [])
        log("C1", f"会话数: {len(sessions)}")
        zero_created = [s["sessionId"] for s in sessions if not s.get("createdAt")]
        if zero_created:
            log("C1", f"createdAt=0 的会话: {zero_created}", mark=WARN)
        else:
            log("C1", "所有会话 createdAt 非零", mark=PASS)

        # ── C2: 模型配置 ──
        log("C2", "=== 模型配置 ===")
        r = api_call(base_url, "GET", "/api/model-config")
        safe = {
            "chat": {k: v for k, v in r["body"].get("chat", {}).items() if k != "apiKey"},
            "planner": {k: v for k, v in r["body"].get("planner", {}).items() if k != "apiKey"},
        }
        log("C2", f"GET /model-config -> {r['status']}", safe)

        # ================================================================
        #  清理
        # ================================================================
        log("CLEANUP", "=== 清理 ===")
        r = api_call(base_url, "DELETE", f"/api/sessions/{sid}")
        log("CLEANUP", f"DELETE session {sid} -> {r['status']}")

        # ================================================================
        #  总结
        # ================================================================
        print()
        log("DONE", "=" * 60)
        if errors:
            log("DONE", f"全链路检测完成，{len(errors)} 个问题:", mark=WARN)
            for e in errors:
                log("DONE", f"  - {e}")
        else:
            log("DONE", "全链路检测完成，无问题", mark=PASS)
        log("DONE", "=" * 60)
        return 1 if errors else 0
    finally:
        server.stop()
        log("INIT", "Server stopped")


if __name__ == "__main__":
    raise SystemExit(main())
