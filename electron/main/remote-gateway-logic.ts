import { Buffer } from 'node:buffer'

/**
 * Pure request classification for the local 8765 → Modal gateway.
 * Kept free of Node http / Electron so unit tests stay cheap.
 */

export type GatewayAction =
  | { type: 'import-by-path' }
  | { type: 'prefetch-output' }
  | { type: 'workspace-cache'; rel: string }
  | { type: 'serve-local-file' }
  | { type: 'local-health' }
  | { type: 'cache-get' }
  | { type: 'proxy' }

/** Opening the desktop must not wake the Modal CPU ASGI. */
export const LOCAL_HEALTH_BODY = { status: 'ok' }

/** Short TTL so Models-page bursts collapse into one Modal GET. */
export const CACHE_GET_TTL_MS = 8_000

/** Catalog only. `/runs` is a live ledger — never add it here. */
const CACHE_GET_PATHS = new Set([
  '/model/all',
  '/model/status',
  '/extensions/catalog',
])

export function pathOnly(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

export function isCacheGetPath(path: string): boolean {
  return CACHE_GET_PATHS.has(path)
}

export function isMutatingMethod(method: string): boolean {
  const m = method.toUpperCase()
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE'
}

export function classifyGatewayRequest(method: string, url: string): GatewayAction {
  const path = pathOnly(url)
  const m = method.toUpperCase()

  if (m === 'GET' && path === '/health') {
    return { type: 'local-health' }
  }
  if (m === 'POST' && path === '/optimize/import-by-path') {
    return { type: 'import-by-path' }
  }
  if (m === 'GET' && (path.startsWith('/generate/status/') || /^\/workflow-runs\/[^/]+$/.test(path))) {
    return { type: 'prefetch-output' }
  }
  if (m === 'GET' && path.startsWith('/workspace/')) {
    return { type: 'workspace-cache', rel: decodeURIComponent(path.slice('/workspace/'.length)) }
  }
  if (m === 'GET' && path === '/optimize/serve-file') {
    return { type: 'serve-local-file' }
  }
  if (m === 'GET' && isCacheGetPath(path)) {
    return { type: 'cache-get' }
  }
  return { type: 'proxy' }
}

export type CachedGet = {
  expires: number
  statusCode: number
  contentType: string
  body: Buffer
}

export class ShortGetCache {
  private store = new Map<string, CachedGet>()
  private ttlMs: number

  constructor(ttlMs: number = CACHE_GET_TTL_MS) {
    this.ttlMs = ttlMs
  }

  get(path: string, now = Date.now()): CachedGet | null {
    const hit = this.store.get(path)
    if (!hit) return null
    if (hit.expires <= now) {
      this.store.delete(path)
      return null
    }
    return hit
  }

  set(path: string, value: Omit<CachedGet, 'expires'>, now = Date.now()): void {
    this.store.set(path, { ...value, expires: now + this.ttlMs })
  }

  invalidate(): void {
    this.store.clear()
  }
}

/** Host-absolute paths the Modal container cannot see. */
export function isLocalFsPath(p: string): boolean {
  const value = p.trim()
  if (!value) return false
  if (value.startsWith('/workspace/')) return false
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  if (value.startsWith('/')) return true
  return false
}

export function workspaceRelFromOutputUrl(outputUrl: unknown): string | null {
  if (typeof outputUrl !== 'string') return null
  if (!outputUrl.startsWith('/workspace/')) return null
  const rel = outputUrl.slice('/workspace/'.length)
  return rel.length > 0 ? rel : null
}

export function queryParam(url: string, key: string): string | null {
  const q = url.indexOf('?')
  if (q === -1) return null
  const params = new URLSearchParams(url.slice(q + 1))
  const value = params.get(key)
  return value && value.length > 0 ? value : null
}
