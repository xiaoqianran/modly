"""Parse a `modal token set` line into env assignments.

Reads MODAL_TOKEN_LINE, then argv, then stdin. Prints:

    MODAL_TOKEN_ID=ak-...
    MODAL_TOKEN_SECRET=as-...

Never logs the values. Exit 2 if the pair is missing.
"""

from __future__ import annotations

import os
import re
import sys

_ID = re.compile(r"\b(ak-[A-Za-z0-9_-]+)")
_SECRET = re.compile(r"\b(as-[A-Za-z0-9_-]+)")
_FLAG_ID = re.compile(r"""--token-id(?:\s*=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))""", re.I)
_FLAG_SECRET = re.compile(r"""--token-secret(?:\s*=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))""", re.I)


def _group(match: re.Match[str] | None) -> str:
    if not match:
        return ""
    return (match.group(1) or match.group(2) or match.group(3) or "").strip()


def parse_modal_token_line(text: str) -> tuple[str, str] | None:
    raw = (text or "").replace("\r", "\n").strip()
    if not raw:
        return None
    flag_id = _group(_FLAG_ID.search(raw))
    flag_secret = _group(_FLAG_SECRET.search(raw))
    token_id = (_ID.search(flag_id) or _ID.search(raw))
    token_secret = (_SECRET.search(flag_secret) or _SECRET.search(raw))
    if not token_id or not token_secret:
        return None
    return token_id.group(1), token_secret.group(1)


def _input_text() -> str:
    env = os.environ.get("MODAL_TOKEN_LINE", "").strip()
    if env:
        return env
    if len(sys.argv) > 1:
        return " ".join(sys.argv[1:])
    return sys.stdin.read()


def main() -> int:
    parsed = parse_modal_token_line(_input_text())
    if not parsed:
        return 2
    token_id, token_secret = parsed
    sys.stdout.write(f"MODAL_TOKEN_ID={token_id}\n")
    sys.stdout.write(f"MODAL_TOKEN_SECRET={token_secret}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
