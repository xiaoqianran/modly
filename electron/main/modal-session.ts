/**
 * In-memory Modal session for this Electron process only.
 * Never writes token-id / token-secret / URL to userData/settings.json.
 */

import {
  buildModalRunUrl,
  mergeRemoteSession,
  normalizeRemoteApiUrl,
  publicModalSession,
  redactModalSecrets,
  tryResolveConnectCredentials,
  slugifyModalWorkspace,
  type ModalSessionConnectInput,
  type ModalSessionOverlay,
  type ModalSessionPublic,
  type RemoteSessionFields,
} from '../../src/shared/modalSession'
import { lookupModalWorkspace, type WorkspaceLookupDeps } from './modal-workspace'

let session: ModalSessionOverlay | null = null

export function getModalSession(): ModalSessionOverlay | null {
  return session
}

export function getModalSessionPublic(): ModalSessionPublic {
  return publicModalSession(session)
}

export function clearModalSession(): ModalSessionPublic {
  session = null
  return getModalSessionPublic()
}

export function overlayRemoteSettings(disk: RemoteSessionFields): RemoteSessionFields {
  return mergeRemoteSession(disk, session)
}

export type ModalSessionConnectResult = ModalSessionPublic & {
  ok: boolean
  error?: string
  warning?: string
}

function applySession(next: ModalSessionOverlay): ModalSessionConnectResult {
  session = {
    apiUrl: normalizeRemoteApiUrl(next.apiUrl),
    workspace: next.workspace,
    bearerToken: (next.bearerToken ?? '').trim(),
  }
  return { ok: true, ...getModalSessionPublic() }
}

export async function connectModalSession(
  input: ModalSessionConnectInput,
  deps: WorkspaceLookupDeps = {},
): Promise<ModalSessionConnectResult> {
  try {
    const bearerToken = (input.bearerToken ?? '').trim()
    const typedWorkspace = slugifyModalWorkspace(input.workspace ?? '')
    const pastedUrl = (input.apiUrl ?? '').trim()
    const creds = tryResolveConnectCredentials(input)

    if (creds) {
      try {
        const workspace = await lookupModalWorkspace(creds.tokenId, creds.tokenSecret, deps)
        return applySession({
          apiUrl: buildModalRunUrl(workspace),
          workspace,
          bearerToken,
        })
      } catch (err) {
        if (typedWorkspace) {
          return applySession({
            apiUrl: buildModalRunUrl(typedWorkspace),
            workspace: typedWorkspace,
            bearerToken,
          })
        }
        throw err
      }
    }

    if (typedWorkspace) {
      return applySession({
        apiUrl: buildModalRunUrl(typedWorkspace),
        workspace: typedWorkspace,
        bearerToken,
      })
    }

    if (pastedUrl) {
      const parsed = new URL(pastedUrl)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('URL must be http(s)')
      }
      return applySession({
        apiUrl: pastedUrl,
        workspace: typedWorkspace || undefined,
        bearerToken,
      })
    }

    throw new Error('Run `python -m modal token set` once (writes ~/.modal.toml), or paste the token pair, a workspace name, or the https://…modal.run URL')
  } catch (err) {
    const error = redactModalSecrets(err instanceof Error ? err.message : String(err))
    return { ok: false, error, ...getModalSessionPublic() }
  }
}
