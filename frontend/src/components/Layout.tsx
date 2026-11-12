import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth, useLive } from '../live'
import { api } from '../api'
import { LANGS, setLanguage, type Lang } from '../i18n'
import {
  UiDashboard,
  UiDevices,
  UiSettings,
  UiSearch,
  UiLogout,
  UiRefresh,
  UiMark,
} from './icons'
import {
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  Gauge,
  Globe,
  History,
  Menu,
  Network,
  Pencil,
  Wifi,
  X,
} from 'lucide-react'
import Toasts from './Toasts'

const NavIcon = ({ children }: { children: React.ReactNode }) => (
  <span className="shrink-0">{children}</span>
)

/** Two-letter avatar used beside the account name in the sidebar. */
function InitialAvatar({ name }: { name: string | null }) {
  const initials = (name || '?')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join('')
    .toUpperCase()
  return (
    <span className="inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0 text-[11px] font-medium border border-border bg-surface2 text-ink">
      {initials || '?'}
    </span>
  )
}

const menuRow =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] text-muted transition hover:bg-surface2 hover:text-ink'

/**
 * Compact account control: avatar + name + chevron, with a floating menu for
 * live state, a quick display-name edit, Settings and sign-out. This replaces
 * the old static bordered account card.
 */
function ProfileMenu() {
  const { t } = useTranslation()
  const { username, displayName, updateProfile, logout } = useAuth()
  const { connected } = useLive()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const name = displayName || username || '—'

  function close() {
    setOpen(false)
    setEditing(false)
    setError(null)
  }

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) close()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  async function saveName(e: FormEvent) {
    e.preventDefault()
    const next = draft.trim()
    if (next === (displayName || '').trim()) {
      setEditing(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await updateProfile({ display_name: next })
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profile.saveError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) close()
          else {
            setDraft(displayName || '')
            setOpen(true)
          }
        }}
        className="flex max-w-[190px] items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-surface2"
      >
        <InitialAvatar name={name} />
        <span className="hidden min-w-0 flex-1 truncate text-[13px] text-ink sm:block">
          {name}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-60 rounded-md p-1.5 glass-popover"
        >
          <div className="flex items-center gap-2 px-2 py-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: connected ? 'var(--color-green)' : 'var(--color-muted2)',
              }}
            />
            <span className="text-[12px] text-muted">
              {connected ? t('nav.live') : t('nav.offline')}
            </span>
            {username && displayName && (
              <span className="ml-auto mono text-[10px] text-muted2 truncate">@{username}</span>
            )}
          </div>

          <div className="my-1 h-px bg-border" />

          {editing ? (
            <form onSubmit={saveName} className="px-1.5 py-1 space-y-1.5">
              <label className="block text-[11px] text-muted" htmlFor="profile-display-name">
                {t('profile.displayName')}
              </label>
              <input
                id="profile-display-name"
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={48}
                placeholder={t('profile.displayNameHint')}
                className="w-full bg-surface border border-border rounded px-2 py-1.5 text-[12px] text-ink placeholder:text-muted2 outline-none transition focus:border-bright"
              />
              <div className="flex gap-1.5">
                <button
                  type="submit"
                  disabled={busy}
                  className="btn btn-primary flex-1 py-1 text-[11px]"
                >
                  {busy ? t('common.saving') : t('common.save')}
                </button>
                <button
                  type="button"
                  className="btn flex-1 py-1 text-[11px]"
                  onClick={() => setEditing(false)}
                >
                  {t('common.cancel')}
                </button>
              </div>
              {error && <div className="text-[11px] text-red">{error}</div>}
            </form>
          ) : (
            <button
              role="menuitem"
              className={menuRow}
              onClick={() => {
                setDraft(displayName || '')
                setError(null)
                setEditing(true)
              }}
            >
              <Pencil size={14} />
              {t('profile.editName')}
            </button>
          )}

          <button
            role="menuitem"
            className={menuRow}
            onClick={() => {
              close()
              nav('/settings')
            }}
          >
            <UiSettings />
            {t('nav.settings')}
          </button>
          <button
            role="menuitem"
            className={menuRow}
            onClick={async () => {
              close()
              await logout()
              nav('/login', { replace: true })
            }}
          >
            <UiLogout />
            {t('nav.logout')}
          </button>
        </div>
      )}
    </div>
  )
}

