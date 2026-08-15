import assert from 'node:assert/strict'
import test from 'node:test'
import {
  absorbModalTokenPaste,
  buildModalRunUrl,
  extractWorkspaceSlug,
  mergeRemoteSession,
  parseModalTokenSetCommand,
  publicModalSession,
  redactModalSecrets,
  resolveConnectCredentials,
  slugifyModalWorkspace,
} from './modalSession.ts'

test('builds the FastAPI URL from a workspace slug', () => {
  assert.equal(
    buildModalRunUrl('pythonmoive'),
    'https://pythonmoive--modly-backend-fastapi-app.modal.run',
  )
  assert.equal(
    buildModalRunUrl(' My_Workspace '),
    'https://my-workspace--modly-backend-fastapi-app.modal.run',
  )
})

test('parses a pasted modal token set command without keeping extra flags', () => {
  const parsed = parseModalTokenSetCommand(
    'modal token set --token-id ak-EXAMPLEID --token-secret as-EXAMPLESECRET --profile work',
  )
  assert.deepEqual(parsed, { tokenId: 'ak-EXAMPLEID', tokenSecret: 'as-EXAMPLESECRET' })
  assert.equal(parseModalTokenSetCommand('not a command'), null)
  assert.deepEqual(
    parseModalTokenSetCommand('modal token set --token-id "ak-QUOTEDID" --token-secret=\'as-QUOTEDSECRET\''),
    { tokenId: 'ak-QUOTEDID', tokenSecret: 'as-QUOTEDSECRET' },
  )
})

test('resolveConnectCredentials accepts either fields or the CLI command', () => {
  const fromFields = resolveConnectCredentials({ tokenId: 'ak-1', tokenSecret: 'as-2' })
  assert.deepEqual(fromFields, { tokenId: 'ak-1', tokenSecret: 'as-2' })
  const fromCmd = resolveConnectCredentials({
    tokenSetCommand: 'modal token set --token-id=ak-3 --token-secret=as-4',
  })
  assert.deepEqual(fromCmd, { tokenId: 'ak-3', tokenSecret: 'as-4' })
  assert.throws(() => resolveConnectCredentials({}), /token-id/)
})

test('empty dedicated fields do not hide a pasted modal token set command', () => {
  const fromEmptyFields = resolveConnectCredentials({
    tokenSetCommand: 'modal token set --token-id ak-ONLYCMD --token-secret as-ONLYCMD',
    tokenId: '',
    tokenSecret: '',
  })
  assert.deepEqual(fromEmptyFields, { tokenId: 'ak-ONLYCMD', tokenSecret: 'as-ONLYCMD' })

  const fromIdBox = resolveConnectCredentials({
    tokenId: 'modal token set --token-id ak-INID --token-secret as-INID',
    tokenSecret: '',
  })
  assert.deepEqual(fromIdBox, { tokenId: 'ak-INID', tokenSecret: 'as-INID' })
})

test('absorbModalTokenPaste splits a CLI line pasted into any one box', () => {
  const absorbed = absorbModalTokenPaste(
    { tokenSetCommand: '', tokenId: '', tokenSecret: '' },
    'tokenSetCommand',
    'modal token set --token-id ak-PASTED --token-secret as-PASTED',
  )
  assert.equal(absorbed.tokenId, 'ak-PASTED')
  assert.equal(absorbed.tokenSecret, 'as-PASTED')
})

test('extracts a workspace slug from common Modal JSON shapes', () => {
  assert.equal(extractWorkspaceSlug({ username: 'pythonmoive' }), 'pythonmoive')
  assert.equal(extractWorkspaceSlug({ data: { slug: 'Team_Name' } }), 'team-name')
  assert.equal(extractWorkspaceSlug({ workspace: { name: 'demo' } }), 'demo')
  assert.equal(extractWorkspaceSlug({}), null)
  assert.equal(extractWorkspaceSlug({ username: 'ak-NOTAWORKSPACE' }), null)
  assert.equal(slugifyModalWorkspace(''), '')
})

test('session overlay wins over disk without writing secrets onto disk fields we do not have', () => {
  const merged = mergeRemoteSession(
    { backendMode: 'local', remoteApiUrl: 'https://old.example', remoteApiToken: 'disk' },
    { apiUrl: 'https://pythonmoive--modly-backend-fastapi-app.modal.run/', workspace: 'pythonmoive' },
  )
  assert.equal(merged.backendMode, 'remote')
  assert.equal(merged.remoteApiUrl, 'https://pythonmoive--modly-backend-fastapi-app.modal.run')
  assert.equal(merged.remoteApiToken, 'disk')
  assert.deepEqual(mergeRemoteSession({ backendMode: 'local' }, null), { backendMode: 'local' })
})

test('public session never claims persistence and hides an empty bearer', () => {
  const pub = publicModalSession({
    apiUrl: 'https://demo--modly-backend-fastapi-app.modal.run',
    workspace: 'demo',
    bearerToken: '',
  })
  assert.equal(pub.active, true)
  assert.equal(pub.persisted, false)
  assert.equal(pub.hasBearer, false)
  assert.equal(publicModalSession(null).active, false)
})

test('redacts Modal-looking tokens from error text', () => {
  const redacted = redactModalSecrets('failed ak-ABCDEFG and as-HIJKLMN leftover')
  assert.equal(redacted.includes('ak-'), false)
  assert.equal(redacted.includes('as-'), false)
  assert.match(redacted, /\[redacted\]/)
})
