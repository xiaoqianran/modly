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

test('gateway answers health locally and caches workspace artifacts', async () => {
  let healthHits = 0
  const jobs: Record<string, { status: string; output_url?: string }> = {
    'job-1': { status: 'done', output_url: '/workspace/Default/out.glb' },
  }
  const upstream = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/health') {
      healthHits += 1
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
    assert.equal(healthHits, 0)

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

test('Windows generate/status/cancel/runs return sound JSON and /runs is never cached', async () => {
  let healthHits = 0
  let runHits = 0
  const jobs: Record<string, { job_id: string; status: string; progress: number; step?: string }> = {}
  const upstream = http.createServer((req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url === '/health') {
      healthHits += 1
      json(200, { status: 'ok' })
      return
    }
    if (method === 'POST' && url === '/generate/from-image') {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (raw.includes('nope')) {
          json(400, { detail: "Unknown model ID: 'nope'." })
          return
        }
        jobs['job-1'] = { job_id: 'job-1', status: 'pending', progress: 0 }
        json(200, { job_id: 'job-1' })
      })
      return
    }
    if (method === 'GET' && url === '/generate/status/job-1') {
      json(200, jobs['job-1'] ?? { job_id: 'job-1', status: 'running', progress: 10, step: 'Loading model' })
      return
    }
    if (method === 'POST' && url === '/generate/cancel/job-1') {
      json(200, { cancelled: true })
      return
    }
    if (method === 'GET' && (url === '/runs' || url.startsWith('/runs?'))) {
      runHits += 1
      json(200, {
        runs: [{
          job_id: 'job-1',
          status: 'running',
          chain: ['desktop.8765', 'gateway', 'cpu.asgi', 'gpu.worker'],
          spawn_call_id: 'fc-1',
          bill: { estimated_usd: 0.01, gpu_seconds: 1, cpu_seconds: 2 },
          leak: null,
        }],
      })
      return
    }
    if (method === 'GET' && url === '/model/all') {
      json(200, [{ id: 'hunyuan-mini/mini', name: 'Mini', downloaded: true }])
      return
    }
    if (method === 'GET' && url === '/extensions/catalog') {
      json(200, { extensions: [{ id: 'hunyuan', type: 'model' }] })
      return
    }
    json(404, { detail: 'not found' })
  })

  const upstreamPort = await listen(upstream)
  const workspaceDir = mkdtempSync(join(tmpdir(), 'modly-contract-'))
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
    assert.equal(healthHits, 0)

    const gen = await axios.post(`${base}/generate/from-image`, 'model_id=hunyuan-mini/mini', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    assert.equal(typeof gen.data.job_id, 'string')
    assert.ok(gen.data.job_id.length > 0)

    const status = await axios.get(`${base}/generate/status/job-1`)
    assert.equal(status.data.job_id, 'job-1')
    assert.ok(['pending', 'running', 'done', 'error', 'cancelled'].includes(status.data.status))
    assert.equal(typeof status.data.progress, 'number')

    const cancel = await axios.post(`${base}/generate/cancel/job-1`)
    assert.equal(cancel.data.cancelled, true)

    const a = await axios.get(`${base}/runs`)
    const b = await axios.get(`${base}/runs`)
    assert.equal(runHits, 2)
    assert.equal(typeof a.data.runs[0].bill.estimated_usd, 'number')
    assert.deepEqual(a.data.runs[0].chain.slice(0, 3), ['desktop.8765', 'gateway', 'cpu.asgi'])
    assert.equal(b.data.runs[0].spawn_call_id, 'fc-1')

    try {
      await axios.post(`${base}/generate/from-image`, 'model_id=nope', {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
      assert.fail('unknown model must be 400')
    } catch (err: unknown) {
      const ax = err as { response?: { status?: number; data?: { detail?: string } } }
      assert.equal(ax.response?.status, 400)
      assert.match(String(ax.response?.data?.detail), /Unknown model ID/)
    }

    const models = await axios.get(`${base}/model/all`)
    assert.equal(models.data[0].downloaded, true)
    const catalog = await axios.get(`${base}/extensions/catalog`)
    assert.equal(catalog.data.extensions[0].id, 'hunyuan')
  } finally {
    await gateway.stop()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})

test('gateway coalesces catalog GETs and does not wake Modal for health', async () => {
  let catalogHits = 0
  const upstream = http.createServer((req, res) => {
    if (req.url === '/extensions/catalog') {
      catalogHits += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ id: 'hunyuan' }]))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const upstreamPort = await listen(upstream)
  const workspaceDir = mkdtempSync(join(tmpdir(), 'modly-cache-'))
  const { startRemoteGateway } = await loadGateway()
  const gateway = await startRemoteGateway({
    host: '127.0.0.1',
    port: 0,
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    workspaceDir,
  })
  try {
    const base = `http://127.0.0.1:${gateway.port}`
    const [a, b] = await Promise.all([
      axios.get(`${base}/extensions/catalog`),
      axios.get(`${base}/extensions/catalog`),
    ])
    assert.deepEqual(a.data, [{ id: 'hunyuan' }])
    assert.deepEqual(b.data, [{ id: 'hunyuan' }])
    assert.equal(catalogHits, 1)
    const c = await axios.get(`${base}/extensions/catalog`)
    assert.deepEqual(c.data, [{ id: 'hunyuan' }])
    assert.equal(catalogHits, 1)
  } finally {
    await gateway.stop()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
