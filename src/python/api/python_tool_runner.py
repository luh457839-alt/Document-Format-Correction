from __future__ import annotations

import argparse
import base64
import copy
import json
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.python.core.project_paths import AGENT_MEDIA_DIR


class PythonToolRunnerError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        cause: Exception | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.cause = cause

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }


@dataclass
class _OutputFileSnapshot:
    output_docx_path: str
    existed_before: bool
    backup_path: str | None = None
    backup_dir: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "outputDocxPath": self.output_docx_path,
            "backupPath": self.backup_path,
            "backupDir": self.backup_dir,
            "existedBefore": self.existed_before,
        }


def execute_tool_request(request: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise PythonToolRunnerError("E_INVALID_TOOL_REQUEST", "tool request must be an object.")

    action = _require_non_empty_string(request.get("action"), "E_INVALID_TOOL_REQUEST", "action is required.")
    tool_name = _require_non_empty_string(
        request.get("toolName"), "E_INVALID_TOOL_REQUEST", "toolName is required."
    )

    if action == "execute":
        raw_input = request.get("input")
        if not isinstance(raw_input, dict):
            raise PythonToolRunnerError(
                "E_INVALID_TOOL_REQUEST",
                "execute action requires input object.",
            )
        return _execute_tool(tool_name, raw_input)

    if action == "rollback":
        rollback_token = _require_non_empty_string(
            request.get("rollbackToken"),
            "E_INVALID_TOOL_REQUEST",
            "rollback action requires rollbackToken.",
        )
        raw_doc = request.get("doc")
        if not isinstance(raw_doc, dict):
            raise PythonToolRunnerError(
                "E_INVALID_TOOL_REQUEST",
                "rollback action requires doc object.",
            )
        return _rollback_tool(tool_name, rollback_token, raw_doc)

    raise PythonToolRunnerError("E_INVALID_TOOL_REQUEST", f"unsupported action: {action}")


def _execute_tool(tool_name: str, tool_input: dict[str, Any]) -> dict[str, Any]:
    doc = _clone_doc(tool_input.get("doc"))
    context = tool_input.get("context")
    if not isinstance(context, dict):
        raise PythonToolRunnerError("E_INVALID_TOOL_INPUT", "tool input.context must be an object.")

    if tool_name == "inspect_document":
        return {
            "doc": doc,
            "summary": f"Inspected {len(doc.get('nodes', []))} node(s).",
        }

    if tool_name == "docx_observation":
        operation = _require_operation(tool_input)
        payload = operation["payload"]
        docx_path = _require_non_empty_string(
            payload.get("docxPath"),
            "E_INVALID_DOCX_PATH",
            "docx_observation requires operation.payload.docxPath",
        )
        try:
            state = _parse_docx_state(
                docx_path,
                media_dir=str(payload.get("mediaDir") or AGENT_MEDIA_DIR),
            )
        except Exception as exc:
            raise _classify_python_boundary_error(
                exc,
                default_code="E_PYTHON_IMPORT_FAILED",
                default_message=f"Failed to load DOCX observation parser: {exc}",
                retryable=False,
            ) from exc
        metadata = doc.setdefault("metadata", {})
        if not isinstance(metadata, dict):
            metadata = {}
            doc["metadata"] = metadata
        metadata["docxObservation"] = state
        return {
            "doc": doc,
            "summary": f"Observed docx: nodes={len(state.get('nodes', []))}",
        }

    if tool_name == "write_operation":
        operation = _require_operation(tool_input)
        dry_run = bool(context.get("dryRun"))
        next_doc = _apply_write_operation(doc, operation)
        return {
            "doc": next_doc,
            "summary": (
                f"Dry-run: {operation['type']} prepared for {operation['targetNodeId']}."
                if dry_run
                else f"Applied {operation['type']} to {operation['targetNodeId']}."
            ),
        }

    if tool_name == "materialize_document":
        return _materialize_document(doc, dry_run=bool(context.get("dryRun")))

    raise PythonToolRunnerError("E_TOOL_NOT_FOUND", f"Tool not found: {tool_name}")


def _rollback_tool(tool_name: str, rollback_token: str, doc: dict[str, Any]) -> dict[str, Any]:
    if tool_name == "materialize_document":
        snapshot = _decode_rollback_token(rollback_token)
        if snapshot is not None:
            _restore_file_snapshot(snapshot)
    elif tool_name != "write_operation":
        return _clone_doc(doc)

    next_doc = _clone_doc(doc)
    metadata = next_doc.setdefault("metadata", {})
    if not isinstance(metadata, dict):
        metadata = {}
        next_doc["metadata"] = metadata
    metadata["lastRollbackToken"] = rollback_token
    return next_doc


def _require_operation(tool_input: dict[str, Any]) -> dict[str, Any]:
    operation = tool_input.get("operation")
    if not isinstance(operation, dict):
        raise PythonToolRunnerError("E_INVALID_OPERATION", "Write operation is required.")
    payload = operation.get("payload")
    if not isinstance(payload, dict):
        raise PythonToolRunnerError("E_INVALID_OPERATION", "operation.payload must be an object.")
    operation.setdefault("payload", payload)
    return operation


def _apply_write_operation(doc: dict[str, Any], operation: dict[str, Any]) -> dict[str, Any]:
    next_doc = _clone_doc(doc)
    nodes = next_doc.get("nodes")
    if not isinstance(nodes, list):
        raise PythonToolRunnerError("E_INVALID_DOCUMENT", "document.nodes must be a list.")

    target_node_id = _require_non_empty_string(
        operation.get("targetNodeId"),
        "E_INVALID_OPERATION",
        "operation.targetNodeId is required.",
    )
    target_node = None
    for node in nodes:
        if isinstance(node, dict) and node.get("id") == target_node_id:
            target_node = node
            break
    if target_node is None:
        raise PythonToolRunnerError("E_TARGET_NOT_FOUND", f"Target node not found: {target_node_id}")

    operation_type = str(operation.get("type", "")).strip()
    normalized_style = _normalize_write_operation_payload(operation)
    if operation_type in {"merge_paragraph", "split_paragraph"}:
        return _apply_structure_write_operation(next_doc, operation, normalized_style)

    style = target_node.get("style")
    if not isinstance(style, dict):
        style = {}
        target_node["style"] = style
    style.update(normalized_style)
    style["operation"] = operation_type
    return next_doc


def _normalize_write_operation_payload(operation: dict[str, Any]) -> dict[str, Any]:
    payload = operation.get("payload")
    if not isinstance(payload, dict):
        raise PythonToolRunnerError("E_INVALID_OPERATION_PAYLOAD", "operation.payload must be an object.")

    operation_type = str(operation.get("type", "")).strip()
    if operation_type == "set_font":
        font_name = _pick_non_empty_string(payload.get("font_name"), payload.get("fontName"))
        if font_name is None:
            raise PythonToolRunnerError(
                "E_INVALID_OPERATION_PAYLOAD",
                "set_font: set_font requires font_name",
            )
        return {"font_name": font_name}

    if operation_type == "set_size":
        font_size_pt = _pick_positive_number(
            payload.get("font_size_pt"),
            payload.get("fontSizePt"),
            payload.get("fontSize"),
        )
        if font_size_pt is None:
            raise PythonToolRunnerError(
                "E_INVALID_OPERATION_PAYLOAD",
                "set_size: set_size requires font_size_pt",
            )
        return {"font_size_pt": font_size_pt}

    if operation_type == "set_alignment":
        paragraph_alignment = _pick_non_empty_string(
            payload.get("paragraph_alignment"),
            payload.get("alignment"),
        )
        if paragraph_alignment is None:
            raise PythonToolRunnerError(
                "E_INVALID_OPERATION_PAYLOAD",
                "set_alignment: set_alignment requires paragraph_alignment",
            )
        return {"paragraph_alignment": paragraph_alignment}

    if operation_type == "set_font_color":
        font_color = _pick_hex_color(payload.get("font_color"), payload.get("fontColor"))
        if font_color is None:
            raise PythonToolRunnerError(
                "E_INVALID_OPERATION_PAYLOAD",
                "set_font_color: set_font_color requires font_color",
            )
        return {"font_color": font_color}

    if operation_type == "set_bold":
        return {"is_bold": _pick_required_bool(operation_type, "is_bold", payload.get("is_bold"), payload.get("isBold"))}

    if operation_type == "set_italic":
        return {
            "is_italic": _pick_required_bool(
                operation_type, "is_italic", payload.get("is_italic"), payload.get("isItalic")
            )
        }

    if operation_type == "set_underline":
        return {
            "is_underline": _pick_required_bool(
                operation_type, "is_underline", payload.get("is_underline"), payload.get("isUnderline")
            )
        }

    if operation_type == "set_strike":
        return {
            "is_strike": _pick_required_bool(
                operation_type, "is_strike", payload.get("is_strike"), payload.get("isStrike")
            )
        }

    if operation_type == "set_highlight_color":
        highlight_color = _pick_highlight_color(payload.get("highlight_color"), payload.get("highlightColor"))
        if highlight_color is None:
            raise PythonToolRunnerError(
                "E_INVALID_OPERATION_PAYLOAD",
                "set_highlight_color: set_highlight_color requires highlight_color",
            )
        return {"highlight_color": highlight_color}

    if operation_type == "set_all_caps":
        return {
            "is_all_caps": _pick_required_bool(
                operation_type, "is_all_caps", payload.get("is_all_caps"), payload.get("isAllCaps")
            )
        }

    if operation_type == "merge_paragraph":
        return {}

    if operation_type == "split_paragraph":
        split_offset = _pick_positive_integer(payload.get("split_offset"), payload.get("splitOffset"))
        if split_offset is None:
            raise PythonToolRunnerError(
                "E_INVALID_OPERATION_PAYLOAD",
                "split_paragraph: split_paragraph requires split_offset",
            )
        return {"split_offset": split_offset}

    return dict(payload)


def _read_output_docx_path(doc: dict[str, Any]) -> str | None:
    metadata = doc.get("metadata")
    if not isinstance(metadata, dict):
        return None
    output_path = metadata.get("outputDocxPath")
    if not isinstance(output_path, str) or not output_path.strip():
        return None
    return output_path.strip()


def _materialize_document(doc: dict[str, Any], *, dry_run: bool) -> dict[str, Any]:
    next_doc = _clone_doc(doc)
    output_docx_path = _read_output_docx_path(next_doc)
    if output_docx_path is None:
        raise PythonToolRunnerError(
            "E_OUTPUT_PATH_REQUIRED",
            "document.metadata.outputDocxPath is required for materialize_document.",
        )

    if dry_run:
        return {
            "doc": next_doc,
            "summary": f"Dry-run: materialize skipped for {output_docx_path}.",
            "artifacts": {"outputDocxPath": output_docx_path},
        }

    snapshot = _create_file_snapshot(output_docx_path)
    temp_dir = Path(tempfile.mkdtemp(prefix="python-tool-write-"))
    input_json_path = temp_dir / "doc-ir.json"
    try:
        write_docx_from_ir, _ = _load_docx_writer_functions()

        input_json_path.write_text(json.dumps(next_doc, ensure_ascii=False), encoding="utf-8")
        write_docx_from_ir(input_json_path, Path(output_docx_path))
    except Exception as exc:
        _restore_file_snapshot(snapshot)
        raise _classify_python_boundary_error(
            exc,
            default_code="E_DOCX_WRITE_FAILED",
            default_message=f"DOCX write failed: {exc}",
            retryable=True,
        ) from exc
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return {
        "doc": next_doc,
        "summary": f"Materialized document to {output_docx_path}.",
        "rollbackToken": _encode_rollback_token(snapshot),
        "artifacts": {"outputDocxPath": output_docx_path},
    }


def _apply_structure_write_operation(
    doc: dict[str, Any], operation: dict[str, Any], normalized_payload: dict[str, Any]
) -> dict[str, Any]:
    metadata = doc.setdefault("metadata", {})
    if not isinstance(metadata, dict):
        metadata = {}
        doc["metadata"] = metadata

    base_docx_path = _read_working_docx_path(doc) or _read_input_docx_path(doc)
    if base_docx_path is None:
        raise PythonToolRunnerError(
            "E_INPUT_PATH_REQUIRED",
            "Structural write_operation requires document.metadata.inputDocxPath.",
        )

    working_docx_path = _prepare_working_docx(doc, Path(base_docx_path))
    operation_with_payload = dict(operation)
    operation_with_payload["payload"] = normalized_payload

    try:
        _, apply_structure_operation = _load_docx_writer_functions()

        apply_structure_operation(working_docx_path, operation_with_payload)
    except Exception as exc:
        raise _classify_python_boundary_error(
            exc,
            default_code="E_DOCX_STRUCTURE_WRITE_FAILED",
            default_message=f"Failed to apply {operation.get('type')} to DOCX: {exc}",
            retryable=False,
        ) from exc

    state = _parse_docx_state(working_docx_path)
    doc["nodes"] = _document_state_to_nodes(state)
    metadata["workingDocxPath"] = str(working_docx_path)
    metadata["docxObservation"] = state
    return doc


def _prepare_working_docx(doc: dict[str, Any], base_docx_path: Path) -> Path:
    working_path = _read_working_docx_path(doc)
    if working_path:
        target_path = Path(working_path)
    else:
        working_dir = Path(tempfile.mkdtemp(prefix="python-tool-working-docx-"))
        target_path = working_dir / "working.docx"

    temp_dir = Path(tempfile.mkdtemp(prefix="python-tool-doc-ir-"))
    input_json_path = temp_dir / "doc-ir.json"
    try:
        write_docx_from_ir, _ = _load_docx_writer_functions()

        payload = _clone_doc(doc)
        payload_metadata = payload.setdefault("metadata", {})
        if not isinstance(payload_metadata, dict):
            payload_metadata = {}
            payload["metadata"] = payload_metadata
        payload_metadata["workingDocxPath"] = str(base_docx_path)
        input_json_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        write_docx_from_ir(input_json_path, target_path)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return target_path


def _document_state_to_nodes(state: dict[str, Any]) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []

    def visit_paragraph(paragraph: dict[str, Any]) -> None:
        for child in paragraph.get("children", []):
            if not isinstance(child, dict) or child.get("node_type") != "text_run":
                continue
            node_id = child.get("id")
            content = child.get("content")
            if not isinstance(node_id, str) or not node_id.strip():
                continue
            if not isinstance(content, str) or not content.strip():
                continue
            style = child.get("style")
            node: dict[str, Any] = {"id": node_id.strip(), "text": content.strip()}
            if isinstance(style, dict):
                node["style"] = dict(style)
            nodes.append(node)

    def visit_table(table: dict[str, Any]) -> None:
        for row in table.get("rows", []):
            if not isinstance(row, dict):
                continue
            for cell in row.get("cells", []):
                if not isinstance(cell, dict):
                    continue
                for paragraph in cell.get("paragraphs", []):
                    if isinstance(paragraph, dict):
                        visit_paragraph(paragraph)
                for nested in cell.get("tables", []):
                    if isinstance(nested, dict):
                        visit_table(nested)

    for item in state.get("nodes", []):
        if not isinstance(item, dict):
            continue
        if item.get("node_type") == "paragraph":
            visit_paragraph(item)
        elif item.get("node_type") == "table":
            visit_table(item)

    return nodes


def _read_input_docx_path(doc: dict[str, Any]) -> str | None:
    metadata = doc.get("metadata")
    if not isinstance(metadata, dict):
        return None
    input_path = metadata.get("inputDocxPath")
    if not isinstance(input_path, str) or not input_path.strip():
        return None
    return input_path.strip()


def _read_working_docx_path(doc: dict[str, Any]) -> str | None:
    metadata = doc.get("metadata")
    if not isinstance(metadata, dict):
        return None
    working_path = metadata.get("workingDocxPath")
    if not isinstance(working_path, str) or not working_path.strip():
        return None
    return working_path.strip()


def _create_file_snapshot(output_docx_path: str) -> _OutputFileSnapshot:
    output_path = Path(output_docx_path)
    if output_path.exists():
        backup_dir = Path(tempfile.mkdtemp(prefix="python-tool-backup-"))
        backup_path = backup_dir / "backup.docx"
        shutil.copyfile(output_path, backup_path)
        return _OutputFileSnapshot(
            output_docx_path=output_docx_path,
            existed_before=True,
            backup_path=str(backup_path),
            backup_dir=str(backup_dir),
        )
    return _OutputFileSnapshot(output_docx_path=output_docx_path, existed_before=False)


def _restore_file_snapshot(snapshot: _OutputFileSnapshot) -> None:
    output_path = Path(snapshot.output_docx_path)
    if snapshot.existed_before:
        if snapshot.backup_path:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(snapshot.backup_path, output_path)
    elif output_path.exists():
        output_path.unlink()

    if snapshot.backup_dir:
        shutil.rmtree(snapshot.backup_dir, ignore_errors=True)


def _encode_rollback_token(snapshot: _OutputFileSnapshot) -> str:
    encoded = base64.urlsafe_b64encode(
        json.dumps(snapshot.to_dict(), ensure_ascii=False).encode("utf-8")
    ).decode("ascii")
    return f"rb_file:{encoded.rstrip('=')}"


def _decode_rollback_token(token: str) -> _OutputFileSnapshot | None:
    if not token.startswith("rb_file:"):
        return None
    encoded = token[len("rb_file:") :]
    padding = "=" * (-len(encoded) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode((encoded + padding).encode("ascii")).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    output_docx_path = payload.get("outputDocxPath")
    existed_before = payload.get("existedBefore")
    if not isinstance(output_docx_path, str) or not isinstance(existed_before, bool):
        return None
    return _OutputFileSnapshot(
        output_docx_path=output_docx_path,
        existed_before=existed_before,
        backup_path=payload.get("backupPath") if isinstance(payload.get("backupPath"), str) else None,
        backup_dir=payload.get("backupDir") if isinstance(payload.get("backupDir"), str) else None,
    )


def _parse_docx_state(
    docx_path: str | Path,
    *,
    media_dir: str | Path = AGENT_MEDIA_DIR,
    output_json_path: str | Path | None = None,
) -> dict[str, Any]:
    try:
        from src.python.tools.docx_observation_tool import parse_docx_to_state

        return parse_docx_to_state(
            docx_path,
            media_dir=media_dir,
            output_json_path=output_json_path,
        )
    except Exception as exc:
        raise _classify_python_boundary_error(
            exc,
            default_code="E_PYTHON_IMPORT_FAILED",
            default_message=f"Failed to load DOCX observation parser: {exc}",
            retryable=False,
        ) from exc


def _load_docx_writer_functions() -> tuple[Callable[..., Any], Callable[..., Any]]:
    try:
        from scripts.write_docx_from_ir import apply_structure_operation, write_docx_from_ir

        return write_docx_from_ir, apply_structure_operation
    except Exception as exc:
        raise _classify_python_boundary_error(
            exc,
            default_code="E_PYTHON_IMPORT_FAILED",
            default_message=f"Failed to load DOCX writer helpers: {exc}",
            retryable=False,
        ) from exc


def _classify_python_boundary_error(
    exc: Exception,
    *,
    default_code: str,
    default_message: str,
    retryable: bool,
) -> PythonToolRunnerError:
    dependency_message = _dependency_error_message(exc)
    if dependency_message is not None:
        return PythonToolRunnerError(
            "E_PYTHON_DEPENDENCY_MISSING",
            dependency_message,
            retryable=False,
            cause=exc,
        )
    if isinstance(exc, PythonToolRunnerError):
        return exc
    return PythonToolRunnerError(default_code, default_message, retryable=retryable, cause=exc)


def _dependency_error_message(exc: BaseException) -> str | None:
    message = str(exc)
    lowered = message.lower()
    if isinstance(exc, ModuleNotFoundError):
        missing_name = getattr(exc, "name", None)
        if missing_name == "docx" or "no module named 'docx'" in lowered:
            return "python-docx is required for Python DOCX tools."
        if missing_name == "lxml" or "no module named 'lxml'" in lowered:
            return "lxml is required for Python DOCX tools."
    if "python-docx is required" in lowered or "no module named 'docx'" in lowered:
        return "python-docx is required for Python DOCX tools."
    if "lxml is required" in lowered or "no module named 'lxml'" in lowered:
        return "lxml is required for Python DOCX tools."
    return None


def run_tool_cli(input_json_path: str, output_json_path: str) -> int:
    input_path = Path(input_json_path)
    output_path = Path(output_json_path)
    try:
        request = json.loads(input_path.read_text(encoding="utf-8"))
        result = execute_tool_request(request)
        output = {"ok": True, "result": result}
        output_path.write_text(f"{json.dumps(output, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
        return 0
    except PythonToolRunnerError as exc:
        output = {"ok": False, "error": exc.to_dict()}
        output_path.write_text(f"{json.dumps(output, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
        return 1
    except Exception as exc:  # pragma: no cover - defensive
        output = {
            "ok": False,
            "error": {
                "code": "E_PYTHON_TOOL_FAILED",
                "message": str(exc),
                "retryable": False,
            },
        }
        output_path.write_text(f"{json.dumps(output, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Python-backed tools for the TypeScript runtime.")
    parser.add_argument("--input-json", required=True, help="Path to request JSON")
    parser.add_argument("--output-json", required=True, help="Path to response JSON")
    args = parser.parse_args()
    return run_tool_cli(args.input_json, args.output_json)


def _clone_doc(raw_doc: Any) -> dict[str, Any]:
    if not isinstance(raw_doc, dict):
        raise PythonToolRunnerError("E_INVALID_DOCUMENT", "tool input.doc must be an object.")
    return copy.deepcopy(raw_doc)


def _require_non_empty_string(value: Any, code: str, message: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PythonToolRunnerError(code, message)
    return value.strip()


def _pick_non_empty_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _pick_positive_number(*values: Any) -> float | None:
    for value in values:
        if isinstance(value, (int, float)) and float(value) > 0:
            return float(value)
        if isinstance(value, str) and value.strip():
            try:
                parsed = float(value)
            except ValueError:
                continue
            if parsed > 0:
                return parsed
    return None


def _pick_positive_integer(*values: Any) -> int | None:
    for value in values:
        number = _pick_positive_number(value)
        if number is None:
            continue
        if float(number).is_integer():
            return int(number)
    return None


def _pick_hex_color(*values: Any) -> str | None:
    for value in values:
        if not isinstance(value, str):
            continue
        normalized = value.strip().lstrip("#")
        if len(normalized) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in normalized):
            return normalized.upper()
    return None


def _pick_required_bool(operation_type: str, field_name: str, *values: Any) -> bool:
    for value in values:
        if isinstance(value, bool):
            return value
    raise PythonToolRunnerError(
        "E_INVALID_OPERATION_PAYLOAD",
        f"{operation_type}: {operation_type} requires {field_name}",
    )


def _pick_highlight_color(*values: Any) -> str | None:
    alias_map = {
        "yellow": "yellow",
        "#ffff00": "yellow",
        "ffff00": "yellow",
        "green": "green",
        "#00ff00": "green",
        "00ff00": "green",
        "cyan": "cyan",
        "#00ffff": "cyan",
        "00ffff": "cyan",
        "magenta": "magenta",
        "#ff00ff": "magenta",
        "ff00ff": "magenta",
        "blue": "blue",
        "#0000ff": "blue",
        "0000ff": "blue",
        "red": "red",
        "#ff0000": "red",
        "ff0000": "red",
        "darkblue": "darkBlue",
        "#000080": "darkBlue",
        "000080": "darkBlue",
        "darkcyan": "darkCyan",
        "#008080": "darkCyan",
        "008080": "darkCyan",
        "darkgreen": "darkGreen",
        "#008000": "darkGreen",
        "008000": "darkGreen",
        "darkmagenta": "darkMagenta",
        "#800080": "darkMagenta",
        "800080": "darkMagenta",
        "darkred": "darkRed",
        "#800000": "darkRed",
        "800000": "darkRed",
        "darkyellow": "darkYellow",
        "#808000": "darkYellow",
        "808000": "darkYellow",
        "darkgray": "darkGray",
        "#808080": "darkGray",
        "808080": "darkGray",
        "lightgray": "lightGray",
        "#c0c0c0": "lightGray",
        "c0c0c0": "lightGray",
        "black": "black",
        "#000000": "black",
        "000000": "black",
        "none": "none",
    }
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        mapped = alias_map.get(value.strip().replace(" ", "").lower())
        if mapped is not None:
            return mapped
    return None


__all__ = [
    "PythonToolRunnerError",
    "execute_tool_request",
    "run_tool_cli",
]


if __name__ == "__main__":
    raise SystemExit(main())
