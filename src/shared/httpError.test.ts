import assert from 'node:assert/strict'
import test from 'node:test'
import { httpErrorMessage } from './httpError.ts'

test('prefers FastAPI string detail over AxiosError.toString()', () => {
  const err = Object.assign(new Error('Request failed with status code 400'), {
    name: 'AxiosError',
    response: {
      data: { detail: "trellis-2 has no isolated venv, so Generate cannot run it on this backend." },
    },
  })
  err.toString = () => 'AxiosError: Request failed with status code 400'
  assert.equal(
    httpErrorMessage(err),
    'trellis-2 has no isolated venv, so Generate cannot run it on this backend.',
  )
})

test('joins FastAPI validation detail arrays', () => {
  const err = {
    response: { data: { detail: [{ msg: 'Field required' }, { msg: 'value is not a valid integer' }] } },
  }
  assert.equal(httpErrorMessage(err), 'Field required; value is not a valid integer')
})

test('falls back to Error.message when there is no detail', () => {
  assert.equal(httpErrorMessage(new Error('boom')), 'boom')
  assert.equal(httpErrorMessage('plain'), 'plain')
})
