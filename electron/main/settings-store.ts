import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { clampGpuLingerSeconds, normalizeRemoteGpu } from '../../src/shared/modalPrefs'
import type { AppSettings } from '../../src/shared/types/appSettings'

export type { AppSettings } from '../../src/shared/types/appSettings'

function settingsPath(userData: string): string {
  return join(userData, 'settings.json')
}

function normalizeSaved(saved: Partial<AppSettings> & Record<string, unknown>): Partial<AppSettings> {
  const next: Partial<AppSettings> = { ...saved }
  if (saved['outputsDir'] && !saved.workspaceDir) {
    next.workspaceDir = String(saved['outputsDir'])
  }
  if (next.gpuLingerSeconds !== undefined) {
    next.gpuLingerSeconds = clampGpuLingerSeconds(next.gpuLingerSeconds)
  }
  if (next.remoteGpu !== undefined) {
    next.remoteGpu = normalizeRemoteGpu(next.remoteGpu)
  }
  return next
}

export function getSettings(userData: string): AppSettings {
  const defaults: AppSettings = {
    modelsDir:        join(userData, 'models'),
    workspaceDir:     join(userData, 'workspace'),
    workflowsDir:     join(userData, 'workflows'),
    extensionsDir:    join(userData, 'extensions'),
    dependenciesDir:  join(userData, 'dependencies'),
  }

  const file = settingsPath(userData)
  if (!existsSync(file)) return defaults

  try {
    const saved = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings> & Record<string, unknown>
    return { ...defaults, ...normalizeSaved(saved) }
  } catch {
    return defaults
  }
}

export function setSettings(userData: string, patch: Partial<AppSettings>): AppSettings {
  const updated = { ...getSettings(userData), ...normalizeSaved(patch) }
  writeFileSync(settingsPath(userData), JSON.stringify(updated, null, 2), 'utf-8')
  return updated
}
