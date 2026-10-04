import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
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
  type WanStatus,
} from '../api'
import { PageHeader, ScanButton } from '../components/Layout'
import {
  DeviceTypeChip,
  IconPlug,
  IconUnplug,
  STAT_ICON,
} from '../components/icons'
import { useWanEvent } from '../components/Toasts'
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

  // Capacity ceiling for the dashed rule: a round step above the highest count
  // seen in the window, so the line always sits inside the plot.
  const chartMax = Math.max(
    4,
    Math.ceil(Math.max(online, ...chart.map((c) => c.total ?? 0)) / 4) * 4,
  )

  const types = Object.entries(data?.by_type ?? {}).sort((a, b) => b[1] - a[1])

  // Trend for the stat cards: compare the first and last sample in the window
  // the chart already shows, so the badge can never disagree with the graph.
  // Comparing only the last two samples hides the trend whenever the count is
  // momentarily flat, which is most of the time on a quiet network.
  const firstOnline = chart[0]?.online ?? 0
  const lastOnline = chart[chart.length - 1]?.online ?? 0
  const onlineTrend =
    firstOnline === 0 ? (lastOnline > 0 ? 100 : 0) : ((lastOnline - firstOnline) / firstOnline) * 100
  // Offline is "good news when it goes down", so its arrow flips direction.
  const offlineNow = Math.max(0, total - online)
  const spanLabel =
    chart.length > 1
      ? `${Math.round((new Date(chart[chart.length - 1].at).getTime() - new Date(chart[0].at).getTime()) / 60000)} menit`
      : 'belum ada data cukup' 

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={
          <>
            {data?.gateway.subnet ?? '—'}
            <span className="mx-2 text-[#58585F]">|</span>
            {connected ? 'update realtime aktif' : 'menunggu koneksi live'}
          </>
        }
        actions={<ScanButton />}
      />

      {err && (
        <div className="card px-4 py-3 border-[rgba(232,96,74,0.32)] bg-[rgba(232,96,74,0.07)] text-sm text-[#E8604A] mb-5">
          {err}
        </div>
      )}

      {/* Compact internet status, linking to the full page. Not a Stat card
          because it needs to be clickable and carries a colour state. */}
      <WanSummary />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-5">
        <Stat
          label="Total Device"
          value={total}
          note="terdaftar di jaringan"
          icon={<StatIcon kind="total" />}
        />
        <Stat
          label="Online Sekarang"
          value={online}
          note="terhubung saat ini"
          trend={onlineTrend}
          spanLabel={spanLabel}
          icon={<StatIcon kind="online" />}
        />
        <Stat
          label="Offline"
          value={offlineNow}
          note="tidak merespons"
          trend={-onlineTrend}
          spanLabel={spanLabel}
          invertTone
          icon={<StatIcon kind="offline" />}
        />
        <Stat
          label="Sedang Di-kick"
          value={kickedCount}
          note={kickedCount ? 'blokir router aktif' : 'tidak ada blokir aktif'}
          tone={kickedCount ? 'danger' : 'muted'}
          icon={<StatIcon kind="kick" />}
        />
      </div>

      <div className="card p-5 mb-5">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="card-title">Perangkat Online</h2>
            <p className="card-sub mt-0.5">
              Tendensi jumlah device online dari hasil scan terakhir
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-green">{online}</span>
            <span className="text-[12px] text-muted2">/ {chartMax} maks</span>
          </div>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chart} margin={{ top: 6, right: 10, bottom: 0, left: -24 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              {/* Capacity reference: a flat dashed rule so the live count can
                  be read against the ceiling at a glance. */}
              <ReferenceLine
                y={chartMax}
                stroke="#2f2f35"
                strokeDasharray="4 4"
                label={{
                  value: 'kapasitas',
                  position: 'insideTopRight',
                  fill: '#58585F',
                  fontSize: 10,
                }}
              />
              <XAxis
                dataKey="at"
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: string) =>
                  new Date(v).toLocaleTimeString('id-ID', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                }
                minTickGap={40}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                width={44}
              />
              <Tooltip
                cursor={{ stroke: 'rgba(255,255,255,0.14)', strokeWidth: 1 }}
                labelFormatter={(v) => fmtTime(String(v))}
                contentStyle={{
                  background: '#17171B',
                  border: '1px solid #232327',
                  borderRadius: 10,
                  fontSize: 12,
                }}
              />
              <Bar dataKey="online" fill="#1e1e22" radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Line
                type="monotone"
                dataKey="online"
                stroke="#3ED28C"
                strokeWidth={2}
                dot={{ r: 2.5, fill: '#3ED28C', strokeWidth: 0 }}
                activeDot={{ r: 4.5, fill: '#3ED28C', stroke: '#0A0A0B', strokeWidth: 2 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5">
          <h2 className="card-title mb-4">Device terbaru</h2>
          {data?.recent?.length ? (
            <ul className="space-y-1">
              {data.recent.map((d) => (
                <li key={d.mac}>
                  <Link
                    to={`/devices/${encodeURIComponent(d.mac)}`}
                    className="flex items-center gap-3 rounded-[10px] px-2 py-2 -mx-2 hover:bg-surface2/70 transition"
                  >
                    <DeviceTypeChip type={d.device_type} />
                    <span className="flex-1 min-w-0 truncate text-sm text-[#F2F2F3] hover:text-[#8B8D93]">
                      {displayName(d)}
                    </span>
                    <span
                      className={`badge ${d.kicked != null ? 'badge-kicked' : d.online ? 'badge-online' : 'badge-offline'}`}
                    >
                      {d.kicked != null ? 'di-kick' : d.online ? 'online' : 'offline'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[#8B8D93]">Belum ada data.</p>
          )}
        </div>

        <div className="card p-5">
          <h2 className="card-title mb-4">Komposisi tipe</h2>
          {types.length ? (
            <ul className="space-y-1">
              {types.map(([type, n]) => (
                <li
                  key={type}
                  className="flex items-center gap-3 rounded-[10px] px-2 py-2 -mx-2 hover:bg-surface2/70 transition"
                >
                  <DeviceTypeChip type={type} />
                  <span className="flex-1 text-sm text-[#8B8D93]">
                    {TYPE_LABEL[type] || type}
                  </span>
                  <span className="mono text-[#8B8D93]">{n}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[#8B8D93]">Belum ada device online.</p>
          )}
        </div>

        <div className="card p-5">
          <h2 className="card-title mb-4">Log kick terakhir</h2>
          {data?.kick_log?.length ? (
            <ul className="space-y-1">
              {data.kick_log.slice(0, 8).map((k) => (
                <li
                  key={k.id}
                  className="flex items-start justify-between gap-2 rounded-[10px] px-2 py-2 -mx-2 hover:bg-surface2/70 transition"
                >
                  <span className="text-[#8B8D93]">
                    <Link
                      to={`/devices/${encodeURIComponent(k.mac)}`}
                      className="mono hover:text-[#8B8D93]"
                    >
                      {k.mac}
                    </Link>
                    <div className="text-[11px] text-[#58585F]">
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
            <p className="text-xs text-[#8B8D93]">Belum ada aksi kick.</p>
          )}
        </div>
      </div>
    </div>
  )
}

/** Stat-card icon: one lucide glyph per metric, tinted so it reads against
 *  the card surface without competing with the number. */
function StatIcon({ kind }: { kind: 'total' | 'online' | 'offline' | 'kick' }) {
  const Ico = STAT_ICON[kind]
  return (
    <Ico size={17} className="shrink-0 text-muted2 mt-0.5" aria-hidden="true" />
  )
}

/** Small arrow for the trend pill. Not a device icon, so it stays inline. */
function TrendArrow({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={12}
      height={12}
      className="shrink-0"
      aria-hidden="true"
    >
      {dir === 'up' ? (
        <path d="M12 19V5M5 12l7-7 7 7" />
      ) : (
        <path d="M12 5v14M5 12l7 7 7-7" />
      )}
    </svg>
  )
}

/** Stat card: big number, optional trend pill, soft icon chip, muted caption. */
function Stat({
  label,
  value,
  note,
  trend,
  spanLabel,
  invertTone,
  tone = 'default',
  icon,
}: {
  label: string
  value: number
  note?: string
  trend?: number
  spanLabel?: string
  /** Set when a rising number is bad news (e.g. Offline). Flips the pill tone
   *  so green always means "better", never just "up". */
  invertTone?: boolean
  tone?: 'default' | 'muted' | 'danger'
  icon?: ReactNode
}) {
  // Shown whenever a comparison window exists: "0%" is itself information.
  const showTrend = trend != null && Number.isFinite(trend)
  const rising = (trend ?? 0) >= 0
  const up = invertTone ? !rising : rising
  const flat = Math.abs(trend ?? 0) < 0.5
  const valueColor =
    tone === 'danger'
      ? 'text-[#E8604A]'
      : tone === 'muted'
        ? 'text-[#8B8D93]'
        : ''

  return (
    <div className="card card-hover p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="stat-label">{label}</div>
          <div className={`stat-value mt-2.5 text-[2.125rem] ${valueColor}`}>
            {value}
          </div>
        </div>
        {icon && <div>{icon}</div>}
      </div>
      <div className="flex items-center gap-2 mt-3.5">
        {showTrend && (
          <span
            className={`badge ${
              flat ? 'badge-offline' : up ? 'trend-up' : 'trend-down'
            }`}
          >
            <TrendArrow dir={rising ? 'up' : 'down'} />
            {rising ? '↑' : '↓'} {Math.abs(trend!).toFixed(0)}%
          </span>
        )}
        {note && <span className="stat-caption">{note}</span>}
      </div>
      {showTrend && spanLabel && (
        <div className="text-[11px] text-muted2 mt-1.5">
          dibanding {spanLabel} lalu
        </div>
      )}
    </div>
  )
}
/**
 * One-line internet status for the dashboard.
 *
 * Loads once and refreshes when the monitor pushes a change; the endpoint is
 * cached server-side for two minutes, so mounting this costs one request, not
 * one per render or per device scan.
 */
function WanSummary() {
  const [s, setS] = useState<WanStatus | null>(null)
  const wanEvent = useWanEvent()

  const load = useCallback(async () => {
    try {
      setS((await api.wan()).status)
    } catch {
      // Leave the card hidden rather than showing a false "unknown" state.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (wanEvent) void load()
  }, [wanEvent, load])

  if (!s) return null

  const up = s.ipv4_status === 'connected'
  const color = !s.available ? '#8B8D93' : up ? '#3ED28C' : '#E8604A'
  const text = !s.available
    ? 'Router tidak terhubung'
    : up
      ? 'Internet Tersambung'
      : 'Internet Terputus'
  const sub = !s.available
    ? 'status terakhir tidak bisa diperbarui'
    : up
      ? `${s.connection_name} · online ${s.online_human}`
      : s.disconnect_reason || 'koneksi ke ISP terputus'

  return (
    <Link
      to="/connection"
      className="card card-hover px-4 py-3 mb-5 flex items-center gap-3 transition"
      style={{ borderColor: up ? 'rgba(62,210,140,0.22)' : 'rgba(232,96,74,0.3)' }}
    >
      <span
        className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
        style={{ color, background: `${color}1f` }}
      >
        {up ? <IconPlug size={16} /> : <IconUnplug size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold" style={{ color }}>
          {text}
        </span>
        <span className="block text-[11px] text-[#8B8D93] truncate">{sub}</span>
      </span>
      <span className="text-[11px] text-[#58585F] shrink-0 hidden sm:inline">
        Lihat detail
      </span>
    </Link>
  )
}
