/**
 * Remote adapters for IPC channels that scan the laptop disk.
 * HTTP that already goes to 127.0.0.1:8765 is left alone (gateway).
 */

import axios from 'axios'
import { API_BASE_URL } from './python-bridge'

type CatalogManifest = {
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

export async function remoteReplaceIpc(channel: string, args: unknown[]): Promise<unknown> {
  switch (channel) {
    case 'model:isDownloaded':
      return modelIsDownloaded(String(args[0] ?? ''))
    case 'model:listDownloaded':
      return modelListDownloaded()
    case 'model:delete':
      return modelDelete(String(args[0] ?? ''))
    case 'model:cancelDownload':
      return modelCancelDownload(String(args[0] ?? ''))
    case 'model:showInFolder':
      return undefined
    case 'extensions:installFromGitHub':
      return installFromGitHub(String(args[0] ?? ''))
    case 'extensions:uninstall':
      return uninstallExtension(String(args[0] ?? ''))
    case 'extensions:repair':
      return repairExtension(String(args[0] ?? ''))
    case 'extensions:installFromLocal':
      return {
        success: false,
        error: 'Local-folder installs are not sent to Modal. Use a GitHub URL, or bake the extension into the Volume.',
      }
    default:
      return forwardUnknown(channel, args)
  }
}

export async function mergeRemoteExtensionCatalog(localListed: unknown): Promise<unknown> {
  const local = Array.isArray(localListed) ? localListed : []
  const builtins = local.filter((item) => {
    const row = item as { builtin?: boolean; type?: string }
    return row.builtin === true || row.type === 'process'
  })
  try {
    const { data } = await axios.get(`${API_BASE_URL}/extensions/catalog`, { timeout: 15_000 })
    const raws: CatalogManifest[] = Array.isArray(data) ? data : (data?.extensions ?? [])
    const remote = raws.map((parsed) => manifestToExtension(parsed))
    return [...builtins, ...remote]
  } catch (err) {
    console.error('[remote-ipc] catalog failed', err)
    return builtins
  }
}

export async function forwardUnknown(channel: string, args: unknown[]): Promise<unknown> {
  const { data } = await axios.post(
    `${API_BASE_URL}/desktop/ipc`,
    { channel, args },
    { timeout: 30_000, validateStatus: () => true },
  )
  if (data && typeof data === 'object' && (data as { fallback?: boolean }).fallback) {
    const err = new Error('desktop-ipc-fallback')
    ;(err as Error & { fallback: true }).fallback = true
    throw err
  }
  return data
}

async function modelListDownloaded() {
  const { data } = await axios.get(`${API_BASE_URL}/model/all`, { timeout: 15_000 })
  const rows = Array.isArray(data) ? data : []
  return rows
    .filter((m: { downloaded?: boolean }) => m.downloaded)
    .map((m: { id: string; name?: string; size_gb?: number }) => ({
      id: m.id,
      name: m.name ?? m.id,
      size_gb: m.size_gb ?? 0,
    }))
}

async function modelIsDownloaded(modelId: string): Promise<boolean> {
  const { data } = await axios.get(`${API_BASE_URL}/model/all`, { timeout: 15_000 })
  const rows = Array.isArray(data) ? data : []
  return rows.some((m: { id: string; downloaded?: boolean }) => m.id === modelId && m.downloaded)
}

async function modelDelete(modelId: string) {
  try {
    await axios.post(`${API_BASE_URL}/model/delete/${encodeURIComponent(modelId)}`, {}, { timeout: 30_000 })
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

async function modelCancelDownload(modelId: string) {
  try {
    await axios.post(`${API_BASE_URL}/model/hf-download/cancel`, null, {
      params: { model_id: modelId },
      timeout: 5000,
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

async function installFromGitHub(url: string) {
  try {
    const { data } = await axios.post(
      `${API_BASE_URL}/extensions/install-from-github`,
      { url },
      { timeout: 10 * 60_000 },
    )
    return data
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { detail?: string } } }
    const detail = axiosErr.response?.data?.detail
    return { success: false, error: typeof detail === 'string' ? detail : String(err) }
  }
}

async function uninstallExtension(extensionId: string) {
  try {
    const { data } = await axios.post(
      `${API_BASE_URL}/extensions/uninstall`,
      { id: extensionId },
      { timeout: 30_000 },
    )
    return data
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

async function repairExtension(extensionId: string) {
  try {
    const { data } = await axios.post(
      `${API_BASE_URL}/extensions/repair`,
      { id: extensionId },
      { timeout: 10 * 60_000 },
    )
    return data
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

function manifestToExtension(parsed: CatalogManifest) {
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
