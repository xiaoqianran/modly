"""Shared upstream files stay Modal-free. Overlay lives in new modules.

No FastAPI TestClient. Reads source so a future merge cannot put catalog /
bearer / modal.Dict back into files that also exist on lightningpixel/modly.
"""

from __future__ import annotations

import unittest
from pathlib import Path

API = Path(__file__).resolve().parents[1]


def read(*parts: str) -> str:
    return (API.joinpath(*parts)).read_text(encoding="utf-8")


class ThinForkContractTests(unittest.TestCase):
    def test_settings_and_extensions_routers_match_upstream_surface(self) -> None:
        settings = read("routers", "settings.py")
        extensions = read("routers", "extensions.py")
        self.assertNotIn("/modal", settings)
        self.assertNotIn("modal_prefs", settings)
        self.assertNotIn("catalog", extensions)
        self.assertNotIn("install-from-github", extensions)
        self.assertNotIn("modal_runtime", extensions)
        self.assertIn("/reload", extensions)
        self.assertIn("/setup/{ext_id}", extensions)

    def test_optimize_has_no_upload_import(self) -> None:
        optimize = read("routers", "optimize.py")
        self.assertNotIn('/import"', optimize)
        self.assertIn("/import-by-path", optimize)

    def test_model_router_has_no_delete_and_no_modal_runtime(self) -> None:
        model = read("routers", "model.py")
        self.assertNotIn("/delete/", model)
        self.assertNotIn("modal_runtime", model)
        self.assertIn("overlay_hooks", model)
        self.assertIn("after_hf_download", model)

    def test_generation_and_workflow_only_import_the_overlay_facade(self) -> None:
        generation = read("routers", "generation.py")
        workflow = read("routers", "workflow_runs.py")
        for src in (generation, workflow):
            self.assertIn("services.generation_overlay", src)
            self.assertNotIn("modal_runtime", src)
            self.assertNotIn("run_tracker", src)
            self.assertNotIn("job_store", src)
            self.assertIn("dispatch_from_image", src)

    def test_main_is_a_two_line_mount(self) -> None:
        main = read("main.py")
        self.assertIn("from overlay_asgi import mount_overlay", main)
        self.assertIn("mount_overlay(app)", main)
        self.assertNotIn("desktop_ipc", main)
        self.assertNotIn("MODLY_API_TOKEN", main)
        self.assertNotIn("optional_bearer", main)

    def test_overlay_http_owns_the_moved_routes(self) -> None:
        overlay = read("routers", "overlay_http.py")
        self.assertIn("list_extension_catalog", overlay)
        for path in (
            "/settings/modal",
            "/extensions/catalog",
            "/extensions/install-from-github",
            "/extensions/uninstall",
            "/extensions/repair",
            "/model/delete/",
            "/optimize/import",
        ):
            self.assertIn(path, overlay)

    def test_mount_overlay_registers_bearer_and_extra_routers(self) -> None:
        asgi = read("overlay_asgi.py")
        self.assertIn("def mount_overlay", asgi)
        self.assertIn("optional_bearer", asgi)
        self.assertIn("desktop_ipc", asgi)
        self.assertIn("overlay_router", asgi)


class OverlayHookTests(unittest.TestCase):
    def test_after_hf_download_commits_models_volume(self) -> None:
        from unittest.mock import patch

        from services.overlay_hooks import after_hf_download

        with patch("services.modal_runtime.commit_volume") as commit:
            after_hf_download()
        commit.assert_called_once_with("modly-models")
