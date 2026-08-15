/**
 * Single IPC chokepoint. Installed before setupIpcHandlers so every
 * ipcMain.handle — including ones upstream adds later — goes through
 * classifyIpcChannel. Renderer and ipc-handlers stay Modal-unaware.
 *
 * The switch itself lives in ipc-dispatch.ts so tests do not load Electron.
 */

import { ipcMain } from 'electron'
import { app } from 'electron'
import { dispatchRemoteIpc, type IpcListener } from './ipc-dispatch'
import { resolveRemoteBackend } from './remote-backend'
import { getSettings } from './settings-store'
import { afterSettingsSet, forwardUnknown, mergeRemoteExtensionCatalog, remoteReplaceIpc } from './remote-ipc'

function remoteEnabled(): boolean {
  try {
    return resolveRemoteBackend(getSettings(app.getPath('userData'))).enabled
  } catch {
    return false
  }
}

export function installIpcIntercept(): void {
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: IpcListener) => {
    return originalHandle(channel, async (event: unknown, ...args: unknown[]) => {
      if (!remoteEnabled()) {
        return listener(event, ...args)
      }
      return dispatchRemoteIpc(channel, event, args, listener, {
        replace: remoteReplaceIpc,
        mergeCatalog: mergeRemoteExtensionCatalog,
        forward: forwardUnknown,
        afterSettingsSet,
      })
    })
  }) as typeof ipcMain.handle
}
