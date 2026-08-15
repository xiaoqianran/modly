import assert from 'node:assert/strict'
import test from 'node:test'

async function load() {
  return import(new URL('./remote-ipc-routes.ts', import.meta.url).href)
}

test('catalog envelope from FastAPI unwraps; incomplete-looking local models are dropped', async () => {
  const { unwrapCatalogPayload, mergeCatalogLists, manifestToExtension } = await load()
  assert.deepEqual(unwrapCatalogPayload([{ id: 'a' }]), [{ id: 'a' }])
  assert.deepEqual(unwrapCatalogPayload({ extensions: [{ id: 'b' }] }), [{ id: 'b' }])
  assert.deepEqual(unwrapCatalogPayload({}), [])

  const mapped = manifestToExtension({
    id: 'hunyuan3d-mini',
    displayName: 'Hunyuan',
    nodes: [{ id: 'mini', hf_repo: 'tencent/Hunyuan3D-2mini', download_check: 'model.safetensors' }],
  })
  assert.equal(mapped.type, 'model')
  assert.equal(mapped.builtin, false)
  assert.equal(mapped.trusted, true)
  assert.equal(mapped.nodes[0].hfRepo, 'tencent/Hunyuan3D-2mini')
  assert.equal(mapped.nodes[0].downloadCheck, 'model.safetensors')

  const leftover = manifestToExtension({
    id: 'sdcpp',
    name: 'stable-diffusion.cpp',
    author: 'sdcpp-hooks',
    source: 'examples/modal/modly_extension',
    nodes: [{ id: 'txt2img', input: 'text', output: 'image' }],
  })
  assert.equal(leftover.trusted, false)

  const merged = mergeCatalogLists(
    [
      { id: 'smoother', type: 'process' },
      { id: 'local-hunyuan', type: 'model', builtin: false },
    ],
    { extensions: [{ id: 'hunyuan', type: 'model', nodes: [{ id: 'mini' }] }] },
  ) as Array<{ id: string }>
  assert.deepEqual(merged.map((r) => r.id), ['smoother', 'hunyuan'])
})

test('empty remote catalog keeps local model extensions', async () => {
  const { mergeCatalogLists } = await load()
  const merged = mergeCatalogLists(
    [
      { id: 'smoother', type: 'process', builtin: true },
      { id: 'hunyuan3d-mini', type: 'model', builtin: false, nodes: [{ id: 'generate' }] },
    ],
    { extensions: [] },
  ) as Array<{ id: string }>
  assert.deepEqual(merged.map((r) => r.id), ['smoother', 'hunyuan3d-mini', 'triposg', 'trellis-2'])
})

test('GET /model/all is the source of truth for downloaded flags', async () => {
  const { modelAllHasId, modelAllToDownloadedList } = await load()
  const payload = [
    { id: 'a', name: 'A', downloaded: true, size_gb: 2 },
    { id: 'b', downloaded: false },
  ]
  assert.equal(modelAllHasId(payload, 'a'), true)
  assert.equal(modelAllHasId(payload, 'b'), false)
  assert.equal(modelAllHasId(payload, 'missing'), false)
  assert.deepEqual(modelAllToDownloadedList(payload), [{ id: 'a', name: 'A', size_gb: 2 }])
})
