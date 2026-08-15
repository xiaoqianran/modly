import assert from 'node:assert/strict'
import test from 'node:test'
import { parseModalTomlProfiles, pickModalTomlTokens } from './modalToml.ts'

test('picks the active profile from a modal token set toml', () => {
  const text = `
[default]
token_id = "ak-DEFAULT"
token_secret = "as-DEFAULT"

[pythonmoive]
token_id = "ak-ACTIVE"
token_secret = "as-ACTIVE"
active = true
`
  assert.deepEqual(pickModalTomlTokens(text), { tokenId: 'ak-ACTIVE', tokenSecret: 'as-ACTIVE' })
  assert.equal(parseModalTomlProfiles(text).length, 2)
})

test('falls back to default then first pair', () => {
  assert.deepEqual(
    pickModalTomlTokens('token_id = ak-BARE\ntoken_secret = as-BARE\n'),
    { tokenId: 'ak-BARE', tokenSecret: 'as-BARE' },
  )
  assert.equal(pickModalTomlTokens(''), null)
  assert.equal(pickModalTomlTokens('[empty]\nactive = true\n'), null)
})
