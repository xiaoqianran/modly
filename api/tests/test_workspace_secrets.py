"""Secret.from_name must not get create_if_missing; missing secret must not block deploy."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "workspace_secrets",
    ROOT / "modal" / "workspace_secrets.py",
)
assert SPEC and SPEC.loader
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class _Handle:
    def __init__(self, name: str, **kwargs):
        self.name = name
        self.kwargs = kwargs
        self.hydrated = False

    def hydrate(self) -> None:
        self.hydrated = True


class WorkspaceSecretTests(unittest.TestCase):
    def test_current_sdk_from_name_has_no_create_if_missing(self) -> None:
        calls: list[dict] = []

        def from_name(name: str, **kwargs):
            calls.append({"name": name, **kwargs})
            return SimpleNamespace()  # no hydrate → do not attach (secret may be missing)

        secret_cls = SimpleNamespace(from_name=from_name)
        self.assertEqual(mod.workspace_token_secrets(secret_cls, environ={}), [])
        self.assertEqual(calls, [{"name": "modly-tokens"}])

    def test_objects_create_stub_then_lookup(self) -> None:
        created: list[tuple] = []

        def from_name(name: str, **kwargs):
            return _Handle(name, **kwargs)

        def create(name: str, env_dict: dict, **kwargs):
            created.append((name, env_dict, kwargs))

        secret_cls = SimpleNamespace(
            from_name=from_name,
            objects=SimpleNamespace(create=create),
        )
        attached = mod.workspace_token_secrets(secret_cls, environ={})
        self.assertEqual(len(attached), 1)
        self.assertEqual(attached[0].name, "modly-tokens")
        self.assertNotIn("create_if_missing", attached[0].kwargs)
        self.assertEqual(created[0][0], "modly-tokens")
        self.assertEqual(created[0][2].get("allow_existing"), True)

    def test_future_sdk_may_pass_create_if_missing(self) -> None:
        def from_name(name: str, *, create_if_missing: bool = False, environment_name=None):
            return _Handle(name, create_if_missing=create_if_missing)

        attached = mod.workspace_token_secrets(SimpleNamespace(from_name=from_name), environ={})
        self.assertEqual(attached[0].kwargs["create_if_missing"], True)

    def test_local_hf_env_uses_from_dict(self) -> None:
        def from_name(name: str, **kwargs):
            return None

        def from_dict(values: dict):
            return ("from_dict", values)

        secret_cls = SimpleNamespace(from_name=from_name, from_dict=from_dict)
        attached = mod.workspace_token_secrets(
            secret_cls,
            environ={"HF_TOKEN": "hf-example", "PATH": "/bin"},
        )
        self.assertEqual(attached, [("from_dict", {"HF_TOKEN": "hf-example"})])

    def test_app_py_does_not_pass_create_if_missing_to_secret(self) -> None:
        app_py = (ROOT / "modal" / "app.py").read_text(encoding="utf-8")
        self.assertNotIn('Secret.from_name("modly-tokens", create_if_missing', app_py)
        self.assertIn("workspace_token_secrets", app_py)
        self.assertIn("secrets=TOKEN_SECRETS", app_py)
        self.assertIn('Volume.from_name("modly-models", create_if_missing=True)', app_py)
