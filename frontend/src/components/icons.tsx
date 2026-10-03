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
export const UiLogout = ({ className = '' }: { className?: string }) => (
  <Icon Ico={LogOut} size={15} className={className} />
)
export const UiRefresh = ({ className = '' }: { className?: string }) => (
  <Icon Ico={RefreshCw} size={15} className={className} />
)

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

/** Per-type tint, kept muted so the table does not turn into confetti. */
const TYPE_TINT: Record<string, { bg: string; fg: string }> = {
  phone: { bg: 'rgba(91,124,240,0.14)', fg: '#9db4f7' },
  tablet: { bg: 'rgba(91,124,240,0.14)', fg: '#9db4f7' },
  laptop: { bg: 'rgba(79,209,197,0.13)', fg: '#6fd8d0' },
  desktop: { bg: 'rgba(79,209,197,0.13)', fg: '#6fd8d0' },
  tv: { bg: 'rgba(167,139,250,0.14)', fg: '#b79efb' },
  printer: { bg: 'rgba(124,135,152,0.14)', fg: '#a3adbd' },
  router: { bg: 'rgba(242,113,139,0.13)', fg: '#f295aa' },
  server: { bg: 'rgba(240,180,41,0.12)', fg: '#e0bb63' },
  iot: { bg: 'rgba(240,180,41,0.12)', fg: '#e0bb63' },
  other: { bg: 'rgba(124,135,152,0.10)', fg: '#98a3b4' },
  unknown: { bg: 'rgba(124,135,152,0.10)', fg: '#98a3b4' },
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
        borderRadius: Math.round(size * 0.31),
        background: tint.bg,
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
  total: { bg: 'rgba(167,139,250,0.16)', fg: '#b79efb' },
  online: { bg: 'rgba(70,201,162,0.16)', fg: '#6fd9b8' },
  offline: { bg: 'rgba(124,135,152,0.16)', fg: '#a3adbd' },
  kick: { bg: 'rgba(242,113,139,0.16)', fg: '#f295aa' },
} as const