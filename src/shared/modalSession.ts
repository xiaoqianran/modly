/**
 * Session-only Modal connection helpers. Pure — no Electron, no disk, no secrets I/O.
 *
 * CLI token-id / token-secret authenticate api.modal.com so we can learn the
 * workspace slug and build https://<workspace>--modly-backend-fastapi-app.modal.run.
 * Those tokens are not the optional FastAPI Bearer on that URL.
 */

export const DEFAULT_MODAL_APP = 'modly-backend'
export const DEFAULT_MODAL_FUNCTION = 'fastapi-app'

export type RemoteSessionFields = {
  backendMode?: string
  remoteApiUrl?: string
  remoteApiToken?: string
}

export type ModalSessionOverlay = {
  apiUrl: string
  workspace?: string
  bearerToken?: string
}

export type ModalSessionPublic = {
  active: boolean
  workspace: string
  apiUrl: string
  hasBearer: boolean
  persisted: false
}

export type ModalSessionConnectInput = {
  tokenId?: string
  tokenSecret?: string
  tokenSetCommand?: string
  apiUrl?: string
  workspace?: string
  bearerToken?: string
}

export function normalizeRemoteApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function slugifyModalWorkspace(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]/g, '')
}

export function buildModalRunUrl(
  workspace: string,
  appName = DEFAULT_MODAL_APP,
  functionName = DEFAULT_MODAL_FUNCTION,
): string {
  const slug = slugifyModalWorkspace(workspace)
  if (!slug) throw new Error('Workspace name is empty')
  const app = appName.trim().toLowerCase().replace(/_/g, '-')
  const fn = functionName.trim().toLowerCase().replace(/_/g, '-')
  return `https://${slug}--${app}-${fn}.modal.run`
}

const TOKEN_ID_RE = /\b(ak-[A-Za-z0-9_-]+)/
const TOKEN_SECRET_RE = /\b(as-[A-Za-z0-9_-]+)/
const COMMAND_HINT_RE = /modal\s+token\s+set|--token-id|--token-secret/i

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function firstGroup(match: RegExpMatchArray | null): string {
  if (!match) return ''
  return stripWrappingQuotes(match[1] || match[2] || match[3] || '')
}

function extractPrefixedToken(text: string, kind: 'ak' | 'as'): string {
  const match = text.replace(/\r/g, '').match(kind === 'ak' ? TOKEN_ID_RE : TOKEN_SECRET_RE)
  return match?.[1] ?? ''
}

/** True when this box holds a whole CLI command, not a single token. */
function looksLikeTokenSetCommand(text: string): boolean {
  const raw = text.replace(/\r/g, '').trim()
  return Boolean(raw) && COMMAND_HINT_RE.test(raw) && /\s/.test(raw)
}

/**
 * Accepts the official CLI line, quoted flags, or a blob that merely
 * contains `ak-…` and `as-…`. Empty dedicated fields must not hide a
 * successful parse of the pasted command.
 */
export function parseModalTokenSetCommand(text: string): { tokenId: string; tokenSecret: string } | null {
  const raw = text.replace(/\r/g, '\n').trim()
  if (!raw) return null
  const flagId = firstGroup(raw.match(/--token-id(?:\s*=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i))
  const flagSecret = firstGroup(raw.match(/--token-secret(?:\s*=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i))
  const tokenId = extractPrefixedToken(flagId, 'ak') || extractPrefixedToken(raw, 'ak')
  const tokenSecret = extractPrefixedToken(flagSecret, 'as') || extractPrefixedToken(raw, 'as')
  if (!tokenId || !tokenSecret) return null
  return { tokenId, tokenSecret }
}

export function tryResolveConnectCredentials(
  input: ModalSessionConnectInput,
): { tokenId: string; tokenSecret: string } | null {
  try {
    return resolveConnectCredentials(input)
  } catch {
    return null
  }
}

export function resolveConnectCredentials(input: ModalSessionConnectInput): {
  tokenId: string
  tokenSecret: string
} {
  const blob = [input.tokenSetCommand, input.tokenId, input.tokenSecret]
    .filter((part) => (part ?? '').trim())
    .join('\n')
  const fromBlob = parseModalTokenSetCommand(blob)
  const tokenId = (
    looksLikeTokenSetCommand(input.tokenId ?? '') ? '' : extractPrefixedToken(input.tokenId ?? '', 'ak')
  ) || fromBlob?.tokenId || ''
  const tokenSecret = (
    looksLikeTokenSetCommand(input.tokenSecret ?? '') ? '' : extractPrefixedToken(input.tokenSecret ?? '', 'as')
  ) || fromBlob?.tokenSecret || ''
  if (!tokenId || !tokenSecret) {
    throw new Error('Paste a Modal token-id and token-secret, or the full `modal token set` command')
  }
  return { tokenId, tokenSecret }
}

/** When the user pastes the CLI line into any one box, fill the pair. */
export function absorbModalTokenPaste(
  current: { tokenSetCommand: string; tokenId: string; tokenSecret: string },
  field: 'tokenSetCommand' | 'tokenId' | 'tokenSecret',
  value: string,
): { tokenSetCommand: string; tokenId: string; tokenSecret: string } {
  const next = { ...current, [field]: value }
  const parsed = parseModalTokenSetCommand([next.tokenSetCommand, next.tokenId, next.tokenSecret].join('\n'))
  if (!parsed) return next
  return {
    tokenSetCommand: looksLikeTokenSetCommand(value) ? value.trim() : next.tokenSetCommand,
    tokenId: parsed.tokenId,
    tokenSecret: parsed.tokenSecret,
  }
}

function isUsableWorkspaceSlug(slug: string): boolean {
  if (!slug || slug.length < 2 || slug.length > 64) return false
  if (/^(ak|as|wk|ws|tk)-/i.test(slug)) return false
  return true
}

export function extractWorkspaceSlug(payload: unknown): string | null {
  if (typeof payload === 'string') {
    const slug = slugifyModalWorkspace(payload)
    return isUsableWorkspaceSlug(slug) ? slug : null
  }
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const nested = [record.data, record.workspace, record.current].filter((v) => v && typeof v === 'object')
  const keys = ['username', 'slug', 'workspace_name', 'workspaceName', 'name', 'workspace']
  for (const bag of [record, ...nested as Record<string, unknown>[]]) {
    for (const key of keys) {
      const value = bag[key]
      if (typeof value === 'string') {
        const slug = slugifyModalWorkspace(value)
        if (isUsableWorkspaceSlug(slug)) return slug
      }
    }
  }
  return null
}

export function mergeRemoteSession(
  disk: RemoteSessionFields,
  session: ModalSessionOverlay | null | undefined,
): RemoteSessionFields {
  if (!session?.apiUrl) return disk
  return {
    ...disk,
    backendMode: 'remote',
    remoteApiUrl: normalizeRemoteApiUrl(session.apiUrl),
    remoteApiToken: (session.bearerToken ?? disk.remoteApiToken ?? '').trim(),
  }
}

export function publicModalSession(session: ModalSessionOverlay | null | undefined): ModalSessionPublic {
  if (!session?.apiUrl) {
    return { active: false, workspace: '', apiUrl: '', hasBearer: false, persisted: false }
  }
  return {
    active: true,
    workspace: session.workspace ?? '',
    apiUrl: normalizeRemoteApiUrl(session.apiUrl),
    hasBearer: Boolean((session.bearerToken ?? '').trim()),
    persisted: false,
  }
}

const SECRET_PATTERN = /\b(?:ak|as|wk|ws)-[A-Za-z0-9_-]+\b/g

export function redactModalSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '[redacted]')
}
