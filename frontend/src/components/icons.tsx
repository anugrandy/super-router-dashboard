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
  siAcer,
  siAmd,
  siApple,
  siAppletv,
  siArduino,
  siAsus,
  siBosch,
  siCisco,
  siDell,
  siEpson,
  siEspressif,
  siGoogle,
  siGoogletv,
  siHonor,
  siHp,
  siHuawei,
  siIntel,
  siKyocera,
  siLenovo,
  siLg,
  siLinksys,
  siMediatek,
  siMikrotik,
  siMotorola,
  siMsi,
  siNetgear,
  siNokia,
  siNvidia,
  siOneplus,
  siOppo,
  siPanasonic,
  siQnap,
  siQualcomm,
  siRaspberrypi,
  siRing,
  siRoku,
  siSamsung,
  siSeagate,
  siSharp,
  siShelly,
  siSiemens,
  siSonos,
  siSony,
  siSynology,
  siToshiba,
  siTplink,
  siUbiquiti,
  siVivo,
  siWyze,
  siXiaomi,
  type SimpleIcon,
} from 'simple-icons'
import {
  Ban,
  Cpu,
  HelpCircle,
  LayoutDashboard,
  Laptop,
  LogOut,
  Monitor,
  Plug,
  Unplug,
  X,
  Printer,
  RefreshCw,
  Router,
  Search,
  Server,
  Settings as SettingsIcon,
  Smartphone,
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
  // A modern rounded-rectangle smartphone, never the classic handset glyph.
  phone: Smartphone,
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

/** OUI vendor -> simple-icons brand. Order matters: more specific first. */
const BRAND_MATCHERS: Array<{ needles: Needle[]; icon: SimpleIcon }> = [
  { needles: ['raspberry pi', 'raspberrypi'], icon: siRaspberrypi },
  { needles: ['hewlett', 'hp inc', 'hp,', 'hp '], icon: siHp },
  { needles: [/^tp-?link/, 'tp-link', 'tplink', 'tp link'], icon: siTplink },
  // Phones match earlier in PHONE_BRANDS; these hostnames catch Macs that use
  // a private (randomized) Wi-Fi address and therefore have no Apple OUI.
  {
    needles: ['apple', 'macbook', 'imac', 'mac-mini', 'macmini', 'mac pro'],
    icon: siApple,
  },
  { needles: ['samsung'], icon: siSamsung },
  { needles: ['xiaomi', 'redmi', 'poco'], icon: siXiaomi },
  { needles: ['huawei'], icon: siHuawei },
  { needles: ['honor'], icon: siHonor },
  { needles: ['oppo'], icon: siOppo },
  { needles: ['vivo'], icon: siVivo },
  { needles: ['oneplus'], icon: siOneplus },
  { needles: ['motorola', 'moto '], icon: siMotorola },
  { needles: ['nokia', 'hmd global'], icon: siNokia },
  { needles: ['sony'], icon: siSony },
  { needles: ['lg electronics', 'lg innotek', ' lg '], icon: siLg },
  { needles: ['panasonic'], icon: siPanasonic },
  { needles: ['sharp'], icon: siSharp },
  { needles: ['toshiba'], icon: siToshiba },
  { needles: ['dell'], icon: siDell },
  { needles: ['lenovo', 'thinkpad'], icon: siLenovo },
  { needles: ['asus'], icon: siAsus },
  { needles: ['acer'], icon: siAcer },
  { needles: ['micro-star', 'msi '], icon: siMsi },
  { needles: ['intel'], icon: siIntel },
  { needles: ['advanced micro devices', 'amd '], icon: siAmd },
  { needles: ['nvidia'], icon: siNvidia },
  { needles: ['mediatek'], icon: siMediatek },
  { needles: ['qualcomm'], icon: siQualcomm },
  { needles: ['netgear'], icon: siNetgear },
  { needles: ['linksys'], icon: siLinksys },
  { needles: ['cisco'], icon: siCisco },
  { needles: ['ubiquiti', 'ubnt'], icon: siUbiquiti },
  { needles: ['mikrotik'], icon: siMikrotik },
  { needles: ['synology'], icon: siSynology },
  { needles: ['qnap'], icon: siQnap },
  { needles: ['seagate'], icon: siSeagate },
  { needles: ['espressif'], icon: siEspressif },
  { needles: ['arduino'], icon: siArduino },
  { needles: ['shelly'], icon: siShelly },
  { needles: ['wyze'], icon: siWyze },
  { needles: ['ring llc', 'amazon ring'], icon: siRing },
  { needles: ['bosch'], icon: siBosch },
  { needles: ['siemens'], icon: siSiemens },
  { needles: ['epson'], icon: siEpson },
  { needles: ['kyocera'], icon: siKyocera },
  { needles: ['sonos'], icon: siSonos },
  { needles: ['roku'], icon: siRoku },
  { needles: ['apple tv', 'appletv'], icon: siAppletv },
  { needles: ['google tv', 'googletv', 'chromecast'], icon: siGoogletv },
  { needles: ['google', 'nest labs'], icon: siGoogle },
]

type Needle = string | RegExp

function matchesNeedles(value: string, needles: Needle[]): boolean {
  return needles.some((n) =>
    typeof n === 'string' ? value.includes(n) : n.test(value),
  )
}

/**
 * Phone makers and the hostnames their devices advertise.
 *
 * A phone with a randomized MAC has no usable OUI, so the hostname is the
 * only brand signal left. Realme/Tecno/Itel have no mark in simple-icons;
 * they stay here with no icon so the chip can still fall back to the
 * smartphone glyph instead of a generic question-mark device.
 */
const PHONE_BRANDS: Array<{
  icon?: SimpleIcon
  vendor: Needle[]
  host: Needle[]
}> = [
  {
    icon: siApple,
    vendor: ['apple'],
    host: ['iphone', 'iphone', 'ipad', 'ipod'],
  },
  {
    icon: siSamsung,
    vendor: ['samsung'],
    host: ['samsung', 'galaxy', /(^|[-_.])sm-[a-z0-9]/],
  },
  {
    icon: siXiaomi,
    vendor: ['xiaomi', 'redmi', 'poco'],
    host: ['xiaomi', 'redmi', 'poco'],
  },
  {
    icon: siOppo,
    vendor: ['oppo'],
    host: ['oppo', /(^|[-_.])cph\d/],
  },
  {
    icon: siVivo,
    vendor: ['vivo'],
    host: ['vivo', 'iqoo', /(^|[-_.])v\d{4}/],
  },
  { icon: siOneplus, vendor: ['oneplus'], host: ['oneplus'] },
  { icon: siHuawei, vendor: ['huawei'], host: ['huawei nova', 'huawei p', 'huawei-'] },
  { icon: siHonor, vendor: ['honor'], host: ['honor'] },
  { icon: siGoogle, vendor: ['google'], host: ['pixel'] },
  { icon: siSony, vendor: ['sony'], host: ['xperia', 'sony xperia'] },
  { icon: siAsus, vendor: ['asus'], host: ['zenfone', 'asus zenfone'] },
  { icon: siMotorola, vendor: ['motorola'], host: [/(^|[-_. ])moto([-_. ]|$)/] },
  { icon: siNokia, vendor: ['nokia', 'hmd global'], host: ['nokia'] },
  // No simple-icons export for these makers; still recognised as phones so the
  // chip falls back to the modern smartphone glyph instead of a question mark.
  { vendor: ['realme'], host: ['realme', /(^|[-_.])rmx\d/] },
  { vendor: ['tecno'], host: ['tecno', 'camon', 'pova'] },
  { vendor: ['itel'], host: ['itel'] },
  { vendor: ['infinix'], host: ['infinix', 'infinix hot', 'infinix note'] },
]

/** The brand that describes a device, including brands with no available icon. */
export type BrandMatch = {
  /** simple-icons slug, or '' when the maker has no mark in the library. */
  slug: string
  /** Display name, e.g. "Samsung" or "Realme". */
  title: string
  icon: SimpleIcon | null
}

/** A selectable brand in the manual picker. */
export type BrandEntry = {
  slug: string
  title: string
  icon: SimpleIcon
}

/** simple-icons keeps the maker's own wordmark casing; a few wordmarks are
 *  all-lowercase and read as typos in a list of names. Normalise just those. */
const BRAND_TITLE_FIX: Record<string, string> = {
  sharp: 'Sharp',
  vivo: 'Vivo',
}

function brandTitle(icon: SimpleIcon): string {
  return BRAND_TITLE_FIX[icon.slug] ?? icon.title
}

function makeBrand(icon: SimpleIcon): BrandEntry {
  return { slug: icon.slug, title: brandTitle(icon), icon }
}

/**
 * Every simple-icons mark the picker offers. Ordered by title so the search
 * list reads alphabetically. Brands that do not exist in the library (Realme,
 * Tecno, Itel, Infinix, D-Link, ZTE, Amazon, Realtek, ...) are deliberately
 * absent: there is no mark to draw, so the type icon remains the honest choice.
 */
export const BRAND_CATALOG: BrandEntry[] = [
  siAcer,
  siAmd,
  siApple,
  siAppletv,
  siArduino,
  siAsus,
  siBosch,
  siCisco,
  siDell,
  siEpson,
  siEspressif,
  siGoogle,
  siGoogletv,
  siHonor,
  siHp,
  siHuawei,
  siIntel,
  siKyocera,
  siLenovo,
  siLg,
  siLinksys,
  siMediatek,
  siMikrotik,
  siMotorola,
  siMsi,
  siNetgear,
  siNokia,
  siNvidia,
  siOneplus,
  siOppo,
  siPanasonic,
  siQnap,
  siQualcomm,
  siRaspberrypi,
  siRing,
  siRoku,
  siSamsung,
  siSeagate,
  siSharp,
  siShelly,
  siSiemens,
  siSonos,
  siSony,
  siSynology,
  siToshiba,
  siTplink,
  siUbiquiti,
  siVivo,
  siWyze,
  siXiaomi,
].map(makeBrand)

const BRAND_BY_SLUG = new Map(BRAND_CATALOG.map((b) => [b.slug, b]))

/** Look up a catalog entry by its stored slug. */
export function brandBySlug(slug: string): BrandEntry | null {
  if (!slug) return null
  return BRAND_BY_SLUG.get(slug.toLowerCase()) ?? null
}

function phoneBrandFor(vendor: string, hostname: string): BrandMatch | null {
  const v = (vendor || '').toLowerCase()
  const h = (hostname || '').toLowerCase()
  for (const brand of PHONE_BRANDS) {
    if ((v && matchesNeedles(v, brand.vendor)) || (h && matchesNeedles(h, brand.host))) {
      return {
        slug: brand.icon?.slug ?? '',
        title: brand.icon ? brandTitle(brand.icon) : titleFromNeedle(brand.vendor[0]),
        icon: brand.icon ?? null,
      }
    }
  }
  return null
}

/** Human label for a maker that has no icon, derived from its matcher. */
function titleFromNeedle(needle: Needle | undefined): string {
  if (typeof needle !== 'string') return ''
  return needle.charAt(0).toUpperCase() + needle.slice(1)
}

/** First brand matching an OUI vendor or a phone hostname, or null. */
export function brandMatchFor(vendor: string, hostname = ''): BrandMatch | null {
  // Phones first: they often have no OUI at all, and only the hostname names
  // the maker. A recognised brand without an icon stops the search here so it
  // cannot accidentally match an unrelated vendor rule.
  const phone = phoneBrandFor(vendor, hostname)
  if (phone) return phone

  const v = (vendor || '').toLowerCase()
  const h = (hostname || '').toLowerCase()
  if (!v && !h) return null
  for (const { needles, icon } of BRAND_MATCHERS) {
    if ((v && matchesNeedles(v, needles)) || (h && matchesNeedles(h, needles))) {
      return { slug: icon.slug, title: brandTitle(icon), icon }
    }
  }
  return null
}

/** First brand icon matching an OUI vendor or a phone hostname, or null. */
export function brandIconFor(vendor: string, hostname = ''): SimpleIcon | null {
  return brandMatchFor(vendor, hostname)?.icon ?? null
}

/**
 * Device avatar: a manually chosen brand mark first, then the vendor's real
 * brand mark when the OUI or phone hostname is recognisable, otherwise the
 * generic device-type glyph. A recognised phone brand with no simple-icons
 * mark (Realme/Tecno/Itel/Infinix) still gets the modern smartphone glyph, so
 * the user at least knows it is a phone.
 * Brand marks are monochrome and tinted with the UI's muted foreground.
 */
export function DeviceChip({
  type,
  vendor = '',
  hostname = '',
  brandOverride = '',
  size = 32,
}: {
  type: string
  vendor?: string
  hostname?: string
  /** simple-icons slug chosen by the user. Empty means auto-detection. */
  brandOverride?: string
  size?: number
}) {
  const override = brandBySlug(brandOverride)
  const match = override ?? brandMatchFor(vendor, hostname)
  const brand = match?.icon ?? null

  if (!brand) {
    // A known phone maker without a mark still reads as a phone, never as an
    // unknown device. An explicit type always wins over this guess.
    const phoneFallback =
      brandMatchFor(vendor, hostname) !== null &&
      ['', 'phone', 'other', 'unknown'].includes(type)
    return <DeviceTypeChip type={phoneFallback ? 'phone' : type} size={size} />
  }

  const tint = TYPE_TINT[type] ?? TYPE_TINT.other
  const glyph = Math.round(size * 0.52)
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
      title={override ? override.title : vendor || brandTitle(brand)}
    >
      <svg
        viewBox="0 0 24 24"
        width={glyph}
        height={glyph}
        aria-hidden="true"
        className="shrink-0"
        fill="currentColor"
      >
        <path d={brand.path} />
      </svg>
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