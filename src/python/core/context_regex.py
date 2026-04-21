from __future__ import annotations

import re


class ContextRegexProcessor:
    _ZERO_WIDTH_PATTERN = re.compile(r"[\u200b-\u200f\ufeff]")
    _CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
    _TRAILING_WHITESPACE_PATTERN = re.compile(r"[ \t]+$", re.MULTILINE)
    _EXCESS_BLANK_LINES_PATTERN = re.compile(r"\n{3,}")
    _CHATML_START = "<|im_start|>"
    _CHATML_END = "<|im_end|>"

    def preprocess_user_input(self, text: str) -> str:
        return self._normalize_text(text)

    def postprocess_assistant_output(self, text: str) -> str:
        normalized = self._normalize_text(text)
        if self._CHATML_START not in normalized:
            return normalized

        # Some local OpenAI-compatible backends may leak ChatML transcript in output.
        # Keep the natural-language prefix when present; otherwise extract assistant block.
        start_index = normalized.find(self._CHATML_START)
        prefix = normalized[:start_index].strip()
        if prefix:
            return self._normalize_text(prefix)

        blocks = self._parse_chatml_blocks(normalized)
        assistant_contents = [
            content for role, content, _closed in blocks if role == "assistant" and content
        ]
        if assistant_contents:
            return self._normalize_text(assistant_contents[-1])

        fallback = normalized.replace(self._CHATML_START, "").replace(self._CHATML_END, "")
        return self._normalize_text(fallback)

    def convert_chatml_to_markdown_xml(self, text: str) -> str:
        normalized = self._normalize_text(text)
        blocks = self._parse_chatml_blocks(normalized)
        if not blocks:
            return normalized

        lines: list[str] = []
        assistant_open_needed = False

        system_contents = [content for role, content, closed in blocks if role == "system" and closed]
        if system_contents:
            lines.append("## System")
            for content in system_contents:
                lines.append("<system>")
                lines.append(content)
                lines.append("</system>")
                lines.append("")

        convo_blocks = [
            (role, content, closed)
            for role, content, closed in blocks
            if role in {"user", "assistant"}
        ]
        if convo_blocks:
            lines.append("## Conversation")
            for role, content, closed in convo_blocks:
                if role == "assistant" and not closed:
                    assistant_open_needed = True
                    continue
                lines.append(f"<{role}>")
                lines.append(content)
                lines.append(f"</{role}>")
                lines.append("")

        if assistant_open_needed:
            lines.append("## Assistant")
            lines.append("<assistant>")

        result = "\n".join(lines).strip()
        return result if result else normalized

    def _normalize_text(self, text: str) -> str:
        normalized = str(text).replace("\r\n", "\n").replace("\r", "\n")
        normalized = self._ZERO_WIDTH_PATTERN.sub("", normalized)
        normalized = self._CONTROL_PATTERN.sub("", normalized)
        normalized = self._TRAILING_WHITESPACE_PATTERN.sub("", normalized)
        normalized = self._EXCESS_BLANK_LINES_PATTERN.sub("\n\n", normalized)
        return normalized.strip()

    def _parse_chatml_blocks(self, text: str) -> list[tuple[str, str, bool]]:
        blocks: list[tuple[str, str, bool]] = []
        index = 0
        text_len = len(text)

        while index < text_len:
            start = text.find(self._CHATML_START, index)
            if start < 0:
                break

            role_start = start + len(self._CHATML_START)
            role_end = text.find("\n", role_start)
            if role_end < 0:
                break

            role = text[role_start:role_end].strip()
            if not role:
                break

            content_start = role_end + 1
            end = text.find(self._CHATML_END, content_start)
            if end < 0:
                content = text[content_start:].strip()
                blocks.append((role, content, False))
                break

            content = text[content_start:end].strip()
            blocks.append((role, content, True))
            index = end + len(self._CHATML_END)
            if index < text_len and text[index] == "\n":
                index += 1

        return blocks
