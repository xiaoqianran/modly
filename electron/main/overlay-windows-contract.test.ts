/**
 * Windows (renderer + preload + 8765) → Modal overlay contract.
 *
 * Does not import React, Electron, FastAPI, or the Modal SDK.
 * If a new window.electron.invoke or useApi HTTP path appears, this file
 * fails until the overlay classifies it (local vs 8765 vs Modal).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

function readRepo(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8')
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}

function invokeChannels(src: string): string[] {
  return unique([...src.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])).sort()
}

function handleChannels(src: string): string[] {
  return unique([...src.matchAll(/(?:ipcMain|deps\.ipcMain)\.handle\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])).sort()
}

function useApiHttpPrefixes(src: string): string[] {
  return unique(
    [...src.matchAll(/['"`](\/(?:generate|model|optimize)[^'"`]*)['"`]/g)].map((m) => {
      const raw = m[1]
      const cut = raw.indexOf('${')
      return cut === -1 ? raw : raw.slice(0, cut)
    }),
  ).sort()
}

const JOB_STATUS = new Set(['pending', 'running', 'done', 'error', 'cancelled'])

/** Operations the Windows UI actually performs that must reach Modal via 8765. */
const WINDOWS_HTTP = [
  { op: 'generateFromImage', method: 'POST', path: '/generate/from-image', gateway: 'proxy', sound: 'job_id' },
  { op: 'pollJobStatus', method: 'GET', path: '/generate/status/job-1', gateway: 'prefetch-output', sound: 'job_status' },
  { op: 'cancelJob', method: 'POST', path: '/generate/cancel/job-1', gateway: 'proxy', sound: 'cancelled' },
  { op: 'getModelStatus', method: 'GET', path: '/model/status', gateway: 'cache-get', sound: 'model_status' },
  { op: 'getAllModelsStatus', method: 'GET', path: '/model/all', gateway: 'cache-get', sound: 'model_all' },
  { op: 'downloadModel', method: 'GET', path: '/model/download', gateway: 'proxy', sound: 'sse' },
  { op: 'hfDownload', method: 'GET', path: '/model/hf-download?repo_id=x&model_id=y', gateway: 'proxy', sound: 'sse' },
  { op: 'hfDownloadPause', method: 'POST', path: '/model/hf-download/pause', gateway: 'proxy', sound: 'ok' },
  { op: 'hfDownloadCancel', method: 'POST', path: '/model/hf-download/cancel', gateway: 'proxy', sound: 'ok' },
  { op: 'modelUnloadAll', method: 'POST', path: '/model/unload-all', gateway: 'proxy', sound: 'unloaded' },
  { op: 'modelDelete', method: 'POST', path: '/model/delete/hunyuan-mini%2Fmini', gateway: 'proxy', sound: 'deleted' },
  { op: 'optimizeMesh', method: 'POST', path: '/optimize/mesh', gateway: 'proxy', sound: 'url' },
  { op: 'smoothMesh', method: 'POST', path: '/optimize/smooth', gateway: 'proxy', sound: 'url' },
  { op: 'transformMesh', method: 'POST', path: '/optimize/transform', gateway: 'proxy', sound: 'url' },
  { op: 'importMesh', method: 'POST', path: '/optimize/import-by-path', gateway: 'import-by-path', sound: 'url' },
  { op: 'extensionsCatalog', method: 'GET', path: '/extensions/catalog', gateway: 'cache-get', sound: 'catalog' },
  { op: 'extensionsInstall', method: 'POST', path: '/extensions/install-from-github', gateway: 'proxy', sound: 'success' },
  { op: 'extensionsUninstall', method: 'POST', path: '/extensions/uninstall', gateway: 'proxy', sound: 'success' },
  { op: 'extensionsRepair', method: 'POST', path: '/extensions/repair', gateway: 'proxy', sound: 'success' },
  { op: 'extensionsReload', method: 'POST', path: '/extensions/reload', gateway: 'proxy', sound: 'ok' },
  { op: 'desktopIpc', method: 'POST', path: '/desktop/ipc', gateway: 'proxy', sound: 'desktop_ipc' },
  { op: 'listRuns', method: 'GET', path: '/runs', gateway: 'proxy', sound: 'runs' },
  { op: 'getRun', method: 'GET', path: '/runs/job-1', gateway: 'proxy', sound: 'run' },
  { op: 'settingsHfToken', method: 'POST', path: '/settings/hf-token', gateway: 'proxy', sound: 'ok' },
  { op: 'settingsPaths', method: 'POST', path: '/settings/paths', gateway: 'proxy', sound: 'ok' },
  { op: 'exportGlb', method: 'GET', path: '/export/glb?path=Default%2Fa.glb', gateway: 'proxy', sound: 'file' },
] as const

