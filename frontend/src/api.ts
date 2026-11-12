import i18n, { type Lang } from './i18n'

export type Device = {
  /** Network profile this row belongs to. */
  profile_id?: number | null
  mac: string
  ip: string
  hostname: string
  vendor: string
  nickname: string
  is_gateway: boolean
  online: boolean
  first_seen: string | null
  last_seen: string | null
  last_online: string | null
  is_static: boolean
  /** True only for the machine running the backend (injected by the scanner). */
  is_self: boolean
  /** Best-effort OS guess, e.g. Windows / Linux / Android / macOS / iOS. */
  os_guess: string
  /** 'high' | 'medium' | 'low' | '' — how much evidence backs os_guess. */
  os_confidence: string
  /** Human-readable evidence, e.g. "TTL 128 konsisten". */
  os_evidence: string
  /** Effective type: the manual override when set, else the auto guess. */
  device_type: string
  /** What the classifier produced, kept for the "auto-detected" hint. */
  guessed_type: string
  /** Manual override, or '' when the guess is in use. */
  type_override: string
  /** Manual simple-icons slug, or '' when brand auto-detection is in use. */
  brand_override: string
  /** 'high' | 'medium' | 'low' — how much evidence backs device_type. */
  type_confidence: string
  /** Router-reported instantaneous link rates (bits/second). */
  rx_rate_bps: number
  tx_rate_bps: number
  link_band: string
  /** The AP this device is associated with, e.g. DEV.WIFI.AP5. */
  wifi_interface: string
  /** SSID name as the router knows it, e.g. AgraSec. */
  ssid_name: string
  /** Cumulative bytes reported by the router. */
  rx_bytes: number
  tx_bytes: number
  data_total_bytes: number
  /** True when the device uses a private/randomized MAC (no IEEE OUI). */
  randomized_mac: boolean
  /** False when the type is a guess with no supporting evidence. */
  type_confident: boolean
  /** Seconds since the kick began, or null when not being kicked. */
  kicked: number | null
}

/** Device types the backend can produce or accept as an override. */
export const DEVICE_TYPES = [
  'phone',
  'tablet',
  'laptop',
  'desktop',
  'tv',
  'printer',
  'router',
  'server',
  'iot',
  'other',
] as const

export type DeviceType = (typeof DEVICE_TYPES)[number]

export type KickLog = {
  id: number
  mac: string
  ip?: string
  at: string
  ended_at?: string | null
  duration?: number | null
  actor: string
  reason: string
  active: boolean
}

export type DeviceEvent = { id: number; kind: 'online' | 'offline'; at: string; ip: string }

/** One connect/disconnect transition, pushed over the WebSocket by the scanner
 *  and used to drive toasts. `kind` is 'new' for a first-ever sighting. */
export type Transition = {
  mac: string
  kind: 'new' | 'online' | 'offline'
  name: string
  ip: string
  device_type: string
  vendor: string
  hostname: string
  /** Manual brand slug, mirrored from the device row. */
  brand_override?: string
}

/** Current internet (WAN) link state, from the router's Internet > Status > WAN. */
export type WanStatus = {
  available: boolean
  connection_name: string
  connection_type: string
  auth_type: string
  ipv4_status: 'connected' | 'disconnected' | 'unknown'
  ipv4_address: string
  subnet_mask: string
  gateway: string
  dns: string[]
  online_seconds: number
  online_human: string
  disconnect_reason: string
  ipv6_status: 'connected' | 'disconnected' | 'unknown'
  ipv6_address: string
  ipv6_gateway: string
  ipv6_dns: string[]
  ipv6_online_human: string
  vlan_id: string
  mtu: string
  is_nat: boolean
  is_default_gateway: boolean
  connections: {
    name: string
    type: string
    ipv4_status: string
    ipv4_address: string
    uptime: number
    is_default_gateway: boolean
  }[]
  error: string
  fetched_at: number
  connected: boolean
}

export type WanEvent = {
  id: number
  at: string | null
  kind: 'connected' | 'disconnected'
  ipv4_address: string
  connection_name: string
  reason: string
  online_seconds: number
}

export type ActivityEvent = {
  id: number
  at: string | null
  mac: string
  kind: 'online' | 'offline'
  ip: string
  name: string
  device_type: string
}

export type SpeedtestServer = {
  id: string
  name: string
  sponsor: string
  country: string
  cc: string
  city: string
  host: string
  distance: number | null
}

export type SpeedtestResult = {
  download_mbps: number
  upload_mbps: number
  ping_ms: number
  /** Connection jitter reported by the test engine, when it exposes one. */
  ping_jitter_ms: number
  server_id: string
  server_name: string
  server_sponsor: string
  server_host: string
  server_country: string
  /** City/location of the selected test server, when known. */
  server_city: string
  client_isp: string
  client_ip: string
  /** 'ookla-cli' for the official client, 'speedtest-cli' for the fallback. */
  engine: string
  packet_loss: number
  at: string
  error: string
}

