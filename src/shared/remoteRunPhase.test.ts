import assert from 'node:assert/strict'
import test from 'node:test'
import { describeRemoteRunPhase } from './remoteRunPhase.ts'

test('uses the ASGI phase field when present', () => {
  const phase = describeRemoteRunPhase({
    status: 'pending',
    phase: { id: 'starting_gpu', label: 'Starting GPU worker (cold start or image pull)' },
  })
  assert.equal(phase.id, 'starting_gpu')
})

test('pending without spawn is accepted on CPU', () => {
  const phase = describeRemoteRunPhase({
    status: 'pending',
    chain: ['desktop.8765', 'gateway', 'cpu.asgi', 'cpu.accept'],
    spans: [{ name: 'cpu.accept', t0: 1, t1: null }],
  })
  assert.equal(phase.id, 'accepted')
})

test('pending with FunctionCall is GPU cold start / image pull', () => {
  const phase = describeRemoteRunPhase({
    status: 'pending',
    spawn_call_id: 'fc-1',
    chain: ['desktop.8765', 'gateway', 'cpu.asgi', 'gpu.worker'],
    spans: [
      { name: 'cpu.accept', t0: 1, t1: null },
      { name: 'cpu.spawn_gpu', t0: 2, t1: null, detail: 'fc-1' },
    ],
  })
  assert.equal(phase.id, 'starting_gpu')
  assert.match(phase.label, /cold start or image pull/)
})

test('downloading is not classified as loading (substring trap)', () => {
  const phase = describeRemoteRunPhase({
    status: 'running',
    spawn_call_id: 'fc-1',
    spans: [
      { name: 'gpu.generate', t0: 1, t1: null, detail: 'Loading model' },
      { name: 'gpu.step', t0: 2, t1: 2, detail: 'Downloading model weights' },
    ],
  })
  assert.equal(phase.id, 'downloading_weights')
})

test('loading / generating / commit / terminal', () => {
  assert.equal(
    describeRemoteRunPhase({
      status: 'running',
      spans: [{ name: 'gpu.generate', t0: 1, t1: null, detail: 'Loading model' }],
    }).id,
    'loading_model',
  )
  assert.equal(
    describeRemoteRunPhase({
      status: 'running',
      spans: [
        { name: 'gpu.generate', t0: 1, t1: null, detail: 'Loading model' },
        { name: 'gpu.step', t0: 2, t1: 2, detail: 'Generating 3D mesh…' },
      ],
    }).id,
    'generating',
  )
  assert.equal(
    describeRemoteRunPhase({
      status: 'running',
      spans: [{ name: 'gpu.step', t0: 1, t1: 1, detail: 'volume.commit' }],
    }).id,
    'committing',
  )
  assert.equal(describeRemoteRunPhase({ status: 'error', error: 'boom' }).id, 'error')
  assert.equal(describeRemoteRunPhase({ status: 'done' }).id, 'done')
  assert.equal(describeRemoteRunPhase({ status: 'cancelled' }).id, 'cancelled')
})
