import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  api,
  TYPE_LABEL,
  displayName,
  fmtDuration,
  fmtTime,
  type Dashboard,
} from '../api'
import { ScanButton } from '../components/Layout'
import { useLive } from '../live'

export default function DashboardPage() {
  const { devices, connected, lastEventAt } = useLive()
  const [data, setData] = useState<Dashboard | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    try {
      setData(await api.dashboard())
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal memuat dashboard')
    }
  }

  useEffect(() => {
    void load()
    // Re-pull the chart/kick log when a live push lands (kicks, new devices).
  }, [lastEventAt])

  const online = devices.filter((d) => d.online).length
  const total = devices.length
  const kickedCount = devices.filter((d) => d.kicked != null).length

  const chart =
    data?.chart?.length
      ? data.chart
      : [{ at: new Date().toISOString(), online: 0, total: 0 }]

  const types = Object.entries(data?.by_type ?? {}).sort((a, b) => b[1] - a[1])

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <span className="mono text-xs text-slate-500">{data?.gateway.subnet ?? '—'}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-500">
            {connected ? 'update realtime' : 'menunggu koneksi'}
          </span>
          <ScanButton />
        </div>
      </div>

      {err && (
        <div className="card px-4 py-3 border-rose-500/40 bg-rose-500/10 text-sm text-rose-200">
          {err}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Online" value={online} tone="ok" />
        <Stat label="Offline" value={Math.max(0, total - online)} tone="muted" />
        <Stat label="Total device" value={total} tone="default" />
        <Stat label="Sedang di-kick" value={kickedCount} tone={kickedCount ? 'danger' : 'muted'} />
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold mb-1">Perangkat online</h2>
        <p className="text-xs text-slate-500 mb-4">
          Tendensi jumlah device online dari hasil scan terakhir
        </p>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chart} margin={{ top: 4, right: 8, bottom: 0, left: -22 }}>
              <defs>
                <linearGradient id="gOnline" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1d2433" vertical={false} />
              <XAxis
                dataKey="at"
                stroke="#64748b"
                tick={{ fontSize: 11 }}
                tickFormatter={(v: string) =>
                  new Date(v).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
                }
                minTickGap={40}
              />
              <YAxis stroke="#64748b" tick={{ fontSize: 11 }} allowDecimals={false} width={40} />
              <Tooltip
                contentStyle={{
                  background: '#151a27',
                  border: '1px solid #2a3346',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(v) => fmtTime(String(v))}
              />
              <Area
                type="monotone"
                dataKey="online"
                stroke="#38bdf8"
                strokeWidth={2}
                fill="url(#gOnline)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-4">Device terbaru</h2>
          {data?.recent?.length ? (
            <ul className="space-y-2.5 text-sm">
              {data.recent.map((d) => (
                <li key={d.mac} className="flex items-center justify-between gap-2">
                  <Link
                    to={`/devices/${encodeURIComponent(d.mac)}`}
                    className="hover:text-sky-300 truncate"
                  >
                    {displayName(d)}
                  </Link>
                  <span
                    className={`badge ${d.kicked != null ? 'badge-kicked' : d.online ? 'badge-online' : 'badge-offline'}`}
                  >
                    {d.kicked != null ? 'di-kick' : d.online ? 'online' : 'offline'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">Belum ada data.</p>
          )}
        </div>

        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-4">Komposisi tipe</h2>
          {types.length ? (
            <ul className="space-y-2 text-sm">
              {types.map(([type, n]) => (
                <li key={type} className="flex items-center justify-between">
                  <span className="text-slate-300">{TYPE_LABEL[type] || type}</span>
                  <span className="mono text-slate-400">{n}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">Belum ada device online.</p>
          )}
        </div>

        <div className="card p-5">
          <h2 className="text-sm font-semibold mb-4">Log kick terakhir</h2>
          {data?.kick_log?.length ? (
            <ul className="space-y-2.5 text-xs">
              {data.kick_log.slice(0, 8).map((k) => (
                <li key={k.id} className="flex items-start justify-between gap-2">
                  <span className="text-slate-400">
                    <Link
                      to={`/devices/${encodeURIComponent(k.mac)}`}
                      className="mono hover:text-sky-300"
                    >
                      {k.mac}
                    </Link>
                    <div className="text-slate-500">
                      {fmtTime(k.at)} · {k.actor || '-'}
                    </div>
                  </span>
                  <span className={`badge ${k.active ? 'badge-kicked' : 'badge-offline'}`}>
                    {k.active ? 'aktif' : fmtDuration(k.duration)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">Belum ada aksi kick.</p>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'ok' | 'danger' | 'muted' | 'default'
}) {
  const color =
    tone === 'ok'
      ? 'text-emerald-300'
      : tone === 'danger'
        ? 'text-rose-300'
        : tone === 'muted'
          ? 'text-slate-400'
          : 'text-slate-100'
  return (
    <div className="card p-5">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-3xl font-semibold mt-1 ${color}`}>{value}</div>
    </div>
  )
}