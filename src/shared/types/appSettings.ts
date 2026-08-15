export type BackendMode = 'local' | 'remote'

/** Persisted in Electron userData/settings.json. Optional fields keep old files valid. */
export interface AppSettings {
  modelsDir: string
  workspaceDir: string
  workflowsDir: string
  extensionsDir: string
  dependenciesDir: string
  hfToken?: string
  backendMode?: BackendMode
  remoteApiUrl?: string
  remoteApiToken?: string
  /** Seconds GPU stays warm after a successful generate. Default 60. */
  gpuLingerSeconds?: number
  /** Preferred Modal GPU SKU. Applied on the next `modal deploy`. */
  remoteGpu?: string
}

export type AppSettingsPatch = Partial<AppSettings>
