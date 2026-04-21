from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..core.project_paths import AGENT_MEDIA_DIR
from ..core.universal_docx_parser import UniversalDocxParser


def parse_docx_to_state(
    docx_path: str | Path,
    *,
    media_dir: str | Path = AGENT_MEDIA_DIR,
    output_json_path: str | Path | None = None,
) -> dict[str, Any]:
    """
    Parse .docx into standardized document_state JSON.

    - docx_path: input .docx file path
    - media_dir: image extraction directory
    - output_json_path: optional json file output path
    """
    parser = UniversalDocxParser(media_dir=media_dir)
    state = parser.parse(docx_path)

    if output_json_path is not None:
        output_path = Path(output_json_path).resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(state, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    return state


__all__ = ["parse_docx_to_state"]
