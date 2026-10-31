import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  fmtTime,
  type SpeedtestResult,
  type SpeedtestRun,
} from '../api'
import { PageHeader } from '../components/Layout'
import { ArrowDown, Gauge, Upload } from 'lucide-react'

/**
 * Manual speedtest page.
 *
 * Performance rules baked in:
 * - **Nothing polls while idle.** The status poller exists only between a click
 *   and completion, and is torn down afterwards. No background timer.
 * - **Polls are throttled** to 1.5s - a test takes 10-30s and 1.5s granularity is
 *   plenty for a progress label.
 * - **History is loaded once** on mount and after a finished run; no interval.
 */
const POLL_MS = 1500

export default function SpeedtestPage() {
  const [status, setStatus] = useState<{
    running: boolean
    phase: string
    elapsed: number
  }>({ running: false, phase: '', elapsed: 0 })
  const [result, setResult] = useState<SpeedtestResult | null>(null)
  const [history, setHistory] = useState<SpeedtestRun[]>([])
  const [err, setErr] = useState('')
  const timer = useRef<number | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const r = await api.speedtestHistory(20)
      setHistory(r.runs)
    } catch {
      /* history is decorative; a failure must not block the page */
    }
  }, [])

  useEffect(() => {
    void loadHistory()
    // Restore the last result so the page is useful before any test runs.
    api
      .speedtestStatus()
      .then((s) => {
        if (s.result) setResult(s.result)
        if (s.running) setStatus({ running: true, phase: s.phase, elapsed: 0 })
      })
      .catch(() => {})
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [loadHistory])

  const start = useCallback(async () => {
    setErr('')
    try {
      const r = await api.speedtestStart()
      if (!r.started) {
        setErr(r.reason || 'Test sudah berjalan')
        return
      }
      setStatus({ running: true, phase: 'Memulai…', elapsed: 0 })
      // Poller lives only for the duration of this run.
      timer.current = window.setInterval(async () => {
        try {
          const s = await api.speedtestStatus()
          if (!s.running) {
            // Stop first, then update state: the button must never stay in the
            // running state after results arrive.
            if (timer.current) window.clearInterval(timer.current)
            timer.current = null
            setStatus({ running: false, phase: '', elapsed: 0 })
            if (s.result) setResult(s.result)
            if (s.error) setErr(s.error)
            void loadHistory()
          } else {
            setStatus({ running: true, phase: s.phase, elapsed: s.elapsed })
          }
        } catch {
          if (timer.current) window.clearInterval(timer.current)
          timer.current = null
          setStatus({ running: false, phase: '', elapsed: 0 })
        }
      }, POLL_MS)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal memulai speedtest')
    }
  }, [loadHistory])

  return (
    <div>
      <PageHeader
        title="Speedtest"
        subtitle="Manual — tidak pernah jalan otomatis"
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-1">
          <button
            className="btn btn-primary w-full !py-3"
            disabled={status.running}
            onClick={start}
          >
            {status.running ? (
              <>
                <span className="inline-block w-3 h-3 rounded-full border-2 border-black/30 border-t-black animate-spin" />
                Menjalankan…
              </>
            ) : (
              'Mulai Test'
            )}
          </button>

          <p className="text-[11px] text-muted2 mt-3 leading-relaxed">
            Test memakai bandwidth penuh selama ±10–30 detik, jadi tidak
            dijalankan otomatis. Klik lagi setelah selesai untuk mengulang.
          </p>

          {status.running && (
            <div className="mt-4 rounded-md border border-border px-3 py-2.5">
              <div className="text-[13px] text-ink">{status.phase || 'Menguji…'}</div>
              <div className="mono text-[11px] text-muted mt-0.5">
                {status.elapsed.toFixed(0)} detik berjalan
              </div>
              {/* Determinate bar driven only by elapsed time: no extra polling. */}
              <div className="mt-2 h-1 rounded-sm bg-surface2 overflow-hidden">
                <div
                  className="h-full bg-bright transition-all"
                  style={{ width: `${Math.min(95, (status.elapsed / 30) * 100)}%` }}
                />
              </div>
            </div>
          )}

          {err && (
            <div className="mt-4 rounded-md border border-red/40 px-3 py-2.5 text-[12px] text-red">
              {err}
            </div>
          )}
        </div>

        <div className="card p-5 lg:col-span-2">
          <h2 className="card-title mb-4">Hasil terakhir</h2>
          {result ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Metric
                  icon={<ArrowDown size={16} />}
                  label="Download"
                  value={`${result.download_mbps.toFixed(1)}`}
                  unit="Mbps"
                />
                <Metric
                  icon={<Upload size={16} />}
                  label="Upload"
                  value={`${result.upload_mbps.toFixed(1)}`}
                  unit="Mbps"
                />
                <Metric
                  icon={<Gauge size={16} />}
                  label="Ping"
                  value={result.ping_ms ? result.ping_ms.toFixed(1) : '—'}
                  unit="ms"
                />
              </div>
              <dl className="mt-5 space-y-1.5 text-[12px]">
                <Line k="Server" v={result.server_name || '-'} />
                <Line k="Provider" v={result.server_sponsor || '-'} />
                <Line k="Lokasi" v={result.server_country || '-'} />
                <Line k="ISP kamu" v={result.client_isp || '-'} />
                <Line k="Waktu" v={fmtTime(result.at)} mono />
              </dl>
              <p className="text-[11px] text-muted2 mt-3 leading-relaxed">
                Ping diukur sebagai median waktu koneksi TCP ke server yang sama
                (speedtest-cli melaporkan angka tidak valid di koneksi ini).
              </p>
            </>
          ) : (
            <p className="text-[13px] text-muted">
              Belum ada hasil. Tekan “Mulai Test”.
            </p>
          )}
        </div>
      </div>

      <div className="card p-5 mt-4">
        <h2 className="card-title mb-4">Riwayat test</h2>
        {history.length === 0 ? (
          <p className="text-[13px] text-muted">Belum ada riwayat.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="net">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Download</th>
                  <th>Upload</th>
                  <th>Ping</th>
                  <th>Server</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td className="mono text-[11px] text-muted">{fmtTime(r.at)}</td>
                    <td className="mono">{r.download_mbps.toFixed(1)} Mbps</td>
                    <td className="mono">{r.upload_mbps.toFixed(1)} Mbps</td>
                    <td className="mono">
                      {r.ping_ms ? `${r.ping_ms.toFixed(1)} ms` : '—'}
                    </td>
                    <td className="text-muted text-xs max-w-[220px] truncate">
                      {r.server_sponsor || r.server_name || '-'}
                    </td>
                    <td>
                      <span className={`badge ${r.ok ? 'badge-online' : 'badge-kicked'}`}>
                        {r.ok ? 'ok' : 'gagal'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function Metric({
  icon,
  label,
  value,
  unit,
}: {
  icon: React.ReactNode
  label: string
  value: string
  unit: string
}) {
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-[4px] border border-border bg-surface2 text-muted">
          {icon}
        </span>
        <span className="stat-label">{label}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="mono text-[1.65rem] font-medium tracking-tight text-ink">
          {value}
        </span>
        <span className="mono text-[12px] text-muted">{unit}</span>
      </div>
    </div>
  )
}

function Line({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted2">{k}</dt>
      <dd className={`text-right text-muted truncate ${mono ? 'mono' : ''}`}>{v}</dd>
    </div>
  )
}