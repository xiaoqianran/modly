/**
 * Probe the constructed .modal.run URL and, if Modal says the function
 * does not exist, deploy modal/app.py with the session CLI tokens.
 *
 * Connect previously only built the hostname. 8765 /health is local and
 * never wakes Modal, so a missing fastapi_app looked like a successful
 * login until catalog returned `modal-http: invalid function call`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

const DEPLOY_TIMEOUT_MS = 12 * 60_000

export function deployModalApp(opts: {
  tokenId: string
  tokenSecret: string
  appPy: string
  spawnImpl?: typeof spawn
}): Promise<{ ok: boolean; detail: string }> {
  const repoRoot = dirname(dirname(opts.appPy))
  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: 'modal', args: ['deploy', 'modal/app.py'] },
    {
      cmd: process.platform === 'win32' ? 'py' : 'python3',
      args: process.platform === 'win32'
        ? ['-3', '-m', 'modal', 'deploy', 'modal/app.py']
        : ['-m', 'modal', 'deploy', 'modal/app.py'],
    },
  ]

  const run = (index: number): Promise<{ ok: boolean; detail: string }> => {
    const attempt = attempts[index]
    if (!attempt) {
      return Promise.resolve({
        ok: false,
        detail: 'modal CLI not found. Install `pip install modal` and run `modal deploy modal/app.py`.',
      })
    }
    return new Promise((resolve) => {
      const child: ChildProcess = (opts.spawnImpl ?? spawn)(attempt.cmd, attempt.args, {
        cwd: repoRoot,
        env: {
          ...process.env,
          MODAL_TOKEN_ID: opts.tokenId,
          MODAL_TOKEN_SECRET: opts.tokenSecret,
        },
        shell: process.platform === 'win32',
      })
      const chunks: string[] = []
      const take = (buf: Buffer | string) => {
        chunks.push(typeof buf === 'string' ? buf : buf.toString('utf8'))
      }
      child.stdout?.on('data', take)
      child.stderr?.on('data', take)
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
        resolve({ ok: false, detail: 'modal deploy timed out after 12 minutes' })
      }, DEPLOY_TIMEOUT_MS)
      child.on('error', (err) => {
        clearTimeout(timer)
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          void run(index + 1).then(resolve)
          return
        }
        resolve({ ok: false, detail: redactModalSecrets(err.message) })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const detail = redactModalSecrets(chunks.join('')).trim().slice(-1500)
        if (code === 0) {
          resolve({ ok: true, detail: detail || 'modal deploy finished' })
          return
        }
        if (code === 127 || /not recognized|not found/i.test(detail)) {
          void run(index + 1).then(resolve)
          return
        }
        resolve({ ok: false, detail: detail || `modal deploy exited ${code}` })
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
  if (!tokenId || !tokenSecret) {
    return {
      ok: false,
      deployed: false,
      error: `${NOT_DEPLOYED_HINT} Paste CLI tokens so Connect can deploy, or paste the URL printed by \`modal deploy modal/app.py\`.`,
    }
  }

  const appPy = (deps.findAppPy ?? (() => findModalAppPy(process.cwd(), opts.extraAppRoots)))()
  if (!appPy) {
    return {
      ok: false,
      deployed: false,
      error: `${NOT_DEPLOYED_HINT} Could not find modal/app.py next to the app. From the repo run \`modal deploy modal/app.py\`.`,
    }
  }

  const deploy = deps.deploy ?? ((args) => deployModalApp(args))
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
      ? 'Deploy finished. The CPU container is still starting; Generate may need a minute.'
      : undefined,
  }
}
