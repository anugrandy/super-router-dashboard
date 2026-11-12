/** Flexible history deletion: one dialog for every log type.
 *
 * The backend exposes a single `POST /api/logs/delete` endpoint with
 * scope + device + time + id filters. This component is the shared UI for the
 * bulk case; per-row deletes use {@link DeleteLogButton} so a single entry can
 * be removed without opening the full form.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import {
  api,
  displayName,
  type Device,
  type LogDeleteBody,
  type LogDeleteResult,
  type LogScope,
} from '../api'

type TimePreset = 'all' | '7' | '30' | '90' | 'custom'

const SCOPES: LogScope[] = [
  'device_events',
  'kick_logs',
  'wan_events',
  'speedtest_runs',
  'all',
]

export function LogDeleteDialog({
  open,
  initialScope = 'all',
  initialMac = '',
  devices,
  profile = null,
  onClose,
  onDeleted,
  onError,
}: {
  open: boolean
  initialScope?: LogScope
  /** Preselect a device, e.g. when deleting from its own detail page. */
  initialMac?: string
  devices: Device[]
  /** Scope device/kick history to this network profile. */
  profile?: number | null
  onClose: () => void
  onDeleted: (result: LogDeleteResult) => void
  onError: (message: string) => void
}) {
  const { t } = useTranslation()
  const [scope, setScope] = useState<LogScope>(initialScope)
  const [mac, setMac] = useState('')
  const [time, setTime] = useState<TimePreset>('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  // Reset each time the dialog opens so a previous filter never lingers.
  useEffect(() => {
    if (!open) return
    setScope(initialScope)
    setMac(initialMac)
    setTime('all')
    setFrom('')
    setTo('')
    setTyped('')
    setBusy(false)
  }, [open, initialScope, initialMac])

  const sortedDevices = useMemo(
    () => [...devices].sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [devices],
  )

  // WAN and speedtest history are global tables with no MAC column.
  const deviceAllowed = scope === 'all' || scope === 'device_events' || scope === 'kick_logs'

  const scopeLabel: Record<LogScope, string> = {
    all: t('logs.scopeAll'),
    device_events: t('logs.scopeDeviceEvents'),
    kick_logs: t('logs.scopeKickLogs'),
    wan_events: t('logs.scopeWanEvents'),
    speedtest_runs: t('logs.scopeSpeedtest'),
  }

  function buildBody(): LogDeleteBody {
    const body: LogDeleteBody = { scope }
    if (profile != null) body.profile = profile
    if (deviceAllowed && mac) body.mac = mac
    if (time === 'custom') {
      if (from) body.after = new Date(`${from}T00:00:00`).toISOString()
      if (to) body.before = new Date(`${to}T23:59:59.999`).toISOString()
    } else if (time !== 'all') {
      const days = Number(time)
      body.before = new Date(Date.now() - days * 86_400_000).toISOString()
    }
    // A bare "everything in this scope" request must opt in explicitly; the
    // backend rejects it otherwise so a mistyped call cannot wipe a table.
    if (!body.mac && !body.before && !body.after) body.all = true
    return body
  }

  const body = buildBody()
  const wideOpen = Boolean(body.all)
  const confirmWord = t('logs.confirmWord')

  async function submit() {
    if (time === 'custom' && !from && !to) {
      onError(t('logs.dateRequired'))
      return
    }
    if (wideOpen && typed.trim().toUpperCase() !== confirmWord) {
      onError(t('logs.confirmNeeded', { word: confirmWord }))
      return
    }
    setBusy(true)
    try {
      const result = await api.deleteLogs(body)
      onDeleted(result)
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : t('logs.deleteError'))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4 glass-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={t('logs.title')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="glass-panel w-full max-w-lg rounded-lg p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="card-title">{t('logs.title')}</h2>
          <button
            className="text-muted hover:text-ink transition p-1 -mr-1 -mt-1"
            onClick={onClose}
            disabled={busy}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </div>
        <p className="card-sub mb-4">{t('logs.description')}</p>

        <label className="block text-[11px] font-medium text-muted mb-1.5">
          {t('logs.scope')}
        </label>
        <select
          className="input mb-3"
          value={scope}
          disabled={busy}
          onChange={(e) => setScope(e.target.value as LogScope)}
        >
          {SCOPES.map((s) => (
            <option key={s} value={s}>
              {scopeLabel[s]}
            </option>
          ))}
        </select>

        {deviceAllowed && (
          <>
            <label className="block text-[11px] font-medium text-muted mb-1.5">
              {t('logs.device')}
            </label>
            <select
              className="input mb-3"
              value={mac}
              disabled={busy}
              onChange={(e) => setMac(e.target.value)}
            >
              <option value="">{t('logs.allDevices')}</option>
              {sortedDevices.map((d) => (
                <option key={d.mac} value={d.mac}>
                  {displayName(d)} — {d.mac}
                </option>
              ))}
            </select>
          </>
        )}

        <label className="block text-[11px] font-medium text-muted mb-1.5">
          {t('logs.time')}
        </label>
        <select
          className="input mb-3"
          value={time}
          disabled={busy}
          onChange={(e) => setTime(e.target.value as TimePreset)}
        >
          <option value="all">{t('logs.timeAll')}</option>
          <option value="7">{t('logs.timeOlder7')}</option>
          <option value="30">{t('logs.timeOlder30')}</option>
          <option value="90">{t('logs.timeOlder90')}</option>
          <option value="custom">{t('logs.timeCustom')}</option>
        </select>

        {time === 'custom' && (
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-[11px] font-medium text-muted mb-1.5">
                {t('logs.from')}
              </label>
              <input
                className="input mono"
                type="date"
                value={from}
                disabled={busy}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-muted mb-1.5">
                {t('logs.to')}
              </label>
              <input
                className="input mono"
                type="date"
                value={to}
                disabled={busy}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
        )}

        {wideOpen ? (
          <div className="rounded-md border border-red/40 bg-surface2 px-3 py-2.5 mt-1">
            <p className="text-[12px] text-red leading-relaxed">{t('logs.allWarning')}</p>
            <p className="text-[11px] text-muted mt-1.5">
              {t('logs.confirmAllHint', { word: confirmWord })}
            </p>
            <input
              className="input mono mt-2"
              value={typed}
              disabled={busy}
              placeholder={confirmWord}
              onChange={(e) => setTyped(e.target.value)}
              aria-label={t('logs.confirmAllHint', { word: confirmWord })}
            />
          </div>
        ) : (
          <p className="text-[11px] text-muted2 mt-1 leading-relaxed">
            {t('logs.description')}
          </p>
        )}

        <div className="flex flex-wrap gap-2 mt-5">
          <button className="btn btn-danger" disabled={busy} onClick={submit}>
            <Trash2 size={14} />
            {busy
              ? t('common.deleting')
              : wideOpen
                ? t('logs.confirmAll')
                : t('logs.confirm')}
          </button>
          <button className="btn" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One-row delete. Confirms first, then removes exactly that entry. */
export function DeleteLogButton({
  scope,
  id,
  onDeleted,
  onError,
  className = '',
}: {
  scope: Exclude<LogScope, 'all'>
  id: number
  onDeleted: (result: LogDeleteResult) => void
  onError: (message: string) => void
  className?: string
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  async function remove() {
    if (!window.confirm(t('logs.deleteRowConfirm'))) return
    setBusy(true)
    try {
      onDeleted(await api.deleteLogs({ scope, ids: [id] }))
    } catch (e) {
      onError(e instanceof Error ? e.message : t('logs.deleteError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className={`btn-icon btn-icon-danger disabled:opacity-50 ${className}`.trim()}
      title={t('logs.deleteRow')}
      aria-label={t('logs.deleteRow')}
      disabled={busy}
      onClick={remove}
    >
      <Trash2 size={13} />
    </button>
  )
}
