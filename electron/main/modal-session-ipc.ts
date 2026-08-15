/**
 * Laptop-only IPC for the in-memory Modal session.
 * Classified `local` — tokens never go to Modal HTTP.
 *
 * Connect does not spawn a local `modal` CLI (Windows EINVAL / no PATH).
 * First-time register is scripts/deploy-modal.bat.
 */

import { ipcMain } from 'electron'
import type { ModalSessionConnectInput } from '../../src/shared/modalSession'
import { probeModalAsgi } from './modal-asgi-ensure'
import {
  clearModalSession,
  connectModalSession,
  getModalSessionPublic,
} from './modal-session'
import type { PythonBridge } from './python-bridge'

const NOT_DEPLOYED =
  'This Modal workspace has no live modly-backend CPU app. Double-click scripts\\deploy-modal.bat (needs uv), log in, then Connect again. Deploy registers the empty shell; it does not keep GPU/CPU running.'

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
    const probe = await probeModalAsgi(result.apiUrl, (input?.bearerToken ?? '').trim())
    if (probe.kind === 'not-deployed') {
      clearModalSession()
      return { ok: false, error: NOT_DEPLOYED, ...getModalSessionPublic() }
    }
    await applyBridge(getBridge())
    return {
      ...result,
      warning: probe.kind === 'unreachable'
        ? `Modal CPU /health did not answer yet (${probe.detail}). Catalog may fail until the container is up.`
        : undefined,
    }
  })
}
