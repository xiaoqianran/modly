/**
 * Local reverse proxy on 127.0.0.1:8765.
 *
 * The renderer, useApi, and Electron IPC keep using API_BASE_URL.
 * This process forwards to Modal and translates the few local-path
 * assumptions upstream cannot see (import-by-path, workspace cache).
 *
 * New FastAPI routes added upstream are proxied automatically.
 */

import http from 'node:http'
import https from 'node:https'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { classifyGatewayRequest, isLocalFsPath, queryParam, workspaceRelFromOutputUrl } from './remote-gateway-logic'

export interface RemoteGatewayOptions {
  host: string
  port: number
  upstreamUrl: string
  token?: string
  workspaceDir: string
}

export interface StartedGateway {
  stop: () => Promise<void>
  port: number
}

const WORKSPACE_MEDIA: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.splat': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

export async function startRemoteGateway(opts: RemoteGatewayOptions): Promise<StartedGateway> {
  const upstream = new URL(opts.upstreamUrl.includes('://') ? opts.upstreamUrl : `https://${opts.upstreamUrl}`)

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, { ...opts, upstream }).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ detail: String(err) }))
      } else {
        res.end()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host, () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : opts.port

  return {
    port,
    stop: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    }),
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RemoteGatewayOptions & { upstream: URL },
): Promise<void> {
  const url = req.url ?? '/'
  const action = classifyGatewayRequest(req.method ?? 'GET', url)

  if (action.type === 'import-by-path') {
    await handleImportByPath(req, res, opts)
    return
  }
  if (action.type === 'serve-local-file') {
    const localPath = queryParam(url, 'path')
    if (localPath && isLocalFsPath(localPath) && existsSync(localPath) && statSync(localPath).isFile()) {
      serveLocalFile(res, localPath)
      return
    }
  }
  if (action.type === 'workspace-cache') {
    const local = join(opts.workspaceDir, action.rel)
    if (existsSync(local) && statSync(local).isFile()) {
      serveLocalFile(res, local)
      return
    }
    await proxyAndCacheWorkspace(req, res, opts, action.rel)
    return
  }
  if (action.type === 'prefetch-output') {
    await proxyAndPrefetch(req, res, opts)
    return
  }

  await pipeProxy(req, res, opts)
}

async function handleImportByPath(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RemoteGatewayOptions & { upstream: URL },
): Promise<void> {
  const raw = await readBody(req)
  let body: { path?: string }
  try {
    body = JSON.parse(raw.toString('utf8')) as { path?: string }
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: 'Invalid JSON' }))
    return
  }

  const filePath = body.path ?? ''
  if (!isLocalFsPath(filePath) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    await pipeProxy(req, res, opts, raw)
    return
  }

  const filename = basename(filePath)
  const fileBuf = readFileSync(filePath)
  const boundary = `----modly${Date.now().toString(16)}`
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  )
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
  const multipart = Buffer.concat([prefix, fileBuf, suffix])

  const upstreamRes = await requestUpstream(opts, {
    method: 'POST',
    path: '/optimize/import',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(multipart.length),
    },
    body: multipart,
  })

  if (upstreamRes.statusCode === 404) {
    // Older Modal image without /optimize/import — fall back to path POST
    // (will 400 on Modal, but keeps the contract visible).
    await pipeProxy(req, res, opts, raw)
    return
  }

  res.writeHead(upstreamRes.statusCode, { 'content-type': 'application/json' })
  res.end(upstreamRes.body)
}

