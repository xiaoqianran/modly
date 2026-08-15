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

export function parseModalTokenSetCommand(text: string): { tokenId: string; tokenSecret: string } | null {
  const raw = text.trim()
  if (!raw) return null
  const id = raw.match(/--token-id(?:=|\s+)(\S+)/)?.[1]
  const secret = raw.match(/--token-secret(?:=|\s+)(\S+)/)?.[1]
  if (!id || !secret) return null
  return { tokenId: id.trim(), tokenSecret: secret.trim() }
}

export function resolveConnectCredentials(input: ModalSessionConnectInput): {
  tokenId: string
  tokenSecret: string
} {
  const fromCommand = parseModalTokenSetCommand(input.tokenSetCommand ?? '')
  const tokenId = (input.tokenId ?? fromCommand?.tokenId ?? '').trim()
  const tokenSecret = (input.tokenSecret ?? fromCommand?.tokenSecret ?? '').trim()
  if (!tokenId || !tokenSecret) {
    throw new Error('Paste a Modal token-id and token-secret, or the full `modal token set` command')
  }
  return { tokenId, tokenSecret }
}

export function extractWorkspaceSlug(payload: unknown): string | null {
  if (typeof payload === 'string') {
    const slug = slugifyModalWorkspace(payload)
    return slug || null
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
        if (slug) return slug
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
