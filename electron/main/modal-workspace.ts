/**
 * Resolve a Modal workspace slug from CLI tokens.
 * Tokens stay in the arguments — this file never writes them.
 */

import http2 from 'node:http2'
import { extractWorkspaceSlug, redactModalSecrets, slugifyModalWorkspace } from '../../src/shared/modalSession'

export type WorkspaceLookupDeps = {
  fetchImpl?: typeof fetch
  grpcLookup?: (tokenId: string, tokenSecret: string) => Promise<string>
  restBaseUrl?: string
}

const DEFAULT_REST = 'https://api.modal.com'
const GRPC_AUTHORITY = 'https://api.modal.com'
const GRPC_PATH = '/modal.client.ModalClient/WorkspaceNameLookup'

export function decodeProtoStrings(buf: Uint8Array): Array<{ field: number; value: string }> {
  const out: Array<{ field: number; value: string }> = []
  let i = 0
  while (i < buf.length) {
    const tag = buf[i++]
    const field = tag >> 3
    const wire = tag & 7
    if (wire === 2) {
      let len = 0
      let shift = 0
      while (i < buf.length) {
        const b = buf[i++]
        len |= (b & 0x7f) << shift
        if ((b & 0x80) === 0) break
        shift += 7
      }
      const slice = buf.subarray(i, i + len)
      i += len
      out.push({ field, value: new TextDecoder().decode(slice) })
    } else if (wire === 0) {
      while (i < buf.length && (buf[i++] & 0x80) !== 0) { /* skip varint */ }
    } else {
      break
    }
  }
  return out
}

export function parseGrpcUnaryPayload(buf: Uint8Array): Uint8Array {
  if (buf.length < 5) throw new Error('short gRPC frame')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const length = view.getUint32(1)
  return buf.subarray(5, 5 + length)
}

function workspaceFromProto(payload: Uint8Array): string | null {
  const fields = decodeProtoStrings(payload)
  const username = fields.find((f) => f.field === 2)?.value
  const workspaceName = fields.find((f) => f.field === 1)?.value
  return extractWorkspaceSlug(username ?? workspaceName ?? '')
}

export async function lookupWorkspaceViaGrpc(tokenId: string, tokenSecret: string): Promise<string> {
  const payload = await new Promise<Uint8Array>((resolve, reject) => {
    const client = http2.connect(GRPC_AUTHORITY)
    const chunks: Buffer[] = []
    let settled = false
    const finish = (err?: Error, data?: Uint8Array) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { client.close() } catch { /* already closed */ }
      if (err) reject(err)
      else resolve(data ?? new Uint8Array())
    }
    const timer = setTimeout(() => finish(new Error('Modal workspace lookup timed out')), 12_000)
    client.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))))
    const req = client.request({
      ':method': 'POST',
      ':path': GRPC_PATH,
      'content-type': 'application/grpc',
      te: 'trailers',
      'x-modal-token-id': tokenId,
      'x-modal-token-secret': tokenSecret,
      'x-modal-client-type': '1',
      'x-modal-client-version': '0.77.0',
    })
    req.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))))
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => finish(undefined, Buffer.concat(chunks)))
    req.end(Buffer.from([0, 0, 0, 0, 0]))
  })

  const proto = parseGrpcUnaryPayload(payload)
  const slug = workspaceFromProto(proto)
  if (!slug) throw new Error('Modal gRPC lookup returned no workspace name')
  return slug
}

function authHeaderSets(tokenId: string, tokenSecret: string): Array<Record<string, string>> {
  return [
    { 'x-modal-token-id': tokenId, 'x-modal-token-secret': tokenSecret },
    { Authorization: `Bearer ${tokenId}.${tokenSecret}` },
    { Authorization: `Bearer ${tokenId}:${tokenSecret}` },
  ]
}

async function lookupWorkspaceViaRest(
  tokenId: string,
  tokenSecret: string,
  fetchImpl: typeof fetch,
  restBaseUrl: string,
): Promise<string> {
  const paths = ['/v1/workspaces/current', '/workspaces/current']
  let lastError = 'Modal REST workspace lookup failed'
  for (const path of paths) {
    for (const headers of authHeaderSets(tokenId, tokenSecret)) {
      try {
        const res = await fetchImpl(`${restBaseUrl}${path}`, {
          method: 'GET',
          headers: { Accept: 'application/json', ...headers },
          signal: AbortSignal.timeout(10_000),
        })
        const text = await res.text()
        if (!res.ok) {
          lastError = `Modal API ${res.status}`
          continue
        }
        let parsed: unknown = text
        try { parsed = JSON.parse(text) } catch { /* keep text */ }
        const slug = extractWorkspaceSlug(parsed)
        if (slug) return slug
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
  }
  throw new Error(lastError)
}

export async function lookupModalWorkspace(
  tokenId: string,
  tokenSecret: string,
  deps: WorkspaceLookupDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const restBaseUrl = (deps.restBaseUrl ?? DEFAULT_REST).replace(/\/+$/, '')
  const errors: string[] = []

  if (fetchImpl) {
    try {
      return await lookupWorkspaceViaRest(tokenId, tokenSecret, fetchImpl, restBaseUrl)
    } catch (err) {
      errors.push(redactModalSecrets(err instanceof Error ? err.message : String(err)))
    }
  }

  const grpcLookup = deps.grpcLookup ?? lookupWorkspaceViaGrpc
  try {
    const slug = slugifyModalWorkspace(await grpcLookup(tokenId, tokenSecret))
    if (slug) return slug
  } catch (err) {
    errors.push(redactModalSecrets(err instanceof Error ? err.message : String(err)))
  }

  throw new Error(
    `Could not read the Modal workspace from these tokens. ${errors.filter(Boolean).join(' / ') || 'No lookup method worked'}. You can still paste the https://…modal.run URL for this session, or type the workspace name.`,
  )
}
