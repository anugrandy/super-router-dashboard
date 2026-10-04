import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fmtAge, fmtTime, type ActivityEvent } from '../api'
import { PageHeader } from '../components/Layout'
import { DeviceTypeChip, IconPlug, IconUnplug } from '../components/icons'
import { useTransitions } from '../components/Toasts'

/**
 * Cross-device activity feed.
 *
 * Reads the `device_events` rows the scanner has always written - no new table,
 * no background polling of its own. It reloads once on mount and then again
 * whenever a transitions push arrives, so a live session stays current without
 * a timer running in the background.
 */
export default function ActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null)
  const [filter, setFilter] = useState<'all' | 'online' | 'offline'>('all')
  const [err, setErr] = useState('')
  const transitions = useTransitions()

  const load = useCallback(async () => {
    try {
      const r = await api.activity(150)
      setEvents(r.events)
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal memuat aktivitas')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Refresh when the live socket reports a change. `transitions` is a stable
  // reference between pushes, so this does not fire on unrelated renders.
  useEffect(() => {
    if (transitions.length > 0) void load()
  }, [transitions, load])

  const rows = useMemo(() => {
    const list = events ?? []
    if (filter === 'all') return list
    return list.filter((e) => e.kind === filter)
  }, [events, filter])

  const todayCount = useMemo(() => {
    if (!events) return 0
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return events.filter((e) => e.at && new Date(e.at) >= start).length
  }, [events])

  return (
    <div>
      <PageHeader
        title="Aktivitas"
        subtitle={
          events
            ? `${events.length} event terbaru${todayCount ? ` · ${todayCount} hari ini` : ''}`
            : undefined
        }
        actions={
          <div className="flex gap-1 p-1 rounded-[10px] bg-bg/60 border border-border">
            {(['all', 'online', 'offline'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-[13px] font-medium capitalize transition ${
                  filter === f
                    ? 'bg-surface2 text-[#F2F2F3]'
                    : 'text-[#8B8D93] hover:text-[#F2F2F3] hover:bg-surface2'
                }`}
              >
                {f === 'all' ? 'Semua' : f === 'online' ? 'Online' : 'Offline'}
              </button>
            ))}
          </div>
        }
      />

      {err && (
        <div className="card px-4 py-3 mb-4 border-[rgba(232,96,74,0.3)] bg-[rgba(232,96,74,0.07)] text-sm text-[#E8604A]">
          {err}
        </div>
      )}

      <div className="card overflow-hidden">
        {events === null ? (
          <p className="p-6 text-center text-[13px] text-[#8B8D93]">Memuat…</p>
        ) : rows.length === 0 ? (
          <p className="p-10 text-center text-[13px] text-[#8B8D93]">
            Belum ada aktivitas{maybe(filter)} Devices yang sering connect-disconnect
            akan muncul di sini.
          </p>
        ) : (
          <ul>
            {rows.map((e) => {
              const online = e.kind === 'online'
              return (
                <li
                  key={e.id}
                  className="flex items-center gap-3 px-4 py-2.5 border-b border-[rgba(255,255,255,0.035)] last:border-0 hover:bg-[rgba(255,255,255,0.022)] transition"
                >
                  <DeviceTypeChip type={e.device_type} size={28} />
                  <span
                    className="shrink-0"
                    style={{ color: online ? '#3ED28C' : '#E8604A' }}
                    title={online ? 'Connect' : 'Disconnect'}
                  >
                    {online ? <IconPlug size={14} /> : <IconUnplug size={14} />}
                  </span>
                  <Link
                    to={`/devices/${encodeURIComponent(e.mac)}`}
                    className="flex-1 min-w-0 text-[13px] text-[#F2F2F3] hover:text-[#8B8D93] truncate transition"
                  >
                    {e.name}
                  </Link>
                  <span className="mono text-[11px] text-[#8B8D93] hidden sm:inline">
                    {e.ip || '—'}
                  </span>
                  <span
                    className={`badge shrink-0 ${online ? 'badge-online' : 'badge-offline'}`}
                  >
                    {online ? 'connect' : 'disconnect'}
                  </span>
                  <span
                    className="text-[11px] text-[#58585F] shrink-0 w-24 text-right"
                    title={fmtTime(e.at)}
                  >
                    {fmtAge(e.at)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function maybe(filter: string): string {
  return filter === 'all' ? '. ' : ` untuk filter "${filter}". `
}