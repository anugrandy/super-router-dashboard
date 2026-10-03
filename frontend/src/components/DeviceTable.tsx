import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { TYPE_LABEL, displayName, fmtAge, type Device } from '../api'

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

function KickedBadge({ secs }: { secs: number }) {
  const left = Math.max(0, Math.round(secs))
  return (
    <span className="badge badge-kicked badge-pulse" title="Traffic sedang diblokir (ARP spoof)">
      Di-kick · {left}s
    </span>
  )
}

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
      {sort === k && <span className="ml-1 text-sky-400">{asc ? '↑' : '↓'}</span>}
    </th>
  )

  return (
    <div className="card overflow-hidden">
      <div className="p-4 flex flex-wrap gap-3 items-center border-b border-ink-700">
        <input
          className="input max-w-xs"
          placeholder="Cari nama, IP, MAC, vendor…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex gap-1">
          {(['all', 'online', 'offline', 'kicked'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm capitalize ${
                filter === f ? 'bg-ink-700 text-white' : 'text-slate-400 hover:bg-ink-800'
              }`}
            >
              {f === 'all' ? 'Semua' : f === 'kicked' ? 'Di-kick' : f}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-slate-500">{rows.length} device</span>
      </div>

      <div className="overflow-x-auto">
        <table className="net">
          <thead>
            <tr>
              <th className="w-8"></th>
              {head('name', 'Nama')}
              {head('ip', 'IP')}
              {head('vendor', 'Vendor')}
              {head('device_type', 'Tipe')}
              {head('last_seen', 'Terakhir terlihat')}
              {head('status', 'Status')}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-500 py-10">
                  Belum ada device yang cocok. Ubah subnet di Settings lalu scan.
                </td>
              </tr>
            )}
            {rows.map((d) => (
              <tr key={d.mac} className={d.kicked != null ? 'row-kicked' : ''}>
                <td>
                  <Link
                    to={`/devices/${encodeURIComponent(d.mac)}`}
                    className="text-sky-400 hover:text-sky-300"
                    title="Detail device"
                  >
                    &rsaquo;
                  </Link>
                </td>
                <td>
                  <Link
                    to={`/devices/${encodeURIComponent(d.mac)}`}
                    className="hover:text-sky-300 font-medium"
                  >
                    {displayName(d)}
                  </Link>
                  <div className="mono text-slate-500">{d.mac}</div>
                </td>
                <td className="mono">{d.ip || '-'}</td>
                <td className="text-slate-300 max-w-[220px] truncate" title={d.vendor}>
                  {d.vendor || '-'}
                </td>
                <td className="text-slate-400">{TYPE_LABEL[d.device_type] || d.device_type}</td>
                <td className="text-slate-400 text-xs">{fmtAge(d.last_seen)}</td>
                <td>
                  <div className="flex flex-wrap gap-1.5">
                    {d.kicked != null ? (
                      <KickedBadge secs={d.kicked} />
                    ) : d.online ? (
                      <span className="badge badge-online badge-pulse">Online</span>
                    ) : (
                      <span className="badge badge-offline">Offline</span>
                    )}
                    {d.is_gateway && <span className="badge badge-gateway">Gateway</span>}
                  </div>
                </td>
              </tr>
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