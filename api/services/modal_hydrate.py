"""Walk extension manifests and list HuggingFace snapshot targets.

Used by the CPU hydrate function so weight downloads never sit on a GPU.
Does not import `modal`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def hf_targets_from_extensions(ext_root: Path, models_root: Path) -> list[dict[str, Any]]:
    """Return snapshot_download jobs, including folders still marked incomplete."""
    if not ext_root.exists():
        return []
    targets: list[dict[str, Any]] = []
    for ext_dir in sorted(ext_root.iterdir()):
        if not ext_dir.is_dir() or ext_dir.name.startswith("."):
            continue
        manifest_path = ext_dir / "manifest.json"
        if not manifest_path.exists():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(manifest, dict):
            continue
        if manifest.get("type", "model") != "model":
            continue
        ext_id = str(manifest.get("id") or ext_dir.name)
        nodes = [n for n in manifest.get("nodes", []) if isinstance(n, dict) and n.get("id")]
        if nodes:
            for node in nodes:
                model_id = f"{ext_id}/{node['id']}"
                hf_repo = str(node.get("hf_repo") or manifest.get("hf_repo") or "")
                if not hf_repo:
                    continue
                skip = node.get("hf_skip_prefixes") or manifest.get("hf_skip_prefixes") or []
                targets.append(
                    {
                        "model_id": model_id,
                        "hf_repo": hf_repo,
                        "dest": str(models_root / model_id),
                        "hf_skip_prefixes": list(skip) if isinstance(skip, list) else [],
                    }
                )
        else:
            hf_repo = str(manifest.get("hf_repo") or "")
            if not hf_repo:
                continue
            skip = manifest.get("hf_skip_prefixes") or []
            targets.append(
                {
                    "model_id": ext_id,
                    "hf_repo": hf_repo,
                    "dest": str(models_root / ext_id),
                    "hf_skip_prefixes": list(skip) if isinstance(skip, list) else [],
                }
            )
    return targets


SNAPSHOT_IGNORE = ["*.md", "LICENSE", "NOTICE", "Notice.txt", ".gitattributes"]
