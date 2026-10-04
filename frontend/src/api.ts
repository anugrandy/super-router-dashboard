export type Device = {
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
  /** Effective type: the manual override when set, else the auto guess. */
  device_type: string
  /** What the classifier produced, kept for the "auto-detected" hint. */
  guessed_type: string
  /** Manual override, or '' when the guess is in use. */
  type_override: string
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

export type DeviceEvent = { kind: 'online' | 'offline'; at: string; ip: string }

/** One connect/disconnect transition, pushed over the WebSocket by the scanner
 *  and used to drive toasts. `kind` is 'new' for a first-ever sighting. */
export type Transition = {
  mac: string
  kind: 'new' | 'online' | 'offline'
  name: string
  ip: string
  device_type: string
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

export type SpeedtestResult = {
  download_mbps: number
  upload_mbps: number
  ping_ms: number
  server_name: string
  server_sponsor: string
  server_host: string
  server_country: string
  client_isp: string
  client_ip: string
  at: string
  error: string
}

export type SpeedtestStatus = {
  running: boolean
  phase: string
  elapsed: number
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
}

export type KickedMap = Record<string, number>

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
    const kind = ctype.includes('text/html') ? 'HTML' : ctype || 'body kosong'
    throw new Error(
      `Server mengirim ${kind}, bukan JSON (HTTP ${res.status}). ` +
        `Cek halaman ini dilayani frontend mana: dev server :5173, atau ` +
        `bundle produksi lama.`,
    )
  }
  if (!res.ok) {
    const detail = (body as { detail?: string })?.detail
    throw new Error(detail || `Request gagal (${res.status})`)
  }
  return body as T
}

export class AuthError extends Error {
  constructor() {
    super('Sesi tidak valid')
  }
}

export const api = {
  me: () => req<{ username: string }>('/api/auth/me'),
  login: (username: string, password: string) =>
    req<{ ok: boolean; username: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  devices: () => req<{ devices: Device[]; count: number }>('/api/devices'),
  activity: (limit = 100) =>
    req<{ events: ActivityEvent[] }>(`/api/activity?limit=${limit}`),
  wan: () =>
    req<{ status: WanStatus; history: WanEvent[]; poll_seconds: number }>('/api/wan'),
  device: (mac: string) =>
    req<{ device: Device; events: DeviceEvent[]; kicks: KickLog[] }>(`/api/devices/${enc(mac)}`),
  rename: (mac: string, nickname: string) =>
    req<Device>(`/api/devices/${enc(mac)}`, {
      method: 'PATCH',
      body: JSON.stringify({ nickname }),
    }),
  /** Override the auto-detected type. Pass '' to return to auto-detection. */
  setType: (mac: string, typeOverride: string) =>
    req<Device>(`/api/devices/${enc(mac)}`, {
      method: 'PATCH',
      body: JSON.stringify({ type_override: typeOverride }),
    }),
  kick: (mac: string, reason = '', maxSeconds?: number) =>
    req<KickReport>(`/api/devices/${enc(mac)}/kick`, {
      method: 'POST',
      body: JSON.stringify({ reason, max_seconds: maxSeconds ?? null }),
    }),
  unkick: (mac: string) =>
    req<{
      ok: boolean
      was_active: boolean
      rule_deleted: boolean
      used_inst_id: string
      /** Every rule removed - one per AP a multi-interface kick created. */
      removed_inst_ids?: string[]
      errors?: string[]
      arp_stopped: boolean
    }>(`/api/devices/${enc(mac)}/unkick`, { method: 'POST' }),
  scanNow: () => req<{ ok: boolean }>('/api/scan', { method: 'POST' }),

  // Speedtest: manual only. start() returns immediately; status() is polled
  // by the caller while a test is in flight and nowhere else.
  speedtestStart: () =>
    req<{ started: boolean; reason?: string }>('/api/speedtest/start', {
      method: 'POST',
    }),
  speedtestStatus: () =>
    req<SpeedtestStatus>('/api/speedtest/status'),
  speedtestHistory: (limit = 20) =>
    req<{ runs: SpeedtestRun[] }>(`/api/speedtest/history?limit=${limit}`),
  routerHealth: () => req<RouterHealth>('/api/router/health'),

  dashboard: () => req<Dashboard>('/api/dashboard'),
  interfaces: () => req<IfaceReport>('/api/interfaces'),
  routerStatus: () => req<RouterStatus>('/api/router/status'),
  routerSync: () =>
    req<{ ok: boolean; blocked: string[] }>('/api/router/sync', { method: 'POST' }),
  kicks: () => req<{ kicks: KickLog[] }>('/api/kicks'),
  settings: () => req<Settings>('/api/settings'),
  /** Replace the whole per-MAC interface map (the API has no partial update). */
  saveWifiInterfaceMap: (map: Record<string, string>) =>
    req<{ ok: boolean }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ wifi_interface_map: map }),
    }),
  saveSettings: (body: Partial<Settings> & { username?: string }) =>
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

export const TYPE_LABEL: Record<string, string> = {
  phone: 'HP',
  tablet: 'Tablet',
  laptop: 'Laptop',
  desktop: 'PC',
  tv: 'TV/Streaming',
  printer: 'Printer',
  router: 'Router/AP',
  server: 'Linux/Server',
  iot: 'IoT',
  other: 'Lainnya',
  // Legacy values from older databases.
  computer: 'Laptop/PC',
  unknown: 'Lainnya',
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
  if (secs < 60) return `${Math.floor(secs)} dtk lalu`
  if (secs < 3600) return `${Math.floor(secs / 60)} mnt lalu`
  if (secs < 86400) return `${Math.floor(secs / 3600)} jam lalu`
  return `${Math.floor(secs / 86400)} hari lalu`
}

export function fmtDuration(secs: number | null | undefined): string {
  if (secs == null) return '-'
  const s = Math.max(0, Math.floor(secs))
  if (s < 60) return `${s} dtk`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} mnt ${s % 60} dtk`
  return `${Math.floor(m / 60)} jam ${m % 60} mnt`
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
}