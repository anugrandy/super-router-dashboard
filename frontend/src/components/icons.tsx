/** Device-type and UI icons, all from lucide-react.
 *
 * Every icon is wrapped so callers can pass extra classes (e.g. `animate-spin`)
 * without ever losing the size. An earlier hand-rolled version used a
 * `className = 'w-4 h-4'` default parameter, so passing `className='animate-spin'`
 * *replaced* the size classes and the SVG fell back to its 300x150 intrinsic
 * default - that was the bug that made the Scan button look broken. Sizing here
 * is applied by the wrapper, never by a default a caller can clobber.
 */
import {
  Ban,
  Cpu,
  HelpCircle,
  LayoutDashboard,
  Laptop,
  LogOut,
  Monitor,
  Phone,
  Plug,
  Unplug,
  X,
  Printer,
  RefreshCw,
  Router,
  Search,
  Server,
  Settings as SettingsIcon,
  Tablet,
  Tv,
  type LucideIcon,
} from 'lucide-react'

/** Fixed-size wrapper: size is always applied, never caller-dependent. */
function Icon({
  Ico,
  size = 16,
  className = '',
}: {
  Ico: LucideIcon
  size?: number
  className?: string
}) {
  return <Ico size={size} className={`shrink-0 ${className}`} aria-hidden="true" />
}

export const UiDashboard = ({ className = '' }: { className?: string }) => (
  <Icon Ico={LayoutDashboard} size={17} className={className} />
)
export const UiDevices = ({ className = '' }: { className?: string }) => (
  <Icon Ico={Monitor} size={17} className={className} />
)
export const UiSettings = ({ className = '' }: { className?: string }) => (
  <Icon Ico={SettingsIcon} size={17} className={className} />
)
export const UiSearch = ({ className = '' }: { className?: string }) => (
  <Icon Ico={Search} size={15} className={className} />
)

/** Brand mark: a hub with three spokes. Hand-drawn rather than pulled from a
 *  generic icon set, so the logo reads as chosen instead of assembled. */
export function UiMark({ size = 17 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 9.4V4.6" />
      <path d="M10.1 13.3 5.6 17.4" />
      <path d="M13.9 13.3l4.5 4.1" />
      <circle cx="12" cy="3.4" r="1.5" />
      <circle cx="4.6" cy="18.4" r="1.5" />
      <circle cx="19.4" cy="18.4" r="1.5" />
    </svg>
  )
}
export const UiLogout = ({ className = '' }: { className?: string }) => (
  <Icon Ico={LogOut} size={15} className={className} />
)
export const UiRefresh = ({ className = '' }: { className?: string }) => (
  <Icon Ico={RefreshCw} size={15} className={className} />
)
export const IconClose = ({
  size = 13,
  className = '',
}: {
  size?: number
  className?: string
}) => <Icon Ico={X} size={size} className={className} />
export const IconPlug = ({
  size = 13,
  className = '',
}: {
  size?: number
  className?: string
}) => <Icon Ico={Plug} size={size} className={className} />
export const IconUnplug = ({
  size = 13,
  className = '',
}: {
  size?: number
  className?: string
}) => <Icon Ico={Unplug} size={size} className={className} />

/** Device type -> lucide glyph. Keys match the backend `device_type` values. */
export const TYPE_ICON: Record<string, LucideIcon> = {
  phone: Phone,
  tablet: Tablet,
  laptop: Laptop,
  desktop: Monitor,
  tv: Tv,
  printer: Printer,
  router: Router,
  server: Server,
  iot: Cpu,
  other: HelpCircle,
  // Legacy value still present in older databases.
  unknown: HelpCircle,
}

/** Per-type tint: strictly grayscale. Type is metadata, not state. */
const TYPE_TINT: Record<string, { bg: string; fg: string }> = {
  phone: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
  tablet: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
  laptop: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
  desktop: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
  tv: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
  printer: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
  router: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
  server: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
  iot: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
  other: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
  unknown: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
}

/** The raw glyph for a device type, with a safe fallback. */
export function IconDeviceType({ type, size = 16 }: { type: string; size?: number }) {
  const Ico = TYPE_ICON[type] ?? HelpCircle
  return <Icon Ico={Ico} size={size} />
}

/** Rounded avatar chip wrapping the device-type glyph. */
export function DeviceTypeChip({ type, size = 32 }: { type: string; size?: number }) {
  const tint = TYPE_TINT[type] ?? TYPE_TINT.other
  return (
    <span
      className="inline-flex items-center justify-center shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: Math.min(6, Math.round(size * 0.2)),
        background: tint.bg,
        border: '1px solid var(--color-border)',
        color: tint.fg,
      }}
      title={type}
    >
      <IconDeviceType type={type} size={Math.round(size * 0.5)} />
    </span>
  )
}

/** Stat-card icons, one per dashboard metric. */
export const STAT_ICON = {
  total: Monitor,
  online: HelpCircle,
  offline: Ban,
  kick: Ban,
} as const

export const STAT_TINT = {
  total: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
  online: { bg: 'var(--color-surface2)', fg: 'var(--color-green)' },
  offline: { bg: 'var(--color-surface2)', fg: 'var(--color-muted)' },
  kick: { bg: 'var(--color-surface2)', fg: 'var(--color-red)' },
} as const