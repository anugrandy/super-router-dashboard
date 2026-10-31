import { useLive } from '../live'
import { PageHeader } from '../components/Layout'
import TopologyMap from '../components/TopologyMap'
import { api } from '../api'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RouterHealth } from '../api'
import { Cpu, MemoryStick, Timer } from 'lucide-react'

/**
 * Topology page: the graph plus router health.
 *
 * Router health is fetched once on mount and then not polled. The backend caches
 * it for three minutes, so even a navigation back and forth barely touches the
 * router, and nothing re-renders on a timer.
 */
export default function TopologyPage() {
  const { devices } = useLive()
  const [health, setHealth] = useState<RouterHealth | null>(null)

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await api.routerHealth())
    } catch {
      setHealth(null)
    }
  }, [])

  useEffect(() => {
    void loadHealth()
  }, [loadHealth])

  // Per-core CPU values. The average is the headline figure; the router reports
  // one value per core, and summing them ("300%") would be meaningless.
  const cores = health?.available ? health.cpu_cores ?? [] : []
  const cpuAvg =
    cores.length > 0
      ? cores.reduce((a, b) => a + b, 0) / cores.length
      : null

  // When the router booted, derived from its own uptime counter. Held in state so
  // it is computed once per fetch rather than on every render.
  const bootedAt = useMemo(() => {
    if (!health?.available || !health.uptime_seconds) return ''
    const booted = new Date(Date.now() - health.uptime_seconds * 1000)
    return booted.toLocaleString('id-ID', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  }, [health])

  const gateway = devices.find((d) => d.is_gateway)
  // Fall back to the .1 address when nothing has been flagged as the gateway.
  const gatewayMac = gateway?.mac ?? ''

  return (
    <div>
      <PageHeader
        title="Topologi"
        subtitle={`${devices.length} perangkat terdaftar`}
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-4">
        <HealthCard
          icon={<Timer size={16} />}
          label="Router Uptime"
          value={health?.available ? health.uptime_human : '—'}
          // Boot time is derived from the uptime the router reports; it fills
          // the card's second line with something actually useful rather than
          // leaving it empty next to the CPU per-core detail.
          detail={bootedAt ? `nyala sejak ${bootedAt}` : undefined}
          hint={health?.available ? health.uptime_human : undefined}
          tint={{ bg: 'var(--color-surface2)', fg: 'var(--color-muted)' }}
        />
        <HealthCard
          icon={<Cpu size={16} />}
          label="CPU rata-rata"
          // The four cores were rendered inline ("3% / 2% / 0% / 0%") and wrapped
          // to two lines, crowding out the card. The average is the number worth
          // showing at a glance; the per-core split is detail, not headline.
          value={
            cpuAvg != null ? cpuAvg.toFixed(cpuAvg < 10 ? 1 : 0) : '—'
          }
          unit={cpuAvg != null ? '%' : undefined}
          detail={
            cores.length ? `core: ${cores.map((c) => `${c}%`).join(' / ')}` : undefined
          }
          hint={
            cores.length
              ? `${cores.length} core — ${cores.map((c) => `${c}%`).join(' / ')}`
              : undefined
          }
          tint={{ bg: 'var(--color-surface2)', fg: 'var(--color-muted)' }}
        />
        <HealthCard
          icon={<MemoryStick size={16} />}
          label="Memory"
          value={health?.available && health.mem_pct != null ? String(health.mem_pct) : '—'}
          unit={health?.available && health.mem_pct != null ? '%' : undefined}
          hint={
            health?.available && health.mem_pct != null
              ? `Memory terpakai ${health.mem_pct}%`
              : undefined
          }
          tint={{ bg: 'var(--color-surface2)', fg: 'var(--color-muted)' }}
        />
      </div>

      {health && !health.available && health.error && (
        <div className="card px-4 py-3 mb-4 border-red/40 text-[13px] text-red">
          Data kesehatan router tidak bisa dibaca: {health.error}
        </div>
      )}

      {health?.available && (
        <p className="mono text-[11px] text-muted2 mb-3 leading-relaxed">
          {health.model} · firmware {health.software_version} · serial{' '}
          {health.serial_number} · CPU 4 core ditampilkan terpisah, refresh tiap
          3 menit
        </p>
      )}

      <TopologyMap
        devices={devices}
        routerName={gateway ? 'Router' : 'Gateway'}
        gatewayMac={gatewayMac}
      />
    </div>
  )
}

/**
 * Font size by value length.
 *
 * The same 1.5rem that reads well for a bare number ("69") overflows a card
 * when the value is a duration string ("1 hari 10j 7m"). Stepping down by
 * length keeps all three cards consistent without measuring the DOM.
 */
function valueSize(v: string): string {
  if (v.length <= 4) return 'text-[1.5rem]'
  if (v.length <= 7) return 'text-[1.4rem]'
  if (v.length <= 11) return 'text-[1.3rem]'
  return 'text-[1.25rem]'
}

function HealthCard({
  icon,
  label,
  value,
  unit,
  detail,
  hint,
  tint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  /** Shown next to the number, e.g. "%" or "Mbps". */
  unit?: string
  /** Small secondary line under the number (per-core breakdown, etc.). */
  detail?: string
  /** Full text for the tooltip, so nothing is lost on narrow cards. */
  hint?: string
  tint: { bg: string; fg: string }
}) {
  return (
    <div className="card card-hover p-5 min-h-[100px] flex flex-col" title={hint}>
      <div className="flex items-start justify-between gap-3 flex-1">
        <div className="min-w-0">
          <div className="stat-label">{label}</div>
          {/* One number per card, on one line: the value is the only thing that
              needs to be large. Anything per-item goes in `detail` below. */}
          <div className="mt-1.5 flex items-baseline gap-1 whitespace-nowrap">
            <span
              className={`stat-value stat-value-text ${valueSize(value)}`}
            >
              {value}
            </span>
            {unit && (
              <span className="text-[12px] text-muted shrink-0">{unit}</span>
            )}
          </div>
          {/* Reserved line so all three cards keep the same height whether or
              not they have a detail row. The height must cover the text's full
              line box (10px x 1.55 = 15.5px), not just the glyph height, or the
              descenders are clipped against the card's bottom edge. */}
          <div className="mono text-[10px] leading-4 text-muted2 mt-2 h-4 truncate">
            {detail}
          </div>
        </div>
        <span
          className="inline-flex items-center justify-center w-8 h-8 rounded-md shrink-0 border border-border"
          style={{ background: tint.bg, color: tint.fg }}
        >
          {icon}
        </span>
      </div>
    </div>
  )
}