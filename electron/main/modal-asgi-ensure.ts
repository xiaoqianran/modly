/**
 * Probe the constructed .modal.run URL and, if Modal says the function
 * does not exist, deploy modal/app.py with the user's own Modal CLI.
 *
 * This app does not install Modal. The user installs it (uv / pip) and
 * runs `python -m modal token set` once. We read ~/.modal.toml and spawn
 * an existing python.exe -m modal deploy. Never spawn modal.cmd (EINVAL).
 * Force UTF-8 so Windows GBK cannot crash on Modal's ✓ character.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { normalizeRemoteApiUrl, redactModalSecrets } from '../../src/shared/modalSession'

export type AsgiProbeKind = 'ok' | 'not-deployed' | 'unreachable'

export type AsgiProbe = {
  kind: AsgiProbeKind
  status?: number
  detail: string
}

export type EnsureAsgiResult = {
  ok: boolean
  deployed: boolean
  error?: string
  warning?: string
}

export type EnsureAsgiDeps = {
  probe?: (apiUrl: string, bearerToken?: string) => Promise<AsgiProbe>
  deploy?: (opts: { tokenId: string; tokenSecret: string; appPy: string }) => Promise<{ ok: boolean; detail: string }>
  findAppPy?: () => string | null
}

const NOT_DEPLOYED_HINT =
  'This Modal workspace has no live modly-backend CPU app (modal-http: invalid function call).'

const DEPLOY_TIMEOUT_MS = 12 * 60_000

export const CLI_MISSING_HELP =
  'This app does not install Modal. In a terminal: uv pip install "modal[api-proxy-support]" && python -m modal token set --token-id … --token-secret …  then Connect again so we can run python -m modal deploy. Need a python.exe that already has the modal package.'

export function classifyModalAsgiResponse(status: number, body: string): AsgiProbeKind {
  const text = body || ''
  if (/invalid function call/i.test(text) || /modal-http:\s*invalid/i.test(text)) {
    return 'not-deployed'
  }
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401 || status === 403) return 'ok'
  if (status === 404 && /["']detail["']/.test(text)) return 'ok'
  if (status === 404) return 'not-deployed'
  if (status >= 500) return 'unreachable'
  return 'ok'
}

export async function probeModalAsgi(apiUrl: string, bearerToken?: string): Promise<AsgiProbe> {
  const url = `${normalizeRemoteApiUrl(apiUrl)}/health`
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(45_000),
    })
    const body = await res.text()
    return {
      kind: classifyModalAsgiResponse(res.status, body),
      status: res.status,
      detail: redactModalSecrets(body).slice(0, 240),
    }
  } catch (err) {
    const msg = redactModalSecrets(err instanceof Error ? err.message : String(err))
    if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|getaddrinfo/i.test(msg)) {
      return { kind: 'not-deployed', detail: msg }
    }
    return { kind: 'unreachable', detail: msg }
  }
}

export function findModalAppPy(cwd = process.cwd(), extraRoots: string[] = []): string | null {
  for (const root of [cwd, ...extraRoots]) {
    if (!root) continue
    const candidate = join(root, 'modal', 'app.py')
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function modalVenvPython(repoRoot: string): string {
  return process.platform === 'win32'
    ? join(repoRoot, '.venv-modal', 'Scripts', 'python.exe')
    : join(repoRoot, '.venv-modal', 'bin', 'python')
}

/** Existing pythons that already have the modal package. Never creates a venv. */
export function findExistingModalPythons(
  repoRoot: string,
  exists: (path: string) => boolean = existsSync,
  extra: string[] = [],
): string[] {
  const win = process.platform === 'win32'
  const files = [
    ...extra,
    modalVenvPython(repoRoot),
    join(repoRoot, '.venv', win ? join('Scripts', 'python.exe') : join('bin', 'python')),
    process.env.VIRTUAL_ENV
      ? join(process.env.VIRTUAL_ENV, win ? join('Scripts', 'python.exe') : join('bin', 'python'))
      : '',
  ]
  const names = win ? ['python.exe'] : ['python3', 'python']
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) files.push(join(dir, name))
  }
  const found: string[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (!file || seen.has(file)) continue
    seen.add(file)
    if (exists(file) && modalPackageInstalled(file, exists)) found.push(file)
  }
  return found
}

export function modalPackageInstalled(
  pythonPath: string,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const scriptsDir = dirname(pythonPath)
  const venv = dirname(scriptsDir)
  if (exists(join(venv, 'Lib', 'site-packages', 'modal'))) return true
  if (exists(join(scriptsDir, 'modal.exe')) || exists(join(scriptsDir, 'modal'))) return true
  const lib = join(venv, 'lib')
  try {
    for (const name of readdirSync(lib)) {
      if (exists(join(lib, name, 'site-packages', 'modal'))) return true
    }
  } catch {
    /* no lib/ yet */
  }
  return false
}

