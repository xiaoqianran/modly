/**
 * One hook in index.ts. Intercept must wrap ipcMain.handle before setupIpcHandlers.
 */

import type { BrowserWindow } from 'electron'
import { setupIpcHandlers } from './ipc-handlers'
import { installIpcIntercept } from './ipc-intercept'
import { setupModalSessionIpc } from './modal-session-ipc'
import type { PythonBridge } from './python-bridge'

export function installOverlay(
  pythonBridge: PythonBridge,
  getWindow: () => BrowserWindow | null,
): void {
  installIpcIntercept()
  setupIpcHandlers(pythonBridge, getWindow)
  setupModalSessionIpc(() => pythonBridge)
}
