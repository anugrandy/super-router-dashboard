export type Device = {
  mac: string
  ip: string
  hostname: string
  vendor: string
  device_type: string
  nickname: string
  is_gateway: boolean
  online: boolean
  first_seen: string | null
  last_seen: string | null
  last_online: string | null
  is_static: boolean
  /** Seconds since the kick began, or null when not being kicked. */
  kicked: number | null
}

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
  interface_source: 'auto' | 'manual' | 'fallback'
  log_id: number
  arp_seconds: number
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
    throw new Error(`Responsan tidak valid dari server (${res.status})`)
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
  device: (mac: string) =>
    req<{ device: Device; events: DeviceEvent[]; kicks: KickLog[] }>(`/api/devices/${enc(mac)}`),
  rename: (mac: string, nickname: string) =>
    req<Device>(`/api/devices/${enc(mac)}`, {
      method: 'PATCH',
      body: JSON.stringify({ nickname }),
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
      arp_stopped: boolean
    }>(`/api/devices/${enc(mac)}/unkick`, { method: 'POST' }),
  scanNow: () => req<{ ok: boolean }>('/api/scan', { method: 'POST' }),

  dashboard: () => req<Dashboard>('/api/dashboard'),
  interfaces: () => req<IfaceReport>('/api/interfaces'),
  routerStatus: () => req<RouterStatus>('/api/router/status'),
  routerSync: () =>
    req<{ ok: boolean; blocked: string[] }>('/api/router/sync', { method: 'POST' }),
  kicks: () => req<{ kicks: KickLog[] }>('/api/kicks'),
  settings: () => req<Settings>('/api/settings'),
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
  computer: 'Laptop/PC',
  tv: 'TV/Streaming',
  iot: 'IoT',
  router: 'Router',
  server: 'Server',
  unknown: 'Lainnya',
}

export function displayName(d: Device): string {
  return d.nickname || d.hostname || d.ip || d.mac
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