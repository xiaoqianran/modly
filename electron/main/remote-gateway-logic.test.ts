import assert from 'node:assert/strict'
import test from 'node:test'

async function load() {
  return import(new URL('./remote-gateway-logic.ts', import.meta.url).href)
}

test('classifies the local-path and workspace intercepts', async () => {
  const { classifyGatewayRequest } = await load()
  assert.equal(classifyGatewayRequest('POST', '/optimize/import-by-path').type, 'import-by-path')
  assert.equal(classifyGatewayRequest('GET', '/generate/status/abc').type, 'prefetch-output')
  assert.equal(classifyGatewayRequest('GET', '/workflow-runs/abc').type, 'prefetch-output')
  const cached = classifyGatewayRequest('GET', '/workspace/Default/mesh.glb')
  assert.deepEqual(cached, { type: 'workspace-cache', rel: 'Default/mesh.glb' })
  assert.equal(classifyGatewayRequest('GET', '/optimize/serve-file?path=C:%5Cmesh.glb').type, 'serve-local-file')
  assert.equal(classifyGatewayRequest('POST', '/generate/from-image').type, 'proxy')
  assert.equal(classifyGatewayRequest('GET', '/health').type, 'local-health')
  assert.equal(classifyGatewayRequest('GET', '/model/all').type, 'cache-get')
  assert.equal(classifyGatewayRequest('GET', '/extensions/catalog').type, 'cache-get')
  assert.equal(classifyGatewayRequest('GET', '/runs').type, 'proxy')
  assert.equal(classifyGatewayRequest('GET', '/runs/abc').type, 'proxy')
})

test('short GET cache expires and invalidates', async () => {
  const { ShortGetCache } = await load()
  const cache = new ShortGetCache(50)
  cache.set('/model/all', { statusCode: 200, contentType: 'application/json', body: Buffer.from('[]') }, 1000)
  assert.equal(cache.get('/model/all', 1010)?.statusCode, 200)
  assert.equal(cache.get('/model/all', 1060), null)
  cache.set('/model/all', { statusCode: 200, contentType: 'application/json', body: Buffer.from('[]') }, 2000)
  cache.invalidate()
  assert.equal(cache.get('/model/all', 2001), null)
})

test('new upstream routes default to transparent proxy', async () => {
  const { classifyGatewayRequest } = await load()
  assert.equal(classifyGatewayRequest('POST', '/future/new-feature').type, 'proxy')
  assert.equal(classifyGatewayRequest('GET', '/optimize/brand-new').type, 'proxy')
})

test('isLocalFsPath rejects workspace URLs and accepts host paths', async () => {
  const { isLocalFsPath } = await load()
  assert.equal(isLocalFsPath('/workspace/Default/a.glb'), false)
  assert.equal(isLocalFsPath('C:\\Users\\me\\a.glb'), true)
  assert.equal(isLocalFsPath('/home/me/a.glb'), true)
  assert.equal(isLocalFsPath('Default/a.glb'), false)
})

test('workspaceRelFromOutputUrl only accepts /workspace URLs', async () => {
  const { workspaceRelFromOutputUrl } = await load()
  assert.equal(workspaceRelFromOutputUrl('/workspace/Default/a.glb'), 'Default/a.glb')
  assert.equal(workspaceRelFromOutputUrl('/optimize/serve-file?path=/tmp/a.glb'), null)
  assert.equal(workspaceRelFromOutputUrl(undefined), null)
})
