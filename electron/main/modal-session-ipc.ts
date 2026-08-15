/**
 * Laptop-only IPC for the in-memory Modal session.
 * Classified `local` — tokens never go to Modal HTTP.
 *
 * Connect prefers a pasted pair, else ~/.modal.toml from `modal token set`,
 * else MODAL_TOKEN_ID/SECRET. Then deploys with the user's own python -m modal.
 * This app does not install Modal. No browser. No modal.cmd.
 */

import { app, ipcMain } from 'electron'
import { tryResolveConnectCredentials, type ModalSessionConnectInput } from '../../src/shared/modalSession'
import { ensureModalCpuAsgi } from './modal-asgi-ensure'
import { envModalTokens, readModalTomlTokens } from './modal-toml'
import {
  clearModalSession,
  connectModalSession,
  getModalSessionPublic,
} from './modal-session'
import type { PythonBridge } from './python-bridge'

async function applyBridge(pythonBridge: PythonBridge | null): Promise<void> {
  if (!pythonBridge) return
  try {
    if (pythonBridge.isReady()) {
      await pythonBridge.restart()
      return
    }
    await pythonBridge.start()
  } catch {
    /* first-run will start the gateway via python:start after setup:check */
  }
}

function extraAppRoots(): string[] {
  try {
    return [process.cwd(), app.getAppPath()]
  } catch {
    return [process.cwd()]
  }
}

export function resolveLaptopModalCreds(input: ModalSessionConnectInput = {}): {
  tokenId: string
  tokenSecret: string
} | null {
  return tryResolveConnectCredentials(input) ?? readModalTomlTokens() ?? envModalTokens()
}

export function setupModalSessionIpc(getBridge: () => PythonBridge | null): void {
  ipcMain.handle('modal:session:status', async () => getModalSessionPublic())

  ipcMain.handle('modal:session:clear', async () => {
    const status = clearModalSession()
    await applyBridge(getBridge())
    return status
  })

  ipcMain.handle('modal:session:connect', async (_event, input: ModalSessionConnectInput) => {
    const creds = resolveLaptopModalCreds(input ?? {})
    const result = await connectModalSession({
      ...(input ?? {}),
      tokenId: (input?.tokenId ?? '').trim() || creds?.tokenId,
      tokenSecret: (input?.tokenSecret ?? '').trim() || creds?.tokenSecret,
    })
    if (!result.ok) return result
    const ensure = await ensureModalCpuAsgi({
      apiUrl: result.apiUrl,
      tokenId: creds?.tokenId,
      tokenSecret: creds?.tokenSecret,
      bearerToken: (input?.bearerToken ?? '').trim(),
      extraAppRoots: extraAppRoots(),
    })
    if (!ensure.ok) {
      clearModalSession()
      return { ok: false, error: ensure.error, ...getModalSessionPublic() }
    }
    await applyBridge(getBridge())
    return {
      ...result,
      warning: ensure.warning,
    }
  })
}
