/**
 * Remote 8765 gateway lifecycle. PythonBridge stays a local uvicorn launcher;
 * this module is the only place that starts/stops the overlay gateway.
 */

import { app } from 'electron'
import axios from 'axios'
import { overlayRemoteSettings } from './modal-session'
import { resolveRemoteBackend } from './remote-backend'
import { startRemoteGateway, type StartedGateway } from './remote-gateway'
import { getSettings } from './settings-store'

const API_PORT = 8765
const API_HOST = '127.0.0.1'
const API_BASE_URL = `http://${API_HOST}:${API_PORT}`

export type RemoteBridgeHost = {
  killProcessOnPort: () => Promise<void>
  resolveWorkspaceDir: () => string
  setReady: (ready: boolean) => void
}

const gateways = new WeakMap<object, StartedGateway>()

async function waitLocalHealth(attempts = 40, delayMs = 200): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await axios.get(`${API_BASE_URL}/health`, { timeout: 2000 })
      return
    } catch {
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw new Error('Remote Modal backend did not become ready in time')
}

export async function tryStartRemoteGateway(key: object, host: RemoteBridgeHost): Promise<boolean> {
  const remote = resolveRemoteBackend(overlayRemoteSettings(getSettings(app.getPath('userData'))))
  if (!remote.enabled) return false

  const existing = gateways.get(key)
  if (existing) {
    await waitLocalHealth()
    host.setReady(true)
    return true
  }

  console.log('[PythonBridge] Starting remote gateway →', remote.apiUrl)
  await host.killProcessOnPort()
  const gateway = await startRemoteGateway({
    host: API_HOST,
    port: API_PORT,
    upstreamUrl: remote.apiUrl,
    token: remote.token,
    workspaceDir: host.resolveWorkspaceDir(),
  })
  gateways.set(key, gateway)
  await waitLocalHealth()
  host.setReady(true)
  console.log('[PythonBridge] Remote gateway is ready (local /health; Modal stays scaled to 0 until generate)')
  return true
}

export async function dropRemoteCompute(): Promise<void> {
  try {
    await axios.post(`${API_BASE_URL}/model/unload-all`, {}, { timeout: 5000 })
  } catch {
    /* gateway or Modal already gone */
  }
}

export async function tryStopRemoteGateway(key: object, host: RemoteBridgeHost): Promise<boolean> {
  const gateway = gateways.get(key)
  if (!gateway) return false
  await dropRemoteCompute()
  gateways.delete(key)
  host.setReady(false)
  await gateway.stop()
  console.log('[PythonBridge] Remote gateway stopped')
  return true
}
