import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import { api, fmtAge, fmtTime, type ActivityEvent, type Device } from '../api'
import { PageHeader } from '../components/Layout'
import { DeviceTypeChip, IconPlug, IconUnplug } from '../components/icons'
import { useTransitions } from '../components/Toasts'
import { DeleteLogButton, LogDeleteDialog } from '../components/LogDelete'
import { useLive } from '../live'

/**
 * Cross-device activity feed.
 *
 * Reads the `device_events` rows the scanner has always written - no new table,
 * no background polling of its own. It reloads once on mount and then again
 * whenever a transitions push arrives, so a live session stays current without
 * a timer running in the background.
 */
export default function ActivityPage() {
  const { t } = useTranslation()
  const {
    devices: liveDevices,
    logsChangedAt,
    isViewingActive,
    viewProfileId,
  } = useLive()
  const [events, setEvents] = useState<ActivityEvent[] | null>(null)
  const [scopeDevices, setScopeDevices] = useState<Device[]>([])
  const [filter, setFilter] = useState<'all' | 'online' | 'offline'>('all')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const transitions = useTransitions()

  const profileParam = isViewingActive ? null : viewProfileId

  const load = useCallback(async () => {
    try {
      const r = await api.activity(150, profileParam)
      setEvents(r.events)
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('activity.error'))
    }
  }, [t, profileParam])

  // The delete dialog needs the same profile's device names. The live list is
  // only correct for the active network, so pull the scoped list as well.
  useEffect(() => {
    api
      .devices(profileParam)
      .then((r) => setScopeDevices(r.devices))
      .catch(() => setScopeDevices([]))
  }, [profileParam, logsChangedAt, transitions])

  const dialogDevices = isViewingActive ? liveDevices : scopeDevices

  useEffect(() => {
    void load()
  }, [load])

  // Refresh when the live socket reports a change. `transitions` is a stable
  // reference between pushes, so this does not fire on unrelated renders.
  useEffect(() => {
    if (transitions.length > 0) void load()
  }, [transitions, load])

  // Refresh when history was deleted (here or from another tab).
  useEffect(() => {
    if (logsChangedAt) void load()
  }, [logsChangedAt, load])

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

  const filterLabel = (f: 'all' | 'online' | 'offline') =>
    t(`activity.filters.${f}`)

  function onDeleted(total: number) {
    setMsg(total ? t('logs.deleted', { n: total }) : t('logs.nothing'))
    void load()
  }

  return (
    <div>
      <PageHeader
        title={t('activity.title')}
        subtitle={
          events
            ? t('activity.subtitle', { n: events.length }) +
              (todayCount ? t('activity.today', { n: todayCount }) : '')
            : undefined
        }
      />

      {msg && <div className="notice notice-success mb-4">{msg}</div>}
      {err && <div className="notice notice-danger mb-4">{err}</div>}

      <div className="card overflow-hidden">
        {/* Filters and the bulk-delete action live on the list they act on,
            not in the page header. */}
        <div className="card-toolbar">
          <div className="segmented">
            {(['all', 'online', 'offline'] as const).map((f) => (
              <button
                key={f}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {filterLabel(f)}
              </button>
            ))}
          </div>
          <button
            className="btn btn-sm btn-danger-quiet ml-auto"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 size={14} />
            {t('logs.button')}
          </button>
        </div>
        {events === null ? (
          <p className="p-6 text-center text-[13px] text-muted">{t('activity.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="p-10 text-center text-[13px] text-muted">
            {filter === 'all'
              ? t('activity.emptyAll')
              : t('activity.emptyFilter', { filter: filterLabel(filter) })}
          </p>
        ) : (
          <ul>
            {rows.map((e) => {
              const online = e.kind === 'online'
              return (
                <li
                  key={e.id}
                  className="flex items-start gap-3 border-b border-border px-4 py-3 transition last:border-0 hover:bg-surface2 sm:px-5"
                >
                  <DeviceTypeChip type={e.device_type} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="shrink-0"
                        style={{ color: online ? 'var(--color-green)' : 'var(--color-red)' }}
                        title={online ? t('activity.connected') : t('activity.disconnected')}
                      >
                        {online ? <IconPlug size={14} /> : <IconUnplug size={14} />}
                      </span>
                      <Link
                        to={`/devices/${encodeURIComponent(e.mac)}`}
                        className="min-w-0 truncate text-[13px] text-ink transition hover:text-muted"
                      >
                        {e.name}
                      </Link>
                      <span
                        className={`badge ml-auto shrink-0 ${online ? 'badge-online' : 'badge-offline'}`}
                      >
                        {online ? t('activity.connected') : t('activity.disconnected')}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted2">
                      <span className="mono">{e.ip || '—'}</span>
                      <span aria-hidden="true">·</span>
                      <span className="mono" title={fmtTime(e.at)}>
                        {fmtAge(e.at)}
                      </span>
                    </div>
                  </div>
                  <DeleteLogButton
                    scope="device_events"
                    id={e.id}
                    onDeleted={() => {
                      setMsg(t('activity.deleted'))
                      void load()
                    }}
                    onError={setErr}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <LogDeleteDialog
        open={deleteOpen}
        initialScope="device_events"
        devices={dialogDevices}
        profile={profileParam}
        onClose={() => setDeleteOpen(false)}
        onDeleted={(r) => onDeleted(r.total)}
        onError={setErr}
      />
    </div>
  )
}
