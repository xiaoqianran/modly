"""Laptop helper: parse `modal token set` without echoing secrets."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "parse_modal_token_line",
    ROOT / "scripts" / "parse_modal_token_line.py",
)
assert SPEC and SPEC.loader
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class ParseModalTokenLineTests(unittest.TestCase):
    def test_official_cli_line(self) -> None:
        self.assertEqual(
            mod.parse_modal_token_line(
                "modal token set --token-id ak-EXAMPLE --token-secret as-EXAMPLE",
            ),
            ("ak-EXAMPLE", "as-EXAMPLE"),
        )

    def test_equals_and_quotes(self) -> None:
        self.assertEqual(
            mod.parse_modal_token_line(
                'modal token set --token-id="ak-QUOTED" --token-secret=\'as-QUOTED\'',
            ),
            ("ak-QUOTED", "as-QUOTED"),
        )

    def test_empty_is_none(self) -> None:
        self.assertIsNone(mod.parse_modal_token_line(""))
        self.assertIsNone(mod.parse_modal_token_line("modal token set"))
