import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import axios from 'axios'

async function loadGateway() {
  return import(new URL('./remote-gateway.ts', import.meta.url).href)
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'))
        return
      }
      resolve(addr.port)
    })
  })
}

test('gateway proxies health and caches workspace artifacts', async () => {
  const jobs: Record<string, { status: string; output_url?: string }> = {
    'job-1': { status: 'done', output_url: '/workspace/Default/out.glb' },
  }
  const upstream = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (url === '/generate/status/job-1') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(jobs['job-1']))
      return
    }
    if (url === '/workspace/Default/out.glb') {
      res.writeHead(200, { 'content-type': 'model/gltf-binary' })
      res.end(Buffer.from('glb-bytes'))
      return
    }
    if (url === '/future/new-feature') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ added: 'upstream' }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const upstreamPort = await listen(upstream)
  const workspaceDir = mkdtempSync(join(tmpdir(), 'modly-gw-'))
  mkdirSync(join(workspaceDir, 'Default'), { recursive: true })

  const { startRemoteGateway } = await loadGateway()
  const gateway = await startRemoteGateway({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    workspaceDir,
  })

  try {
    const base = `http://127.0.0.1:${gateway.port}`
    const health = await axios.get(`${base}/health`)
    assert.deepEqual(health.data, { status: 'ok' })

    const future = await axios.get(`${base}/future/new-feature`)
    assert.deepEqual(future.data, { added: 'upstream' })

    const status = await axios.get(`${base}/generate/status/job-1`)
    assert.equal(status.data.status, 'done')
    const cached = readFileSync(join(workspaceDir, 'Default', 'out.glb'), 'utf8')
    assert.equal(cached, 'glb-bytes')
  } finally {
    await gateway.stop()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})

test('import-by-path uploads a local file to /optimize/import', async () => {
  let uploadedName = ''
  const upstream = http.createServer((req, res) => {
    if (req.url === '/optimize/import' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        uploadedName = body.includes('mesh.glb') ? 'mesh.glb' : ''
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ url: '/workspace/Imports/mesh.glb' }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  const upstreamPort = await listen(upstream)
  const workspaceDir = mkdtempSync(join(tmpdir(), 'modly-imp-'))
  const localFile = join(workspaceDir, 'mesh.glb')
  writeFileSync(localFile, 'local-glb')

  const { startRemoteGateway } = await loadGateway()
  const gateway = await startRemoteGateway({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    workspaceDir,
  })

  try {
    const { data } = await axios.post(`http://127.0.0.1:${gateway.port}/optimize/import-by-path`, {
      path: localFile,
    })
    assert.equal(data.url, '/workspace/Imports/mesh.glb')
    assert.equal(uploadedName, 'mesh.glb')
  } finally {
    await gateway.stop()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
