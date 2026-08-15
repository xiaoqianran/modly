import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeProtoStrings, lookupModalWorkspace, parseGrpcUnaryPayload } from './modal-workspace.ts'

test('decodes protobuf string fields used by WorkspaceNameLookup', () => {
  const username = Buffer.from('pythonmoive')
  const buf = Buffer.concat([
    Buffer.from([0x12, username.length]),
    username,
  ])
  const fields = decodeProtoStrings(buf)
  assert.equal(fields[0]?.field, 2)
  assert.equal(fields[0]?.value, 'pythonmoive')
})

test('reads the payload after a gRPC-web / HTTP2 data frame header', () => {
  const inner = Buffer.from([0x12, 4, 100, 101, 109, 111])
  const frame = Buffer.alloc(5 + inner.length)
  frame[0] = 0
  frame.writeUInt32BE(inner.length, 1)
  inner.copy(frame, 5)
  const payload = parseGrpcUnaryPayload(frame)
  assert.deepEqual(Buffer.from(payload), inner)
})

test('REST lookup prefers username/slug and never returns the secret', async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ username: 'pythonmoive' }),
  })) as unknown as typeof fetch

  const slug = await lookupModalWorkspace('ak-EXAMPLE', 'as-EXAMPLE', {
    fetchImpl,
    grpcLookup: async () => { throw new Error('grpc should not run') },
  })
  assert.equal(slug, 'pythonmoive')
})

test('falls back to gRPC when REST fails, and redacts tokens in the final error', async () => {
  const fetchImpl = (async () => { throw new Error('network as-SHOULDNOTLEAK') }) as unknown as typeof fetch
  const slug = await lookupModalWorkspace('ak-EXAMPLE', 'as-EXAMPLE', {
    fetchImpl,
    grpcLookup: async () => 'Demo_WS',
  })
  assert.equal(slug, 'demo-ws')

  await assert.rejects(
    () => lookupModalWorkspace('ak-EXAMPLE', 'as-SHOULDNOTLEAK', {
      fetchImpl,
      grpcLookup: async () => { throw new Error('denied as-SHOULDNOTLEAK') },
    }),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      assert.equal(message.includes('as-SHOULDNOTLEAK'), false)
      assert.match(message, /workspace|URL|session/i)
      return true
    },
  )
})
