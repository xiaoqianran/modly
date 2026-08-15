import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import {
  describeRemoteRunPhase,
  type RemoteRunSnapshot,
} from '@shared/remoteRunPhase'
import { Card } from '@shared/ui'

function phaseClass(id: string): string {
  if (id === 'error') return 'text-red-400'
  if (id === 'done') return 'text-emerald-400'
  if (id === 'cancelled') return 'text-zinc-500'
  if (id === 'downloading_weights' || id === 'starting_gpu' || id === 'accepted') {
    return 'text-amber-300'
  }
  return 'text-accent-light'
}

function formatUsd(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—'
  if (value < 0.0001) return `$${value.toFixed(6)}`
  return `$${value.toFixed(4)}`
}

function shortId(value: string | undefined): string {
  if (!value) return '—'
  return value.length > 14 ? `${value.slice(0, 8)}…` : value
}

export function RemoteRunsCard(): JSX.Element {
  const apiUrl = useAppStore((s) => s.apiUrl)
  const [runs, setRuns] = useState<RemoteRunSnapshot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const runsRef = useRef<RemoteRunSnapshot[]>([])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/runs?limit=8`)
      if (!res.ok) {
        throw new Error(`GET /runs → HTTP ${res.status}`)
      }
      const body = (await res.json()) as { runs?: RemoteRunSnapshot[] }
      const next = Array.isArray(body.runs) ? body.runs : []
      runsRef.current = next
      setRuns(next)
      setError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(
        `${message}. Connect this session must be active, then Generate at least once. Or: curl http://127.0.0.1:8765/runs`,
      )
    } finally {
      setLoading(false)
    }
  }, [apiUrl])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function tick() {
      await load()
      if (cancelled) return
      const live = runsRef.current.some((run) => run.status === 'pending' || run.status === 'running')
      if (live) timer = setTimeout(() => void tick(), 2000)
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [load])

  return (
    <Card
      title="Remote runs"
      description="Live ledger from GET /runs — whether the last Generate is starting the GPU, pulling weights, generating, or already failed. Generate / useApi are unchanged."
    >
      <div className="px-4 py-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-zinc-500">
            {loading ? 'Reading /runs…' : runs.length ? `${runs.length} recent` : 'No runs yet'}
          </p>
          <button
            type="button"
            onClick={() => {
              setLoading(true)
              void load()
            }}
            className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
          >
            Refresh
          </button>
        </div>
        {error && (
          <pre className="text-xs text-red-400 bg-red-950/30 border border-red-900/30 rounded-lg px-3 py-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words select-text font-mono leading-relaxed">
            {error}
          </pre>
        )}
        {!error && !loading && runs.length === 0 && (
          <p className="text-[11px] text-zinc-500">
            Empty until a Generate reaches the CPU ASGI. If the HUD is stuck on Reading image, POST /generate/from-image has not returned yet (CPU cold start or deploy).
          </p>
        )}
        <ul className="space-y-2">
          {runs.map((run) => {
            const phase = describeRemoteRunPhase(run)
            const chain = (run.chain ?? []).join(' → ')
            return (
              <li
                key={run.job_id ?? `${run.created_at}-${run.model_id}`}
                className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 px-3 py-2 space-y-1"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className={`text-xs font-medium ${phaseClass(String(phase.id))}`}>{phase.label}</p>
                  <span className="text-[10px] font-mono text-zinc-500 shrink-0">{run.status ?? '—'}</span>
                </div>
                <p className="text-[11px] text-zinc-400 font-mono break-all">
                  {run.model_id ?? 'model?'} · {shortId(run.job_id)}
                </p>
                {chain && (
                  <p className="text-[10px] text-zinc-500 font-mono break-all leading-relaxed">{chain}</p>
                )}
                <p className="text-[10px] text-zinc-600 font-mono">
                  spawn {shortId(run.spawn_call_id)} · est {formatUsd(run.bill?.estimated_usd)}
                  {run.bill?.gpu ? ` · ${run.bill.gpu}` : ''}
                </p>
                {run.error && (
                  <pre className="text-[11px] text-red-400 bg-red-950/30 border border-red-900/30 rounded-md px-2 py-1.5 max-h-28 overflow-y-auto whitespace-pre-wrap break-words select-text font-mono">
                    {run.error}
                  </pre>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </Card>
  )
}