export type SpeedtestStatus = {
  running: boolean
  /** Stable phase key: server | ping | download | upload. */
  phase: string
  phase_elapsed: number
  elapsed: number
  progress: number
  live_download_mbps: number
  live_upload_mbps: number
  live_ping_ms: number
  live_jitter_ms: number
  client_ip: string
  client_isp: string
  server: SpeedtestServer | null
  log: string[]
  result: SpeedtestResult | null
  error: string
}

export type SpeedtestRun = {
  id: number
  at: string | null
  download_mbps: number
  upload_mbps: number
  ping_ms: number
  server_name: string
  server_sponsor: string
  client_isp: string
  ok: boolean
  error: string
}

export type RouterHealth = {
  available: boolean
  model: string
  software_version: string
  serial_number: string
  uptime_seconds: number
  uptime_human: string
  cpu_cores: number[]
  cpu_max: number
  mem_pct: number | null
  error: string
}

export type Settings = {
  subnet: string
  interface: string | null
  detected_interface: string | null
  local_ip: string | null
  scan_interval: number
  gateway_mac: string | null
  whitelist_macs: string[]
  kick_max_seconds: number
  oui_file: string | null
  username: string
  /** Friendly name shown in the sidebar; empty means use the username. */
  display_name: string
  /** "router" = block MAC in the router's Access Control (default, works on iOS). */
  kick_mode: 'router' | 'arp'
  /** SSID interface used for router rules, e.g. DEV.WIFI.AP6. */
  default_wifi_interface: string
  /** Per-device override: MAC -> DEV.WIFI.APn */
  wifi_interface_map: Record<string, string>
  /** Diagnostics: is the router credential pair actually available? */
  router_configured: boolean
  env_file_found: boolean
}

export type KickReport = {
  ok: boolean
  router_blocked: boolean
  router_inst_id: string
  router_error: string
  arp_active: boolean
  arp_error: string
  interface: string
  /** 'auto+history' means several APs were targeted from the roam history. */
  interface_source: 'auto' | 'auto+history' | 'manual' | 'fallback' | 'wired'
  log_id: number
  arp_seconds: number
  /** Every AP a rule was created on. */
  router_inst_ids?: string[]
  interfaces_targeted?: string[]
  interfaces_blocked?: string[]
  interfaces_failed?: string[]
}

export type RouterStatus = {
  reachable: boolean
  message: string
  kick_mode: string
  default_wifi_interface: string
  active_rules: Record<string, number>
}

export type NetIface = {
  name: string
  guid: string
  ip: string | null
  mac: string | null
  description: string
  is_default: boolean
  is_virtual: boolean
}

export type IfaceReport = {
  interfaces: NetIface[]
  chosen: { name: string | null; guid: string | null; ip: string | null; mac: string | null }
  local_ip: string | null
  configured_interface: string | null
  is_admin: boolean
  raw_socket?: boolean
  raw_socket_error?: string
}

export type Dashboard = {
  total: number
  online: number
  offline: number
  kicked: number
  by_type: Record<string, number>
  chart: { at: string; online: number; total: number }[]
  recent: Device[]
  kick_log: KickLog[]
  gateway: { subnet: string; gateway_mac: string | null; interface: string | null }
  profile: NetworkProfile | null
  profile_id: number | null
  is_active: boolean
}

/** One physical network the dashboard has recorded. */
export type NetworkProfile = {
  id: number
  name: string
  fingerprint: string
  gateway_mac: string
  ssid: string
  subnet: string
  gateway_ip: string
  created_at: string | null
  last_seen_at: string | null
  /** True only for the network the backend is physically on right now. */
  active: boolean
  device_count: number
  online_count: number
}

export type ProfileSnapshot = {
  profiles: NetworkProfile[]
  active_id: number | null
}

export type KickedMap = Record<string, number>

/** History tables the delete endpoint understands. */
export type LogScope =
  | 'device_events'
  | 'kick_logs'
  | 'wan_events'
  | 'speedtest_runs'
  | 'all'

/** Filter for `api.deleteLogs`. At least one filter or `all` is required. */
export type LogDeleteBody = {
  scope?: LogScope
  mac?: string
  ids?: number[]
  /** Delete rows strictly before this ISO timestamp. */
  before?: string
  /** Delete rows at or after this ISO timestamp. */
  after?: string
  /** Explicit opt-in to wipe the selected scope with no other filter. */
  all?: boolean
  /** Scope device/kick history to one network profile. */
  profile?: number
}