async function proxyAndPrefetch(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RemoteGatewayOptions & { upstream: URL },
): Promise<void> {
  const upstreamRes = await requestUpstream(opts, {
    method: req.method ?? 'GET',
    path: req.url ?? '/',
    headers: forwardedHeaders(req, opts),
    body: undefined,
  })

  const json = parseJson(upstreamRes.body)
  const rel = json && typeof json === 'object'
    ? workspaceRelFromOutputUrl((json as { output_url?: string; outputUrl?: string }).output_url
      ?? (json as { outputUrl?: string }).outputUrl)
    : null
  if (rel) {
    const dest = join(opts.workspaceDir, rel)
    if (!existsSync(dest)) {
      try {
        const fileRes = await requestUpstream(opts, {
          method: 'GET',
          path: `/workspace/${rel.split('/').map(encodeURIComponent).join('/')}`,
          headers: authHeaders(opts),
        })
        if (fileRes.statusCode >= 200 && fileRes.statusCode < 300 && fileRes.body.length > 0) {
          cacheBuffer(dest, fileRes.body)
        }
      } catch {
        // Viewer can still load via a later /workspace/ fetch
      }
    }
  }

  res.writeHead(upstreamRes.statusCode, copyResponseHeaders(upstreamRes.headers))
  res.end(upstreamRes.body)
}

async function proxyAndCacheWorkspace(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RemoteGatewayOptions & { upstream: URL },
  rel: string,
): Promise<void> {
  const upstreamRes = await requestUpstream(opts, {
    method: 'GET',
    path: req.url ?? '/',
    headers: forwardedHeaders(req, opts),
  })
  if (upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300 && upstreamRes.body.length > 0) {
    cacheBuffer(join(opts.workspaceDir, rel), upstreamRes.body)
  }
  res.writeHead(upstreamRes.statusCode, copyResponseHeaders(upstreamRes.headers))
  res.end(upstreamRes.body)
}

function serveLocalFile(res: ServerResponse, filePath: string): void {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  const type = WORKSPACE_MEDIA[ext] ?? 'application/octet-stream'
  const data = readFileSync(filePath)
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(data.length),
    'access-control-expose-headers': 'Content-Length',
  })
  res.end(data)
}

async function pipeProxy(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RemoteGatewayOptions & { upstream: URL },
  preReadBody?: Buffer,
): Promise<void> {
  const target = new URL(req.url ?? '/', opts.upstream)
  const lib = target.protocol === 'https:' ? https : http
  const headers = forwardedHeaders(req, opts)
  if (preReadBody) headers['content-length'] = String(preReadBody.length)

  await new Promise<void>((resolve, reject) => {
    const preq = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (pres) => {
        res.writeHead(pres.statusCode ?? 502, copyResponseHeaders(pres.headers))
        pres.pipe(res)
        pres.on('end', resolve)
        pres.on('error', reject)
      },
    )
    preq.on('error', reject)
    if (preReadBody) {
      preq.end(preReadBody)
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      preq.end()
    } else {
      req.pipe(preq)
    }
  })
}

function forwardedHeaders(req: IncomingMessage, opts: RemoteGatewayOptions & { upstream: URL }): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: opts.upstream.host }
  delete headers.connection
  delete headers['proxy-connection']
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  return headers
}

function authHeaders(opts: RemoteGatewayOptions): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {}
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  return headers
}

function copyResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers }
  delete out.connection
  delete out['transfer-encoding']
  return out
}

function cacheBuffer(dest: string, data: Buffer): void {
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  writeFileSync(tmp, data)
  renameSync(tmp, dest)
}

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function requestUpstream(
  opts: RemoteGatewayOptions & { upstream: URL },
  init: { method: string; path: string; headers?: http.OutgoingHttpHeaders; body?: Buffer },
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const target = new URL(init.path, opts.upstream)
  const lib = target.protocol === 'https:' ? https : http
  const headers: http.OutgoingHttpHeaders = { ...init.headers, host: opts.upstream.host }
  if (opts.token && !headers.authorization) headers.authorization = `Bearer ${opts.token}`

  return new Promise((resolve, reject) => {
    const preq = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: init.method,
        headers,
      },
      (pres) => {
        const chunks: Buffer[] = []
        pres.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        pres.on('end', () => resolve({
          statusCode: pres.statusCode ?? 502,
          headers: pres.headers,
          body: Buffer.concat(chunks),
        }))
        pres.on('error', reject)
      },
    )
    preq.on('error', reject)
    if (init.body) preq.end(init.body)
    else preq.end()
  })
}
