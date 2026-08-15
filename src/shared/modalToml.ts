/**
 * Parse the file written by `python -m modal token set`.
 * Official location is ~/.modal.toml (Windows: %USERPROFILE%\.modal.toml).
 * This module is pure — no disk I/O.
 */

const TOKEN_ID_RE = /\b(ak-[A-Za-z0-9_-]+)/
const TOKEN_SECRET_RE = /\b(as-[A-Za-z0-9_-]+)/

export type ModalTomlProfile = {
  name: string
  active: boolean
  tokenId: string
  tokenSecret: string
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function extractPrefixed(text: string, kind: 'ak' | 'as'): string {
  const match = text.match(kind === 'ak' ? TOKEN_ID_RE : TOKEN_SECRET_RE)
  return match?.[1] ?? ''
}

export function parseModalTomlProfiles(text: string): ModalTomlProfile[] {
  const lines = (text || '').replace(/\r/g, '').split('\n')
  const profiles: ModalTomlProfile[] = []
  let current: ModalTomlProfile = { name: 'default', active: false, tokenId: '', tokenSecret: '' }

  const flush = () => {
    if (current.tokenId && current.tokenSecret) profiles.push(current)
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = line.match(/^\[([^\]]+)\]$/)
    if (section) {
      flush()
      current = { name: section[1].trim() || 'default', active: false, tokenId: '', tokenSecret: '' }
      continue
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const value = unquote(kv[2])
    if (key === 'token_id' || key === 'token-id') current.tokenId = extractPrefixed(value, 'ak')
    if (key === 'token_secret' || key === 'token-secret') current.tokenSecret = extractPrefixed(value, 'as')
    if (key === 'active' && /^(true|1|yes)$/i.test(value)) current.active = true
  }
  flush()
  return profiles
}

/** Prefer the active profile, then [default], then the first pair. */
export function pickModalTomlTokens(text: string): { tokenId: string; tokenSecret: string } | null {
  const profiles = parseModalTomlProfiles(text)
  const chosen = profiles.find((p) => p.active)
    || profiles.find((p) => p.name.toLowerCase() === 'default')
    || profiles[0]
  if (!chosen?.tokenId || !chosen.tokenSecret) return null
  return { tokenId: chosen.tokenId, tokenSecret: chosen.tokenSecret }
}