export type LogDeleteResult = {
  ok: boolean
  deleted: Record<string, number>
  total: number
  skipped_active_kicks: number
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (res.status === 401) {
    // Session expired or not logged in — let the router guard redirect.
    throw new AuthError()
  }
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // Do NOT guess a cause here. An earlier version of this message blamed the
    // proxy and the backend, which sent the debugging in the wrong direction -
    // the real cause was a stale production bundle served instead of the dev
    // server. Report what actually arrived and let the reader decide.
    const ctype = res.headers.get('content-type') || ''
    const kind = ctype.includes('text/html')
      ? 'HTML'
      : ctype || i18n.t('common.emptyBody')
    throw new Error(
      i18n.t('common.serverNotJson', { kind, status: res.status }),
    )
  }
  if (!res.ok) {
    const detail = (body as { detail?: string })?.detail
    throw new Error(detail || i18n.t('common.requestFailed', { status: res.status }))
  }
  return body as T
}

export class AuthError extends Error {
  constructor() {
    super(i18n.t('common.sessionInvalid'))
  }
}

export const api = {
  me: () => req<{ username: string; display_name: string }>('/api/auth/me'),
  login: (username: string, password: string) =>
    req<{ ok: boolean; username: string; display_name: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  updateProfile: (body: { username?: string; display_name?: string }) =>
    req<{ ok: boolean; username: string; display_name: string }>('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  devices: (profile?: number | null) =>
    req<{ devices: Device[]; count: number }>(withProfile('/api/devices', profile)),
  activity: (limit = 100, profile?: number | null) =>
    req<{ events: ActivityEvent[] }>(
      withProfile(`/api/activity?limit=${limit}`, profile),
    ),
  wan: () =>
    req<{ status: WanStatus; history: WanEvent[]; poll_seconds: number }>('/api/wan'),
  device: (mac: string, profile?: number | null) =>
    req<{ device: Device; events: DeviceEvent[]; kicks: KickLog[]; is_active: boolean }>(
      withProfile(`/api/devices/${enc(mac)}`, profile),
    ),
  rename: (mac: string, nickname: string, profile?: number | null) =>
    req<Device>(withProfile(`/api/devices/${enc(mac)}`, profile), {
      method: 'PATCH',
      body: JSON.stringify({ nickname }),
    }),
  /** Override the auto-detected type. Pass '' to return to auto-detection. */
  setType: (mac: string, typeOverride: string, profile?: number | null) =>
    req<Device>(withProfile(`/api/devices/${enc(mac)}`, profile), {
      method: 'PATCH',
      body: JSON.stringify({ type_override: typeOverride }),
    }),
  /** Override the auto-detected brand logo. Pass '' to return to auto. */
  setBrand: (mac: string, brandOverride: string, profile?: number | null) =>
    req<Device>(withProfile(`/api/devices/${enc(mac)}`, profile), {
      method: 'PATCH',
      body: JSON.stringify({ brand_override: brandOverride }),
    }),
  /** Remove a stale/test device and all of its history. */
  deleteDevice: (mac: string, profile?: number | null) =>
    req<{ ok: boolean; mac: string }>(
      withProfile(`/api/devices/${enc(mac)}`, profile),
      { method: 'DELETE' },
    ),
  kick: (mac: string, reason = '', maxSeconds?: number, profile?: number | null) =>
    req<KickReport>(withProfile(`/api/devices/${enc(mac)}/kick`, profile), {
      method: 'POST',
      body: JSON.stringify({ reason, max_seconds: maxSeconds ?? null }),
    }),
  unkick: (mac: string, profile?: number | null) =>
    req<{
      ok: boolean
      was_active: boolean
      rule_deleted: boolean
      used_inst_id: string
      /** Every rule removed - one per AP a multi-interface kick created. */
      removed_inst_ids?: string[]
      errors?: string[]
      arp_stopped: boolean
    }>(withProfile(`/api/devices/${enc(mac)}/unkick`, profile), { method: 'POST' }),
  scanNow: () => req<{ ok: boolean }>('/api/scan', { method: 'POST' }),
  /** Delete history rows: per device, date range, explicit ids, or everything. */
  deleteLogs: (body: LogDeleteBody) =>
    req<LogDeleteResult>('/api/logs/delete', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Speedtest: manual only. start() returns immediately; status() is polled
  // by the caller while a test is in flight and nowhere else.
  speedtestStart: (serverId?: number | null) =>
    req<{ started: boolean; reason?: string }>('/api/speedtest/start', {
      method: 'POST',
      body: JSON.stringify({ server_id: serverId ?? null }),
    }),
  speedtestStatus: () =>
    req<SpeedtestStatus>('/api/speedtest/status'),
  speedtestHistory: (limit = 20) =>
    req<{ runs: SpeedtestRun[] }>(`/api/speedtest/history?limit=${limit}`),
  speedtestServers: (limit = 25) =>
    req<{ servers: SpeedtestServer[]; cached: boolean; error: string }>(
      `/api/speedtest/servers?limit=${limit}`,
    ),
  speedtestPublicIp: () =>
    req<{ ip: string; isp: string; country: string; error: string }>(
      '/api/speedtest/public-ip',
    ),
  routerHealth: () => req<RouterHealth>('/api/router/health'),

  dashboard: (profile?: number | null) =>
    req<Dashboard>(withProfile('/api/dashboard', profile)),
  interfaces: () => req<IfaceReport>('/api/interfaces'),
  routerStatus: () => req<RouterStatus>('/api/router/status'),
  routerSync: () =>
    req<{ ok: boolean; blocked: string[] }>('/api/router/sync', { method: 'POST' }),
  kicks: (profile?: number | null) =>
    req<{ kicks: KickLog[] }>(withProfile('/api/kicks', profile)),
  profiles: () => req<ProfileSnapshot>('/api/profiles'),
  renameProfile: (id: number, name: string) =>
    req<{ ok: boolean; profile: NetworkProfile }>(`/api/profiles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  /** Wipe one active network and rescan it. Requires the exact profile name. */
  resetProfile: (id: number, confirmName: string) =>
    req<{ ok: boolean; deleted: Record<string, number>; total: number }>(
      `/api/profiles/${id}/reset`,
      {
        method: 'POST',
        body: JSON.stringify({ confirm_name: confirmName }),
      },
    ),
  settings: () => req<Settings>('/api/settings'),
  /** Replace the whole per-MAC interface map (the API has no partial update). */
  saveWifiInterfaceMap: (map: Record<string, string>) =>
    req<{ ok: boolean }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ wifi_interface_map: map }),
    }),
  saveSettings: (body: Partial<Settings> & { username?: string; display_name?: string }) =>
    req<{ ok: boolean }>('/api/settings', { method: 'POST', body: JSON.stringify(body) }),
  changePassword: (password: string) =>
    req<{ ok: boolean }>('/api/settings/password', {
      method: 'POST',
      body: JSON.stringify({ username: '', password }),
    }),
}

export function enc(mac: string): string {
  return mac.replace(/:/g, '%3A')
}

/** Append `profile=<id>` to a path, preserving an existing query string. */
export function withProfile(path: string, profile?: number | null): string {
  if (profile == null) return path
  return `${path}${path.includes('?') ? '&' : '?'}profile=${profile}`
}

/** Translate a type key, falling back to the raw value for unknown keys. */
export function typeLabel(type: string): string {
  const key = `types.${type}`
  const value = i18n.t(key)
  return value === key ? type : value
}

/** Honest wording for an OS guess. Only "high" reads as a real detection. */
export function osConfidenceLabel(confidence: string): string {
  return confidence ? i18n.t(`osConfidence.${confidence}`) : ''
}

/** Honest wording for the type confidence reported by the backend. */
export function typeConfidenceLabel(confidence: string): string {
  return confidence ? i18n.t(`typeConfidence.${confidence}`) : ''
}

export function osLabel(d: Pick<Device, 'os_guess' | 'os_confidence'>): string {
  if (!d.os_guess) return ''
  if (d.os_confidence === 'high') return d.os_guess
  return `${d.os_guess}?`
}

/** BCP-47 locale for date/number formatting, following the active language. */
export function currentLocale(): string {
  return (i18n.language as Lang) === 'en' ? 'en-US' : 'id-ID'
}

export function displayName(d: Device): string {
  // The router echoes the MAC back as HostName when DHCP has no name, so a
  // hostname equal to the MAC carries no information.
  const host = d.hostname?.trim()
  const hostUseful = host && host.toUpperCase() !== d.mac.toUpperCase() ? host : ''
  return d.nickname || hostUseful || d.ip || d.mac
}

/** Human-readable bits/s, for the router-reported link rate. */
export function fmtRate(bps: number): string {
  if (!bps || bps < 1) return '—'
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps']
  let v = bps
  let u = 0
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000
    u += 1
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

export function fmtAge(iso: string | null): string {
  if (!iso) return '-'
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return i18n.t('time.secondsAgo', { n: Math.floor(secs) })
  if (secs < 3600) return i18n.t('time.minutesAgo', { n: Math.floor(secs / 60) })
  if (secs < 86400) return i18n.t('time.hoursAgo', { n: Math.floor(secs / 3600) })
  return i18n.t('time.daysAgo', { n: Math.floor(secs / 86400) })
}

export function fmtDuration(secs: number | null | undefined): string {
  if (secs == null) return '-'
  const s = Math.max(0, Math.floor(secs))
  if (s < 60) return i18n.t('time.durationSeconds', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return i18n.t('time.durationMinutes', { minutes: m, seconds: s % 60 })
  return i18n.t('time.durationHours', { hours: Math.floor(m / 60), minutes: m % 60 })
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}