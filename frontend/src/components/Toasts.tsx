/** Real-time toasts for device connect/disconnect.
 *
 * Deliberately NOT part of LiveContext. Adding transitions to the shared value
 * would re-render every consumer once per transition, which is exactly the lag
 * that was fixed earlier by isolating the 1 Hz kick clock.
 *
 * Instead this is a tiny pub/sub: the socket handler pushes into a module-level
 * buffer and notifies subscribers. Components that show toasts subscribe; every
 * other component never re-renders at all.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { Transition, WanEvent } from '../api'
import { DeviceChip, IconClose, IconPlug, IconUnplug } from './icons'

type Listener = (t: Transition[]) => void

const listeners = new Set<Listener>()
let buffer: Transition[] = []

// WAN outages are tracked separately. Losing the internet is a different kind
// of event from one device dropping off, so it gets a persistent banner instead
// of a toast that quietly disappears.
type WanListener = (w: WanEvent | null) => void
const wanListeners = new Set<WanListener>()
let wanBuffer: WanEvent | null = null

export function publishWan(w: WanEvent) {
  wanBuffer = w
  wanListeners.forEach((fn) => fn(wanBuffer))
}

export function useWanEvent() {
  const [w, setW] = useState<WanEvent | null>(wanBuffer)
  useEffect(() => {
    const fn: WanListener = (next) => setW(next)
    wanListeners.add(fn)
    setW(wanBuffer)
    return () => {
      wanListeners.delete(fn)
    }
  }, [])
  return w
}

/** Cap the buffer: a flapping device must not grow this without bound. */
const MAX_BUFFER = 50

export function publishTransitions(list: Transition[]): void {
  if (!list.length) return
  buffer = [...list, ...buffer].slice(0, MAX_BUFFER)
  listeners.forEach((fn) => fn(buffer))
}

// Debug handle, registered at module load so it exists before the first push.
// Useful from the console, and it lets a test drive the real pub/sub instead of
// a duplicate module instance (which a dev-server import would create).
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__netdashToasts = {
    publish: publishTransitions,
    peek: () => buffer,
    publishWan,
    peekWan: () => wanBuffer,
  }
}

export function useTransitions() {
  const [items, setItems] = useState<Transition[]>(buffer)
  useEffect(() => {
    const fn: Listener = (next) => setItems(next)
    listeners.add(fn)
    setItems(buffer)
    return () => {
      listeners.delete(fn)
    }
  }, [])
  return items
}

function Toast({ t: transition, onDone }: { t: Transition; onDone: () => void }) {
  const { t } = useTranslation()
  const online = transition.kind !== 'offline'
  const fresh = transition.kind === 'new'

  useEffect(() => {
    // A newly-seen device stays up a little longer so it registers.
    const ms = fresh ? 8000 : 5000
    const id = window.setTimeout(onDone, ms)
    return () => window.clearTimeout(id)
  }, [onDone, fresh])

  return (
    <Link
      to={`/devices/${encodeURIComponent(transition.mac)}`}
      onClick={onDone}
      className="pointer-events-auto flex items-start gap-3 rounded-lg glass-panel px-4 py-3 transition hover:-translate-y-0.5"
      style={{
        borderColor: fresh
          ? 'var(--color-border-strong)'
          : online
            ? 'rgba(34,197,94,0.35)'
            : 'rgba(239,68,68,0.35)',
      }}
    >
      <DeviceChip
        type={transition.device_type}
        vendor={transition.vendor}
        hostname={transition.hostname}
        brandOverride={transition.brand_override}
        size={30}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            style={{ color: online ? 'var(--color-green)' : 'var(--color-red)' }}
            className="shrink-0"
          >
            {online ? <IconPlug size={13} /> : <IconUnplug size={13} />}
          </span>
          <span className="text-[13px] font-medium text-ink truncate">
            {transition.name}
          </span>
          {fresh && <span className="badge badge-warn shrink-0">{t('toasts.newBadge')}</span>}
        </div>
        <div className="text-[11px] text-muted mt-0.5 truncate">
          {fresh
            ? t('toasts.firstSeen', {
                ip: transition.ip ? t('toasts.firstSeenIp', { ip: transition.ip }) : '',
              })
            : online
              ? t('toasts.connected', {
                  ip: transition.ip ? t('toasts.connectedIp', { ip: transition.ip }) : '',
                })
              : t('toasts.disconnected')}
        </div>
      </div>
    </Link>
  )
}

