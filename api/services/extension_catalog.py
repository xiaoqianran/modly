"""List model-extension manifests from EXTENSIONS_DIR.

Used by GET /extensions/catalog so a remote Electron client can populate
the Models page without scanning a local extensions folder.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from services.official_extension_stubs import (
    merge_official_catalog_stubs,
    official_extension_ids,
)


def list_model_extension_manifests(
    extensions_dir: Optional[Path],
    *,
    include_incomplete_official: bool = False,
) -> list[dict]:
    if extensions_dir is None or not extensions_dir.exists():
        return []

    official_ids = official_extension_ids()
    result: list[dict] = []
    for ext_dir in sorted(extensions_dir.iterdir()):
        if not ext_dir.is_dir() or ext_dir.name.startswith("."):
            continue
        incomplete = (ext_dir / ".modly-incomplete").exists()
        if incomplete and not include_incomplete_official:
            continue
        manifest_path = ext_dir / "manifest.json"
        if not manifest_path.exists():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(manifest, dict):
            continue
        if manifest.get("type", "model") != "model":
            continue
        if not manifest.get("id"):
            manifest["id"] = ext_dir.name
        ext_id = str(manifest["id"])
        if incomplete and ext_id not in official_ids and ext_dir.name not in official_ids:
            continue
        result.append(manifest)
    return result


def list_extension_catalog(extensions_dir: Optional[Path]) -> list[dict]:
    """Catalog the desktop merge expects: disk + official stubs if Volume is empty.

    Incomplete official clones are included so a CPU hydrate that has not
    finished setup.py still advertises hunyuan3d-mini/generate. Missing
    official ids are filled from stubs. Hydrate is spawned at most once
    per container and never blocks this GET.
    """
    listed = list_model_extension_manifests(
        extensions_dir,
        include_incomplete_official=True,
    )
    _maybe_request_official_hydrate(listed)
    return merge_official_catalog_stubs(listed)


def _maybe_request_official_hydrate(listed: list[dict]) -> None:
    present = {item.get("id") for item in listed}
    if official_extension_ids().issubset(present):
        return
    from services.modal_runtime import spawn_hydrate_official_extensions

    spawn_hydrate_official_extensions()
