import unittest

from services.desktop_ipc_policy import (
    desktop_ipc_fallback_body,
    desktop_ipc_kind,
    is_desktop_ipc_fallback,
)


class DesktopIpcPolicyTests(unittest.TestCase):
    def test_known_aliases(self) -> None:
        self.assertEqual(desktop_ipc_kind("model:isDownloaded"), "model-is-downloaded")
        self.assertEqual(desktop_ipc_kind("model:listDownloaded"), "model-list-downloaded")

    def test_unknown_model_channel_is_fallback_so_electron_needs_no_patch(self) -> None:
        body = desktop_ipc_fallback_body("model:futureChecksum")
        self.assertTrue(is_desktop_ipc_fallback(body))
        self.assertIn("model:futureChecksum", body["detail"])
        self.assertEqual(desktop_ipc_kind("model:futureChecksum"), "fallback")

    def test_unknown_extensions_channel_is_fallback(self) -> None:
        body = desktop_ipc_fallback_body("extensions:futurePin")
        self.assertTrue(body["fallback"])
        self.assertIn("Electron does not need a patch", body["detail"])

    def test_unrelated_channel_still_fallback(self) -> None:
        body = desktop_ipc_fallback_body("brand-new-area:foo")
        self.assertTrue(body["fallback"])
        self.assertIn("Unhandled channel", body["detail"])
