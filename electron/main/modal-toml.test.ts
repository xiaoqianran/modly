import assert from 'node:assert/strict'
import test from 'node:test'
import { envModalTokens, modalTomlCandidatePaths, readModalTomlTokens } from './modal-toml.ts'

test('candidate paths include home .modal.toml and optional APPDATA', () => {
  const paths = modalTomlCandidatePaths({
    USERPROFILE: 'C:\\Users\\demo',
    APPDATA: 'C:\\Users\\demo\\AppData\\Roaming',
    MODAL_CONFIG_PATH: 'D:\\custom\\modal.toml',
  })
  assert.ok(paths.includes('D:\\custom\\modal.toml'))
  assert.ok(paths.some((p) => p.endsWith('.modal.toml') && p.includes('Users')))
})

test('readModalTomlTokens uses the first readable pair and never throws', () => {
  const parsed = readModalTomlTokens({
    paths: ['missing.toml', 'ok.toml'],
    exists: (path) => path === 'ok.toml',
    readFile: () => '[default]\ntoken_id = "ak-FROMFILE"\ntoken_secret = "as-FROMFILE"\n',
  })
  assert.deepEqual(parsed, { tokenId: 'ak-FROMFILE', tokenSecret: 'as-FROMFILE' })
  assert.equal(readModalTomlTokens({ paths: ['x'], exists: () => false }), null)
})

test('envModalTokens requires both ak- and as- prefixes', () => {
  assert.deepEqual(
    envModalTokens({ MODAL_TOKEN_ID: 'ak-ENV', MODAL_TOKEN_SECRET: 'as-ENV' }),
    { tokenId: 'ak-ENV', tokenSecret: 'as-ENV' },
  )
  assert.equal(envModalTokens({ MODAL_TOKEN_ID: 'ak-ENV' }), null)
})