export function decodeSpawnChunk(buf: Buffer | string): string {
  if (typeof buf === 'string') return buf
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le')
  }
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0 && buf[0] !== 0) {
    return buf.toString('utf16le')
  }
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buf)
  } catch {
    return utf8
  }
}

export function isMissingCommandOutput(text: string, command = 'modal'): boolean {
  if (/not recognized|is not recognized|not found|command not found|ENOENT|EINVAL/i.test(text)) return true
  if (/不是内部或外部命令|不是可运行的程序|无法识别|不是内部或外部/.test(text)) return true
  const stripped = text.replace(/\uFFFD/g, '').trim()
  if (new RegExp(`^['"]${command}['"]\\s*$`).test(stripped)) return true
  if (text.includes('\uFFFD') && new RegExp(`['"]${command}['"]`).test(text)) return true
  return false
}

export function isUnusableSpawnError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException
  if (e?.code === 'ENOENT' || e?.code === 'EINVAL') return true
  const msg = e?.message || String(err)
  return /\bEINVAL\b|\bENOENT\b/.test(msg)
}

export function deployChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    ...extra,
  }
}

export function sanitizeDeployDetail(text: string): string {
  const cleaned = redactModalSecrets(text)
    .replace(/\uFFFD+/g, ' ')
    .replace(/[^\t\n\r\x20-\x7e\u4e00-\u9fff]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (/codec can.t encode character|gbk. codec/i.test(text)) {
    return 'Windows GBK cannot print Modal\'s ✓. Connect now sets PYTHONUTF8=1. Install Modal yourself, run token set once, then Connect again.'
  }
  if (!cleaned || isMissingCommandOutput(cleaned) || /^['"]modal['"]$/.test(cleaned)) {
    return CLI_MISSING_HELP
  }
  return cleaned.slice(-1200)
}

/** Real python executables only. Never `modal.cmd` — Electron spawn EINVAL on Windows. */
export function modalDeployAttempts(pythonBins: string[] = []): Array<{ cmd: string; args: string[] }> {
  const attempts: Array<{ cmd: string; args: string[] }> = []
  const seen = new Set<string>()
  for (const py of pythonBins) {
    if (!py) continue
    const base = py.replace(/\\/g, '/').split('/').pop() ?? py
    if (/^modal(\.cmd|\.exe)?$/i.test(base)) continue
    const args = /^py(\.exe)?$/i.test(base)
      ? ['-3', '-m', 'modal', 'deploy', 'modal/app.py']
      : ['-m', 'modal', 'deploy', 'modal/app.py']
    const key = `${py} ${args.join(' ')}`
    if (seen.has(key)) continue
    seen.add(key)
    attempts.push({ cmd: py, args })
  }
  return attempts
}

type RunCapturedOpts = {
  cwd: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
}

export function runCaptured(
  spawnImpl: typeof spawn,
  cmd: string,
  args: string[],
  opts: RunCapturedOpts,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawnImpl(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? deployChildEnv(),
        windowsHide: true,
      })
    } catch (err) {
      resolve({
        ok: false,
        detail: sanitizeDeployDetail(err instanceof Error ? err.message : String(err)),
      })
      return
    }
    const chunks: string[] = []
    const take = (buf: Buffer | string) => {
      chunks.push(decodeSpawnChunk(buf))
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      resolve({ ok: false, detail: `${cmd} timed out` })
    }, opts.timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, detail: sanitizeDeployDetail(err.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const raw = chunks.join('')
      if (code === 0) {
        resolve({ ok: true, detail: raw })
        return
      }
      resolve({ ok: false, detail: sanitizeDeployDetail(raw) || `${cmd} exited ${code}` })
    })
  })
}

export function resolveModalCliPython(opts: {
  repoRoot: string
  existsSyncImpl?: (path: string) => boolean
  extraPythons?: string[]
}): { ok: true; python: string } | { ok: false; detail: string } {
  const found = findExistingModalPythons(
    opts.repoRoot,
    opts.existsSyncImpl ?? existsSync,
    opts.extraPythons ?? [],
  )
  if (found[0]) return { ok: true, python: found[0] }
  return { ok: false, detail: CLI_MISSING_HELP }
}

