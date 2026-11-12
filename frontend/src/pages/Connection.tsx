import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import { api, fmtTime, type WanEvent, type WanStatus } from '../api'
import { PageHeader } from '../components/Layout'
import { IconPlug, IconUnplug, UiRefresh } from '../components/icons'
import { useWanEvent } from '../components/Toasts'
import { DeleteLogButton, LogDeleteDialog } from '../components/LogDelete'
import { useLive } from '../live'

function Row({
  label,
  value,
  mono = true,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 border-b border-border last:border-0">
      <span className="text-[12px] text-muted shrink-0">{label}</span>
      <span
        className={`text-[13px] text-ink text-right truncate ${mono ? 'mono' : ''}`}
        title={value}
      >
        {value || '—'}
      </span>
    </div>
  )
}

function StatusPill({
  status,
  label,
}: {
  status: 'connected' | 'disconnected' | 'unknown'
  label: string
}) {
  const up = status === 'connected'
  const color = up
    ? 'var(--color-green)'
    : status === 'disconnected'
      ? 'var(--color-red)'
      : 'var(--color-muted)'
  const border = up
    ? 'rgba(34,197,94,0.35)'
    : status === 'disconnected'
      ? 'rgba(239,68,68,0.35)'
      : 'var(--color-border)'
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium border"
      style={{ color, borderColor: border }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  )
}

/**
 * Internet (WAN) connection status.
 *
 * Deliberately does NOT poll. The backend already polls the router every two
 * minutes and pushes a socket event when the state changes; this page loads
 * once and then updates when that arrives. Adding a timer here would mean two
 * pollers for one number.
 */
