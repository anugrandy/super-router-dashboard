import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Gauge as GaugeIcon,
  Globe2,
  MapPin,
  Server as ServerIcon,
  Trash2,
} from 'lucide-react'
import {
  api,
  fmtTime,
  type SpeedtestResult,
  type SpeedtestRun,
  type SpeedtestServer,
  type SpeedtestStatus,
} from '../api'
import { PageHeader } from '../components/Layout'
import { DeleteLogButton, LogDeleteDialog } from '../components/LogDelete'
import { useLive } from '../live'

/**
 * Manual speedtest page, built around one deliberate flow:
 *
 *   click → download (live) → upload (live) → final result + details
 *
 * The backend runs both phases in a single job, so the page never asks the user
 * to press a second button. Polling only exists while that job is in flight.
 */
const POLL_MS = 600

const EMPTY_STATUS: SpeedtestStatus = {
  running: false,
  phase: '',
  phase_elapsed: 0,
  elapsed: 0,
  progress: 0,
  live_download_mbps: 0,
  live_upload_mbps: 0,
  live_ping_ms: 0,
  live_jitter_ms: 0,
  client_ip: '',
  client_isp: '',
  server: null,
  log: [],
  result: null,
  error: '',
}

type PublicInfo = { ip: string; isp: string; country: string; error: string }
type PanelState = 'idle' | 'waiting' | 'active' | 'done'

