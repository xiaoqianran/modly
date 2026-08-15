/**
 * Remote adapters for IPC channels that scan the laptop disk.
 * HTTP that already goes to 127.0.0.1:8765 is left alone (gateway).
 *
 * Path table: remote-ipc-routes.ts (shared with contract tests).
 */

import axios from 'axios'
import { httpErrorMessage } from '../../src/shared/httpError'
import { modalPrefsBody } from '../../src/shared/modalPrefs'
import { API_BASE_URL } from './python-bridge'
import { DESKTOP_IPC_FALLBACK } from './ipc-dispatch'
import {
  isDesktopIpcFallback,
  mergeCatalogLists,
  modelAllHasId,
  modelAllToDownloadedList,
  planIpcReplace,
  type OverlayHttpCall,
} from './remote-ipc-routes'

export async function remoteReplaceIpc(channel: string, args: unknown[]): Promise<unknown> {
  const plan = planIpcReplace(channel, args)
  if (plan.kind === 'noop') return undefined
  if (plan.kind === 'reject') return plan.result
  try {
    const data = await overlayHttp(plan.http)
    return interpretReplaceResponse(channel, args, data)
  } catch (err: unknown) {
    return interpretReplaceError(channel, err)
  }
}

export async function mergeRemoteExtensionCatalog(localListed: unknown): Promise<unknown> {
  try {
    const { data } = await axios.get(`${API_BASE_URL}/extensions/catalog`, { timeout: 15_000 })
    return mergeCatalogLists(localListed, data)
  } catch (err) {
    console.error('[remote-ipc] catalog failed', err)
    return mergeCatalogLists(localListed, { extensions: [] })
  }
}

export async function afterSettingsSet(patch: unknown, updated: unknown): Promise<void> {
  const body = patch as { gpuLingerSeconds?: number; remoteGpu?: string } | null
  if (!body || (body.gpuLingerSeconds === undefined && body.remoteGpu === undefined)) {
    return
  }
  const settings = (updated ?? body) as { gpuLingerSeconds?: number; remoteGpu?: string }
  try {
    await axios.post(`${API_BASE_URL}/settings/modal`, modalPrefsBody(settings), { timeout: 5000 })
  } catch {
    /* FastAPI / Modal may not be running yet */
  }
}

export async function forwardUnknown(channel: string, args: unknown[]): Promise<unknown> {
  const plan = planIpcReplace(channel, args)
  if (plan.kind !== 'http') {
    throw new Error(DESKTOP_IPC_FALLBACK)
  }
  const data = await overlayHttp({ ...plan.http, acceptAnyStatus: true })
  if (isDesktopIpcFallback(data)) {
    const err = new Error(DESKTOP_IPC_FALLBACK)
    ;(err as Error & { fallback: true }).fallback = true
    throw err
  }
  return data
}

async function overlayHttp(http: OverlayHttpCall): Promise<unknown> {
  const url = `${API_BASE_URL}${http.path}`
  const cfg = {
    timeout: http.timeoutMs,
    params: http.params,
    validateStatus: http.acceptAnyStatus ? () => true : undefined,
  }
  if (http.method === 'GET') {
    const { data } = await axios.get(url, cfg)
    return data
  }
  const { data } = await axios.post(url, http.body ?? null, cfg)
  return data
}

function interpretReplaceResponse(channel: string, args: unknown[], data: unknown): unknown {
  if (channel === 'model:isDownloaded') return modelAllHasId(data, String(args[0] ?? ''))
  if (channel === 'model:listDownloaded') return modelAllToDownloadedList(data)
  if (channel === 'model:delete' || channel === 'model:cancelDownload') return { success: true }
  return data
}

function interpretReplaceError(channel: string, err: unknown): unknown {
  if (channel === 'model:isDownloaded') return false
  if (channel === 'model:listDownloaded') return []
  return { success: false, error: httpErrorMessage(err) }
}
