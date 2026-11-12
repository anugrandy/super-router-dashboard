import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { CSSProperties } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  api,
  typeLabel,
  displayName,
  fmtDuration,
  fmtTime,
  type Dashboard,
  type WanStatus,
} from '../api'
import { ScanButton } from '../components/Layout'
import KpiStrip from '../components/Kpi'
import {
  DeviceChip,
  DeviceTypeChip,
  IconPlug,
  IconUnplug,
} from '../components/icons'
import { useWanEvent } from '../components/Toasts'
import { useAuth, useLive } from '../live'

export default function DashboardPage() {
  const { t } = useTranslation()
  const { username, displayName: authDisplayName } = useAuth()
  const { devices, connected, lastEventAt, isViewingActive, viewProfileId, viewProfile } =
    useLive()
  const [data, setData] = useState<Dashboard | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Re-render exactly at the next hour so the greeting changes with the clock
  // even when the dashboard stays open overnight.
  const [hour, setHour] = useState(() => new Date().getHours())

  useEffect(() => {
    const now = new Date()
    const next = new Date(now)
    next.setMinutes(0, 0, 0)
    next.setHours(now.getHours() + 1)
    const id = window.setTimeout(
      () => setHour(new Date().getHours()),
      Math.max(1000, next.getTime() - now.getTime() + 500),
    )
    return () => window.clearTimeout(id)
  }, [hour])

  // WAN state lives at page level so the hero status and the internet card read
  // from the same snapshot instead of two independent fetches.
  const wanEvent = useWanEvent()
  const [wan, setWan] = useState<WanStatus | null>(null)
  const loadWan = useCallback(async () => {
    try {
      setWan((await api.wan()).status)
    } catch {
      // Keep the last known state rather than turning a failed read into a status.
    }
  }, [])

  useEffect(() => {
    void loadWan()
  }, [loadWan])
  useEffect(() => {
    if (wanEvent) void loadWan()
  }, [wanEvent, loadWan])

  async function load() {
    try {
      setData(await api.dashboard(isViewingActive ? null : viewProfileId))
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('dashboard.loadError'))
    }
  }

  useEffect(() => {
    void load()
    // Re-pull the chart/kick log when a live push lands (kicks, new devices),
    // and whenever the user switches between the active and a historical view.
  }, [lastEventAt, isViewingActive, viewProfileId])

  // In a historical view the live list describes a different network, so the
  // hero figures come from the scoped REST payload instead of the socket.
  const historical = !isViewingActive
  const online = historical
    ? (data?.online ?? 0)
    : devices.filter((d) => d.online).length
  const total = historical ? (data?.total ?? 0) : devices.length
  const kickedCount = historical
    ? (data?.kicked ?? 0)
    : devices.filter((d) => d.kicked != null).length

  // The API stores one sample per scan (up to 288 of them), which is far too
  // dense for a nine-hour line: every raw point became a visible marker and the
  // flat runs read like stitching. Collapse the window into fixed buckets so
  // the shape stays readable at any refresh rate.
  const chart = useMemo(() => aggregateChart(data?.chart ?? []), [data])

  // Leave a round step of headroom above the highest count in the window. The
  // total line then sits inside the plot instead of being pinned to its top
  // edge, where it used to collide with the axis and its label.
  const chartPeak = Math.max(online, ...chart.map((c) => Math.max(c.online, c.total ?? 0)))
  const chartMax = Math.max(4, Math.ceil((chartPeak + 2) / 4) * 4)

  // A numeric time axis gives evenly spaced ticks. Category axes used to place
  // every label on an arbitrary sample, which is what made the final tick read
  // differently from the rest.
  const tMin = chart[0].t
  const tMax = chart[chart.length - 1].t > tMin ? chart[chart.length - 1].t : tMin + 3_600_000
  const timeTicks = buildTimeTicks(tMin, tMax)
  const withDate = tMax - tMin > 86_400_000

  const types = Object.entries(data?.by_type ?? {}).sort((a, b) => b[1] - a[1])

  // Trend for the hero: compare the first and last sample in the window the
  // chart already shows, so the badge can never disagree with the graph.
  const firstOnline = chart[0]?.online ?? 0
  const lastOnline = chart[chart.length - 1]?.online ?? 0
  const onlineTrend =
    firstOnline === 0 ? (lastOnline > 0 ? 100 : 0) : ((lastOnline - firstOnline) / firstOnline) * 100
  const offlineNow = Math.max(0, total - online)
  const spanLabel =
    chart.length > 1
      ? t('dashboard.chart.minutes', {
          n: Math.round((chart[chart.length - 1].t - chart[0].t) / 60000),
        })
      : t('dashboard.chart.notEnough')

  // Time-of-day greeting, translated through the same i18n bundle as the rest
  // of the page. The display name is preferred, with the login username as the
  // fallback so the greeting is never blank.
  const greetingName =
    authDisplayName.trim() || username || t('dashboard.hero.greetingFallback')
  const greeting = t(`dashboard.hero.greeting.${partOfDay(hour)}`, {
    name: greetingName,
  })

  // Hero health line. The WAN link decides it: claiming "all normal" while the
  // internet is down would be false, and before the first WAN read the line
  // stays neutral instead of flashing green.
  const internetDown =
    isViewingActive && wan !== null && !(wan.available && wan.connected)
  const heroStatus = internetDown
    ? { label: t('dashboard.hero.status.internetDown'), color: 'var(--color-red)' }
    : isViewingActive && wan === null
      ? { label: t('dashboard.hero.status.checking'), color: 'var(--color-muted2)' }
      : total === 0
        ? { label: t('dashboard.hero.status.waiting'), color: 'var(--color-muted2)' }
        : { label: t('dashboard.hero.status.allNormal'), color: 'var(--color-green)' }

  const tooltipStyle: CSSProperties = {
    background: '#0a0a0a',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: 6,
    fontSize: 12,
    padding: '6px 8px',
  }

  return (
    <div className="pb-4">
      <header className="flex flex-wrap items-end justify-between gap-5 mb-9">
        <div className="min-w-0">
          <div className="eyebrow flex-wrap">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{
                background: connected && isViewingActive
                  ? 'var(--color-green)'
                  : 'var(--color-muted2)',
              }}
            />
            <span>{t('dashboard.hero.eyebrow')}</span>
            <span className="text-muted2">·</span>
            {viewProfile && (
              <>
                <span className="truncate max-w-[160px]">{viewProfile.name}</span>
                <span className="text-muted2">·</span>
              </>
            )}
            <span className="mono text-[11px] text-muted2">{data?.gateway.subnet ?? '—'}</span>
            <span className="text-muted2 hidden sm:inline">·</span>
            <span className="hidden sm:inline">
              {!isViewingActive
                ? t('profiles.historyLabel')
                : connected
                  ? t('dashboard.live')
                  : t('dashboard.waiting')}
            </span>
          </div>
          <h1 className="display-title mt-3">
            {greeting}
            <br />
            <span className="display-status" style={{ color: heroStatus.color }}>
              {heroStatus.label}
            </span>
          </h1>
        </div>
      </header>

      {err && <div className="notice notice-danger mb-6">{err}</div>}

      {/* Summary figures are one strip, not four little cards. */}
      <KpiStrip
        className="mb-8"
        items={[
          {
            label: t('dashboard.stats.online'),
            value: online,
            tone: 'green',
            sub: (
              <span className="inline-flex items-center gap-1">
                <TrendArrow dir={onlineTrend >= 0 ? 'up' : 'down'} />
                {Math.abs(onlineTrend).toFixed(0)}% ·{' '}
                {t('dashboard.chart.comparedTo', { span: spanLabel })}
              </span>
            ),
          },
          {
            label: t('dashboard.stats.total'),
            value: total,
            sub: t('dashboard.stats.totalNote'),
          },
          {
            label: t('dashboard.stats.offline'),
            value: offlineNow,
            tone: 'muted',
            sub: t('dashboard.stats.offlineNote'),
          },
          {
            label: t('dashboard.stats.kicked'),
            value: kickedCount,
            tone: kickedCount ? 'red' : 'muted',
            sub: kickedCount
              ? t('dashboard.stats.kickedNote')
              : t('dashboard.stats.noKickNote'),
          },
        ]}
      />

      <div className="grid gap-8 lg:grid-cols-3">
        <section className={isViewingActive ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="card-title">{t('dashboard.chart.title')}</h2>
              <p className="card-sub mt-1">{t('dashboard.chart.subtitle')}</p>
            </div>
            <div className="ml-auto flex items-center gap-4">
              <div className="hidden items-center gap-4 text-[11px] text-muted2 sm:flex">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-green" />
                  {t('dashboard.chart.online')}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-4 border-t border-dashed border-border-strong" />
                  {t('dashboard.chart.total')}
                </span>
              </div>
              <ScanButton className="btn btn-sm" />
            </div>
          </div>
          <div className="dashboard-chart h-[240px] sm:h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="dashboardOnlineFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22C55E" stopOpacity={0.26} />
                  <stop offset="100%" stopColor="#22C55E" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={[tMin, tMax]}
                ticks={timeTicks}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => formatAxisTime(v, withDate)}
                minTickGap={40}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                domain={[0, chartMax]}
                width={34}
              />
              <Tooltip
                cursor={{ stroke: 'rgba(255,255,255,0.14)', strokeWidth: 1 }}
                labelFormatter={(v) => fmtTime(new Date(Number(v)).toISOString())}
                contentStyle={tooltipStyle}
                labelStyle={{ color: 'var(--color-muted2)' }}
                itemStyle={{ color: 'var(--color-ink)' }}
              />
              <Area
                type="monotone"
                dataKey="online"
                name={t('dashboard.chart.online')}
                stroke="#22C55E"
                strokeWidth={2}
                fill="url(#dashboardOnlineFill)"
                dot={false}
                activeDot={{ r: 4.5, fill: '#22C55E', stroke: '#000000', strokeWidth: 2 }}
              />
              {/* The total is a quiet dashed rule: context, not the protagonist. */}
              <Line
                type="monotone"
                dataKey="total"
                name={t('dashboard.chart.total')}
                stroke="#6f6f6f"
                strokeWidth={1.5}
                strokeDasharray="5 5"
                dot={false}
                activeDot={false}
              />
              {/* Only the current value gets a marker, the rest of the line
                  stays clean. ReferenceDot sits on the averaged last bucket. */}
              <ReferenceDot
                x={chart[chart.length - 1].t}
                y={chart[chart.length - 1].online}
                r={3}
                fill="#22C55E"
                stroke="#000000"
                strokeWidth={2}
              />
            </ComposedChart>
          </ResponsiveContainer>
          </div>
        </section>

        {/* WAN status is live router state, not part of a historical profile.
            Showing it beside old device counts would falsely imply that old
            network is online right now. */}
        {isViewingActive && <WanCard status={wan} />}
      </div>

      <div className="mt-10 grid gap-x-8 gap-y-10 lg:grid-cols-3">
        <section>
          <CardHead title={t('dashboard.recent')} to="/devices" label={t('dashboard.viewAll')} />
          {data?.recent?.length ? (
            <ul className="mt-2 divide-y divide-border">
              {data.recent.map((d) => (
                <li key={d.mac}>
                  <Link
                    to={`/devices/${encodeURIComponent(d.mac)}`}
                    className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition hover:bg-surface2"
                  >
                    <DeviceChip
                      type={d.device_type}
                      vendor={d.vendor}
                      hostname={d.hostname}
                      brandOverride={d.brand_override}
                    />
                    <span className="flex-1 min-w-0 truncate text-sm text-ink hover:text-muted">
                      {displayName(d)}
                    </span>
                    {d.is_self && (
                      <span className="badge badge-accent shrink-0">
                        {t('devices.self')}
                      </span>
                    )}
                    <span
                      className={`badge ${d.kicked != null ? 'badge-kicked' : d.online ? 'badge-online' : 'badge-offline'}`}
                    >
                      {d.kicked != null
                        ? t('status.kicked')
                        : d.online
                          ? t('status.online')
                          : t('status.offline')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted mt-3">{t('dashboard.noData')}</p>
          )}
        </section>

        <section>
          <CardHead
            title={t('dashboard.composition')}
            to="/devices"
            label={t('dashboard.viewAll')}
          />
          {types.length ? (
            <ul className="mt-4 space-y-3.5">
              {types.map(([type, n]) => {
                const pct = total ? Math.round((n / total) * 100) : 0
                return (
                  <li key={type}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <DeviceTypeChip type={type} />
                      <span className="flex-1 min-w-0 truncate text-[12.5px] text-muted">
                        {typeLabel(type)}
                      </span>
                      <span className="mono text-[11.5px] text-muted2">{n}</span>
                    </div>
                    <div className="h-1 rounded-full bg-surface2 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[var(--color-green)] opacity-60"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-muted">{t('dashboard.noOnline')}</p>
          )}
        </section>

        <section>
          <CardHead
            title={t('dashboard.kickHistory')}
            to="/activity"
            label={t('dashboard.viewAll')}
          />
          {data?.kick_log?.length ? (
            <ul className="mt-2 divide-y divide-border">
              {data.kick_log.slice(0, 8).map((k) => (
                <li
                  key={k.id}
                  className="-mx-2 flex items-start justify-between gap-2 rounded-md px-2 py-2.5 transition hover:bg-surface2"
                >
                  <span className="text-muted">
                    <Link
                      to={`/devices/${encodeURIComponent(k.mac)}`}
                      className="mono hover:text-ink"
                    >
                      {k.mac}
                    </Link>
                    <div className="text-[11px] text-muted2 mono">
                      {fmtTime(k.at)} · {k.actor || '-'}
                    </div>
                  </span>
                  <span className={`badge mono ${k.active ? 'badge-kicked' : 'badge-offline'}`}>
                    {k.active
                      ? t('status.active')
                      : k.duration != null
                        ? fmtDuration(k.duration)
                        : t('status.finished')}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-muted">{t('dashboard.noKicks')}</p>
          )}
        </section>
      </div>
    </div>
  )
}

/** Section title plus a quiet "view all" link, kept on one baseline. */
function CardHead({ title, to, label }: { title: string; to: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="card-title truncate">{title}</h2>
      <Link
        to={to}
        className="text-[12px] text-muted hover:text-ink transition shrink-0"
      >
        {label}
      </Link>
    </div>
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

/**
 * Internet status as a tall side card.
 *
 * Renders the page-level WAN snapshot, which refreshes when the monitor pushes
 * a change; the endpoint is cached server-side for two minutes.
 */
function WanCard({ status: s }: { status: WanStatus | null }) {
  const { t } = useTranslation()

  const up = s?.ipv4_status === 'connected'
  const color = !s
    ? 'var(--color-muted2)'
    : !s.available
      ? 'var(--color-muted)'
      : up
        ? 'var(--color-green)'
        : 'var(--color-red)'
  const border = !s
    ? 'var(--color-border)'
    : !s.available
      ? 'var(--color-border)'
      : up
        ? 'rgba(34,197,94,0.35)'
        : 'rgba(239,68,68,0.4)'
  const status = !s
    ? '—'
    : !s.available
      ? t('dashboard.wan.routerDown')
      : up
        ? t('dashboard.wan.online')
        : t('dashboard.wan.offline')
  const sub = !s
    ? '—'
    : !s.available
      ? t('dashboard.wan.stale')
      : up
        ? t('dashboard.wan.onlineFor', {
            name: s.connection_name,
            duration: s.online_human,
          })
        : s.disconnect_reason || t('dashboard.wan.ispDown')

  return (
    <Link
      to="/connection"
      className="card card-hover p-6 flex flex-col"
      style={{ borderColor: border }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="mini-label">{t('dashboard.wan.pill')}</span>
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
          {!s
            ? '—'
            : up
              ? t('status.connected')
              : !s.available
                ? t('status.inactive')
                : t('status.disconnected')}
        </span>
      </div>

      <div className="flex items-center gap-3 mt-5">
        <span
          className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 border"
          style={{ color, borderColor: border }}
        >
          {up ? <IconPlug size={17} /> : <IconUnplug size={17} />}
        </span>
        <div className="min-w-0">
          <div className="text-[1.55rem] font-medium leading-tight truncate" style={{ color }}>
            {status}
          </div>
          <div className="card-sub mt-1 truncate">{sub}</div>
        </div>
      </div>

      <dl className="mt-6 space-y-2.5 border-t border-border pt-4">
        <WanRow label={t('dashboard.wan.connection')} value={s?.connection_name || '—'} />
        <WanRow
          label={t('dashboard.wan.uptime')}
          value={up ? s?.online_human || '—' : '—'}
        />
        <WanRow label={t('dashboard.wan.ip')} value={s?.ipv4_address || '—'} mono />
      </dl>

      <div className="mt-auto pt-4 text-[12px] text-muted flex items-center gap-1.5">
        {t('dashboard.wan.detail')}
        <span aria-hidden="true">→</span>
      </div>
    </Link>
  )
}

function WanRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[12px] text-muted2 shrink-0">{label}</dt>
      <dd className={`text-[12px] text-ink truncate ${mono ? 'mono' : ''}`}>{value}</dd>
    </div>
  )
}

/** Map the local hour to the greeting bucket used by the dashboard. */
function partOfDay(hour: number): 'morning' | 'afternoon' | 'evening' | 'night' {
  if (hour >= 5 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 15) return 'afternoon'
  if (hour >= 15 && hour < 18) return 'evening'
  return 'night'
}

type ChartPoint = { at: string; t: number; online: number; total: number }

/** Bucket widths to try, smallest first. The window is collapsed just enough
 *  to keep the plot readable without hiding the shape of the day. */
const AGGREGATION_STEPS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
]
const MAX_BUCKETS = 48
/** The card is a nine-hour trend. Older rows belong to previous sessions and
 *  would otherwise be connected across a long gap, flattening the recent shape. */
const CHART_WINDOW_MS = 9 * 60 * 60_000

/**
 * Collapse raw scan samples into time buckets. Online counts are averaged
 * (the line is a trend, not a step log) and `total` keeps the bucket maximum so
 * the capacity rule is never underestimated.
 */
function aggregateChart(raw: Dashboard['chart']): ChartPoint[] {
  const parsed = raw
    .map((p) => ({
      t: new Date(p.at).getTime(),
      online: p.online,
      total: p.total ?? 0,
    }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t)

  if (!parsed.length) {
    const now = Date.now()
    return [{ at: new Date(now).toISOString(), t: now, online: 0, total: 0 }]
  }

  const latest = parsed[parsed.length - 1].t
  const windowed = parsed.filter((p) => p.t >= latest - CHART_WINDOW_MS)
  const span = windowed[windowed.length - 1].t - windowed[0].t
  const step = AGGREGATION_STEPS.find((s) => span / s <= MAX_BUCKETS) ?? 24 * 60 * 60_000
  const offset = new Date(latest).getTimezoneOffset() * 60_000
  const buckets = new Map<number, { sum: number; count: number; total: number }>()

  for (const p of windowed) {
    // Align buckets to local clock boundaries rather than UTC boundaries.
    const key = Math.floor((p.t - offset) / step) * step + offset
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.sum += p.online
      bucket.count += 1
      bucket.total = Math.max(bucket.total, p.total)
    } else {
      buckets.set(key, { sum: p.online, count: 1, total: p.total })
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, b]) => ({
      at: new Date(t).toISOString(),
      t,
      online: Math.round((b.sum / b.count) * 10) / 10,
      total: b.total,
    }))
}

/** Evenly spaced clock ticks for the numeric time axis. */
const AXIS_STEPS = [
  60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
]

function buildTimeTicks(min: number, max: number): number[] {
  const span = max - min
  if (span <= 0) return [min]
  const step = AXIS_STEPS.find((s) => span / s <= 9) ?? AXIS_STEPS[AXIS_STEPS.length - 1]
  const offset = new Date(max).getTimezoneOffset() * 60_000
  const first = Math.ceil((min - offset) / step) * step + offset
  const ticks: number[] = []
  for (let t = first; t <= max; t += step) ticks.push(t)
  if (ticks.length >= 2) return ticks
  return [min, max]
}

/** One label format for every tick: zero-padded HH.mm, plus a date when the
 *  window crosses midnight so two equal clock times can never look ambiguous. */
function formatAxisTime(ts: number, withDate = false): string {
  const d = new Date(ts)
  const time = `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`
  if (!withDate) return time
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${time}`
}
