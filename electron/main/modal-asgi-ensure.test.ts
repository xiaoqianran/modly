import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import {
  CLI_MISSING_HELP,
  UV_MISSING_HELP,
  classifyModalAsgiResponse,
  deployModalApp,
  ensureModalCliPython,
  ensureModalCpuAsgi,
  findModalAppPy,
  findUvExecutable,
  isMissingCommandOutput,
  isUnusableSpawnError,
  modalDeployAttempts,
  modalVenvPython,
  sanitizeDeployDetail,
} from './modal-asgi-ensure.ts'

function fakeChild(onReady: (child: EventEmitter) => void) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {}
  queueMicrotask(() => onReady(child))
  return child
}

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
  assert.match(sanitizeDeployDetail("'modal'\n\uFFFD\uFFFD"), /uv/)
  assert.equal(isUnusableSpawnError(Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' })), true)
  assert.equal(isUnusableSpawnError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })), true)
})

test('modalDeployAttempts is python -m only and drops modal.cmd', () => {
  const attempts = modalDeployAttempts([
    'C:\\repo\\.venv-modal\\Scripts\\python.exe',
    'modal.cmd',
    'modal.exe',
    'modal',
    'python',
  ])
  assert.deepEqual(attempts.map((a) => a.cmd), [
    'C:\\repo\\.venv-modal\\Scripts\\python.exe',
    'python',
  ])
  for (const attempt of attempts) {
    assert.deepEqual(attempt.args.slice(-4), ['-m', 'modal', 'deploy', 'modal/app.py'])
  }
  assert.equal(modalDeployAttempts([]).length, 0)
})

test('deploy uses pythonHints only and never tries modal.cmd', async () => {
  const cmds: string[] = []
  const spawnImpl = ((cmd: string) => {
    cmds.push(cmd)
    return fakeChild((child) => {
      if (cmd === 'python') {
        child.emit('close', 0)
        return
      }
      child.stderr.emit('data', Buffer.from('should not run\n'))
      child.emit('close', 1)
    })
  }) as unknown as typeof import('node:child_process').spawn

  const result = await deployModalApp({
    tokenId: 'ak-EXAMPLE',
    tokenSecret: 'as-EXAMPLE',
    appPy: join(process.cwd(), 'modal', 'app.py'),
    pythonHints: ['python'],
    spawnImpl,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(cmds, ['python'])
})

test('deploy treats EINVAL like a missing command and tries the next python', async () => {
  const cmds: string[] = []
  const spawnImpl = ((cmd: string) => {
    cmds.push(cmd)
    return fakeChild((child) => {
      if (cmd === 'broken-python') {
        child.emit('error', Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }))
        return
      }
      child.emit('close', 0)
    })
  }) as unknown as typeof import('node:child_process').spawn

  const result = await deployModalApp({
    tokenId: 'ak-EXAMPLE',
    tokenSecret: 'as-EXAMPLE',
    appPy: join(process.cwd(), 'modal', 'app.py'),
    pythonHints: ['broken-python', 'good-python'],
    spawnImpl,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(cmds, ['broken-python', 'good-python'])
})

test('sync spawn EINVAL also falls through to the next python', async () => {
  const cmds: string[] = []
  const spawnImpl = ((cmd: string) => {
    cmds.push(cmd)
    if (cmd === 'broken-python') {
      throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' })
    }
    return fakeChild((child) => child.emit('close', 0))
  }) as unknown as typeof import('node:child_process').spawn

  const result = await deployModalApp({
    tokenId: 'ak-EXAMPLE',
    tokenSecret: 'as-EXAMPLE',
    appPy: join(process.cwd(), 'modal', 'app.py'),
    pythonHints: ['broken-python', 'good-python'],
    spawnImpl,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(cmds, ['broken-python', 'good-python'])
})

test('ensureModalCliPython runs uv venv then uv pip when the venv is missing', async () => {
  const files = new Set<string>(['/bin/uv'])
  const python = modalVenvPython('/repo')
  const cmds: string[][] = []
  const spawnImpl = ((cmd: string, args: string[]) => {
    cmds.push([cmd, ...args])
    return fakeChild((child) => {
      if (args[0] === 'venv') files.add(python)
      child.emit('close', 0)
    })
  }) as unknown as typeof import('node:child_process').spawn

  const result = await ensureModalCliPython({
    repoRoot: '/repo',
    spawnImpl,
    uvHints: ['/bin/uv'],
    existsSyncImpl: (path) => files.has(path),
  })
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.python, python)
  assert.ok(cmds.some((c) => c[0] === '/bin/uv' && c[1] === 'venv'))
  assert.ok(cmds.some((c) => c[0] === '/bin/uv' && c[1] === 'pip'))
})

test('ensureModalCliPython fails closed when uv is missing', async () => {
  const result = await ensureModalCliPython({
    repoRoot: '/repo',
    uvHints: [],
    existsSyncImpl: () => false,
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.detail, UV_MISSING_HELP)
  assert.match(CLI_MISSING_HELP, /python -m modal deploy/)
})

test('findUvExecutable prefers an explicit hint that exists', () => {
  assert.equal(findUvExecutable(['/opt/uv'], (path) => path === '/opt/uv'), '/opt/uv')
  assert.equal(findUvExecutable([], () => false), null)
})

test('parse_modal_token_line.py prints env assignments from the CLI line', async () => {
  const { spawnSync } = await import('node:child_process')
  const script = join(process.cwd(), 'scripts', 'parse_modal_token_line.py')
  const r = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [script, 'modal token set --token-id ak-EXAMPLE --token-secret as-EXAMPLE'],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /MODAL_TOKEN_ID=ak-EXAMPLE/)
  assert.match(r.stdout, /MODAL_TOKEN_SECRET=as-EXAMPLE/)
})