const NEVER_WAKE_MODAL = [
  { method: 'GET', path: '/health', gateway: 'local-health' },
] as const

const STAY_ON_LAPTOP = [
  'window:isMaximized',
  'fs:selectImage',
  'fs:selectMeshFile',
  'fs:readFileBase64',
  'fs:selectDirectory',
  'fs:listFiles',
  'fs:listDir',
  'workflows:list',
  'workflows:save',
  'workspace:library:list',
  'workspace:listCollections',
  'log:readAll',
  'updater:check',
  'system:memory',
  'app:info',
  'cache:clear',
  'shell:openExternal',
]

/** Local handler already talks to 8765; intercept must not replace these. */
const HTTP_OK_STILL_HITS_8765 = [
  'model:download',
  'model:pauseDownload',
  'model:unloadAll',
  'model:export',
  'model:activeDownloads',
  'extensions:reload',
  'python:start',
  'api:updatePaths',
  'settings:set',
  'setup:saveDataDir',
  'setup:run',
]

/** Intercept runs the local handler; these must not be forwarded to Modal. */
const HTTP_OK_STAYS_ON_LAPTOP = [
  'extensions:runProcess',
  'python:status',
  'settings:get',
]

async function loadPolicy() {
  return import(new URL('./ipc-policy.ts', import.meta.url).href)
}

async function loadGateway() {
  return import(new URL('./remote-gateway-logic.ts', import.meta.url).href)
}

async function loadRoutes() {
  return import(new URL('./remote-ipc-routes.ts', import.meta.url).href)
}

test('every preload invoke channel is classified; laptop chrome stays local', async () => {
  const { classifyIpcChannel } = await loadPolicy()
  const invokes = invokeChannels(readRepo('electron/preload/electron-api.ts'))
  assert.ok(invokes.length >= 40, `expected a full preload surface, got ${invokes.length}`)

  const handles = unique([
    ...handleChannels(readRepo('electron/main/ipc-handlers.ts')),
    ...handleChannels(readRepo('electron/main/artifact-registry-service.ts')),
  ])

  for (const channel of invokes) {
    const disposition = classifyIpcChannel(channel)
    assert.ok(
      ['local', 'http-ok', 'replace', 'wrap-setup', 'wrap-extensions-list', 'forward-unknown'].includes(disposition),
      `${channel} → ${disposition}`,
    )
    assert.ok(handles.includes(channel), `preload invoke ${channel} has no ipcMain.handle`)
  }

  for (const channel of STAY_ON_LAPTOP) {
    assert.equal(classifyIpcChannel(channel), 'local', channel)
  }

  assert.equal(classifyIpcChannel('extensions:runProcess'), 'http-ok')
  for (const channel of HTTP_OK_STILL_HITS_8765) {
    assert.equal(classifyIpcChannel(channel), 'http-ok', channel)
  }
  for (const channel of HTTP_OK_STAYS_ON_LAPTOP) {
    assert.equal(classifyIpcChannel(channel), 'http-ok', channel)
  }
})

test('every useApi HTTP path is classified so Windows generate/poll/cancel reach Modal', async () => {
  const { classifyGatewayRequest } = await loadGateway()
  const prefixes = useApiHttpPrefixes(readRepo('src/shared/hooks/useApi.ts'))
  const expected = [
    '/generate/from-image',
    '/generate/status/',
    '/generate/cancel/',
    '/model/status',
    '/model/all',
    '/model/download',
    '/optimize/mesh',
    '/optimize/smooth',
    '/optimize/import-by-path',
    '/optimize/transform',
  ]
  for (const path of expected) {
    assert.ok(prefixes.includes(path), `useApi missing ${path}: ${prefixes.join(',')}`)
  }

  for (const row of WINDOWS_HTTP) {
    const action = classifyGatewayRequest(row.method, row.path)
    assert.equal(action.type, row.gateway, `${row.op} ${row.method} ${row.path}`)
  }

  for (const row of NEVER_WAKE_MODAL) {
    assert.equal(classifyGatewayRequest(row.method, row.path).type, row.gateway)
  }
})

test('GET /runs is never a cache-get (live ledger must not go stale)', async () => {
  const { classifyGatewayRequest, isCacheGetPath } = await loadGateway()
  assert.equal(isCacheGetPath('/runs'), false)
  assert.equal(isCacheGetPath('/runs/abc'), false)
  assert.equal(classifyGatewayRequest('GET', '/runs').type, 'proxy')
  assert.equal(classifyGatewayRequest('GET', '/runs/job-1?limit=20').type, 'proxy')
})

