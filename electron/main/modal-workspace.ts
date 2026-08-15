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
const GRPC_CLIENT_VERSION = '1.3.1'
const GRPC_PATHS = [
  '/modal.client.ModalClient/WorkspaceNameLookup',
  '/modal.client.ModalClient/TokenInfoGet',
] as const

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

export type GrpcHeaderBag = Record<string, string | string[] | undefined>

function headerValue(bag: GrpcHeaderBag, key: string): string {
  const raw = bag[key]
  if (Array.isArray(raw)) return String(raw[0] ?? '')
  return raw == null ? '' : String(raw)
}

export function grpcStatusFromHeaders(
  headers: GrpcHeaderBag,
  trailers: GrpcHeaderBag = {},
): { code: number | null; message: string } {
  const raw = headerValue(headers, 'grpc-status') || headerValue(trailers, 'grpc-status')
  const encoded = headerValue(headers, 'grpc-message') || headerValue(trailers, 'grpc-message')
  let message = encoded
  try {
    message = decodeURIComponent(encoded)
  } catch {
    /* keep */
  }
  if (!raw) return { code: null, message }
  const code = Number(raw)
  return { code: Number.isFinite(code) ? code : null, message }
}

export function workspaceFromLookupPayload(payload: Uint8Array): string | null {
  const fields = decodeProtoStrings(payload)
  const username = fields.find((f) => f.field === 2)?.value
  const workspaceName = fields.find((f) => f.field === 1)?.value
  return extractWorkspaceSlug(username ?? workspaceName ?? '')
}

export function workspaceFromTokenInfoPayload(payload: Uint8Array): string | null {
  const fields = decodeProtoStrings(payload)
  return extractWorkspaceSlug(fields.find((f) => f.field === 3)?.value ?? '')
}

function flattenHeaders(headers: NodeJS.Dict<string | string[]>): GrpcHeaderBag {
  const out: GrpcHeaderBag = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value
  }
  return out
}

async function grpcUnaryEmpty(
  path: string,
  tokenId: string,
  tokenSecret: string,
): Promise<{ payload: Uint8Array; status: { code: number | null; message: string } }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(GRPC_AUTHORITY)
    const chunks: Buffer[] = []
    let headers: GrpcHeaderBag = {}
    let trailers: GrpcHeaderBag = {}
    let settled = false
    const finish = (err?: Error, data?: { payload: Uint8Array; status: { code: number | null; message: string } }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { client.close() } catch { /* already closed */ }
      if (err) reject(err)
      else resolve(data ?? { payload: new Uint8Array(), status: { code: null, message: '' } })
    }
    const timer = setTimeout(() => finish(new Error('Modal workspace lookup timed out')), 12_000)
    client.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))))
    const req = client.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      te: 'trailers',
      'x-modal-token-id': tokenId,
      'x-modal-token-secret': tokenSecret,
      'x-modal-client-type': '1',
      'x-modal-client-version': GRPC_CLIENT_VERSION,
    })
    req.on('response', (incoming) => { headers = flattenHeaders(incoming) })
    req.on('trailers', (incoming) => { trailers = flattenHeaders(incoming) })
    req.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))))
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      const status = grpcStatusFromHeaders(headers, trailers)
      if (status.code !== null && status.code !== 0) {
        finish(new Error(status.message || `Modal gRPC status ${status.code}`))
        return
      }
      if (buf.length < 5) {
        finish(new Error(status.message || 'short gRPC frame'))
        return
      }
      try {
        finish(undefined, { payload: parseGrpcUnaryPayload(buf), status })
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)))
      }
    })
    req.end(Buffer.from([0, 0, 0, 0, 0]))
  })
}

export async function lookupWorkspaceViaGrpc(tokenId: string, tokenSecret: string): Promise<string> {
  const errors: string[] = []
  for (const path of GRPC_PATHS) {
    try {
      const { payload } = await grpcUnaryEmpty(path, tokenId, tokenSecret)
      const slug = path.endsWith('TokenInfoGet')
        ? workspaceFromTokenInfoPayload(payload)
        : workspaceFromLookupPayload(payload)
      if (slug) return slug
      errors.push(`${path} returned no workspace name`)
    } catch (err) {
      errors.push(redactModalSecrets(err instanceof Error ? err.message : String(err)))
    }
  }
  throw new Error(errors.filter(Boolean).join(' / ') || 'Modal gRPC lookup returned no workspace name')
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
        const text = (await res.text()).trim()
        if (!text) {
          lastError = `Modal API ${res.status} empty body`
          continue
        }
        if (!res.ok) {
          lastError = `Modal API ${res.status}`
          continue
        }
        let parsed: unknown = text
        try { parsed = JSON.parse(text) } catch { /* keep text */ }
        const slug = extractWorkspaceSlug(parsed)
        if (slug) return slug
        lastError = `Modal API ${res.status} unrecognized JSON`
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

  const grpcLookup = deps.grpcLookup ?? lookupWorkspaceViaGrpc
  try {
    const slug = slugifyModalWorkspace(await grpcLookup(tokenId, tokenSecret))
    if (slug) return slug
  } catch (err) {
    errors.push(redactModalSecrets(err instanceof Error ? err.message : String(err)))
  }

  if (fetchImpl) {
    try {
      return await lookupWorkspaceViaRest(tokenId, tokenSecret, fetchImpl, restBaseUrl)
    } catch (err) {
      errors.push(redactModalSecrets(err instanceof Error ? err.message : String(err)))
    }
  }

  throw new Error(
    `Could not read the Modal workspace from these tokens. ${errors.filter(Boolean).join(' / ') || 'No lookup method worked'}. You can still paste the https://…modal.run URL for this session, or type the workspace name.`,
  )
}
