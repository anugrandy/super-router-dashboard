import { memo, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { typeLabel, displayName, fmtAge, osLabel, type Device } from '../api'
import { DeviceChip } from './icons'
import { elapsedOf, useClock } from '../live'

type SortKey = 'name' | 'ip' | 'vendor' | 'device_type' | 'last_seen' | 'status'

const STATUS_RANK: Record<SortKey, number> = {
  // kicked first, then online, then offline
  status: 3,
  name: 2,
  ip: 1,
  vendor: 0,
  device_type: 0,
  last_seen: 0,
}

/**
 * Live kick countdown.
 *
 * Subscribes to the 1 Hz clock itself instead of receiving elapsed seconds from
 * the shared live state. That keeps the per-second re-render confined to this
 * small badge rather than the whole device table.
 */
function KickedBadge({ started }: { started: number }) {
  const { t } = useTranslation()
  useClock() // re-render once per second while a kick is running
  const left = Math.max(0, Math.round(elapsedOf(started)))
  return (
    <span
      className="badge badge-kicked badge-pulse mono"
      title={t('devices.kickedTitle')}
    >
      {t('devices.kickedFor', { duration: `${left}s` })}
    </span>
  )
}

/**
 * Memoized rows.
 *
 * The devices array is rebuilt on every WebSocket push, so without this every
 * row re-rendered on every scan even when only one device had changed. The
 * stable `mac` key plus memo on the row means React can skip unchanged rows.
 */
const DeviceRow = memo(function DeviceRow({ d }: { d: Device }) {
  const { t } = useTranslation()
  return (
    <tr className={d.kicked != null ? 'row-kicked' : ''}>
      <td>
        <Link
          to={`/devices/${encodeURIComponent(d.mac)}`}
          className="text-muted2 hover:text-bright text-lg leading-none"
          title={t('devices.detail')}
        >
          ›
        </Link>
      </td>
      <td>
        <div className="flex items-center gap-3">
          <DeviceChip
            type={d.device_type}
            vendor={d.vendor}
            hostname={d.hostname}
            brandOverride={d.brand_override}
          />
          <div className="min-w-0">
            <Link
              to={`/devices/${encodeURIComponent(d.mac)}`}
              className="font-medium text-ink hover:text-muted transition"
            >
              {displayName(d)}
            </Link>
            <div className="mono text-muted2">{d.mac}</div>
          </div>
        </div>
      </td>
      <td>
        <div className="mono text-muted">{d.ip || '-'}</div>
        {/* The AP the router reports for this client - not a default. */}
        {d.ssid_name && (
          <div className="text-[11px] text-muted2">{d.ssid_name}</div>
        )}
      </td>
      <td className="hidden lg:table-cell text-muted max-w-[220px] truncate" title={d.vendor}>
        {d.vendor || '-'}
      </td>
      <td className="text-[13px]">
        <span className="text-muted">
          {typeLabel(d.device_type)}
        </span>
        {osLabel(d) && (
          <div className="text-[11px] text-muted2 mt-0.5" title={d.os_evidence}>
            {osLabel(d)}
            {d.os_confidence !== 'high' && (
              <span className="ml-1 text-[10px]">
                · {d.os_confidence === 'low'
                  ? t('osConfidence.guess')
                  : t('osConfidence.estimate')}
              </span>
            )}
          </div>
        )}
        {/* No hostname and a randomized MAC means the type is a guess; say so
            instead of showing a confident-looking label. */}
        {!d.type_confident && (
          <div className="text-[10px] text-muted2 mt-0.5">{t('devices.needsCheck')}</div>
        )}
      </td>
      <td className="mono text-[11px] text-muted whitespace-nowrap">{fmtAge(d.last_seen)}</td>
      <td>
        <div className="flex flex-wrap gap-1.5">
          {d.kicked != null ? (
            <KickedBadge started={d.kicked} />
          ) : d.online ? (
            <span className="badge badge-online badge-pulse">{t('status.online')}</span>
          ) : (
            <span className="badge badge-offline">{t('status.offline')}</span>
          )}
          {d.is_self && <span className="badge badge-accent">{t('devices.self')}</span>}
          {d.is_gateway && <span className="badge badge-gateway">{t('devices.gateway')}</span>}
        </div>
      </td>
    </tr>
  )
})

/**
 * Phone row.
 *
 * The seven-column table cannot shrink to 375px without clipping, so below md
 * the same data is a tappable two-line row: name and flags, then IP/SSID and
 * vendor, then status and last-seen. The whole row is the link.
 */
const DeviceMobileRow = memo(function DeviceMobileRow({ d }: { d: Device }) {
  const { t } = useTranslation()
  return (
    <li>
      <Link
        to={`/devices/${encodeURIComponent(d.mac)}`}
        className="flex items-start gap-3 px-4 py-3.5 transition hover:bg-surface2 active:bg-surface2"
      >
        <DeviceChip
          type={d.device_type}
          vendor={d.vendor}
          hostname={d.hostname}
          brandOverride={d.brand_override}
          size={36}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-[14px] font-medium text-ink">
              {displayName(d)}
            </span>
            {d.is_self && (
              <span className="badge badge-accent shrink-0">{t('devices.self')}</span>
            )}
            {d.is_gateway && (
              <span className="badge badge-gateway shrink-0">{t('devices.gateway')}</span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted2">
            <span className="mono">{d.ip || '-'}</span>
            {d.ssid_name && <span className="truncate">{d.ssid_name}</span>}
            {d.vendor && (
              <span className="max-w-[140px] truncate">{d.vendor}</span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {d.kicked != null ? (
              <KickedBadge started={d.kicked} />
            ) : d.online ? (
              <span className="badge badge-online">{t('status.online')}</span>
            ) : (
              <span className="badge badge-offline">{t('status.offline')}</span>
            )}
            <span className="text-[11px] text-muted">
              {typeLabel(d.device_type)}
            </span>
            <span className="mono ml-auto text-[11px] text-muted2">
              {fmtAge(d.last_seen)}
            </span>
          </div>
        </div>
        <ChevronRight size={16} className="mt-1 shrink-0 text-muted2" aria-hidden="true" />
      </Link>
    </li>
  )
})

export default function DeviceTable({
  devices,
  actions,
}: {
  devices: Device[]
  /** Page-level control rendered at the end of the toolbar (e.g. Scan now). */
  actions?: ReactNode
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'online' | 'offline' | 'kicked'>('all')
  const [sort, setSort] = useState<SortKey>('status')
  const [asc, setAsc] = useState(false)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let out = devices.filter((d) => {
      if (filter === 'online' && !d.online) return false
      if (filter === 'offline' && d.online) return false
      if (filter === 'kicked' && d.kicked == null) return false
      if (!needle) return true
      return [d.nickname, d.hostname, d.ip, d.mac, d.vendor]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    })
    out = [...out].sort((a, b) => {
      const key = (d: Device) => {
        switch (sort) {
          case 'name': return displayName(d).toLowerCase()
          case 'ip': return ipKey(d.ip)
          case 'vendor': return (d.vendor || '').toLowerCase()
          case 'device_type': return d.device_type
          case 'last_seen': return d.last_seen || ''
          default: return ''
        }
      }
      const r = STATUS_RANK[sort]
      if (r) {
        const sa = rankOf(a)
        const sb = rankOf(b)
        if (sa !== sb) return asc ? sa - sb : sb - sa
      }
      const va = key(a)
      const vb = key(b)
      return asc ? va.localeCompare(vb) : vb.localeCompare(va)
    })
    return out
  }, [devices, q, filter, sort, asc])

  const head = (k: SortKey, label: string, className = '') => (
    <th
      className={className}
      onClick={() => {
        if (sort === k) setAsc((v) => !v)
        else {
          setSort(k)
          setAsc(true)
        }
      }}
    >
      {label}
      {sort === k && <span className="ml-1 text-bright">{asc ? '↑' : '↓'}</span>}
    </th>
  )

  return (
    <div className="card overflow-visible">
      <div className="card-toolbar">
        <input
          className="input w-full sm:max-w-xs"
          placeholder={t('devices.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="segmented">
          {(['all', 'online', 'offline', 'kicked'] as const).map((f) => (
            <button
              key={f}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {t(`devices.filters.${f}`)}
            </button>
          ))}
        </div>
        {/* Phones get a compact sort control instead of clickable table heads. */}
        <label className="flex items-center gap-2 md:hidden">
          <span className="text-xs text-muted2">{t('devices.sort')}</span>
          <select
            className="input w-auto"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label={t('devices.sort')}
          >
            <option value="status">{t('devices.headers.status')}</option>
            <option value="name">{t('devices.headers.name')}</option>
            <option value="ip">{t('devices.headers.ip')}</option>
            <option value="vendor">{t('devices.headers.vendor')}</option>
            <option value="device_type">{t('devices.headers.type')}</option>
            <option value="last_seen">{t('devices.headers.lastSeen')}</option>
          </select>
        </label>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-xs text-muted sm:inline">
            {t('devices.count', { n: rows.length })}
          </span>
          {actions}
        </div>
      </div>

      {/* Phone: a card list. The whole row is the tap target. */}
      <ul className="divide-y divide-border md:hidden">
        {rows.length === 0 ? (
          <li className="px-4 py-12 text-center text-muted">{t('devices.empty')}</li>
        ) : (
          rows.map((d) => <DeviceMobileRow key={d.mac} d={d} />)
        )}
      </ul>

      {/* Tablet and up: the table scrolls inside its own card rather than only
          with the page, so the last rows are never lost below the fold. */}
      <div
        className="hidden max-h-[60vh] overflow-auto rounded-b-[var(--radius-card)] md:block"
        tabIndex={0}
        aria-label={t('devices.listAria')}
      >
        <table className="net">
          <thead>
            <tr>
              <th className="w-8"></th>
              {head('name', t('devices.headers.name'))}
              {head('ip', t('devices.headers.ip'))}
              {head('vendor', t('devices.headers.vendor'), 'hidden lg:table-cell')}
              {head('device_type', t('devices.headers.type'))}
              {head('last_seen', t('devices.headers.lastSeen'))}
              {head('status', t('devices.headers.status'))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-muted py-12">
                  {t('devices.empty')}
                </td>
              </tr>
            )}
            {rows.map((d) => (
              <DeviceRow key={d.mac} d={d} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Sortable ordering for the status column: kicked, online, offline. */
function rankOf(d: Device): number {
  if (d.kicked != null) return 0
  return d.online ? 1 : 2
}

/** Numeric IP sort so 192.168.1.9 lands before 192.168.1.10. */
function ipKey(ip: string): string {
  const parts = ip.split('.').map((n) => String(parseInt(n, 10) || 0).padStart(3, '0'))
  return parts.length === 4 ? parts.join('.') : ip
}