/**
 * Toast stack, fixed bottom-right.
 *
 * Only renders when there is something to show, and the list is capped so a
 * burst of transitions cannot flood the viewport.
 */
export default function Toasts() {
  const { t } = useTranslation()
  const items = useTransitions()
  const wan = useWanEvent()
  const [, force] = useState(0)

  if (items.length === 0 && !wan) return null

  const shown = items.slice(0, 4)
  const dismiss = (mac: string) => {
    buffer = buffer.filter((t) => t.mac !== mac)
    force((n) => n + 1)
    listeners.forEach((fn) => fn(buffer))
  }

  return (
    <div className="fixed left-4 right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] sm:left-auto sm:right-5 sm:bottom-5 sm:w-80 z-50 flex flex-col gap-2">
      {wan && <WanAlert w={wan} />}
      {shown.map((t) => (
        <Toast key={t.mac} t={t} onDone={() => dismiss(t.mac)} />
      ))}
      {items.length > shown.length && (
        <div className="text-[11px] text-muted2 text-right">
          {t('toasts.more', { n: items.length - shown.length })}
        </div>
      )}
    </div>
  )
}

/**
 * Internet-outage banner.
 *
 * Persists until dismissed instead of auto-hiding: if the link is down the
 * operator still needs to see that while they look for the cause, so a toast
 * that quietly faded after five seconds would be the wrong behaviour here.
 */
function WanAlert({ w }: { w: WanEvent }) {
  const { t } = useTranslation()
  const down = w.kind !== 'connected'
  const [open, setOpen] = useState(true)
  useEffect(() => setOpen(true), [w])

  if (!open) return null

  return (
    <div
      role="alert"
      className="rounded-lg glass-panel px-4 py-3.5"
      style={{
        borderColor: down ? 'rgba(239,68,68,0.45)' : 'rgba(34,197,94,0.4)',
      }}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="mt-0.5 shrink-0"
          style={{ color: down ? 'var(--color-red)' : 'var(--color-green)' }}
        >
          {down ? <IconUnplug size={16} /> : <IconPlug size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div
            className="text-[14px] font-semibold"
            style={{ color: down ? 'var(--color-red)' : 'var(--color-green)' }}
          >
            {down ? t('toasts.wanDown') : t('toasts.wanUp')}
          </div>
          <div className="text-[11px] text-muted mt-0.5 leading-4">
            {down
              ? w.reason
                ? t('toasts.wanReason', { reason: humanReason(w.reason) })
                : t('toasts.wanDownBody')
              : t('toasts.wanUpBody', {
                  ip: w.ipv4_address ? t('toasts.wanUpIp', { ip: w.ipv4_address }) : '',
                })}
          </div>
          <Link
            to="/connection"
            onClick={() => setOpen(false)}
            className="inline-block mt-2 text-[11px] font-medium underline underline-offset-2 hover:opacity-80"
            style={{ color: down ? 'var(--color-red)' : 'var(--color-green)' }}
          >
            {t('toasts.wanDetail')}
          </Link>
        </div>
        <button
          onClick={() => setOpen(false)}
          aria-label={t('toasts.closeAlert')}
          className="shrink-0 text-muted hover:text-ink transition -mt-0.5 -mr-1 p-1"
        >
          <IconClose size={13} />
        </button>
      </div>
    </div>
  )
}

/** Router error codes are terse; strip the prefix so they read as a sentence. */
function humanReason(code: string): string {
  return code.replace(/^ERROR_/, '').replace(/_/g, ' ').toLowerCase()
}