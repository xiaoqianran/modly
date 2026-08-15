/**
 * Windows IPC → 8765 HTTP mapping for remote mode.
 * No axios / Electron — tests and remote-ipc.ts share this table.
 */

export type OverlayHttpCall = {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  params?: Record<string, string>
  timeoutMs: number
  acceptAnyStatus?: boolean
}

export type IpcReplacePlan =
  | { kind: 'http'; http: OverlayHttpCall }
  | { kind: 'noop' }
  | { kind: 'reject'; result: { success: false; error: string } }

export type CatalogManifest = {
  id?: string
  name?: string
  displayName?: string
  version?: string
  description?: string
  author?: string | { name?: string }
  source?: string
  type?: string
  nodes?: Array<{
    id: string
    name?: string
    input?: string
    inputs?: string[]
    input_labels?: string[]
    output?: string
    params_schema?: unknown[]
    param_defaults?: Record<string, unknown>
    hf_repo?: string
    download_check?: string
    hf_skip_prefixes?: string[]
    hf_include_prefixes?: string[]
  }>
}

const LOCAL_INSTALL_ERROR =
  'Local-folder installs are not sent to Modal. Use a GitHub URL, or bake the extension into the Volume.'

export function planIpcReplace(channel: string, args: unknown[]): IpcReplacePlan {
  switch (channel) {
    case 'model:isDownloaded':
    case 'model:listDownloaded':
      return { kind: 'http', http: { method: 'GET', path: '/model/all', timeoutMs: 15_000 } }
    case 'model:delete':
      return {
        kind: 'http',
        http: {
          method: 'POST',
          path: `/model/delete/${encodeURIComponent(String(args[0] ?? ''))}`,
          body: {},
          timeoutMs: 30_000,
        },
      }
    case 'model:cancelDownload':
      return {
        kind: 'http',
        http: {
          method: 'POST',
          path: '/model/hf-download/cancel',
          params: { model_id: String(args[0] ?? '') },
          timeoutMs: 5_000,
        },
      }
    case 'model:showInFolder':
      return { kind: 'noop' }
    case 'extensions:installFromGitHub':
      return {
        kind: 'http',
        http: {
          method: 'POST',
          path: '/extensions/install-from-github',
          body: { url: String(args[0] ?? '') },
          timeoutMs: 10 * 60_000,
        },
      }
    case 'extensions:uninstall':
      return {
        kind: 'http',
        http: {
          method: 'POST',
          path: '/extensions/uninstall',
          body: { id: String(args[0] ?? '') },
          timeoutMs: 30_000,
        },
      }
    case 'extensions:repair':
      return {
        kind: 'http',
        http: {
          method: 'POST',
          path: '/extensions/repair',
          body: { id: String(args[0] ?? '') },
          timeoutMs: 10 * 60_000,
        },
      }
    case 'extensions:installFromLocal':
      return { kind: 'reject', result: { success: false, error: LOCAL_INSTALL_ERROR } }
    default:
      return {
        kind: 'http',
        http: {
          method: 'POST',
          path: '/desktop/ipc',
          body: { channel, args },
          timeoutMs: 30_000,
          acceptAnyStatus: true,
        },
      }
  }
}

export function unwrapCatalogPayload(data: unknown): CatalogManifest[] {
  if (Array.isArray(data)) return data as CatalogManifest[]
  if (data && typeof data === 'object') {
    const ext = (data as { extensions?: unknown }).extensions
    if (Array.isArray(ext)) return ext as CatalogManifest[]
  }
  return []
}

export function isDesktopIpcFallback(data: unknown): boolean {
  return Boolean(data && typeof data === 'object' && (data as { fallback?: boolean }).fallback === true)
}

export function modelAllHasId(data: unknown, modelId: string): boolean {
  const rows = Array.isArray(data) ? data : []
  return rows.some((m: { id?: string; downloaded?: boolean }) => m.id === modelId && m.downloaded)
}

export function modelAllToDownloadedList(data: unknown): Array<{ id: string; name: string; size_gb: number }> {
  const rows = Array.isArray(data) ? data : []
  return rows
    .filter((m: { downloaded?: boolean }) => m.downloaded)
    .map((m: { id: string; name?: string; size_gb?: number }) => ({
      id: m.id,
      name: m.name ?? m.id,
      size_gb: m.size_gb ?? 0,
    }))
}

export function manifestToExtension(parsed: CatalogManifest) {
  const id = parsed.id ?? 'unknown'
  return {
    type: 'model' as const,
    id,
    name: parsed.displayName ?? parsed.name ?? id,
    version: parsed.version,
    description: parsed.description,
    author: typeof parsed.author === 'string' ? parsed.author : parsed.author?.name,
    trusted: true,
    builtin: false,
    source: parsed.source,
    nodes: (parsed.nodes ?? []).map((n) => ({
      id: n.id,
      name: n.name ?? n.id,
      input: n.input ?? 'image',
      inputs: n.inputs,
      inputLabels: n.input_labels,
      output: n.output ?? 'mesh',
      paramsSchema: n.params_schema ?? [],
      paramDefaults: n.param_defaults ?? {},
      hfRepo: n.hf_repo,
      downloadCheck: n.download_check,
      hfSkipPrefixes: n.hf_skip_prefixes,
      hfIncludePrefixes: n.hf_include_prefixes,
    })),
  }
}

export function mergeCatalogLists(localListed: unknown, remotePayload: unknown): unknown[] {
  const local = Array.isArray(localListed) ? localListed : []
  const builtins = local.filter((item) => {
    const row = item as { builtin?: boolean; type?: string }
    return row.builtin === true || row.type === 'process'
  })
  const remote = unwrapCatalogPayload(remotePayload).map((parsed) => manifestToExtension(parsed))
  return [...builtins, ...remote]
}
