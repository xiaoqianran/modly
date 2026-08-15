/**
 * Laptop-only IPC for the in-memory Modal session.
 * Classified `local` — tokens never go to Modal HTTP.
 *
 * Connect looks up the workspace, then if /health is `invalid function call`
 * it deploys via uv + `python -m modal deploy` using MODAL_TOKEN_ID/SECRET.
 * No browser (`modal setup`). No `modal.cmd` (Windows spawn EINVAL).
 */

import { app, ipcMain } from 'electron'
import { tryResolveConnectCredentials, type ModalSessionConnectInput } from '../../src/shared/modalSession'
import { ensureModalCpuAsgi } from './modal-asgi-ensure'
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

export function setupModalSessionIpc(getBridge: () => PythonBridge | null): void {
  ipcMain.handle('modal:session:status', async () => getModalSessionPublic())

  ipcMain.handle('modal:session:clear', async () => {
    const status = clearModalSession()
    await applyBridge(getBridge())
    return status
  })

  ipcMain.handle('modal:session:connect', async (_event, input: ModalSessionConnectInput) => {
    const result = await connectModalSession(input ?? {})
    if (!result.ok) return result
    const creds = tryResolveConnectCredentials(input ?? {})
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
