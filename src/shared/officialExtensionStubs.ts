/**
 * Official model-extension ids the Generate/Workflows nodes already use.
 * Used when Modal's catalog is empty or the CPU ASGI is not deployed yet.
 * Keep in sync with api/services/official_extension_stubs.py.
 */

export type OfficialCatalogStub = {
  id: string
  name: string
  type: 'model'
  nodes: Array<{ id: string; name: string; input: string; output: string }>
}

export const OFFICIAL_CATALOG_STUBS: OfficialCatalogStub[] = [
  {
    id: 'hunyuan3d-mini',
    name: 'Hunyuan3D 2 Mini',
    type: 'model',
    nodes: [{ id: 'generate', name: 'Generate Mesh', input: 'image', output: 'mesh' }],
  },
  {
    id: 'triposg',
    name: 'TripoSG',
    type: 'model',
    nodes: [{ id: 'generate', name: 'TripoSG', input: 'image', output: 'mesh' }],
  },
  {
    id: 'trellis-2',
    name: 'TRELLIS.2',
    type: 'model',
    nodes: [{ id: 'trellis-2', name: 'TRELLIS.2-4B', input: 'image', output: 'mesh' }],
  },
]

export const OFFICIAL_WORKFLOW_IDS = OFFICIAL_CATALOG_STUBS.flatMap((ext) =>
  ext.nodes.map((node) => `${ext.id}/${node.id}`),
)
