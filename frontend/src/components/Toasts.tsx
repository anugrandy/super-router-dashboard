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
import type { Transition, WanEvent } from '../api'
import { DeviceTypeChip, IconClose, IconPlug, IconUnplug } from './icons'

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

function Toast({ t, onDone }: { t: Transition; onDone: () => void }) {
  const online = t.kind !== 'offline'
  const fresh = t.kind === 'new'

  useEffect(() => {
    // A newly-seen device stays up a little longer so it registers.
    const ms = fresh ? 8000 : 5000
    const id = window.setTimeout(onDone, ms)
    return () => window.clearTimeout(id)
  }, [onDone, fresh])

  return (
    <Link
      to={`/devices/${encodeURIComponent(t.mac)}`}
      onClick={onDone}
      className="pointer-events-auto flex items-start gap-3 rounded-lg border bg-surface px-4 py-3 transition hover:bg-surface2"
      style={{
        borderColor: fresh
          ? 'var(--color-border-strong)'
          : online
            ? 'rgba(34,197,94,0.35)'
            : 'rgba(239,68,68,0.35)',
      }}
    >
      <DeviceTypeChip type={t.device_type} size={30} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            style={{ color: online ? 'var(--color-green)' : 'var(--color-red)' }}
            className="shrink-0"
          >
            {online ? <IconPlug size={13} /> : <IconUnplug size={13} />}
          </span>
          <span className="text-[13px] font-medium text-ink truncate">
            {t.name}
          </span>
          {fresh && <span className="badge badge-warn shrink-0">Baru!</span>}
        </div>
        <div className="text-[11px] text-muted mt-0.5 truncate">
          {fresh
            ? `baru pertama kali terlihat${t.ip ? ` di ${t.ip}` : ''}`
            : online
              ? `terhubung${t.ip ? ` di ${t.ip}` : ''}`
              : 'terputus'}
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
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {wan && <WanAlert w={wan} />}
      {shown.map((t) => (
        <Toast key={t.mac} t={t} onDone={() => dismiss(t.mac)} />
      ))}
      {items.length > shown.length && (
        <div className="text-[11px] text-muted2 text-right">
          +{items.length - shown.length} lainnya
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
  const down = w.kind !== 'connected'
  const [open, setOpen] = useState(true)
  useEffect(() => setOpen(true), [w])

  if (!open) return null

  return (
    <div
      role="alert"
      className="rounded-lg border bg-surface px-4 py-3.5"
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
            {down ? 'Internet Terputus!' : 'Internet Sudah Pulang'}
          </div>
          <div className="text-[11px] text-muted mt-0.5 leading-4">
            {down
              ? w.reason
                ? `Penyebab: ${humanReason(w.reason)}`
                : 'Koneksi ke ISP terputus. Wi-Fi lokal masih aktif.'
              : `Koneksi kembali normal${w.ipv4_address ? ` · ${w.ipv4_address}` : ''}`}
          </div>
          <Link
            to="/connection"
            onClick={() => setOpen(false)}
            className="inline-block mt-2 text-[11px] font-medium underline underline-offset-2 hover:opacity-80"
            style={{ color: down ? 'var(--color-red)' : 'var(--color-green)' }}
          >
            Lihat detail koneksi
          </Link>
        </div>
        <button
          onClick={() => setOpen(false)}
          aria-label="Tutup peringatan"
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