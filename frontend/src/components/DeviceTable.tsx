import { memo, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TYPE_LABEL, displayName, fmtAge, type Device } from '../api'
import { DeviceTypeChip } from './icons'
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
  useClock() // re-render once per second while a kick is running
  const left = Math.max(0, Math.round(elapsedOf(started)))
  return (
    <span
      className="badge badge-kicked badge-pulse"
      title="Traffic sedang diblokir (blokir router + ARP spoof)"
    >
      Di-kick · {left}s
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
  return (
    <tr className={d.kicked != null ? 'row-kicked' : ''}>
      <td>
        <Link
          to={`/devices/${encodeURIComponent(d.mac)}`}
          className="text-[#6b7484] hover:text-[#9db4f7] text-lg leading-none"
          title="Detail device"
        >
          ›
        </Link>
      </td>
      <td>
        <div className="flex items-center gap-3">
          <DeviceTypeChip type={d.device_type} />
          <div className="min-w-0">
            <Link
              to={`/devices/${encodeURIComponent(d.mac)}`}
              className="font-medium text-[#e6eaf2] hover:text-[#9db4f7] transition"
            >
              {displayName(d)}
            </Link>
            <div className="mono text-[#5d6675]">{d.mac}</div>
          </div>
        </div>
      </td>
      <td>
        <div className="mono text-[#b6bfcd]">{d.ip || '-'}</div>
        {/* The AP the router reports for this client - not a default. */}
        {d.ssid_name && (
          <div className="text-[11px] text-[#5d6675]">{d.ssid_name}</div>
        )}
      </td>
      <td className="text-[#98a3b4] max-w-[220px] truncate" title={d.vendor}>
        {d.vendor || '-'}
      </td>
      <td className="text-[13px]">
        <span className={d.type_confident ? 'text-[#98a3b4]' : 'text-[#e0bb63]'}>
          {TYPE_LABEL[d.device_type] || d.device_type}
        </span>
        {/* No hostname and a randomized MAC means the type is a guess; say so
            instead of showing a confident-looking label. */}
        {!d.type_confident && (
          <div className="text-[10px] text-[#5d6675] mt-0.5">perlu dicek</div>
        )}
      </td>
      <td className="text-[#7c8798] text-xs">{fmtAge(d.last_seen)}</td>
      <td>
        <div className="flex flex-wrap gap-1.5">
          {d.kicked != null ? (
            <KickedBadge started={d.kicked} />
          ) : d.online ? (
            <span className="badge badge-online badge-pulse">Online</span>
          ) : (
            <span className="badge badge-offline">Offline</span>
          )}
          {d.is_gateway && <span className="badge badge-gateway">Gateway</span>}
        </div>
      </td>
    </tr>
  )
})

export default function DeviceTable({ devices }: { devices: Device[] }) {
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

  const head = (k: SortKey, label: string) => (
    <th
      onClick={() => {
        if (sort === k) setAsc((v) => !v)
        else {
          setSort(k)
          setAsc(true)
        }
      }}
    >
      {label}
      {sort === k && <span className="ml-1 text-[#8fa8f8]">{asc ? '↑' : '↓'}</span>}
    </th>
  )

  return (
    <div className="card overflow-visible">
      <div className="p-4 flex flex-wrap gap-3 items-center border-b border-base-700">
        <input
          className="input max-w-xs"
          placeholder="Cari nama, IP, MAC, vendor…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex gap-1 p-1 rounded-[10px] bg-base-900/60 border border-base-700">
          {(['all', 'online', 'offline', 'kicked'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-medium capitalize transition ${
                filter === f
                  ? 'bg-accent-soft text-[#b7c8fb]'
                  : 'text-[#7c8798] hover:text-[#dbe1ec] hover:bg-base-800'
              }`}
            >
              {f === 'all' ? 'Semua' : f === 'kicked' ? 'Di-kick' : f}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-[#7c8798]">
          <span className="text-[#b6bfcd]">{rows.length}</span> device
        </span>
      </div>

      <div className="overflow-x-auto rounded-b-[var(--radius-card)]">
        <table className="net">
          <thead>
            <tr>
              <th className="w-8"></th>
              {head('name', 'Nama')}
              {head('ip', 'IP / SSID')}
              {head('vendor', 'Vendor')}
              {head('device_type', 'Tipe')}
              {head('last_seen', 'Terakhir terlihat')}
              {head('status', 'Status')}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-[#7c8798] py-12">
                  Belum ada device yang cocok. Ubah subnet di Settings lalu scan.
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