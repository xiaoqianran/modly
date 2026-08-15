import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearModalSession,
  connectModalSession,
  getModalSessionPublic,
  overlayRemoteSettings,
} from './modal-session.ts'

test('token connect stores only the resolved URL in memory', async () => {
  clearModalSession()
  const result = await connectModalSession(
    { tokenId: 'ak-EXAMPLE', tokenSecret: 'as-EXAMPLE' },
    { fetchImpl: (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ username: 'pythonmoive' }),
    })) as unknown as typeof fetch },
  )
  assert.equal(result.ok, true)
  assert.equal(result.persisted, false)
  assert.equal(result.workspace, 'pythonmoive')
  assert.equal(result.apiUrl, 'https://pythonmoive--modly-backend-fastapi-app.modal.run')
  assert.equal(JSON.stringify(result).includes('as-'), false)

  const overlaid = overlayRemoteSettings({ backendMode: 'local', remoteApiUrl: '' })
  assert.equal(overlaid.backendMode, 'remote')
  assert.equal(overlaid.remoteApiUrl, result.apiUrl)
  clearModalSession()
  assert.equal(getModalSessionPublic().active, false)
  assert.equal(overlayRemoteSettings({ backendMode: 'local' }).backendMode, 'local')
})

test('workspace name is used when token lookup fails', async () => {
  clearModalSession()
  const result = await connectModalSession(
    { tokenId: 'ak-EXAMPLE', tokenSecret: 'as-EXAMPLE', workspace: 'pythonmoive' },
    {
      fetchImpl: (async () => { throw new Error('offline') }) as unknown as typeof fetch,
      grpcLookup: async () => { throw new Error('offline') },
    },
  )
  assert.equal(result.ok, true)
  assert.equal(result.apiUrl, 'https://pythonmoive--modly-backend-fastapi-app.modal.run')
  clearModalSession()
})

test('a pasted URL or workspace name skips the Modal control-plane lookup', async () => {
  clearModalSession()
  const byUrl = await connectModalSession({
    apiUrl: 'https://demo--modly-backend-fastapi-app.modal.run/',
  }, { grpcLookup: async () => { throw new Error('should not lookup') } })
  assert.equal(byUrl.ok, true)
  assert.equal(byUrl.apiUrl, 'https://demo--modly-backend-fastapi-app.modal.run')

  const byWorkspace = await connectModalSession({ workspace: 'pythonmoive' }, {
    grpcLookup: async () => { throw new Error('should not lookup') },
  })
  assert.equal(byWorkspace.ok, true)
  assert.equal(byWorkspace.apiUrl, 'https://pythonmoive--modly-backend-fastapi-app.modal.run')
  clearModalSession()
})

test('connect errors are redacted and do not keep a half-applied session', async () => {
  clearModalSession()
  const result = await connectModalSession(
    { tokenId: 'ak-EXAMPLE', tokenSecret: 'as-SECRETVALUE' },
    {
      fetchImpl: (async () => { throw new Error('nope as-SECRETVALUE') }) as unknown as typeof fetch,
      grpcLookup: async () => { throw new Error('still as-SECRETVALUE') },
    },
  )
  assert.equal(result.ok, false)
  assert.equal(result.active, false)
  assert.equal((result.error ?? '').includes('as-SECRETVALUE'), false)
  clearModalSession()
})
