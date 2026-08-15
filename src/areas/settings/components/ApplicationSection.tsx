import { useEffect, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import {
  ALLOWED_REMOTE_GPUS,
  DEFAULT_GPU_LINGER_SECONDS,
  DEFAULT_REMOTE_GPU,
  MAX_GPU_LINGER_SECONDS,
  MIN_GPU_LINGER_SECONDS,
} from '@shared/modalPrefs'
import { Section, Card, Row, Toggle } from '@shared/ui'

export function ApplicationSection(): JSX.Element {
  const { showRamIndicator, setShowRamIndicator } = useAppStore()
  const [backendMode, setBackendMode] = useState<'local' | 'remote'>('local')
  const [remoteApiUrl, setRemoteApiUrl] = useState('')
  const [remoteApiToken, setRemoteApiToken] = useState('')
  const [gpuLingerSeconds, setGpuLingerSeconds] = useState(DEFAULT_GPU_LINGER_SECONDS)
  const [remoteGpu, setRemoteGpu] = useState(DEFAULT_REMOTE_GPU)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => {
    window.electron.settings.get().then((s) => {
      setBackendMode(s.backendMode === 'remote' ? 'remote' : 'local')
      setRemoteApiUrl(s.remoteApiUrl ?? '')
      setRemoteApiToken(s.remoteApiToken ?? '')
      setGpuLingerSeconds(s.gpuLingerSeconds ?? DEFAULT_GPU_LINGER_SECONDS)
      setRemoteGpu(s.remoteGpu ?? DEFAULT_REMOTE_GPU)
    })
  }, [])

  async function saveBackend() {
    setStatus('saving')
    try {
      if (backendMode === 'remote') {
        const parsed = new URL(remoteApiUrl.trim())
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('invalid url')
        }
      }
      await window.electron.settings.set({
        backendMode,
        remoteApiUrl: remoteApiUrl.trim().replace(/\/+$/, ''),
        remoteApiToken: remoteApiToken.trim(),
        gpuLingerSeconds,
        remoteGpu,
      })
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2500)
    } catch {
      setStatus('error')
      setTimeout(() => setStatus('idle'), 3000)
    }
  }

  return (
    <Section title="Application" subtitle="General application settings.">
      <Card title="Interface">
        <Row
          label="RAM indicator"
          description="Show live memory usage in the top bar."
        >
          <Toggle value={showRamIndicator} onChange={setShowRamIndicator} />
        </Row>
      </Card>

      <Card
        title="Compute backend"
        description="Local mode starts FastAPI on this machine. Remote mode keeps the UI on 127.0.0.1:8765 and proxies to Modal. Restart only if you change Mode or URL. Linger applies as soon as this save reaches the backend."
      >
        <Row label="Mode" description="Switching Mode or URL does not take effect until you restart Modly.">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setBackendMode('local')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                backendMode === 'local' ? 'bg-accent/20 text-accent-light' : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              Local GPU
            </button>
            <button
              type="button"
              onClick={() => setBackendMode('remote')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                backendMode === 'remote' ? 'bg-accent/20 text-accent-light' : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              Modal
            </button>
          </div>
        </Row>
        {backendMode === 'remote' && (
          <div className="px-4 py-3 space-y-3">
            <div>
              <p className="text-xs font-medium text-zinc-300">Modal URL</p>
              <p className="text-[11px] text-zinc-500 mt-0.5 mb-2">From `modal deploy modal/app.py`.</p>
              <input
                value={remoteApiUrl}
                onChange={(e) => { setRemoteApiUrl(e.target.value); setStatus('idle') }}
                placeholder="https://…modly-backend-fastapi-app.modal.run"
                spellCheck={false}
                className="w-full px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700/60 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
            </div>
            <div>
              <p className="text-xs font-medium text-zinc-300">API token</p>
              <p className="text-[11px] text-zinc-500 mt-0.5 mb-2">Optional Bearer token.</p>
              <input
                type="password"
                value={remoteApiToken}
                onChange={(e) => { setRemoteApiToken(e.target.value); setStatus('idle') }}
                placeholder="optional"
                spellCheck={false}
                className="w-full px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700/60 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
            </div>
            <div>
              <p className="text-xs font-medium text-zinc-300">GPU linger after success</p>
              <p className="text-[11px] text-zinc-500 mt-0.5 mb-2">
                Seconds the GPU stays warm so the next Generate does not reload Hunyuan. Default {DEFAULT_GPU_LINGER_SECONDS}s. Cancel still drops in 2s.
              </p>
              <input
                type="number"
                min={MIN_GPU_LINGER_SECONDS}
                max={MAX_GPU_LINGER_SECONDS}
                value={gpuLingerSeconds}
                onChange={(e) => {
                  setGpuLingerSeconds(Number(e.target.value))
                  setStatus('idle')
                }}
                className="w-28 px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700/60 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-500"
              />
              <span className="ml-2 text-[11px] text-zinc-500">seconds ({MIN_GPU_LINGER_SECONDS}–{MAX_GPU_LINGER_SECONDS})</span>
            </div>
            <div>
              <p className="text-xs font-medium text-zinc-300">GPU type</p>
              <p className="text-[11px] text-zinc-500 mt-0.5 mb-2">
                Saved on this PC. Modal applies the card on the next `modal deploy` (`MODLY_GPU=…`). Linger does not wait for that.
              </p>
              <select
                value={remoteGpu}
                onChange={(e) => { setRemoteGpu(e.target.value); setStatus('idle') }}
                className="w-full max-w-xs px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700/60 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-500"
              >
                {ALLOWED_REMOTE_GPUS.map((gpu) => (
                  <option key={gpu} value={gpu}>
                    {gpu}{gpu === DEFAULT_REMOTE_GPU ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        <Row label="Apply" description="Restart Modly only after changing Mode or URL.">
          <button
            type="button"
            onClick={() => void saveBackend()}
            disabled={status === 'saving'}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-50 ${
              status === 'saved' ? 'bg-emerald-500/15 text-emerald-400' :
              status === 'error' ? 'bg-red-500/15 text-red-400' :
              'bg-accent/15 hover:bg-accent/25 text-accent-light'
            }`}
          >
            {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? 'Failed' : 'Save backend'}
          </button>
        </Row>
      </Card>
    </Section>
  )
}
