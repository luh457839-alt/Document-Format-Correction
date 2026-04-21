from __future__ import annotations

import argparse
import json
from pathlib import Path

from src.python.core.project_paths import AGENT_MEDIA_DIR
from src.python.tools.docx_observation_tool import parse_docx_to_state


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Parse .docx into standardized document_state JSON."
    )
    parser.add_argument("--input", required=True, help="Input .docx file path")
    parser.add_argument(
        "--media-dir",
        default=str(AGENT_MEDIA_DIR),
        help="Directory to extract images",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Optional output JSON path. Empty means print to stdout only.",
    )
    args = parser.parse_args()

    state = parse_docx_to_state(
        docx_path=Path(args.input),
        media_dir=Path(args.media_dir),
        output_json_path=Path(args.output) if args.output else None,
    )

    if not args.output:
        print(json.dumps(state, ensure_ascii=False, indent=2))
    else:
        print(f"Parsed: {args.input}")
        print(f"JSON: {Path(args.output).resolve()}")
        print(f"Media: {Path(args.media_dir).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
