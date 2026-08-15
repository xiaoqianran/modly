import assert from 'node:assert/strict'
import test from 'node:test'

async function load() {
  return import(new URL('./ipc-policy.ts', import.meta.url).href)
}

test('disk-scan channels are replaced; HTTP-already-on-8765 stays http-ok', async () => {
  const { classifyIpcChannel } = await load()
  assert.equal(classifyIpcChannel('model:isDownloaded'), 'replace')
  assert.equal(classifyIpcChannel('model:listDownloaded'), 'replace')
  assert.equal(classifyIpcChannel('model:delete'), 'replace')
  assert.equal(classifyIpcChannel('model:cancelDownload'), 'replace')
  assert.equal(classifyIpcChannel('model:download'), 'http-ok')
  assert.equal(classifyIpcChannel('model:export'), 'http-ok')
  assert.equal(classifyIpcChannel('extensions:installFromGitHub'), 'replace')
  assert.equal(classifyIpcChannel('extensions:runProcess'), 'http-ok')
  assert.equal(classifyIpcChannel('python:start'), 'http-ok')
})

test('setup and catalog are wraps so upstream handler text can merge unchanged', async () => {
  const { classifyIpcChannel } = await load()
  assert.equal(classifyIpcChannel('setup:check'), 'wrap-setup')
  assert.equal(classifyIpcChannel('extensions:list'), 'wrap-extensions-list')
  assert.equal(classifyIpcChannel('settings:set'), 'wrap-settings-set')
})

test('local chrome never leaves the laptop', async () => {
  const { classifyIpcChannel } = await load()
  for (const channel of [
    'window:isMaximized',
    'fs:selectImage',
    'fs:listFiles',
    'workflows:save',
    'workspace:library:list',
    'log:readAll',
    'updater:check',
    'modal:session:connect',
    'modal:session:status',
    'modal:session:clear',
  ]) {
    assert.equal(classifyIpcChannel(channel), 'local', channel)
  }
})

test('unknown model/extensions channels forward so upstream IPC needs no Electron patch', async () => {
  const { classifyIpcChannel } = await load()
  assert.equal(classifyIpcChannel('model:futureChecksum'), 'forward-unknown')
  assert.equal(classifyIpcChannel('extensions:futurePin'), 'forward-unknown')
  assert.equal(classifyIpcChannel('brand-new-area:foo'), 'local')
})