export async function deployModalApp(opts: {
  tokenId?: string
  tokenSecret?: string
  appPy: string
  pythonHints?: string[]
  spawnImpl?: typeof spawn
  existsSyncImpl?: (path: string) => boolean
}): Promise<{ ok: boolean; detail: string }> {
  const repoRoot = dirname(dirname(opts.appPy))
  let pythons = (opts.pythonHints ?? []).filter(Boolean)
  if (pythons.length === 0) {
    const resolved = resolveModalCliPython({
      repoRoot,
      existsSyncImpl: opts.existsSyncImpl,
    })
    if (!resolved.ok) return { ok: false, detail: resolved.detail }
    pythons = [resolved.python]
  }

  const attempts = modalDeployAttempts(pythons)
  const spawnImpl = opts.spawnImpl ?? spawn

  const run = (index: number): Promise<{ ok: boolean; detail: string }> => {
    const attempt = attempts[index]
    if (!attempt) {
      return Promise.resolve({ ok: false, detail: CLI_MISSING_HELP })
    }
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        const tokenEnv: NodeJS.ProcessEnv = {}
        if ((opts.tokenId ?? '').trim()) tokenEnv.MODAL_TOKEN_ID = opts.tokenId!.trim()
        if ((opts.tokenSecret ?? '').trim()) tokenEnv.MODAL_TOKEN_SECRET = opts.tokenSecret!.trim()
        child = spawnImpl(attempt.cmd, attempt.args, {
          cwd: repoRoot,
          env: deployChildEnv(tokenEnv),
          windowsHide: true,
        })
      } catch (err) {
        if (isUnusableSpawnError(err)) {
          void run(index + 1).then(resolve)
          return
        }
        resolve({ ok: false, detail: sanitizeDeployDetail(err instanceof Error ? err.message : String(err)) })
        return
      }
      const chunks: string[] = []
      const take = (buf: Buffer | string) => {
        chunks.push(decodeSpawnChunk(buf))
      }
      child.stdout?.on('data', take)
      child.stderr?.on('data', take)
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
        resolve({ ok: false, detail: 'modal deploy timed out after 12 minutes' })
      }, DEPLOY_TIMEOUT_MS)
      child.on('error', (err) => {
        clearTimeout(timer)
        if (isUnusableSpawnError(err)) {
          void run(index + 1).then(resolve)
          return
        }
        resolve({ ok: false, detail: sanitizeDeployDetail(err.message) })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const raw = chunks.join('')
        if (code === 0) {
          resolve({ ok: true, detail: sanitizeDeployDetail(raw) || 'modal deploy finished' })
          return
        }
        if (code === 127 || isMissingCommandOutput(raw, 'modal') || isMissingCommandOutput(raw, attempt.cmd)) {
          void run(index + 1).then(resolve)
          return
        }
        resolve({ ok: false, detail: sanitizeDeployDetail(raw) || `modal deploy exited ${code}` })
      })
    })
  }

  return run(0)
}

export async function ensureModalCpuAsgi(opts: {
  apiUrl: string
  tokenId?: string
  tokenSecret?: string
  bearerToken?: string
  extraAppRoots?: string[]
  pythonHints?: string[]
}, deps: EnsureAsgiDeps = {}): Promise<EnsureAsgiResult> {
  const probe = deps.probe ?? probeModalAsgi
  const first = await probe(opts.apiUrl, opts.bearerToken)
  if (first.kind === 'ok') {
    return { ok: true, deployed: false }
  }
  if (first.kind === 'unreachable') {
    return {
      ok: true,
      deployed: false,
      warning: `Modal CPU app did not answer /health yet (${first.detail}). Catalog may fail until the container is up.`,
    }
  }

  const tokenId = (opts.tokenId ?? '').trim()
  const tokenSecret = (opts.tokenSecret ?? '').trim()

  const appPy = (deps.findAppPy ?? (() => findModalAppPy(process.cwd(), opts.extraAppRoots)))()
  if (!appPy) {
    return {
      ok: false,
      deployed: false,
      error: `${NOT_DEPLOYED_HINT} Could not find modal/app.py next to the app.`,
    }
  }

  const deploy = deps.deploy ?? ((args) => deployModalApp({
    ...args,
    pythonHints: opts.pythonHints,
  }))
  const deployed = await deploy({ tokenId, tokenSecret, appPy })
  if (!deployed.ok) {
    return {
      ok: false,
      deployed: false,
      error: `${NOT_DEPLOYED_HINT} Deploy failed: ${deployed.detail}`,
    }
  }

  const second = await probe(opts.apiUrl, opts.bearerToken)
  if (second.kind === 'not-deployed') {
    return {
      ok: false,
      deployed: true,
      error: `${NOT_DEPLOYED_HINT} Deploy finished but ${opts.apiUrl}/health still rejects the function.`,
    }
  }
  return {
    ok: true,
    deployed: true,
    warning: second.kind === 'unreachable'
      ? 'Deploy finished. The CPU container is still starting; Generate may need a minute. Idle is 0 CPU / 0 GPU.'
      : 'Registered the empty modly-backend shell. Idle is 0 CPU / 0 GPU. Closing the app does not undeploy.',
  }
}