export default function ConnectionPage() {
  const { t } = useTranslation()
  const { devices, logsChangedAt } = useLive()
  const [data, setData] = useState<{ status: WanStatus; history: WanEvent[]; poll_seconds: number } | null>(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const wanEvent = useWanEvent()

  const load = useCallback(async () => {
    try {
      setData(await api.wan())
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('connection.loadError'))
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  // Refresh when the monitor detects a change.
  useEffect(() => {
    if (wanEvent) void load()
  }, [wanEvent, load])

  useEffect(() => {
    if (logsChangedAt) void load()
  }, [logsChangedAt, load])

  const refresh = async () => {
    setBusy(true)
    await load()
    setBusy(false)
  }

  const s = data?.status
  const up = s?.ipv4_status === 'connected'
  const v6 = s?.ipv6_status === 'connected'

  const statusText = (value: string) =>
    value === 'connected'
      ? t('status.connected')
      : value === 'disconnected'
        ? t('status.disconnected')
        : t('common.unknown')

  return (
    <div>
      <PageHeader
        title={t('connection.title')}
        subtitle={
          s?.available
            ? t('connection.subtitle', {
                name: s.connection_name,
                type: s.connection_type,
                seconds: data?.poll_seconds ?? 120,
              })
            : undefined
        }
      />

      {msg && <div className="notice notice-success mb-5">{msg}</div>}
      {err && <div className="notice notice-danger mb-5">{err}</div>}

      {!s ? (
        <p className="py-10 text-center text-[13px] text-muted">
          {t('connection.loading')}
        </p>
      ) : !s.available ? (
        <div className="max-w-2xl py-4">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-red">
            <IconUnplug size={16} />
            {t('connection.routerDown')}
          </div>
          <p className="mt-2 text-[12px] leading-5 text-muted">
            {s.error || t('connection.routerDownBody')}
          </p>
          <p className="mt-2 text-[12px] leading-5 text-muted">
            {t('connection.routerDownNote')}
          </p>
        </div>
      ) : (
        <>
          {/* Main status: a plain summary row, not a boxed hero card. */}
          <div className="mb-8 flex flex-wrap items-center gap-4">
            <span
              className="shrink-0"
              style={{ color: up ? 'var(--color-green)' : 'var(--color-red)' }}
            >
              {up ? <IconPlug size={28} /> : <IconUnplug size={28} />}
            </span>
            <div className="min-w-0 flex-1">
              <div
                className="text-[20px] font-semibold leading-tight tracking-tight"
                style={{ color: up ? 'var(--color-green)' : 'var(--color-red)' }}
              >
                {up ? t('connection.online') : t('connection.offline')}
              </div>
              <div className="mt-1 text-[12px] text-muted">
                {s.connection_name} · {s.connection_type || '—'}
                {up
                  ? t('connection.onlineFor', { duration: s.online_human })
                  : s.disconnect_reason
                    ? ` · ${s.disconnect_reason}`
                    : ''}
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-1.5">
              <StatusPill
                status={s.ipv4_status}
                label={up ? t('connection.ipv4Active') : t('connection.ipv4Down')}
              />
              {s.ipv6_status !== 'unknown' && (
                <StatusPill
                  status={s.ipv6_status}
                  label={v6 ? t('connection.ipv6Active') : t('connection.ipv6Down')}
                />
              )}
            </div>
            {/* Refresh belongs to the status it refreshes, not the page header. */}
            <button
              onClick={refresh}
              disabled={busy}
              className="btn shrink-0 self-start"
              title={t('connection.refresh')}
            >
              <UiRefresh className={busy ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">{t('connection.refresh')}</span>
            </button>
          </div>

          {/* Outage reason keeps a red rule instead of a filled card. */}
          {s.disconnect_reason && (
            <div className="notice notice-danger mb-8">
              <div className="min-w-0">
                <div className="text-[12px] font-semibold">
                  {t('connection.disconnectTitle')}
                </div>
                <div className="mono mt-1 text-[12px] text-ink">{s.disconnect_reason}</div>
                <p className="mt-1.5 text-[11px] leading-4 text-muted">
                  {t('connection.disconnectNote')}
                </p>
              </div>
            </div>
          )}

          <div className="mb-10 grid grid-cols-1 gap-x-10 gap-y-10 lg:grid-cols-2">
            <section>
              <h3 className="mb-1 text-[13px] font-semibold text-ink">{t('connection.ipv4')}</h3>
              <Row label={t('connection.status')} value={statusText(s.ipv4_status)} mono={false} />
              <Row label={t('connection.wanIp')} value={s.ipv4_address} />
              <Row label={t('connection.gateway')} value={s.gateway} />
              <Row label={t('connection.subnetMask')} value={s.subnet_mask} />
              <Row label={t('connection.onlineDuration')} value={s.online_human} mono={false} />
              <Row label={t('connection.dns')} value={s.dns.join(', ') || '—'} />
            </section>

            <section>
              <h3 className="mb-1 text-[13px] font-semibold text-ink">
                {t('connection.ipv6')}{' '}
                {s.ipv6_status !== 'unknown' && (
                  <StatusPill
                    status={s.ipv6_status}
                    label={v6 ? t('status.active') : t('status.inactive')}
                  />
                )}
              </h3>
              {s.ipv6_status === 'unknown' ? (
                <p className="text-[12px] text-muted py-2">
                  {t('connection.noIpv6')}
                </p>
              ) : (
                <>
                  <Row label={t('connection.addressPrefix')} value={s.ipv6_address} />
                  <Row label={t('connection.gateway')} value={s.ipv6_gateway} />
                  <Row
                    label={t('connection.onlineDuration')}
                    value={s.ipv6_online_human}
                    mono={false}
                  />
                  <Row label={t('connection.dns')} value={s.ipv6_dns.join(', ') || '—'} />
                </>
              )}
            </section>

            <section>
              <h3 className="mb-1 text-[13px] font-semibold text-ink">{t('connection.connections')}</h3>
              <Row label={t('connection.name')} value={s.connection_name} mono={false} />
              <Row label={t('connection.connectionType')} value={s.connection_type} mono={false} />
              <Row label={t('connection.auth')} value={s.auth_type || '—'} mono={false} />
              <Row label="VLAN" value={s.vlan_id} />
              <Row label="MTU" value={s.mtu} />
              <Row
                label="NAT"
                value={s.is_nat ? t('connection.natOn') : t('connection.natOff')}
                mono={false}
              />
              <Row
                label={t('connection.defaultGateway')}
                value={s.is_default_gateway ? t('connection.yes') : t('connection.no')}
                mono={false}
              />
            </section>

            {/* Every connection the router reports, so a rename is visible */}
            <section>
              <h3 className="mb-1 text-[13px] font-semibold text-ink">
                {t('connection.allConnections')}
              </h3>
              <ul className="text-[12px]">
                {s.connections.map((c) => (
                  <li
                    key={c.name}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border py-2 last:border-0"
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        background:
                          c.ipv4_status === 'connected'
                            ? 'var(--color-green)'
                            : 'var(--color-muted2)',
                      }}
                    />
                    <span className="shrink-0 text-ink">{c.name}</span>
                    <span className="shrink-0 text-muted">{c.type || '—'}</span>
                    <span className="mono min-w-0 flex-1 truncate text-muted">
                      {c.ipv4_address && c.ipv4_address !== '0.0.0.0' ? c.ipv4_address : '—'}
                    </span>
                    {c.is_default_gateway && (
                      <span className="badge badge-accent shrink-0">
                        {t('connection.default')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {/* Outage history */}
          <section className="mt-10">
            <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-[13px] font-semibold text-ink">
                  {t('connection.history')}
                </h3>
                <p className="mt-0.5 text-[11px] text-muted">
                  {t('connection.historySub')}
                </p>
              </div>
              {data && data.history.length > 0 && (
                <button
                  className="btn btn-sm btn-danger-quiet"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 size={14} />
                  {t('connection.deleteAll')}
                </button>
              )}
            </div>
            {!data || data.history.length === 0 ? (
              <p className="py-8 text-center text-[13px] text-muted">
                {t('connection.noHistory')}
              </p>
            ) : (
              <ul className="border-t border-border">
                {data.history.map((e) => {
                  const on = e.kind === 'connected'
                  return (
                    <li
                      key={e.id}
                      className="flex items-start gap-3 border-b border-border py-3 transition last:border-0 hover:bg-surface2"
                    >
                      <span
                        className="mt-0.5 shrink-0"
                        style={{ color: on ? 'var(--color-green)' : 'var(--color-red)' }}
                      >
                        {on ? <IconPlug size={14} /> : <IconUnplug size={14} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span
                            className={`badge shrink-0 ${on ? 'badge-online' : 'badge-offline'}`}
                          >
                            {on ? t('status.connected') : t('status.disconnected')}
                          </span>
                          <span className="mono text-[11px] text-muted">
                            {e.ipv4_address || '—'}
                          </span>
                          <span
                            className="mono ml-auto text-[11px] text-muted2"
                            title={fmtTime(e.at)}
                          >
                            {fmtTime(e.at)}
                          </span>
                        </div>
                        {e.reason && (
                          <div
                            className="mt-0.5 break-words text-[11px] text-red/80"
                            title={e.reason}
                          >
                            {e.reason}
                          </div>
                        )}
                      </div>
                      <DeleteLogButton
                        scope="wan_events"
                        id={e.id}
                        onDeleted={() => {
                          setMsg(t('connection.deleted', { n: 1 }))
                          void load()
                        }}
                        onError={setErr}
                      />
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </>
      )}

      <LogDeleteDialog
        open={deleteOpen}
        initialScope="wan_events"
        devices={devices}
        onClose={() => setDeleteOpen(false)}
        onDeleted={(r) => {
          setMsg(r.total ? t('connection.deleted', { n: r.total }) : t('logs.nothing'))
          void load()
        }}
        onError={setErr}
      />
    </div>
  )
}