export default function SpeedtestPage() {
  const { t } = useTranslation()
  const { devices, logsChangedAt } = useLive()
  const [status, setStatus] = useState<SpeedtestStatus>(EMPTY_STATUS)
  const [result, setResult] = useState<SpeedtestResult | null>(null)
  const [history, setHistory] = useState<SpeedtestRun[]>([])
  const [publicInfo, setPublicInfo] = useState<PublicInfo | null>(null)
  const [servers, setServers] = useState<SpeedtestServer[]>([])
  const [serverError, setServerError] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [serversLoading, setServersLoading] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)

  const timer = useRef<number | null>(null)
  const alive = useRef(true)
  const serversLoaded = useRef(false)
  const serversFetching = useRef(false)

  const loadHistory = useCallback(async () => {
    try {
      const r = await api.speedtestHistory(20)
      setHistory(r.runs)
    } catch {
      /* history is decorative; a failure must not block the page */
    }
  }, [])

  const loadServers = useCallback(async () => {
    if (serversLoaded.current || serversFetching.current) return
    serversFetching.current = true
    setServersLoading(true)
    setServerError('')
    try {
      const r = await api.speedtestServers(30)
      setServers(r.servers)
      if (r.error) setServerError(r.error)
      serversLoaded.current = true
    } catch (e) {
      setServerError(e instanceof Error ? e.message : t('speedtest.serverLoadError'))
    } finally {
      serversFetching.current = false
      setServersLoading(false)
    }
  }, [t])

  /** Poll only while a run is in flight. */
  const startPolling = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current)

    async function tick() {
      try {
        const s = await api.speedtestStatus()
        if (!alive.current) return
        setStatus(s)
        if (s.running) {
          timer.current = window.setTimeout(tick, POLL_MS)
          return
        }
        timer.current = null
        if (s.result) setResult(s.result)
        if (s.error) setErr(s.error)
        void loadHistory()
        void api.speedtestPublicIp().then((p) => alive.current && setPublicInfo(p)).catch(() => {})
      } catch (e) {
        if (!alive.current) return
        timer.current = null
        setStatus((prev) => ({ ...prev, running: false }))
        setErr(e instanceof Error ? e.message : t('speedtest.startError'))
      }
    }

    void tick()
  }, [loadHistory, t])

  useEffect(() => {
    alive.current = true
    void loadHistory()
    api
      .speedtestStatus()
      .then((s) => {
        if (!alive.current) return
        setStatus(s)
        if (s.result) setResult(s.result)
        if (s.running) startPolling()
      })
      .catch(() => {})
    api
      .speedtestPublicIp()
      .then((p) => alive.current && setPublicInfo(p))
      .catch(() => {})

    return () => {
      alive.current = false
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [loadHistory, startPolling])

  useEffect(() => {
    if (logsChangedAt) void loadHistory()
  }, [logsChangedAt, loadHistory])

  const start = useCallback(async () => {
    setErr('')
    setMsg('')
    try {
      const r = await api.speedtestStart(selectedId ? Number(selectedId) : null)
      if (!r.started) {
        setErr(r.reason || t('speedtest.alreadyRunning'))
        return
      }
      // Clear the previous figures only once the new run is accepted, so a
      // rejected start never wipes the last result from the screen.
      setResult(null)
      setStatus({
        ...EMPTY_STATUS,
        running: true,
        phase: 'server',
        progress: 0.02,
      })
      startPolling()
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('speedtest.startError'))
    }
  }, [selectedId, startPolling, t])

  const running = status.running
  const phase = status.phase || (running ? 'server' : '')
  const selectedServer = selectedId
    ? servers.find((s) => s.id === selectedId) ?? null
    : null
  const statusServer = status.server
  const resultServer = result
    ? {
        id: result.server_id,
        name: result.server_city || result.server_name,
        sponsor: result.server_sponsor,
        country: result.server_country,
        cc: '',
        city: result.server_city,
        host: result.server_host,
        distance: null as number | null,
      }
    : null
  // While an automatic run is discovering its server, do not show the previous
  // run's server as if it were already selected.
  const shownServer = statusServer ?? (running ? selectedServer : selectedServer ?? resultServer)

  const publicIp = status.client_ip || result?.client_ip || publicInfo?.ip || ''
  const publicIsp = status.client_isp || result?.client_isp || publicInfo?.isp || ''

  const downValue = running ? status.live_download_mbps : result?.download_mbps ?? 0
  const upValue = running ? status.live_upload_mbps : result?.upload_mbps ?? 0
  const pingValue = running ? status.live_ping_ms : result?.ping_ms ?? 0
  const jitterValue = running ? status.live_jitter_ms : result?.ping_jitter_ms ?? 0

  // Explicit state per panel, so the waiting/active/done styling can never
  // contradict the stage label above.
  const downloadState: PanelState = !running
    ? result
      ? 'done'
      : 'idle'
    : phase === 'download'
      ? 'active'
      : phase === 'upload'
        ? 'done'
        : 'waiting'
  const uploadState: PanelState = !running
    ? result
      ? 'done'
      : 'idle'
    : phase === 'upload'
      ? 'active'
      : 'waiting'

  const stageLabel = running
    ? phase === 'download'
      ? `1/2 ${t('speedtest.phases.download')}`
      : phase === 'upload'
        ? `2/2 ${t('speedtest.phases.upload')}`
        : t(`speedtest.phases.${phase || 'server'}`)
    : result
      ? t('speedtest.finished')
      : t('speedtest.ready')

  const progressPct = running
    ? Math.max(2, Math.min(100, status.progress * 100))
    : result
      ? 100
      : 0
  const downloadPct = panelPct(downloadState, 'download', status.progress)
  const uploadPct = panelPct(uploadState, 'upload', status.progress)

  return (
    <div>
      <PageHeader title={t('speedtest.title')} subtitle={t('speedtest.subtitle')} />

      {msg && <div className="notice notice-success mb-5">{msg}</div>}
      {err && <div className="notice notice-danger mb-5">{err}</div>}

      {/* ------------------------------------------------------ main test panel */}
      <section className="mb-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={`inline-flex h-9 w-9 shrink-0 items-center justify-center ${
                running || result ? 'text-green' : 'text-muted'
              }`}
            >
              <GaugeIcon size={17} />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-ink">{stageLabel}</div>
              <div className="mono text-[11px] text-muted2">
                {running
                  ? t('speedtest.elapsed', { seconds: status.elapsed.toFixed(0) })
                  : result
                    ? fmtTime(result.at)
                    : t('speedtest.helpShort')}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {running ? (
              <span className="badge badge-online">
                <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-green animate-pulse" />
                {t('speedtest.live')}
              </span>
            ) : result ? (
              <span className="badge badge-online">{t('speedtest.finished')}</span>
            ) : (
              <span className="badge badge-offline">{t('speedtest.ready')}</span>
            )}
            <span className="mono text-[11px] text-muted2">{Math.round(progressPct)}%</span>
          </div>
        </div>

        <div className="mt-4 h-1 overflow-hidden rounded-full bg-surface2">
          <div
            className="h-full rounded-full bg-green transition-[width] duration-500 ease-out"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <div className="mt-6 grid gap-x-10 gap-y-6 md:grid-cols-2">
          <SpeedPanel
            direction="download"
            label={t('speedtest.download')}
            state={downloadState}
            value={downValue}
            barPct={downloadPct}
            stateLabel={panelLabel(downloadState, t)}
          />
          <SpeedPanel
            direction="upload"
            label={t('speedtest.upload')}
            state={uploadState}
            value={upValue}
            barPct={uploadPct}
            stateLabel={panelLabel(uploadState, t)}
          />
        </div>

        <div className="mt-5 flex flex-col items-center gap-3">
          <button
            className="btn btn-primary min-w-[190px] !py-3"
            disabled={running}
            onClick={start}
          >
            {running ? (
              <>
                <span className="inline-block h-3 w-3 rounded-full border-2 border-black/30 border-t-black animate-spin" />
                {t('speedtest.running')}
              </>
            ) : (
              <>
                <GaugeIcon size={15} />
                {t('speedtest.start')}
              </>
            )}
          </button>
          <p className="max-w-[520px] text-center text-[11px] text-muted2 leading-relaxed">
            {t('speedtest.help')}
          </p>
        </div>
      </section>

      {/* --------------------------------------------------- final details */}
      {result && (
        <section className="mb-10">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <h2 className="card-title">{t('speedtest.lastResult')}</h2>
            <span className="mono text-[11px] text-muted2">{fmtTime(result.at)}</span>
          </div>

          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            <Detail
              label={t('speedtest.ping')}
              value={pingValue ? `${pingValue.toFixed(1)} ms` : '—'}
              mono
            />
            <Detail
              label={t('speedtest.jitter')}
              value={jitterValue ? `${jitterValue.toFixed(1)} ms` : '—'}
              mono
            />
            <Detail label={t('speedtest.server')} value={result.server_name || '—'} />
            <Detail
              label={t('speedtest.location')}
              value={
                [result.server_city, result.server_country].filter(Boolean).join(', ') || '—'
              }
            />
            <Detail label={t('speedtest.provider')} value={result.server_sponsor || '—'} />
            <Detail label={t('speedtest.isp')} value={result.client_isp || '—'} />
            <Detail label={t('speedtest.publicIp')} value={result.client_ip || '—'} mono />
            <Detail label={t('speedtest.time')} value={fmtTime(result.at)} mono />
            <Detail
              label={t('speedtest.engine')}
              value={
                result.engine === 'ookla-cli'
                  ? t('speedtest.engineOokla')
                  : t('speedtest.engineFallback')
              }
            />
          </dl>

          <p className="text-[11px] text-muted2 mt-4 leading-relaxed">
            {t('speedtest.pingNote')}
          </p>
          {result.engine !== 'ookla-cli' && (
            <div className="notice notice-muted mt-3">{t('speedtest.fallbackWarning')}</div>
          )}
        </section>
      )}

      {/* ------------------------------------------------- identity + server */}
      <div className="mt-10 grid gap-x-10 gap-y-10 lg:grid-cols-2">
        <section>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="card-title">{t('speedtest.publicIp')}</h2>
              <p className="card-sub mt-1">{t('speedtest.publicIpHint')}</p>
            </div>
            <span className="inline-flex h-8 w-8 items-center justify-center text-muted">
              <Globe2 size={16} />
            </span>
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="mono text-[1.55rem] leading-none tracking-tight text-bright">
              {publicIp || '—'}
            </span>
            {running && <span className="badge badge-online shrink-0">{t('speedtest.live')}</span>}
          </div>
          <p className="mt-1.5 truncate text-[11.5px] text-muted2">
            {publicIsp || t('speedtest.ispUnknown')}
          </p>
          {!publicIp && (
            <p className="mt-2 text-[11px] leading-relaxed text-muted2">
              {t('speedtest.publicIpPending')}
            </p>
          )}
        </section>

        <section>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="card-title">{t('speedtest.server')}</h2>
              <p className="card-sub mt-1">{t('speedtest.serverHint')}</p>
            </div>
            <span className="inline-flex h-8 w-8 items-center justify-center text-muted">
              <ServerIcon size={16} />
            </span>
          </div>

          <label className="mt-4 mb-1.5 block text-[11px] font-medium text-muted">
            {t('speedtest.serverSelect')}
          </label>
          <select
            className="input"
            value={selectedId}
            disabled={running}
            onFocus={() => void loadServers()}
            onMouseDown={() => void loadServers()}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            <option value="">{t('speedtest.autoServer')}</option>
            {serversLoading && (
              <option value="" disabled>
                {t('speedtest.serverLoading')}
              </option>
            )}
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.sponsor ? `${s.sponsor} — ` : ''}
                {s.name}
                {s.country ? ` · ${s.country}` : ''}
              </option>
            ))}
          </select>
          {serverError && (
            <p className="mt-1.5 text-[11px] text-red leading-relaxed">
              {t('speedtest.serverLoadError')}
            </p>
          )}

          <div className="mt-4">
            {shownServer ? (
              <>
                <div className="flex items-center gap-1.5 text-[13px] text-ink">
                  <MapPin size={13} className="text-muted shrink-0" />
                  <span className="truncate">
                    {shownServer.name}
                    {shownServer.country ? `, ${shownServer.country}` : ''}
                  </span>
                </div>
                <div className="mt-1 text-[11.5px] text-muted truncate">
                  {shownServer.sponsor || '—'}
                </div>
                {shownServer.host && (
                  <div className="mono mt-1 text-[10.5px] text-muted2 truncate">
                    {shownServer.host}
                  </div>
                )}
              </>
            ) : (
              <p className="text-[11.5px] text-muted2 leading-relaxed">
                {selectedId ? t('speedtest.serverSelectedHint') : t('speedtest.serverAutoHint')}
              </p>
            )}
          </div>
        </section>
      </div>

      {/* -------------------------------------------------------------- history */}
      <section className="mt-10">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="card-title">{t('speedtest.history')}</h2>
          {history.length > 0 && (
            <button
              className="btn btn-sm btn-danger-quiet"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 size={14} />
              {t('speedtest.deleteAll')}
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <p className="text-[13px] text-muted">{t('speedtest.noHistory')}</p>
        ) : (
          <>
            <p className="mb-2 text-[11px] text-muted2 sm:hidden">
              {t('speedtest.scrollHint')}
            </p>
            <div className="overflow-x-auto">
              <table className="net min-w-[560px] xl:min-w-[760px]">
              <thead>
                <tr>
                  <th>{t('speedtest.time')}</th>
                  <th>{t('speedtest.download')}</th>
                  <th>{t('speedtest.upload')}</th>
                  <th>{t('speedtest.ping')}</th>
                  <th className="hidden xl:table-cell">{t('speedtest.server')}</th>
                  <th>{t('connection.status')}</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td className="mono text-[11px] text-muted whitespace-nowrap">{fmtTime(r.at)}</td>
                    <td className="mono whitespace-nowrap">{r.download_mbps.toFixed(1)} Mbps</td>
                    <td className="mono whitespace-nowrap">{r.upload_mbps.toFixed(1)} Mbps</td>
                    <td className="mono whitespace-nowrap">{r.ping_ms ? `${r.ping_ms.toFixed(1)} ms` : '—'}</td>
                    <td className="hidden text-muted text-xs max-w-[220px] truncate xl:table-cell">
                      {r.server_sponsor || r.server_name || '-'}
                    </td>
                    <td className="whitespace-nowrap">
                      <span className={`badge ${r.ok ? 'badge-online' : 'badge-kicked'}`}>
                        {r.ok ? t('status.ok') : t('status.failed')}
                      </span>
                    </td>
                    <td>
                      <DeleteLogButton
                        scope="speedtest_runs"
                        id={r.id}
                        onDeleted={() => {
                          setMsg(t('speedtest.deleted', { n: 1 }))
                          void loadHistory()
                        }}
                        onError={setErr}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
        )}
      </section>

      <LogDeleteDialog
        open={deleteOpen}
        initialScope="speedtest_runs"
        devices={devices}
        onClose={() => setDeleteOpen(false)}
        onDeleted={(r) => {
          setMsg(r.total ? t('speedtest.deleted', { n: r.total }) : t('logs.nothing'))
          void loadHistory()
        }}
        onError={setErr}
      />
    </div>
  )
}

/** One of the two equal halves of the test. */
function SpeedPanel({
  direction,
  label,
  state,
  value,
  barPct,
  stateLabel,
}: {
  direction: 'download' | 'upload'
  label: string
  state: PanelState
  value: number
  barPct: number
  stateLabel: string
}) {
  const active = state === 'active'
  const done = state === 'done'
  const waiting = state === 'waiting'
  const showValue = active || done
  const Icon = direction === 'download' ? ArrowDown : ArrowUp

  return (
    <div className={`py-2 ${waiting ? 'opacity-55' : ''}`} aria-busy={active}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] ${
              active || done ? 'text-green' : 'text-muted2'
            }`}
          >
            <Icon size={16} />
          </span>
          <span className="truncate text-[12px] font-medium text-muted">{label}</span>
        </div>

        {active ? (
          <span className="badge badge-online shrink-0">
            <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-green animate-pulse" />
            {stateLabel}
          </span>
        ) : done ? (
          <span className="badge badge-online shrink-0">
            <Check size={11} className="mr-1" />
            {stateLabel}
          </span>
        ) : (
          <span className="badge badge-offline shrink-0">{stateLabel}</span>
        )}
      </div>

      <div className="mt-6 flex items-baseline gap-2">
        <span
          className={`mono text-[2.6rem] leading-none font-medium tracking-tight tabular-nums sm:text-[3rem] ${
            active ? 'text-bright' : done ? 'text-ink' : 'text-muted2'
          }`}
        >
          {showValue ? <AnimatedNumber value={value} /> : '—'}
        </span>
        <span className="mono text-[12px] text-muted">Mbps</span>
      </div>

      <div className="mt-4 h-1 overflow-hidden rounded-full bg-surface2">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${
            active ? 'bg-green' : done ? 'bg-green/60' : 'bg-transparent'
          }`}
          style={{ width: `${barPct}%` }}
        />
      </div>
    </div>
  )
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="mini-label truncate">{label}</dt>
      <dd className={`mt-1 truncate text-[13px] text-ink ${mono ? 'mono' : ''}`}>{value}</dd>
    </div>
  )
}

/** Progress inside one phase, from the overall progress the backend reports. */
function panelPct(state: PanelState, direction: 'download' | 'upload', progress: number): number {
  if (state === 'done') return 100
  if (state !== 'active') return 0
  const p = direction === 'download' ? (progress - 0.16) / 0.5 : (progress - 0.66) / 0.31
  return Math.max(2, Math.min(100, p * 100))
}

function panelLabel(state: PanelState, t: TFunction): string {
  if (state === 'active') return t('speedtest.panel.active')
  if (state === 'done') return t('speedtest.panel.done')
  if (state === 'waiting') return t('speedtest.panel.waiting')
  return t('speedtest.panel.ready')
}

/** Count-up number used for both live readings and the final figures. */
function AnimatedNumber({
  value,
  decimals = 1,
  duration = 550,
}: {
  value: number
  decimals?: number
  duration?: number
}) {
  const [shown, setShown] = useState(value)
  const shownRef = useRef(value)

  useEffect(() => {
    const from = shownRef.current
    const target = Number.isFinite(value) ? value : 0
    if (Math.abs(target - from) < 0.001) {
      shownRef.current = target
      setShown(target)
      return
    }
    const start = performance.now()
    let raf = 0
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      const next = from + (target - from) * eased
      shownRef.current = next
      setShown(next)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])

  return <>{shown.toFixed(decimals)}</>
}