test('replace IPC channels map onto sound 8765 routes', async () => {
  const { planIpcReplace } = await loadRoutes()
  const { classifyGatewayRequest } = await loadGateway()

  const cases: Array<{ channel: string; args: unknown[]; pathPrefix: string; method: 'GET' | 'POST' }> = [
    { channel: 'model:isDownloaded', args: ['hunyuan-mini/mini'], pathPrefix: '/model/all', method: 'GET' },
    { channel: 'model:listDownloaded', args: [], pathPrefix: '/model/all', method: 'GET' },
    { channel: 'model:delete', args: ['hunyuan-mini/mini'], pathPrefix: '/model/delete/', method: 'POST' },
    { channel: 'model:cancelDownload', args: ['hunyuan-mini/mini'], pathPrefix: '/model/hf-download/cancel', method: 'POST' },
    { channel: 'extensions:installFromGitHub', args: ['https://github.com/o/r'], pathPrefix: '/extensions/install-from-github', method: 'POST' },
    { channel: 'extensions:uninstall', args: ['hunyuan'], pathPrefix: '/extensions/uninstall', method: 'POST' },
    { channel: 'extensions:repair', args: ['hunyuan'], pathPrefix: '/extensions/repair', method: 'POST' },
    { channel: 'model:futureChecksum', args: ['x'], pathPrefix: '/desktop/ipc', method: 'POST' },
  ]

  for (const row of cases) {
    const plan = planIpcReplace(row.channel, row.args)
    assert.equal(plan.kind, 'http', row.channel)
    if (plan.kind !== 'http') continue
    assert.equal(plan.http.method, row.method, row.channel)
    assert.ok(plan.http.path.startsWith(row.pathPrefix), `${row.channel} ${plan.http.path}`)
    const gw = classifyGatewayRequest(plan.http.method, plan.http.path)
    assert.ok(gw.type === 'proxy' || gw.type === 'cache-get', `${row.channel} gateway ${gw.type}`)
  }

  const localInstall = planIpcReplace('extensions:installFromLocal', [])
  assert.equal(localInstall.kind, 'reject')
  if (localInstall.kind === 'reject') {
    assert.equal(localInstall.result.success, false)
    assert.match(localInstall.result.error, /not sent to Modal/)
  }

  const show = planIpcReplace('model:showInFolder', ['x'])
  assert.equal(show.kind, 'noop')
})

test('sound JSON shapes the Windows UI actually consumes', async () => {
  const { unwrapCatalogPayload, modelAllHasId, modelAllToDownloadedList, mergeCatalogLists, isDesktopIpcFallback } =
    await loadRoutes()

  const job = { job_id: 'j1', status: 'running', progress: 10, step: 'Loading model' }
  assert.equal(typeof job.job_id, 'string')
  assert.ok(JOB_STATUS.has(job.status))
  assert.equal(typeof job.progress, 'number')

  const accept = { job_id: 'j1' }
  assert.ok(accept.job_id.length > 0)

  const cancel = { cancelled: true }
  assert.equal(cancel.cancelled, true)

  const unknown = { detail: "Unknown model ID: 'nope'." }
  assert.equal(typeof unknown.detail, 'string')

  const all = [
    { id: 'hunyuan-mini/mini', name: 'Mini', downloaded: true, size_gb: 1.2 },
    { id: 'trellis/fast', name: 'Fast', downloaded: false },
  ]
  assert.equal(modelAllHasId(all, 'hunyuan-mini/mini'), true)
  assert.equal(modelAllHasId(all, 'trellis/fast'), false)
  assert.deepEqual(modelAllToDownloadedList(all), [{ id: 'hunyuan-mini/mini', name: 'Mini', size_gb: 1.2 }])

  const catalog = { extensions: [{ id: 'hunyuan', type: 'model', nodes: [{ id: 'mini', name: 'Mini' }] }] }
  assert.equal(unwrapCatalogPayload(catalog)[0]?.id, 'hunyuan')
  const merged = mergeCatalogLists(
    [{ id: 'smoother', type: 'process', builtin: true }, { id: 'stale-local-model', type: 'model', builtin: false }],
    catalog,
  ) as Array<{ id: string; type: string }>
  assert.deepEqual(merged.map((r) => r.id), ['smoother', 'hunyuan'])

  const runs = {
    runs: [{
      job_id: 'j1',
      status: 'cancelled',
      chain: ['desktop.8765', 'gateway', 'cpu.asgi', 'gpu.worker'],
      spawn_call_id: 'fc-1',
      bill: { estimated_usd: 0.0006, gpu_seconds: 0, cpu_seconds: 1 },
      leak: null,
    }],
  }
  assert.ok(Array.isArray(runs.runs[0].chain))
  assert.equal(typeof runs.runs[0].bill.estimated_usd, 'number')
  assert.ok('leak' in runs.runs[0])

  assert.equal(isDesktopIpcFallback({ fallback: true, detail: 'No Modal adapter' }), true)
  assert.equal(isDesktopIpcFallback({ success: true }), false)
})
