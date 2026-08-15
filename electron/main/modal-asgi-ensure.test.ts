import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import {
  classifyModalAsgiResponse,
  deployModalApp,
  ensureModalCpuAsgi,
  findModalAppPy,
  isMissingCommandOutput,
  sanitizeDeployDetail,
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

test('Chinese Windows cmd "not a command" is treated as a missing CLI', () => {
  assert.equal(isMissingCommandOutput("'modal' 不是内部或外部命令，也不是可运行的程序", 'modal'), true)
  assert.equal(isMissingCommandOutput("'modal'\n\uFFFD\uFFFD H X", 'modal'), true)
  assert.equal(isMissingCommandOutput("'modal' is not recognized as an internal or external command", 'modal'), true)
  assert.equal(isMissingCommandOutput('App deployed in 12s', 'modal'), false)
  assert.match(sanitizeDeployDetail("'modal'\n\uFFFD\uFFFD"), /pip install modal/)
})

test('deploy falls through when the first spawn is a missing modal.exe', async () => {
  const cmds: string[] = []
  const spawnImpl = ((cmd: string) => {
    cmds.push(cmd)
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(() => {
      if (cmd === 'modal' || cmd === 'modal.cmd' || cmd === 'modal.exe') {
        child.stderr.emit('data', Buffer.from("'modal' 不是内部或外部命令\n"))
        child.emit('close', 1)
        return
      }
      child.emit('close', 0)
    })
    return child
  }) as unknown as typeof import('node:child_process').spawn

  const result = await deployModalApp({
    tokenId: 'ak-EXAMPLE',
    tokenSecret: 'as-EXAMPLE',
    appPy: join(process.cwd(), 'modal', 'app.py'),
    spawnImpl,
  })
  assert.equal(result.ok, true)
  assert.ok(cmds.some((cmd) => cmd === 'python' || cmd === 'python3' || cmd === 'py'))
})
