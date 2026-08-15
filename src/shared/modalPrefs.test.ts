import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALLOWED_REMOTE_GPUS,
  DEFAULT_GPU_LINGER_SECONDS,
  DEFAULT_REMOTE_GPU,
  MAX_GPU_LINGER_SECONDS,
  MIN_GPU_LINGER_SECONDS,
  clampGpuLingerSeconds,
  modalPrefsBody,
  normalizeRemoteGpu,
} from './modalPrefs.ts'

test('default linger is 60 seconds', () => {
  assert.equal(DEFAULT_GPU_LINGER_SECONDS, 60)
  assert.equal(modalPrefsBody({}).lingerSeconds, 60)
  assert.equal(modalPrefsBody({}).gpu, DEFAULT_REMOTE_GPU)
})

test('clamp linger to the idle bounds', () => {
  assert.equal(clampGpuLingerSeconds(1), MIN_GPU_LINGER_SECONDS)
  assert.equal(clampGpuLingerSeconds(99999), MAX_GPU_LINGER_SECONDS)
  assert.equal(clampGpuLingerSeconds('45'), 45)
  assert.equal(clampGpuLingerSeconds('nope'), DEFAULT_GPU_LINGER_SECONDS)
  assert.equal(clampGpuLingerSeconds(45.6), 46)
})

test('normalize GPU names without inventing a silent A100', () => {
  assert.equal(normalizeRemoteGpu(''), 'L40S')
  assert.equal(normalizeRemoteGpu('a100'), 'A100')
  assert.equal(normalizeRemoteGpu('mystery'), 'L40S')
  assert.ok(ALLOWED_REMOTE_GPUS.includes('L40S'))
  assert.ok(ALLOWED_REMOTE_GPUS.includes('A100-80GB'))
})
