import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth, useLive } from '../live'
import { api } from '../api'
import { UiDashboard, UiDevices, UiSettings, UiSearch, UiLogout, UiRefresh } from './icons'
import { Gauge, Network, Activity, Globe } from 'lucide-react'
import Toasts from './Toasts'

const NavIcon = ({ children }: { children: React.ReactNode }) => (
  <span className="shrink-0">{children}</span>
)

/** One sidebar row. NavLink's isActive drives the accent highlight. */
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
      {({ isActive }) => (
        <>
          <span style={{ color: isActive ? '#8fa8f8' : 'currentColor' }}>{icon}</span>
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
    { to: '/devices', label: 'Devices', hint: 'Daftar semua perangkat' },
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
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#5d6675]">
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
          className="w-full bg-base-900/70 border border-base-700 rounded-[10px] pl-9 pr-3 py-2 text-[13px] text-[#dbe1ec] placeholder:text-[#5d6675] outline-none transition focus:border-accent-500 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
        />
      </div>
      {open && hits.length > 0 && (
        <div className="absolute z-30 mt-1.5 w-full card p-1 shadow-xl">
          {hits.map((r) => (
            <button
              key={r.to}
              onClick={() => {
                nav(r.to)
                setOpen(false)
                setQ('')
              }}
              className="w-full text-left px-2.5 py-2 rounded-[9px] hover:bg-base-800 transition"
            >
              <div className="text-[13px] text-[#dbe1ec]">{r.label}</div>
              <div className="text-[11px] text-[#6b7484]">{r.hint}</div>
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
      <aside
        className="w-60 shrink-0 border-r border-base-700/70"
        style={{ background: 'var(--color-base-950)' }}
      >
        <div className="sticky top-0 h-screen flex flex-col px-3.5 py-4">
          <div className="flex items-center gap-2.5 px-1.5 mb-5">
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-[10px] bg-accent-600/90 text-white">
              <UiDashboard />
            </span>
            <span className="font-semibold tracking-tight text-[15px]">AN Telemetry</span>
          </div>

          <SidebarSearch />

          <nav className="mt-5 space-y-1">
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

          <div className="mt-auto space-y-3">
            <div className="px-1.5">
              <div
                className={`badge ${connected ? 'badge-online badge-pulse' : 'badge-offline'}`}
                title={connected ? 'Live update aktif' : 'Koneksi live terputus'}
              >
                {connected ? 'Live' : 'Offline'}
              </div>
            </div>
            <div className="flex items-center gap-2 px-1.5">
              <span className="flex-1 text-[13px] text-[#98a3b4] truncate">{username}</span>
              <button
                className="btn btn-ghost !px-2 !py-1.5"
                title="Keluar"
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
        <div className="max-w-7xl mx-auto px-6 py-6">{children}</div>
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
    <div className="flex flex-wrap items-center gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="section-title">{title}</h1>
        {subtitle && <div className="card-sub mt-0.5">{subtitle}</div>}
      </div>
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  )
}