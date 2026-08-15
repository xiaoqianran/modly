"""Install a model extension from a GitHub tarball into EXTENSIONS_DIR."""

from __future__ import annotations

import io
import json
import shutil
import tarfile
import tempfile
from pathlib import Path
from typing import Optional
from urllib.request import Request, urlopen


def parse_github_repo(url: str) -> tuple[str, str]:
    from urllib.parse import urlparse

    parsed = urlparse(url.strip())
    if parsed.hostname != "github.com":
        raise ValueError("URL must be a github.com repository")
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2:
        raise ValueError("Expected https://github.com/owner/repo")
    return parts[0], parts[1].removesuffix(".git")


def download_github_tarball(owner: str, repo: str) -> bytes:
    import os

    url = f"https://api.github.com/repos/{owner}/{repo}/tarball/HEAD"
    headers = {"Accept": "application/vnd.github.v3+json", "User-Agent": "modly"}
    token = (os.environ.get("GITHUB_TOKEN") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = Request(url, headers=headers)
    with urlopen(req, timeout=120) as resp:
        return resp.read()


def extract_extension(tarball: bytes, dest_dir: Path, source_url: str) -> str:
    dest_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="modly-ext-") as raw:
        tmp = Path(raw)
        with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as tar:
            try:
                tar.extractall(tmp, filter="data")
            except TypeError:
                tar.extractall(tmp)
        children = [p for p in tmp.iterdir() if p.is_dir()]
        root = children[0] if children else tmp
        manifest_path = root / "manifest.json"
        if not manifest_path.exists():
            raise ValueError("manifest.json missing from repository")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise ValueError("invalid manifest.json")
        if manifest.get("type", "model") != "model":
            raise ValueError("Only model extensions can be installed on the remote backend")
        ext_id = str(manifest.get("id") or dest_dir.name)
        if not ext_id or ext_id.startswith(".") or "/" in ext_id or "\\" in ext_id:
            raise ValueError("invalid extension id")
        manifest["id"] = ext_id
        manifest["source"] = source_url
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        target = dest_dir / ext_id
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(root, target)
        (target / ".modly-incomplete").write_text("installing", encoding="utf-8")
        return ext_id


def clear_incomplete(dest_dir: Path, ext_id: str) -> None:
    marker = dest_dir / ext_id / ".modly-incomplete"
    if marker.exists():
        marker.unlink()


def remove_extension(dest_dir: Optional[Path], ext_id: str) -> None:
    if dest_dir is None:
        return
    target = (dest_dir / ext_id).resolve()
    root = dest_dir.resolve()
    if target != root and root not in target.parents:
        raise ValueError("invalid extension id")
    if target.exists():
        shutil.rmtree(target)
