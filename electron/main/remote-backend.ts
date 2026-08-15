/**
 * Overlay config for a Modal (or any remote) FastAPI.
 *
 * Renderer and most of Electron keep talking to http://127.0.0.1:8765.
 * When this resolves to enabled, python-bridge starts a local gateway
 * instead of uvicorn — so upstream UI/API additions that use apiUrl
 * keep working without further renderer patches.
 */

export type BackendMode = 'local' | 'remote'

export interface RemoteBackendSettings {
  backendMode?: BackendMode | string
  remoteApiUrl?: string
  remoteApiToken?: string
}

export interface RemoteBackendConfig {
  enabled: boolean
  apiUrl: string
  token: string
}

export function normalizeRemoteApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function resolveRemoteBackend(
  settings: RemoteBackendSettings,
  env: NodeJS.ProcessEnv = process.env,
): RemoteBackendConfig {
  const envUrl = (env['MODLY_REMOTE_API_URL'] ?? '').trim()
  const settingsUrl = (settings.remoteApiUrl ?? '').trim()
  const raw = envUrl || settingsUrl
  const apiUrl = raw ? normalizeRemoteApiUrl(raw) : ''
  const token = (env['MODLY_REMOTE_API_TOKEN'] ?? settings.remoteApiToken ?? '').trim()
  const envForcesRemote = envUrl.length > 0
  const mode = settings.backendMode === 'remote' || envForcesRemote ? 'remote' : 'local'
  const enabled = apiUrl.length > 0 && mode === 'remote'
  return { enabled, apiUrl, token }
}
