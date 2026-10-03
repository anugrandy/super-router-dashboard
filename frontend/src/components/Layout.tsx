import { useState, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth, useLive } from '../live'
import { api } from '../api'

function Item({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `px-3 py-1.5 rounded-lg text-sm transition ${
          isActive
            ? 'bg-ink-700 text-white'
            : 'text-slate-400 hover:text-slate-100 hover:bg-ink-800'
        }`
      }
    >
      {children}
    </NavLink>
  )
}

export default function Layout({ children }: { children: ReactNode }) {
  const { username, logout } = useAuth()
  const { connected } = useLive()
  const nav = useNavigate()

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-ink-700 bg-ink-900/85 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-5">
          <span className="font-semibold tracking-tight flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-sky-400" />
            netdash
          </span>
          <nav className="flex items-center gap-1">
            <Item to="/dashboard">Dashboard</Item>
            <Item to="/devices">Devices</Item>
            <Item to="/settings">Settings</Item>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span
              title={connected ? 'Live update aktif' : 'Koneksi live terputus'}
              className={`badge ${connected ? 'badge-online' : 'badge-offline'}`}
            >
              {connected ? 'Live' : 'Offline'}
            </span>
            <span className="text-sm text-slate-400 hidden sm:inline">{username}</span>
            <button
              className="btn"
              onClick={async () => {
                await logout()
                nav('/login', { replace: true })
              }}
            >
              Keluar
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
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
      {busy ? 'Scanning…' : 'Scan sekarang'}
    </button>
  )
}