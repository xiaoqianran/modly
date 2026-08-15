/**
 * Read credentials written by `python -m modal token set`.
 * Never writes the file. Never copies values into settings.json.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pickModalTomlTokens } from '../../src/shared/modalToml'
import { redactModalSecrets } from '../../src/shared/modalSession'

export function modalTomlCandidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE || env.HOME || ''
  const appData = env.APPDATA || ''
  const fromEnv = (env.MODAL_CONFIG_PATH || '').trim()
  return [
    fromEnv,
    home ? join(home, '.modal.toml') : '',
    appData ? join(appData, 'Modal', '.modal.toml') : '',
    appData ? join(appData, '.modal.toml') : '',
  ].filter(Boolean)
}

export function readModalTomlTokens(opts?: {
  paths?: string[]
  readFile?: (path: string) => string
  exists?: (path: string) => boolean
}): { tokenId: string; tokenSecret: string } | null {
  const exists = opts?.exists ?? existsSync
  const readFile = opts?.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  for (const path of opts?.paths ?? modalTomlCandidatePaths()) {
    if (!path || !exists(path)) continue
    try {
      const parsed = pickModalTomlTokens(readFile(path))
      if (parsed) return parsed
    } catch (err) {
      void redactModalSecrets(err instanceof Error ? err.message : String(err))
    }
  }
  return null
}

export function envModalTokens(env: NodeJS.ProcessEnv = process.env): { tokenId: string; tokenSecret: string } | null {
  const tokenId = (env.MODAL_TOKEN_ID || '').trim()
  const tokenSecret = (env.MODAL_TOKEN_SECRET || '').trim()
  if (!tokenId.startsWith('ak-') || !tokenSecret.startsWith('as-')) return null
  return { tokenId, tokenSecret }
}
