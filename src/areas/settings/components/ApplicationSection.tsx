import { useEffect, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import {
  ALLOWED_REMOTE_GPUS,
  DEFAULT_GPU_LINGER_SECONDS,
  DEFAULT_REMOTE_GPU,
  MAX_GPU_LINGER_SECONDS,
  MIN_GPU_LINGER_SECONDS,
} from '@shared/modalPrefs'
import type { ModalSessionPublic } from '@shared/modalSession'
import { Section, Card, Row, Toggle } from '@shared/ui'

export function ApplicationSection(): JSX.Element {
  const { showRamIndicator, setShowRamIndicator } = useAppStore()
  const [backendMode, setBackendMode] = useState<'local' | 'remote'>('local')
  const [remoteApiUrl, setRemoteApiUrl] = useState('')
  const [remoteApiToken, setRemoteApiToken] = useState('')
  const [gpuLingerSeconds, setGpuLingerSeconds] = useState(DEFAULT_GPU_LINGER_SECONDS)
  const [remoteGpu, setRemoteGpu] = useState(DEFAULT_REMOTE_GPU)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [session, setSession] = useState<ModalSessionPublic | null>(null)
  const [tokenSetCommand, setTokenSetCommand] = useState('')
  const [tokenId, setTokenId] = useState('')
  const [tokenSecret, setTokenSecret] = useState('')
  const [workspaceHint, setWorkspaceHint] = useState('')
  const [sessionStatus, setSessionStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [sessionError, setSessionError] = useState<string | null>(null)

  useEffect(() => {
    window.electron.settings.get().then((s) => {
      setBackendMode(s.backendMode === 'remote' ? 'remote' : 'local')
      setRemoteApiUrl(s.remoteApiUrl ?? '')
      setRemoteApiToken(s.remoteApiToken ?? '')
      setGpuLingerSeconds(s.gpuLingerSeconds ?? DEFAULT_GPU_LINGER_SECONDS)
      setRemoteGpu(s.remoteGpu ?? DEFAULT_REMOTE_GPU)
    })
    window.electron.modal.status().then(setSession)
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

  async function connectSession() {
    setSessionStatus('saving')
    setSessionError(null)
    try {
      const hasTokens = Boolean(tokenSetCommand.trim() || (tokenId.trim() && tokenSecret.trim()) || workspaceHint.trim())
      const result = await window.electron.modal.connect({
        tokenSetCommand: tokenSetCommand.trim(),
        tokenId: tokenId.trim(),
        tokenSecret: tokenSecret.trim(),
        workspace: workspaceHint.trim(),
        apiUrl: hasTokens ? '' : remoteApiUrl.trim(),
        bearerToken: remoteApiToken.trim(),
      })
      setSession(result)
      if (!result.ok) {
        setSessionError(result.error ?? 'Could not start a Modal session')
        setSessionStatus('error')
        setTimeout(() => setSessionStatus('idle'), 4000)
        return
      }
      setTokenSecret('')
      setTokenSetCommand('')
      setSessionStatus('saved')
      setTimeout(() => setSessionStatus('idle'), 2500)
    } catch {
      setSessionStatus('error')
      setTimeout(() => setSessionStatus('idle'), 3000)
    }
  }

  async function forgetSession() {
    const next = await window.electron.modal.clear()
    setSession(next)
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
        description="Local mode starts FastAPI on this machine. Remote mode keeps the UI on 127.0.0.1:8765 and proxies to Modal. A token session lives only in this running app — quit forgets it, so it is applied immediately. Linger still saves on this PC."
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
            <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 p-3 space-y-2">
              <p className="text-xs font-medium text-zinc-300">This-session tokens</p>
              <p className="text-[11px] text-zinc-500">
                Paste your Modal CLI pair. The app looks up the workspace and builds the `.modal.run` URL. Nothing is written to the settings folder. Quit the app to forget.
              </p>
              {session?.active && (
                <p className="text-[11px] text-emerald-400/90 font-mono break-all">
                  {session.workspace ? `${session.workspace} → ` : ''}{session.apiUrl}
                </p>
              )}
              <input
                value={tokenSetCommand}
                onChange={(e) => { setTokenSetCommand(e.target.value); setSessionStatus('idle'); setSessionError(null) }}
                placeholder="modal token set --token-id ak-… --token-secret as-…"
                spellCheck={false}
                autoComplete="off"
                className="w-full px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700/60 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              <input
                value={tokenId}
                onChange={(e) => { setTokenId(e.target.value); setSessionStatus('idle'); setSessionError(null) }}
                placeholder="token-id (ak-…)"
                spellCheck={false}
                autoComplete="off"
                className="w-full px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700/60 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              <input
                type="password"
                value={tokenSecret}
                onChange={(e) => { setTokenSecret(e.target.value); setSessionStatus('idle'); setSessionError(null) }}
                placeholder="token-secret (as-…)"
                spellCheck={false}
                autoComplete="off"
                className="w-full px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700/60 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              <input
                value={workspaceHint}
                onChange={(e) => { setWorkspaceHint(e.target.value); setSessionStatus('idle'); setSessionError(null) }}
                placeholder="workspace name if lookup fails (optional)"
                spellCheck={false}
                className="w-full px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700/60 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              {sessionError && <p className="text-xs text-red-400">{sessionError}</p>}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void connectSession()}
                  disabled={sessionStatus === 'saving'}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-50 ${
                    sessionStatus === 'saved' ? 'bg-emerald-500/15 text-emerald-400' :
                    sessionStatus === 'error' ? 'bg-red-500/15 text-red-400' :
                    'bg-accent/15 hover:bg-accent/25 text-accent-light'
                  }`}
                >
                  {sessionStatus === 'saving' ? 'Connecting…' : sessionStatus === 'saved' ? 'Connected' : sessionStatus === 'error' ? 'Failed' : 'Connect this session'}
                </button>
                {session?.active && (
                  <button
                    type="button"
                    onClick={() => void forgetSession()}
                    className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200"
                  >
                    Forget session
                  </button>
                )}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-zinc-300">Modal URL</p>
              <p className="text-[11px] text-zinc-500 mt-0.5 mb-2">Optional. Used by Connect this session, or Save backend if you want this PC to remember the URL (never the ak-/as- pair).</p>
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
        <Row label="Apply" description="Save linger / GPU / optional remembered URL to this PC. CLI tokens use Connect this session instead.">
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
