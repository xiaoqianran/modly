/**
 * Desktop Modal GPU prefs. Pure helpers — no Electron, FastAPI, or Generate.
 *
 * Linger can change at runtime (8765 → POST /settings/modal).
 * GPU SKU is remembered here; Modal applies it on the next `modal deploy`.
 */

export const DEFAULT_GPU_LINGER_SECONDS = 60
export const MIN_GPU_LINGER_SECONDS = 2
export const MAX_GPU_LINGER_SECONDS = 20 * 60
export const DEFAULT_REMOTE_GPU = 'L40S'

export const ALLOWED_REMOTE_GPUS = [
  'L40S',
  'L4',
  'A10',
  'A10G',
  'A100',
  'A100-80GB',
  'H100',
  'H200',
  'T4',
  'B200',
  'RTX-PRO-6000',
] as const

export type RemoteGpu = (typeof ALLOWED_REMOTE_GPUS)[number]

export type ModalPrefsBody = {
  lingerSeconds: number
  gpu: RemoteGpu
}

export function clampGpuLingerSeconds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_GPU_LINGER_SECONDS
  return Math.min(MAX_GPU_LINGER_SECONDS, Math.max(MIN_GPU_LINGER_SECONDS, Math.round(n)))
}

export function normalizeRemoteGpu(value: unknown): RemoteGpu {
  const raw = String(value ?? '').trim()
  const hit = ALLOWED_REMOTE_GPUS.find((gpu) => gpu.toLowerCase() === raw.toLowerCase())
  return hit ?? DEFAULT_REMOTE_GPU
}

export function modalPrefsBody(input: {
  gpuLingerSeconds?: number
  remoteGpu?: string
}): ModalPrefsBody {
  return {
    lingerSeconds: clampGpuLingerSeconds(input.gpuLingerSeconds ?? DEFAULT_GPU_LINGER_SECONDS),
    gpu: normalizeRemoteGpu(input.remoteGpu),
  }
}
