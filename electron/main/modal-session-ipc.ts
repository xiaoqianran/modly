/**
 * Laptop-only IPC for the in-memory Modal session.
 * Classified `local` — tokens never go to Modal HTTP.
 */

import { ipcMain } from 'electron'
import type { ModalSessionConnectInput } from '../../src/shared/modalSession'
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
    if (result.ok) {
      await applyBridge(getBridge())
    }
    return result
  })
}
