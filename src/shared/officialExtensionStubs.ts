/**
 * Official model-extension ids the Generate/Workflows nodes already use.
 * Used when Modal's catalog is empty or the CPU ASGI is not deployed yet.
 * Keep in sync with api/services/official_extension_stubs.py.
 */

export type OfficialCatalogStub = {
  id: string
  name: string
  type: 'model'
  source?: string
  nodes: Array<{
    id: string
    name: string
    input: string
    output: string
    hf_repo?: string
    download_check?: string
  }>
}

export const OFFICIAL_CATALOG_STUBS: OfficialCatalogStub[] = [
  {
    id: 'hunyuan3d-mini',
    name: 'Hunyuan3D 2 Mini',
    type: 'model',
    source: 'https://github.com/lightningpixel/modly-hunyuan3d-mini-extension',
    nodes: [{
      id: 'generate',
      name: 'Generate Mesh',
      input: 'image',
      output: 'mesh',
      hf_repo: 'tencent/Hunyuan3D-2mini',
      download_check: 'hunyuan3d-dit-v2-mini',
    }],
  },
  {
    id: 'triposg',
    name: 'TripoSG',
    type: 'model',
    source: 'https://github.com/lightningpixel/modly-triposg-extension',
    nodes: [{
      id: 'generate',
      name: 'TripoSG',
      input: 'image',
      output: 'mesh',
      hf_repo: 'VAST-AI/TripoSG',
      download_check: 'model_index.json',
    }],
  },
  {
    id: 'trellis-2',
    name: 'TRELLIS.2',
    type: 'model',
    source: 'https://github.com/lightningpixel/modly-trellis2-extension',
    nodes: [{
      id: 'trellis-2',
      name: 'TRELLIS.2-4B',
      input: 'image',
      output: 'mesh',
      hf_repo: 'microsoft/TRELLIS.2-4B',
      download_check: 'pipeline.json',
    }],
  },
]

export const OFFICIAL_WORKFLOW_IDS = OFFICIAL_CATALOG_STUBS.flatMap((ext) =>
  ext.nodes.map((node) => `${ext.id}/${node.id}`),
)
