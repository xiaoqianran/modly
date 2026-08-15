import assert from 'node:assert/strict'
import test from 'node:test'

async function load() {
  return import(new URL('./ipc-dispatch.ts', import.meta.url).href)
}

function adapters(log: string[]) {
  return {
    replace: async (channel: string, args: unknown[]) => {
      log.push(`replace:${channel}:${JSON.stringify(args)}`)
      return { success: true, via: 'replace' }
    },
    mergeCatalog: async (listed: unknown) => {
      log.push('merge-catalog')
      return Array.isArray(listed) ? [...listed, { id: 'remote-hunyuan', type: 'model' }] : listed
    },
    forward: async (channel: string, args: unknown[]) => {
      log.push(`forward:${channel}`)
      if (channel === 'extensions:futurePin') {
        const err = new Error('desktop-ipc-fallback')
        throw err
      }
      return { ok: true, channel, args }
    },
  }
}

test('local and http-ok channels never call Modal adapters (process nodes stay on the laptop)', async () => {
  const { dispatchRemoteIpc } = await load()
  const log: string[] = []
  const listener = async () => {
    log.push('listener')
    return { local: true }
  }

  for (const channel of ['fs:selectImage', 'workspace:library:list', 'extensions:runProcess', 'model:download']) {
    log.length = 0
    const result = await dispatchRemoteIpc(channel, {}, [], listener, adapters(log))
    assert.deepEqual(result, { local: true }, channel)
    assert.deepEqual(log, ['listener'], channel)
  }
})

test('replace channels skip the local disk-scan handler', async () => {
  const { dispatchRemoteIpc } = await load()
  const log: string[] = []
  const listener = async () => {
    log.push('listener')
    return { fromDisk: true }
  }
  const result = await dispatchRemoteIpc('model:isDownloaded', {}, ['hunyuan-mini/mini'], listener, adapters(log))
  assert.deepEqual(result, { success: true, via: 'replace' })
  assert.deepEqual(log, ['replace:model:isDownloaded:["hunyuan-mini/mini"]'])
})

test('setup:check wrap forces needed=false so first-run Python install is skipped', async () => {
  const { dispatchRemoteIpc } = await load()
  const result = await dispatchRemoteIpc(
    'setup:check',
    {},
    [],
    async () => ({ needed: true, defaultDataDir: 'C:\\Modly', platform: 'win32', arch: 'x64' }),
    adapters([]),
  )
  assert.deepEqual(result, { needed: false, defaultDataDir: 'C:\\Modly', platform: 'win32', arch: 'x64' })
})

test('extensions:list wrap keeps process builtins and appends the Modal catalog', async () => {
  const { dispatchRemoteIpc } = await load()
  const log: string[] = []
  const result = await dispatchRemoteIpc(
    'extensions:list',
    {},
    [],
    async () => [{ id: 'smoother', type: 'process', builtin: true }],
    adapters(log),
  )
  assert.deepEqual(result, [
    { id: 'smoother', type: 'process', builtin: true },
    { id: 'remote-hunyuan', type: 'model' },
  ])
  assert.deepEqual(log, ['merge-catalog'])
})

test('unknown model/extensions channel falls back to the laptop handler when Modal says fallback', async () => {
  const { dispatchRemoteIpc } = await load()
  const log: string[] = []
  const result = await dispatchRemoteIpc(
    'extensions:futurePin',
    {},
    ['arg'],
    async () => ({ fromLaptop: true }),
    adapters(log),
  )
  assert.deepEqual(result, { fromLaptop: true })
  assert.deepEqual(log, ['forward:extensions:futurePin'])
})

test('unknown model channel returns the Modal adapter body when it is not fallback', async () => {
  const { dispatchRemoteIpc } = await load()
  const log: string[] = []
  const result = await dispatchRemoteIpc(
    'model:futureChecksum',
    {},
    ['x'],
    async () => ({ fromLaptop: true }),
    adapters(log),
  )
  assert.deepEqual(result, { ok: true, channel: 'model:futureChecksum', args: ['x'] })
  assert.deepEqual(log, ['forward:model:futureChecksum'])
})
