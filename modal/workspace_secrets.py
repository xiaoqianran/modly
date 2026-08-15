"""Optional Modal workspace secret for HF / GitHub tokens.

`modal.Volume.from_name` and `modal.Dict.from_name` accept
`create_if_missing=True`. `modal.Secret.from_name` does **not** — passing
that kwarg raises TypeError on current Modal clients and aborts deploy
before the empty CPU shell is registered.

First Connect / `python -m modal deploy` must succeed without a dashboard
secret. If `modly-tokens` already exists (or we can create a stub), attach
it so later HF_TOKEN / GITHUB_TOKEN edits apply. Local env values present
at deploy time are also passed through `Secret.from_dict`.
"""

from __future__ import annotations

import inspect
import os
from typing import Any

SECRET_NAME = "modly-tokens"
LOCAL_ENV_KEYS = ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "GITHUB_TOKEN")
STUB_KEY = "MODLY_TOKENS"


def _signature_params(fn: Any) -> set[str]:
    try:
        return set(inspect.signature(fn).parameters)
    except (TypeError, ValueError):
        return set()


def _from_name(secret_cls: Any, **kwargs: Any) -> Any:
    return secret_cls.from_name(SECRET_NAME, **kwargs)


def _ensure_named_secret(secret_cls: Any) -> Any | None:
    from_name = getattr(secret_cls, "from_name", None)
    if not callable(from_name):
        return None

    if "create_if_missing" in _signature_params(from_name):
        return _from_name(secret_cls, create_if_missing=True)

    objects = getattr(secret_cls, "objects", None)
    create = getattr(objects, "create", None) if objects is not None else None
    if callable(create):
        created = False
        try:
            create(SECRET_NAME, {STUB_KEY: "1"}, allow_existing=True)
            created = True
        except TypeError:
            try:
                create(SECRET_NAME, {STUB_KEY: "1"})
                created = True
            except Exception:
                created = False
        except Exception:
            created = False
        if created:
            return _from_name(secret_cls)
        # Secret may already exist; still try a lookup.
        try:
            return _from_name(secret_cls)
        except Exception:
            return None

    try:
        handle = _from_name(secret_cls)
    except TypeError:
        return None
    hydrate = getattr(handle, "hydrate", None)
    if callable(hydrate):
        try:
            hydrate()
            return handle
        except Exception:
            return None
    # Cannot prove the named secret exists. Do not attach it — a missing
    # Secret.from_name handle fails `modal deploy` with Secret not found.
    return None


def _local_env_secret(secret_cls: Any, environ: dict[str, str] | None) -> Any | None:
    env = environ if environ is not None else os.environ
    values = {key: env[key] for key in LOCAL_ENV_KEYS if env.get(key)}
    if not values:
        return None
    from_dict = getattr(secret_cls, "from_dict", None)
    if not callable(from_dict):
        return None
    return from_dict(values)


def workspace_token_secrets(secret_cls: Any, environ: dict[str, str] | None = None) -> list[Any]:
    """Secrets to attach to every Function/Cls. Never raises TypeError on from_name."""
    attached: list[Any] = []
    named = _ensure_named_secret(secret_cls)
    if named is not None:
        attached.append(named)
    local = _local_env_secret(secret_cls, environ)
    if local is not None:
        attached.append(local)
    return attached
