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

/** Per-type tint, kept muted so the table does not turn into confetti. */
const TYPE_TINT: Record<string, { bg: string; fg: string }> = {
  phone: { bg: 'rgba(139,141,147,0.14)', fg: '#8B8D93' },
  tablet: { bg: 'rgba(139,141,147,0.14)', fg: '#8B8D93' },
  laptop: { bg: 'rgba(62,210,140,0.13)', fg: '#3ED28C' },
  desktop: { bg: 'rgba(62,210,140,0.13)', fg: '#3ED28C' },
  tv: { bg: 'rgba(139,141,147,0.14)', fg: '#8B8D93' },
  printer: { bg: 'rgba(139,141,147,0.14)', fg: '#8B8D93' },
  router: { bg: 'rgba(232,96,74,0.13)', fg: '#E8604A' },
  server: { bg: 'rgba(231,179,74,0.12)', fg: '#E7B34A' },
  iot: { bg: 'rgba(231,179,74,0.12)', fg: '#E7B34A' },
  other: { bg: 'rgba(139,141,147,0.10)', fg: '#8B8D93' },
  unknown: { bg: 'rgba(139,141,147,0.10)', fg: '#8B8D93' },
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
  total: { bg: 'rgba(139,141,147,0.16)', fg: '#8B8D93' },
  online: { bg: 'rgba(62,210,140,0.16)', fg: '#3ED28C' },
  offline: { bg: 'rgba(139,141,147,0.16)', fg: '#8B8D93' },
  kick: { bg: 'rgba(232,96,74,0.16)', fg: '#E8604A' },
} as const