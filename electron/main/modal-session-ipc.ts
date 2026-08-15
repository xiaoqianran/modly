/**
 * Laptop-only IPC for the in-memory Modal session.
 * Classified `local` — tokens never go to Modal HTTP.
 */

import { existsSync } from 'node:fs'
import { app, ipcMain } from 'electron'
import type { ModalSessionConnectInput } from '../../src/shared/modalSession'
import { tryResolveConnectCredentials } from '../../src/shared/modalSession'
import { ensureModalCpuAsgi } from './modal-asgi-ensure'
import { getVenvPythonExe } from './python-setup'
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
    const venvPython = getVenvPythonExe(app.getPath('userData'))
    const ensured = await ensureModalCpuAsgi({
      apiUrl: result.apiUrl,
      tokenId: creds?.tokenId,
      tokenSecret: creds?.tokenSecret,
      bearerToken: (input?.bearerToken ?? '').trim(),
      extraAppRoots: [app.getAppPath(), process.cwd()],
      pythonHints: existsSync(venvPython) ? [venvPython] : [],
    })
    if (!ensured.ok) {
      clearModalSession()
      return { ok: false, error: ensured.error, ...getModalSessionPublic() }
    }
    await applyBridge(getBridge())
    return { ...result, warning: ensured.warning, deployed: ensured.deployed }
  })
}
