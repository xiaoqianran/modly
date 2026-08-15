/**
 * Remote-mode IPC switch. Pure: no Electron, no axios.
 * installIpcIntercept() is the only Electron wrapper.
 */

import { classifyIpcChannel } from './ipc-policy'

export type IpcListener = (event: unknown, ...args: unknown[]) => unknown

export const DESKTOP_IPC_FALLBACK = 'desktop-ipc-fallback'

export interface RemoteIpcAdapters {
  replace: (channel: string, args: unknown[]) => Promise<unknown>
  mergeCatalog: (listed: unknown) => Promise<unknown>
  forward: (channel: string, args: unknown[]) => Promise<unknown>
  afterSettingsSet?: (patch: unknown, updated: unknown) => Promise<void>
}

export async function dispatchRemoteIpc(
  channel: string,
  event: unknown,
  args: unknown[],
  listener: IpcListener,
  adapters: RemoteIpcAdapters,
): Promise<unknown> {
  const disposition = classifyIpcChannel(channel)
  switch (disposition) {
    case 'local':
    case 'http-ok':
      return listener(event, ...args)
    case 'replace':
      return adapters.replace(channel, args)
    case 'wrap-setup': {
      const result = await listener(event, ...args) as { needed?: boolean }
      return { ...result, needed: false }
    }
    case 'wrap-extensions-list': {
      const listed = await listener(event, ...args)
      return adapters.mergeCatalog(listed)
    }
    case 'wrap-settings-set': {
      const updated = await listener(event, ...args)
      if (adapters.afterSettingsSet) {
        await adapters.afterSettingsSet(args[0], updated)
      }
      return updated
    }
    case 'forward-unknown':
      try {
        return await adapters.forward(channel, args)
      } catch (err) {
        if (err instanceof Error && err.message === DESKTOP_IPC_FALLBACK) {
          return listener(event, ...args)
        }
        throw err
      }
    default:
      return listener(event, ...args)
  }
}
