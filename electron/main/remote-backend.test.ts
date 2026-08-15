import assert from 'node:assert/strict'
import test from 'node:test'

async function load() {
  return import(new URL('./remote-backend.ts', import.meta.url).href)
}

test('env URL enables remote even when settings say local', async () => {
  const { resolveRemoteBackend } = await load()
  const cfg = resolveRemoteBackend(
    { backendMode: 'local', remoteApiUrl: '' },
    { MODLY_REMOTE_API_URL: 'https://example.modal.run/' },
  )
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.apiUrl, 'https://example.modal.run')
})

test('settings remote mode requires a URL', async () => {
  const { resolveRemoteBackend } = await load()
  const missing = resolveRemoteBackend({ backendMode: 'remote' }, {})
  assert.equal(missing.enabled, false)
  const ok = resolveRemoteBackend(
    { backendMode: 'remote', remoteApiUrl: 'https://app.modal.run', remoteApiToken: 't' },
    {},
  )
  assert.equal(ok.enabled, true)
  assert.equal(ok.token, 't')
})

test('local mode stays local without env', async () => {
  const { resolveRemoteBackend } = await load()
  const cfg = resolveRemoteBackend(
    { backendMode: 'local', remoteApiUrl: 'https://ignored.modal.run' },
    {},
  )
  assert.equal(cfg.enabled, false)
})
