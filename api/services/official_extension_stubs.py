"""Official model-extension catalog stubs.

A fresh Modal Volume has no clones. GET /extensions/catalog must still
return the workflow ids the desktop already uses (hunyuan3d-mini/generate,
triposg/generate, trellis-2/trellis-2) so Generate does not toast
"Extension is unavailable" before bake/hydrate finishes.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

OFFICIAL_CATALOG_STUBS: tuple[dict[str, Any], ...] = (
    {
        "id": "hunyuan3d-mini",
        "name": "Hunyuan3D 2 Mini",
        "type": "model",
        "source": "https://github.com/lightningpixel/modly-hunyuan3d-mini-extension",
        "description": "Lightweight Hunyuan3D variant with 0.6B parameters. Fast image-to-mesh generation.",
        "version": "1.1.0",
        "author": "Lightning Pixel",
        "nodes": [
            {
                "id": "generate",
                "name": "Generate Mesh",
                "input": "image",
                "output": "mesh",
                "hf_repo": "tencent/Hunyuan3D-2mini",
                "download_check": "hunyuan3d-dit-v2-mini",
                "hf_skip_prefixes": [
                    "hunyuan3d-dit-v2-mini-turbo/",
                    "hunyuan3d-dit-v2-mini-fast/",
                    "hunyuan3d-vae-v2-mini-turbo/",
                    "hunyuan3d-vae-v2-mini-withencoder/",
                ],
                "params_schema": [
                    {
                        "id": "num_inference_steps",
                        "label": "Quality",
                        "type": "select",
                        "default": 30,
                        "options": [
                            {"value": 10, "label": "Fast"},
                            {"value": 30, "label": "Balanced"},
                            {"value": 50, "label": "High"},
                        ],
                    },
                    {
                        "id": "octree_resolution",
                        "label": "Mesh Resolution",
                        "type": "select",
                        "default": 380,
                        "options": [
                            {"value": 256, "label": "Low"},
                            {"value": 380, "label": "Medium"},
                            {"value": 512, "label": "High"},
                        ],
                    },
                    {
                        "id": "guidance_scale",
                        "label": "Guidance Scale",
                        "type": "float",
                        "default": 5.5,
                        "min": 1.0,
                        "max": 10.0,
                        "step": 0.5,
                    },
                    {
                        "id": "seed",
                        "label": "Seed",
                        "type": "int",
                        "default": -1,
                        "min": -1,
                        "max": 4294967295,
                    },
                ],
            }
        ],
    },
    {
        "id": "triposg",
        "name": "TripoSG",
        "type": "model",
        "source": "https://github.com/lightningpixel/modly-triposg-extension",
        "description": "High-quality image-to-3D via flow matching diffusion.",
        "version": "1.0.1",
        "author": "Lightning Pixel",
        "nodes": [
            {
                "id": "generate",
                "name": "TripoSG",
                "input": "image",
                "output": "mesh",
                "hf_repo": "VAST-AI/TripoSG",
                "download_check": "model_index.json",
                "params_schema": [
                    {
                        "id": "num_inference_steps",
                        "label": "Inference Steps",
                        "type": "int",
                        "default": 50,
                        "min": 8,
                        "max": 50,
                    },
                    {
                        "id": "guidance_scale",
                        "label": "CFG Scale",
                        "type": "float",
                        "default": 7.0,
                        "min": 0.0,
                        "max": 20.0,
                        "step": 0.5,
                    },
                    {
                        "id": "foreground_ratio",
                        "label": "Foreground Ratio",
                        "type": "float",
                        "default": 0.85,
                        "min": 0.5,
                        "max": 1.0,
                        "step": 0.05,
                    },
                    {
                        "id": "faces",
                        "label": "Max Faces",
                        "type": "int",
                        "default": -1,
                        "min": -1,
                        "max": 500000,
                    },
                    {
                        "id": "seed",
                        "label": "Seed",
                        "type": "int",
                        "default": -1,
                        "min": -1,
                        "max": 4294967295,
                    },
                    {
                        "id": "use_flash_decoder",
                        "label": "Decoder",
                        "type": "select",
                        "default": "DiffDMC",
                        "options": [
                            {"value": "DiffDMC", "label": "DiffDMC"},
                            {"value": "Marching Cubes", "label": "Marching Cubes"},
                        ],
                    },
                ],
            }
        ],
    },
    {
        "id": "trellis-2",
        "name": "TRELLIS.2",
        "type": "model",
        "source": "https://github.com/lightningpixel/modly-trellis2-extension",
        "description": "High-fidelity image-to-3D with PBR textures via O-Voxel structured latents.",
        "version": "1.0.0",
        "author": "Lightning Pixel",
        "nodes": [
            {
                "id": "trellis-2",
                "name": "TRELLIS.2-4B",
                "input": "image",
                "output": "mesh",
                "hf_repo": "microsoft/TRELLIS.2-4B",
                "download_check": "pipeline.json",
                "params_schema": [
                    {
                        "id": "pipeline_type",
                        "label": "Resolution",
                        "type": "select",
                        "default": "1024_cascade",
                        "options": [
                            {"value": "512", "label": "512³ (~3 s)"},
                            {"value": "1024", "label": "1024³ (~17 s)"},
                            {"value": "1024_cascade", "label": "1024³ Cascade (~17 s)"},
                            {"value": "1536_cascade", "label": "1536³ Cascade (~60 s)"},
                        ],
                    },
                    {
                        "id": "sparse_steps",
                        "label": "Sparse Structure Steps",
                        "type": "int",
                        "default": 12,
                        "min": 1,
                        "max": 50,
                    },
                    {
                        "id": "shape_steps",
                        "label": "Shape SLAT Steps",
                        "type": "int",
                        "default": 12,
                        "min": 1,
                        "max": 50,
                    },
                    {
                        "id": "tex_steps",
                        "label": "Texture SLAT Steps",
                        "type": "int",
                        "default": 12,
                        "min": 1,
                        "max": 50,
                    },
                    {
                        "id": "faces",
                        "label": "Max Faces",
                        "type": "int",
                        "default": -1,
                        "min": -1,
                        "max": 16777216,
                    },
                    {
                        "id": "texture_size",
                        "label": "Texture Size",
                        "type": "select",
                        "default": 4096,
                        "options": [
                            {"value": 2048, "label": "2048"},
                            {"value": 4096, "label": "4096"},
                            {"value": 8192, "label": "8192"},
                        ],
                    },
                    {
                        "id": "seed",
                        "label": "Seed",
                        "type": "int",
                        "default": 42,
                        "min": 0,
                        "max": 2147483647,
                    },
                ],
            }
        ],
    },
)


def official_extension_ids() -> frozenset[str]:
    return frozenset(str(item["id"]) for item in OFFICIAL_CATALOG_STUBS)


def official_catalog_stubs() -> list[dict[str, Any]]:
    return [deepcopy(item) for item in OFFICIAL_CATALOG_STUBS]


def official_workflow_ids() -> tuple[str, ...]:
    ids: list[str] = []
    for ext in OFFICIAL_CATALOG_STUBS:
        ext_id = str(ext["id"])
        for node in ext.get("nodes") or []:
            if isinstance(node, dict) and node.get("id"):
                ids.append(f"{ext_id}/{node['id']}")
    return tuple(ids)


def merge_official_catalog_stubs(listed: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = {item.get("id") for item in listed}
    extras = [stub for stub in official_catalog_stubs() if stub["id"] not in seen]
    return [*listed, *extras]
