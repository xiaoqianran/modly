/**
 * Prefix-based IPC policy for remote mode.
 *
 * Upstream (lightningpixel/modly) almost always adds either:
 *   - a new FastAPI route used via 8765  → gateway proxies, no edit
 *   - a new ipcMain.handle channel       → this file classifies by PREFIX
 *
 * Do not list every handler. Only encode stable prefixes + the few
 * disk-scan channels that must be replaced. Unknown model:/extensions:
 * channels POST /desktop/ipc so Modal can grow without an Electron patch.
 */

export type IpcDisposition =
  | 'local'
  | 'http-ok'
  | 'replace'
  | 'wrap-setup'
  | 'wrap-extensions-list'
  | 'forward-unknown'

const LOCAL_PREFIXES = [
  'window:',
  'fs:',
  'workflows:',
  'log:',
  'updater:',
  'workspace:',
  'system:',
  'app:',
  'shell:',
  'cache:',
  'ui:',
] as const

const REPLACE = new Set([
  'model:isDownloaded',
  'model:listDownloaded',
  'model:delete',
  'model:cancelDownload',
  'model:showInFolder',
  'extensions:installFromGitHub',
  'extensions:uninstall',
  'extensions:repair',
  'extensions:installFromLocal',
])

const HTTP_OK = new Set([
  'model:download',
  'model:pauseDownload',
  'model:unloadAll',
  'model:export',
  'model:activeDownloads',
  'extensions:reload',
  'extensions:runProcess',
  'python:start',
  'python:status',
  'api:updatePaths',
  'settings:get',
  'settings:set',
  'setup:saveDataDir',
  'setup:run',
])

const COMPUTE_PREFIXES = ['model:', 'extensions:', 'python:', 'setup:', 'api:']

export function classifyIpcChannel(channel: string): IpcDisposition {
  if (channel === 'setup:check') return 'wrap-setup'
  if (channel === 'extensions:list') return 'wrap-extensions-list'
  if (REPLACE.has(channel)) return 'replace'
  if (HTTP_OK.has(channel)) return 'http-ok'
  if (LOCAL_PREFIXES.some((p) => channel.startsWith(p))) return 'local'
  if (COMPUTE_PREFIXES.some((p) => channel.startsWith(p))) return 'forward-unknown'
  return 'local'
}

export function isComputePrefix(channel: string): boolean {
  return COMPUTE_PREFIXES.some((p) => channel.startsWith(p))
}
