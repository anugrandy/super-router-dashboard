import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAuth, useLive } from '../live'
import { api } from '../api'
import {
  UiDashboard,
  UiDevices,
  UiSettings,
  UiSearch,
  UiLogout,
  UiRefresh,
  UiMark,
} from './icons'
import { Activity, ChevronLeft, Gauge, Globe, Network } from 'lucide-react'
import Toasts from './Toasts'

const NavIcon = ({ children }: { children: React.ReactNode }) => (
  <span className="shrink-0">{children}</span>
)

/** Two-letter avatar tile used in the sidebar account card. */
function InitialAvatar({ name }: { name: string | null }) {
  const initials = (name || '?')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase()
  return (
    <span className="inline-flex items-center justify-center w-8 h-8 rounded-md shrink-0 text-[12px] font-medium border border-border bg-surface2 text-ink">
      {initials || '?'}
    </span>
  )
}

/** One sidebar row. NavLink's isActive drives the inverted highlight. */
function Item({
  to,
  children,
  icon,
}: {
  to: string
  children: ReactNode
  icon: ReactNode
}) {
  return (
    <NavLink
      to={to}
      end={to === '/dashboard'}
      className={({ isActive }) => `sidebar-item ${isActive ? 'active' : ''}`}
    >
      {() => (
        <>
          <span>{icon}</span>
          <span>{children}</span>
        </>
      )}
    </NavLink>
  )
}

/**
 * Sidebar search box. It filters a client-side list of the app's own routes
 * and jumps to the match on Enter. It is navigation, not a device search —
 * device filtering stays on the Devices page where the data lives.
 */
function SidebarSearch() {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const routes = [
    { to: '/dashboard', label: 'Dashboard', hint: 'Ringkasan jaringan' },
    { to: '/topology', label: 'Topologi', hint: 'Peta jaringan & router' },
    { to: '/devices', label: 'Devices', hint: 'Daftar semua perangkat' },
    { to: '/activity', label: 'Aktivitas', hint: 'Riwayat konek & diskon' },
    {
      to: '/connection',
      label: 'Koneksi Internet',
      hint: 'Status WAN, IP, uptime',
    },
    { to: '/speedtest', label: 'Speedtest', hint: 'Uji bandwidth' },
    { to: '/settings', label: 'Settings', hint: 'Subnet, interface, router' },
  ]
  const hits = q.trim()
    ? routes.filter((r) => (r.label + ' ' + r.hint).toLowerCase().includes(q.trim().toLowerCase()))
    : []

  // Close the result list when clicking elsewhere.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  function submit() {
    const first = hits[0] ?? routes.find((r) =>
      (r.label + ' ' + r.hint).toLowerCase().includes(q.trim().toLowerCase()),
    )
    if (q.trim() && first) {
      nav(first.to)
      setOpen(false)
    }
  }

  return (
    <div className="relative" ref={box}>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted2">
          <UiSearch />
        </span>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Cari menu…"
          aria-label="Cari menu"
          className="w-full bg-surface border border-border rounded-md pl-9 pr-3 py-2 text-[13px] text-ink placeholder:text-muted2 outline-none transition focus:border-bright"
        />
      </div>
      {open && hits.length > 0 && (
        <div className="absolute z-30 mt-1.5 w-full card p-1">
          {hits.map((r) => (
            <button
              key={r.to}
              onClick={() => {
                nav(r.to)
                setOpen(false)
                setQ('')
              }}
              className="w-full text-left px-2.5 py-2 rounded-md hover:bg-surface2 transition"
            >
              <div className="text-[13px] text-ink">{r.label}</div>
              <div className="text-[11px] text-muted">{r.hint}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Layout({ children }: { children: ReactNode }) {
  const { username, logout } = useAuth()
  const { connected } = useLive()
  const nav = useNavigate()

  return (
    <div className="min-h-screen flex">
      {/* Sidebar: the darkest plane in the app, so the content area reads as
          a lighter surface sitting next to it. */}
      <aside className="w-[248px] shrink-0 border-r border-border bg-bg">
        <div className="sticky top-0 h-screen flex flex-col px-4 py-5">
          <div className="flex items-center gap-2.5 px-1 mb-6">
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-border bg-surface2 text-bright">
              <UiMark />
            </span>
            <span className="font-semibold tracking-tight text-[14px] text-ink">
              AN Telemetry
            </span>
          </div>

          <SidebarSearch />

          <nav className="mt-6 space-y-0.5">
            <Item to="/dashboard" icon={<UiDashboard />}>
              Dashboard
            </Item>
            <Item to="/topology" icon={<NavIcon><Network size={17} /></NavIcon>}>
              Topologi
            </Item>
            <Item to="/devices" icon={<UiDevices />}>
              Devices
            </Item>
            <Item to="/activity" icon={<NavIcon><Activity size={17} /></NavIcon>}>
              Aktivitas
            </Item>
            <Item to="/connection" icon={<NavIcon><Globe size={17} /></NavIcon>}>
              Koneksi Internet
            </Item>
            <Item to="/speedtest" icon={<NavIcon><Gauge size={17} /></NavIcon>}>
              Speedtest
            </Item>
            <Item to="/settings" icon={<UiSettings />}>
              Settings
            </Item>
          </nav>

          {/* Account card: avatar, name, live state and sign-out together, as
              one bordered unit rather than loose rows of text. */}
          <div className="mt-auto">
            <div className="flex items-center gap-2.5 rounded-md border border-border bg-surface px-2.5 py-2">
              <InitialAvatar name={username} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-ink truncate leading-tight">
                  {username}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{
                      background: connected ? 'var(--color-green)' : 'var(--color-muted2)',
                    }}
                  />
                  <span className="text-[11px] text-muted">
                    {connected ? 'Live' : 'Offline'}
                  </span>
                </div>
              </div>
              <button
                className="shrink-0 text-muted hover:text-ink transition p-1"
                title="Keluar"
                aria-label="Keluar"
                onClick={async () => {
                  await logout()
                  nav('/login', { replace: true })
                }}
              >
                <UiLogout />
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 min-w-0 relative z-[1]">
        <div className="max-w-[1400px] mx-auto px-8 py-8">{children}</div>
      </main>

      {/* Live connect/disconnect toasts. Subscribes to the transitions pub/sub
          directly, so showing them does not re-render anything else. */}
      <Toasts />
    </div>
  )
}

export function ScanButton({ className = 'btn' }: { className?: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await api.scanNow()
        } finally {
          setBusy(false)
        }
      }}
    >
      <UiRefresh className={busy ? 'animate-spin' : ''} />
      {busy ? 'Scanning…' : 'Scan sekarang'}
    </button>
  )
}

/**
 * Plain-text back link used across the app. Deliberately chrome-free: a small
 * chevron and label share the muted text colour, with only a colour transition
 * on hover.
 */
export function BackLink({
  to,
  label,
  className = '',
}: {
  to: string
  label: string
  className?: string
}) {
  return (
    <Link to={to} className={`back-link ${className}`.trim()}>
      <ChevronLeft size={15} strokeWidth={2} aria-hidden="true" />
      <span>{label}</span>
    </Link>
  )
}

/** Page header used by every page: bold title, muted subtitle, right actions. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 mb-8">
      <div className="min-w-0">
        <h1 className="section-title">{title}</h1>
        {subtitle && <div className="card-sub mt-1">{subtitle}</div>}
      </div>
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  )
}