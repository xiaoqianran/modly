import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyModalAsgiResponse,
  ensureModalCpuAsgi,
  findModalAppPy,
} from './modal-asgi-ensure.ts'

test('Modal edge 404 invalid function call means the CPU ASGI is not deployed', () => {
  assert.equal(
    classifyModalAsgiResponse(404, 'modal-http: invalid function call\n'),
    'not-deployed',
  )
  assert.equal(classifyModalAsgiResponse(200, '{"status":"ok"}'), 'ok')
  assert.equal(classifyModalAsgiResponse(401, 'unauthorized'), 'ok')
  assert.equal(classifyModalAsgiResponse(404, '{"detail":"Not Found"}'), 'ok')
  assert.equal(classifyModalAsgiResponse(502, 'bad gateway'), 'unreachable')
})

test('ensure deploys once when /health is invalid function call, then succeeds', async () => {
  let probes = 0
  let deploys = 0
  const result = await ensureModalCpuAsgi(
    { apiUrl: 'https://demo--modly-backend-fastapi-app.modal.run', tokenId: 'ak-EXAMPLE', tokenSecret: 'as-EXAMPLE' },
    {
      probe: async () => {
        probes += 1
        return probes === 1
          ? { kind: 'not-deployed', status: 404, detail: 'modal-http: invalid function call' }
          : { kind: 'ok', status: 200, detail: '{"status":"ok"}' }
      },
      deploy: async () => {
        deploys += 1
        return { ok: true, detail: 'deployed' }
      },
      findAppPy: () => '/repo/modal/app.py',
    },
  )
  assert.equal(result.ok, true)
  assert.equal(result.deployed, true)
  assert.equal(probes, 2)
  assert.equal(deploys, 1)
})

test('ensure fails closed when the function is missing and deploy cannot run', async () => {
  const noTokens = await ensureModalCpuAsgi(
    { apiUrl: 'https://demo--modly-backend-fastapi-app.modal.run' },
    { probe: async () => ({ kind: 'not-deployed', status: 404, detail: 'modal-http: invalid function call' }) },
  )
  assert.equal(noTokens.ok, false)
  assert.match(noTokens.error ?? '', /invalid function call/)

  const noApp = await ensureModalCpuAsgi(
    { apiUrl: 'https://demo--modly-backend-fastapi-app.modal.run', tokenId: 'ak-EXAMPLE', tokenSecret: 'as-EXAMPLE' },
    {
      probe: async () => ({ kind: 'not-deployed', status: 404, detail: 'modal-http: invalid function call' }),
      findAppPy: () => null,
    },
  )
  assert.equal(noApp.ok, false)
  assert.match(noApp.error ?? '', /modal\/app\.py/)
})

test('a live but cold ASGI does not block Connect', async () => {
  const result = await ensureModalCpuAsgi(
    { apiUrl: 'https://demo--modly-backend-fastapi-app.modal.run' },
    { probe: async () => ({ kind: 'unreachable', detail: 'timeout' }) },
  )
  assert.equal(result.ok, true)
  assert.equal(result.deployed, false)
  assert.match(result.warning ?? '', /did not answer/)
})

test('findModalAppPy sees this repo', () => {
  assert.ok(findModalAppPy(process.cwd())?.endsWith('modal/app.py'))
})