/** One sidebar row. NavLink's isActive drives the inverted highlight. */
function Item({
  to,
  label,
  icon,
  collapsed = false,
}: {
  to: string
  label: string
  icon: ReactNode
  collapsed?: boolean
}) {
  return (
    <NavLink
      to={to}
      end={to === '/dashboard'}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) =>
        `sidebar-item ${isActive ? 'active' : ''} ${
          collapsed ? 'lg:justify-center lg:px-0 lg:py-2.5' : ''
        }`
      }
    >
      <span>{icon}</span>
      <span className={collapsed ? 'lg:hidden' : ''}>{label}</span>
    </NavLink>
  )
}

/**
 * Sidebar search box. It filters a client-side list of the app's own routes
 * and jumps to the match on Enter. It is navigation, not a device search —
 * device filtering stays on the Devices page where the data lives.
 */
function SidebarSearch({
  collapsed = false,
  onExpand,
}: {
  collapsed?: boolean
  onExpand?: () => void
}) {
  const nav = useNavigate()
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const routes = [
    { to: '/dashboard', label: t('nav.dashboard'), hint: t('nav.hints.dashboard') },
    { to: '/topology', label: t('nav.topology'), hint: t('nav.hints.topology') },
    { to: '/devices', label: t('nav.devices'), hint: t('nav.hints.devices') },
    { to: '/activity', label: t('nav.activity'), hint: t('nav.hints.activity') },
    { to: '/connection', label: t('nav.connection'), hint: t('nav.hints.connection') },
    { to: '/speedtest', label: t('nav.speedtest'), hint: t('nav.hints.speedtest') },
    { to: '/settings', label: t('nav.settings'), hint: t('nav.hints.settings') },
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

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onExpand}
        title={t('nav.searchAria')}
        aria-label={t('nav.searchAria')}
        className="flex h-9 w-full items-center justify-center rounded-md border border-border bg-surface text-muted2 transition hover:border-border-strong hover:text-ink"
      >
        <UiSearch />
      </button>
    )
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
          placeholder={t('nav.searchPlaceholder')}
          aria-label={t('nav.searchAria')}
          className="w-full min-h-10 bg-surface border border-border rounded-md pl-9 pr-3 py-2 text-[13px] text-ink placeholder:text-muted2 outline-none transition focus:border-bright"
        />
      </div>
      {open && hits.length > 0 && (
        <div className="absolute z-30 mt-1.5 w-full rounded-md p-1 glass-popover">
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

/** Compact ID/EN switch. Lives in the sidebar so it is reachable from every page. */
function LanguageSwitcher() {
  const { i18n, t } = useTranslation()
  const current: Lang = i18n.language === 'en' ? 'en' : 'id'
  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-[11px] text-muted2 md:inline">
        {t('common.language')}
      </span>
      <div className="flex gap-0.5 p-0.5 rounded-md bg-surface border border-border">
        {LANGS.map((lang) => (
          <button
            key={lang}
            type="button"
            onClick={() => setLanguage(lang)}
            aria-pressed={current === lang}
            className={`px-2.5 py-1.5 min-h-8 rounded-[5px] text-[11px] font-medium transition ${
              current === lang
                ? 'bg-bright text-bg'
                : 'text-muted hover:text-ink hover:bg-surface2'
            }`}
          >
            {lang.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Network profile switcher.
 *
 * The green dot marks the network the laptop is physically on. Selecting any
 * other profile only changes what is displayed; it never tells the backend to
 * activate that network. Kick and scan stay bound to the live connection.
 */
function NetworkSwitcher() {
  const { t } = useTranslation()
  const {
    profiles,
    activeProfileId,
    viewProfile,
    viewProfileId,
    isViewingActive,
    setViewProfile,
  } = useLive()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!viewProfile && !activeProfileId) return null

  return (
    <div className="relative min-w-0 max-w-[150px] sm:max-w-[220px]" ref={box}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition hover:bg-surface2 sm:gap-2 sm:px-2"
      >
        <span className="relative shrink-0">
          <Wifi size={15} className={isViewingActive ? 'text-green' : 'text-muted'} />
          {!isViewingActive && (
            <span className="absolute -right-1 -top-1 w-1.5 h-1.5 rounded-full bg-[var(--color-amber,#F59E0B)]" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="hidden text-[10px] leading-tight text-muted2 sm:block">
            {t('profiles.current')}
          </span>
          <span className="block truncate text-[12px] leading-tight text-ink sm:text-[12.5px]">
            {viewProfile?.name ?? t('profiles.none')}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={t('profiles.switcherAria')}
          className="absolute left-0 top-full z-50 mt-2 w-[300px] max-w-[calc(100vw-2rem)] rounded-md p-1.5 glass-popover max-h-[320px] overflow-y-auto"
        >
          <div className="px-2 py-1 text-[10px] text-muted2">
            {t('profiles.switcherHint')}
          </div>
          {profiles.map((p) => {
            const selected = p.id === (viewProfileId ?? activeProfileId)
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setViewProfile(p.id === activeProfileId ? null : p.id)
                  setOpen(false)
                }}
                className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition ${
                  selected ? 'bg-surface2' : 'hover:bg-surface2'
                }`}
              >
                <span
                  className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                  style={{
                    background: p.active
                      ? 'var(--color-green)'
                      : 'var(--color-muted2)',
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] text-ink">{p.name}</span>
                    <span className="badge badge-offline mono shrink-0">
                      {p.online_count}/{p.device_count}
                    </span>
                  </span>
                  <span className="block truncate text-[10.5px] text-muted2">
                    {p.active ? t('profiles.active') : t('profiles.history')}
                    {p.ssid ? ` · ${p.ssid}` : ''}
                    {p.subnet ? ` · ${p.subnet}` : ''}
                  </span>
                </span>
              </button>
            )
          })}
          {!isViewingActive && (
            <button
              type="button"
              onClick={() => {
                setViewProfile(null)
                setOpen(false)
              }}
              className="mt-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] text-green transition hover:bg-surface2"
            >
              <History size={13} />
              {t('profiles.backToActive')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Short banner when the physical network changes under the user. */
function NetworkChangeBanner() {
  const { t } = useTranslation()
  const { profileChange, dismissProfileChange } = useLive()

  useEffect(() => {
    if (!profileChange) return
    const id = window.setTimeout(dismissProfileChange, 10_000)
    return () => window.clearTimeout(id)
  }, [profileChange, dismissProfileChange])

  if (!profileChange?.profile) return null
  return (
    <div role="status" className="notice notice-success mb-6">
      <Wifi size={16} className="mt-0.5 shrink-0" />
      <p className="flex-1 text-[13px] leading-relaxed text-ink">
        {t('profiles.changed', { name: profileChange.profile.name })}
      </p>
      <button
        type="button"
        onClick={dismissProfileChange}
        className="-my-2 inline-flex h-9 w-9 shrink-0 items-center justify-center text-muted transition hover:text-ink"
        aria-label={t('common.close')}
      >
        ✕
      </button>
    </div>
  )
}

/** Persistent notice while browsing a historical network (read-only). */
function HistoricalBanner() {
  const { t } = useTranslation()
  const { isViewingActive, viewProfile, setViewProfile } = useLive()
  if (isViewingActive || !viewProfile) return null
  return (
    <div className="notice notice-muted mb-6 flex-wrap">
      <History size={15} className="mt-0.5 shrink-0" />
      <p className="min-w-[200px] flex-1 text-[13px] leading-relaxed">
        {t('profiles.viewingHistory', { name: viewProfile.name })}
      </p>
      <button
        type="button"
        onClick={() => setViewProfile(null)}
        className="btn btn-sm shrink-0"
      >
        {t('profiles.backToActive')}
      </button>
    </div>
  )
}

export default function Layout({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('netdash.sidebar') === 'collapsed'
    } catch {
      return false
    }
  })
  const [mobileOpen, setMobileOpen] = useState(false)

  // The mobile drawer is always full-width, even if the desktop sidebar was
  // collapsed before the window was resized.
  const iconOnly = collapsed && !mobileOpen

  useEffect(() => {
    try {
      localStorage.setItem('netdash.sidebar', collapsed ? 'collapsed' : 'expanded')
    } catch {
      /* private mode / storage disabled */
    }
  }, [collapsed])

  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  // Drawer behaviour: Escape closes it and the page behind it stops scrolling,
  // so a thumb swipe does not move the content underneath the overlay.
  useEffect(() => {
    if (!mobileOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', onKey)
    }
  }, [mobileOpen])

  return (
    <div className="min-h-screen lg:flex">
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar: logo, search, and navigation only. Account/language/network
          controls moved to the header so they no longer crowd the bottom. */}
      <aside
        className={`safe-top safe-bottom fixed inset-y-0 left-0 z-50 flex w-[min(300px,86vw)] shrink-0 flex-col border-r border-border bg-bg transition-[width,transform] duration-200 lg:sticky lg:top-0 lg:z-20 lg:h-screen lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        } ${collapsed ? 'lg:w-[76px]' : 'lg:w-[248px]'}`}
      >
        <div className="flex h-full flex-col overflow-y-auto px-3 py-4">
          <div
            className={`mb-5 flex items-center gap-2.5 ${
              collapsed ? 'lg:flex-col lg:gap-2' : 'px-1'
            }`}
          >
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface2 text-bright">
              <UiMark />
            </span>
            <span
              className={`min-w-0 flex-1 truncate font-semibold tracking-tight text-[14px] text-ink ${
                collapsed ? 'lg:hidden' : ''
              }`}
            >
              {t('app.name')}
            </span>
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              title={t(collapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar')}
              aria-label={t(collapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar')}
              className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-muted2 transition hover:bg-surface2 hover:text-ink lg:inline-flex"
            >
              {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
            </button>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              title={t('nav.closeMenu')}
              aria-label={t('nav.closeMenu')}
              className="ml-auto inline-flex h-10 w-10 items-center justify-center rounded-[5px] text-muted2 transition hover:bg-surface2 hover:text-ink lg:hidden"
            >
              <X size={17} />
            </button>
          </div>

          <div onClick={() => setMobileOpen(false)}>
            <SidebarSearch
              collapsed={iconOnly}
              onExpand={() => setCollapsed(false)}
            />
          </div>

          <nav
            className="mt-6 space-y-0.5"
            onClick={() => setMobileOpen(false)}
          >
            <div className={iconOnly ? 'nav-section lg:hidden' : 'nav-section'}>
              {t('nav.section')}
            </div>
            <Item
              to="/dashboard"
              label={t('nav.dashboard')}
              icon={<UiDashboard />}
              collapsed={iconOnly}
            />
            <Item
              to="/topology"
              label={t('nav.topology')}
              icon={<NavIcon><Network size={17} /></NavIcon>}
              collapsed={iconOnly}
            />
            <Item
              to="/devices"
              label={t('nav.devices')}
              icon={<UiDevices />}
              collapsed={iconOnly}
            />
            <Item
              to="/activity"
              label={t('nav.activity')}
              icon={<NavIcon><Activity size={17} /></NavIcon>}
              collapsed={iconOnly}
            />
            <Item
              to="/connection"
              label={t('nav.connection')}
              icon={<NavIcon><Globe size={17} /></NavIcon>}
              collapsed={iconOnly}
            />
            <Item
              to="/speedtest"
              label={t('nav.speedtest')}
              icon={<NavIcon><Gauge size={17} /></NavIcon>}
              collapsed={iconOnly}
            />
            <Item
              to="/settings"
              label={t('nav.settings')}
              icon={<UiSettings />}
              collapsed={iconOnly}
            />
          </nav>

          {/* Language lives here on phones: the header would otherwise hold
              three controls in the width of a thumb. */}
          <div className="mt-auto border-t border-border px-1 pt-4 lg:hidden">
            <LanguageSwitcher />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header is shared by every page: network identity, language, account.
            On phones the language switch moves into the drawer so the bar keeps
            only the menu, the network name, and the account avatar. */}
        <header className="safe-top sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-border bg-bg/85 px-3 py-2 backdrop-blur-md sm:h-16 sm:min-h-16 sm:gap-3 sm:px-6 sm:py-0">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            title={t('nav.openMenu')}
            aria-label={t('nav.openMenu')}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-muted transition hover:border-border-strong hover:text-ink lg:hidden"
          >
            <Menu size={18} />
          </button>

          <NetworkSwitcher />

          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <div className="hidden sm:block">
              <LanguageSwitcher />
            </div>
            <span className="hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
            <ProfileMenu />
          </div>
        </header>

        <main className="app-main safe-bottom relative z-[1] min-w-0 flex-1">
          <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <NetworkChangeBanner />
            <HistoricalBanner />
            {children}
          </div>
        </main>
      </div>

      {/* Live connect/disconnect toasts. Subscribes to the transitions pub/sub
          directly, so showing them does not re-render anything else. */}
      <Toasts />
    </div>
  )
}

export function ScanButton({ className = 'btn' }: { className?: string }) {
  const { t } = useTranslation()
  const { isViewingActive } = useLive()
  const [busy, setBusy] = useState(false)
  return (
    <button
      className={className}
      disabled={busy || !isViewingActive}
      title={!isViewingActive ? t('profiles.scanInactive') : undefined}
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
      {busy ? t('common.scanning') : t('common.scanNow')}
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
    <div className="mb-6 flex flex-wrap items-center gap-3 sm:mb-8">
      <div className="min-w-0">
        <h1 className="section-title break-words">{title}</h1>
        {subtitle && <div className="card-sub mt-1">{subtitle}</div>}
      </div>
      {actions && (
        <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  )
}