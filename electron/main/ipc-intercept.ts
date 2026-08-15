/**
 * Single IPC chokepoint. Installed before setupIpcHandlers so every
 * ipcMain.handle — including ones upstream adds later — goes through
 * classifyIpcChannel. Renderer and ipc-handlers stay Modal-unaware.
 */

import { ipcMain } from 'electron'
import { app } from 'electron'
import { classifyIpcChannel } from './ipc-policy'
import { resolveRemoteBackend } from './remote-backend'
import { getSettings } from './settings-store'
import { forwardUnknown, mergeRemoteExtensionCatalog, remoteReplaceIpc } from './remote-ipc'

type IpcListener = (event: unknown, ...args: unknown[]) => unknown

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

      const disposition = classifyIpcChannel(channel)
      switch (disposition) {
        case 'local':
        case 'http-ok':
          return listener(event, ...args)
        case 'replace':
          return remoteReplaceIpc(channel, args)
        case 'wrap-setup': {
          const result = await listener(event, ...args) as { needed?: boolean }
          return { ...result, needed: false }
        }
        case 'wrap-extensions-list': {
          const listed = await listener(event, ...args)
          return mergeRemoteExtensionCatalog(listed)
        }
        case 'forward-unknown':
          try {
            return await forwardUnknown(channel, args)
          } catch (err) {
            if (err instanceof Error && err.message === 'desktop-ipc-fallback') {
              return listener(event, ...args)
            }
            throw err
          }
        default:
          return listener(event, ...args)
      }
    })
  }) as typeof ipcMain.handle
}
