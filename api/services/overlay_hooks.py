"""The only overlay imports shared upstream routers should grow.

Local runtime: commit is a no-op. Modal: persist the named Volume.
"""

from __future__ import annotations


def after_hf_download() -> None:
    from services.modal_runtime import commit_volume

    commit_volume("modly-models")


def after_unload_all() -> None:
    """Desktop quit / Free Memory: drop the GPU pool so linger does not outlive the app."""
    from services.modal_runtime import release_gpu_pool

    release_gpu_pool()
