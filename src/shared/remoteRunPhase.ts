/** Interpret GET /runs for Settings. Generate / useApi stay unchanged. */

export type RemoteRunPhaseId =
  | 'accepted'
  | 'starting_gpu'
  | 'downloading_weights'
  | 'loading_model'
  | 'generating'
  | 'committing'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled'

export type RemoteRunPhase = { id: RemoteRunPhaseId | string; label: string }

export type RemoteRunSpan = {
  name?: string
  t0?: number
  t1?: number | null
  detail?: string
}

export type RemoteRunSnapshot = {
  job_id?: string
  model_id?: string
  status?: string
  chain?: string[]
  spans?: RemoteRunSpan[]
  spawn_call_id?: string
  error?: string
  created_at?: number
  updated_at?: number
  phase?: RemoteRunPhase
  bill?: { estimated_usd?: number; gpu?: string; gpu_seconds?: number; cpu_seconds?: number }
}

function latestGpuStep(spans: RemoteRunSpan[] | undefined): string {
  if (!spans?.length) return ''
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]
    if (span.name === 'gpu.step' && span.detail) return span.detail
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]
    if (span.name === 'gpu.generate' && span.detail) return span.detail
  }
  return ''
}

function gpuWorkerEntered(spans: RemoteRunSpan[] | undefined): boolean {
  return Boolean(spans?.some((span) => span.name === 'gpu.generate'))
}

/** Same rules as `RunRecord.phase()` — works even if the deployed ASGI has no `phase` field yet. */
export function describeRemoteRunPhase(run: RemoteRunSnapshot): RemoteRunPhase {
  if (run.phase?.id && run.phase.label) {
    return { id: run.phase.id, label: run.phase.label }
  }

  const status = run.status ?? ''
  if (status === 'error') return { id: 'error', label: 'Error' }
  if (status === 'cancelled') return { id: 'cancelled', label: 'Cancelled' }
  if (status === 'done') return { id: 'done', label: 'Done' }

  const latest = latestGpuStep(run.spans)
  const low = latest.toLowerCase()
  // "downloading" contains "load" — check download first.
  if (low.includes('download')) {
    return { id: 'downloading_weights', label: 'Downloading model weights' }
  }
  if (low.includes('commit') || low.includes('saving output')) {
    return { id: 'committing', label: 'Saving output' }
  }
  if (low.includes('generat') || low.includes('mesh')) {
    return { id: 'generating', label: 'Generating 3D mesh' }
  }
  if (low.includes('load')) {
    return { id: 'loading_model', label: 'Loading model' }
  }

  if (!gpuWorkerEntered(run.spans)) {
    if (run.spawn_call_id) {
      return { id: 'starting_gpu', label: 'Starting GPU worker (cold start or image pull)' }
    }
    return { id: 'accepted', label: 'Accepted on CPU — spawning GPU' }
  }

  if (latest) return { id: 'running', label: latest }
  return { id: 'running', label: 'GPU running' }
}
