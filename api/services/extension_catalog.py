"""List model-extension manifests from EXTENSIONS_DIR.

Used by GET /extensions/catalog so a remote Electron client can populate
the Models page without scanning a local extensions folder.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional


def list_model_extension_manifests(extensions_dir: Optional[Path]) -> list[dict]:
    if extensions_dir is None or not extensions_dir.exists():
        return []

    result: list[dict] = []
    for ext_dir in sorted(extensions_dir.iterdir()):
        if not ext_dir.is_dir() or ext_dir.name.startswith("."):
            continue
        if (ext_dir / ".modly-incomplete").exists():
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
        result.append(manifest)
    return result
