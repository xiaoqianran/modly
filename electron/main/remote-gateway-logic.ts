/**
 * Pure request classification for the local 8765 → Modal gateway.
 * Kept free of Node http / Electron so unit tests stay cheap.
 */

export type GatewayAction =
  | { type: 'import-by-path' }
  | { type: 'prefetch-output' }
  | { type: 'workspace-cache'; rel: string }
  | { type: 'serve-local-file' }
  | { type: 'proxy' }

export function pathOnly(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

export function classifyGatewayRequest(method: string, url: string): GatewayAction {
  const path = pathOnly(url)
  const m = method.toUpperCase()

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
  return { type: 'proxy' }
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
