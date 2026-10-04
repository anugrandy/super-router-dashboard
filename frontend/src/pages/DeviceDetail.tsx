import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  api,
  DEVICE_TYPES,
  TYPE_LABEL,
  fmtRate,
  displayName,
  fmtAge,
  fmtDuration,
  fmtTime,
  type Device,
  type DeviceEvent,
  type KickLog,
  type KickReport,
} from '../api'
import { elapsedOf, useClock, useLive } from '../live'
import { DeviceTypeChip } from '../components/icons'

/**
 * APs the ACL form offers. Kept in sync with the router's own Interface
 * dropdown (DEV.WIFI.AP1..AP8); an unknown id would be rejected by the router.
 */
const IFACE_OPTIONS = Array.from({ length: 8 }, (_, i) => ({
  value: `DEV.WIFI.AP${i + 1}`,
  label: `AP${i + 1} (SSID${i + 1})`,
}))

/** Best-effort label for an interface: its number, for the report rows. */
function ssidLabelFor(iface: string): string {
  const n = iface.split('AP').pop()
  return n ? `SSID${n}` : ''
}

export default function DeviceDetail() {
  const { mac = '' } = useParams()
  const nav = useNavigate()
  const { devices } = useLive()
  const [device, setDevice] = useState<Device | null>(null)
  const [events, setEvents] = useState<DeviceEvent[]>([])
  const [kickLog, setKickLog] = useState<KickLog[]>([])
  const [nickname, setNickname] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ifaceMap, setIfaceMap] = useState<Record<string, string>>({})
  const [report, setReport] = useState<KickReport | null>(null)

  // Use the live row so the kicked badge and its countdown come from the
  // merged/ticked view state rather than the one-shot REST payload.
  const live = devices.find((d) => d.mac === mac) ?? null
  const liveKicked = live?.kicked ?? null

  async function load() {
    try {
      const st = await api.settings().catch(() => null)
      if (st) setIfaceMap(st.wifi_interface_map ?? {})
      const res = await api.device(mac)
      setDevice(res.device)
      setEvents(res.events)
      setKickLog(res.kicks)
      setNickname(res.device.nickname)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal memuat device')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mac])

  // Keep the local copy in sync with live pushes for this MAC.
  useEffect(() => {
    if (liveKicked == null && device?.kicked != null) {
      // Kick ended server-side; refresh the log so the row shows as closed.
      void load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKicked])

  async function saveNickname() {
    setBusy(true)
    setErr(null)
    try {
      const d = await api.rename(mac, nickname)
      setDevice((prev) => (prev ? { ...prev, ...d } : d))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan nama')
    } finally {
      setBusy(false)
    }
  }

  /** Pin the AP used for Access Control. Merges, because the endpoint
   *  replaces the whole map - posting one key would drop every other override. */
  async function saveInterface(next: string) {
    setBusy(true)
    setErr(null)
    try {
      const merged = { ...ifaceMap, [mac.toUpperCase()]: next }
      if (!next) delete merged[mac.toUpperCase()]
      await api.saveWifiInterfaceMap(merged)
      setIfaceMap(merged)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan SSID device')
    } finally {
      setBusy(false)
    }
  }

  async function saveType(next: string) {
    setBusy(true)
    setErr(null)
    try {
      const d = await api.setType(mac, next)
      setDevice((prev) => (prev ? { ...prev, ...d } : d))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan tipe device')
    } finally {
      setBusy(false)
    }
  }

  async function doKick() {
    setBusy(true)
    setErr(null)
    setReport(null)
    try {
      const res = await api.kick(mac, reason)
      setReport(res)
      // Say plainly when only one half worked - a silent partial success is
      // the failure mode that got the user here in the first place.
      if (!res.router_blocked || !res.arp_active) {
        const missing = []
        if (!res.router_blocked) missing.push('blokir router GAGAL')
        if (!res.arp_active) missing.push('ARP spoof GAGAL')
        setErr(
          `Kick hanya sebagian berhasil (${missing.join(', ')}). ` +
            (res.router_error ? `Router: ${res.router_error}. ` : '') +
            (res.arp_error ? `ARP: ${res.arp_error}.` : ''),
        )
      }
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal memulai kick')
    } finally {
      setBusy(false)
    }
  }

  async function doUnkick() {
    setBusy(true)
    setErr(null)
    try {
      const res = await api.unkick(mac)
      if (!res.rule_deleted) {
        setErr(
          'Rule tidak ditemukan di router (mungkin sudah dihapus manual). ' +
            'ARP sudah dihentikan.',
        )
      }
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal menghentikan kick')
    } finally {
      setBusy(false)
    }
  }

  // Uptime history derived from the existing connect/disconnect events. The
  // backend stores transitions, not samples, so the series is built by holding
  // each state until the next transition - no new backend endpoint needed.
  const uptimeSeries = useMemo(() => buildUptimeSeries(events), [events])

  if (!device) {
    return (
      <div className="card p-6 max-w-md">
        {err ? (
          <p className="text-[#E8604A] text-sm">{err}</p>
        ) : (
          <p className="text-[#8B8D93] text-sm">Memuat device…</p>
        )}
        <button className="btn mt-4" onClick={() => nav('/devices')}>
          Kembali
        </button>
      </div>
    )
  }

  const isKicked = liveKicked != null
  // Past the `if (!device)` guard above, this is non-null; prefer the live row.
  const shown = live ?? device

  // Per-AP outcome of the last kick. interfaces_blocked is ordered against
  // interfaces_targeted, so anything missing from the first list failed.
  const targeted = report?.interfaces_targeted ?? []
  const blocked = report?.interfaces_blocked ?? []
  const failed = report?.interfaces_failed ?? []

  return (
    <div>
      {/* ------------------------------------------------------------ header */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <Link to="/devices" className="btn btn-ghost">
          &larr; Devices
        </Link>
        <DeviceTypeChip type={shown.device_type} />
        <div className="min-w-0">
          <h1 className="section-title truncate">{displayName(shown)}</h1>
          <div className="mono text-[#58585F]">{shown.mac}</div>
        </div>
        {isKicked ? (
          <KickedPill started={liveKicked} />
        ) : shown.online ? (
          <span className="badge badge-online badge-pulse">Online</span>
        ) : (
          <span className="badge badge-offline">Offline</span>
        )}
        {shown.is_gateway && <span className="badge badge-gateway">Gateway</span>}
      </div>

      {err && (
        <div className="card px-4 py-3 border-[rgba(232,96,74,0.32)] bg-[rgba(232,96,74,0.07)] text-sm text-[#E8604A] mb-4">
          {err}
        </div>
      )}

      {report && (report.router_blocked || report.arp_active) && (
        <div className="card p-4 mb-4">
          <div className="card-title mb-3">Hasil kick terakhir</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <ResultHalf
              ok={report.router_blocked}
              title="Blokir router"
              detail={
                report.router_blocked
                  ? `Access Control aktif${
                      report.router_inst_ids?.length
                        ? ` — ${report.router_inst_ids.length} rule (${report.router_inst_ids.join(', ')})`
                        : ''
                    }`
                  : report.router_error || 'gagal'
              }
            />
            <ResultHalf
              ok={report.arp_active}
              title="ARP spoof"
              detail={
                report.arp_active
                  ? `Putus instan, ${report.arp_seconds}s`
                  : report.arp_error || 'gagal'
              }
            />
          </div>

          {/* One line per AP. A roaming device needs a rule on every AP it has
              ever used, so a single-interface summary would be misleading. */}
          {targeted.length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#58585F] mb-1.5">
                SSID yang di blokir ({blocked.length}/{targeted.length})
              </div>
              <ul className="space-y-1">
                {targeted.map((iface) => {
                  const ok = blocked.includes(iface)
                  return (
                    <li key={iface} className="flex items-center gap-2 text-[12px]">
                      <span className={`badge ${ok ? 'badge-online' : 'badge-kicked'}`}>
                        {ok ? 'blocked' : 'gagal'}
                      </span>
                      <code className="mono text-[#8B8D93]">{iface}</code>
                      <span className="text-[11px] text-[#58585F]">
                        {ssidLabelFor(iface)}
                      </span>
                    </li>
                  )
                })}
              </ul>
              {failed.length > 0 && (
                <p className="text-[11px] text-[#E7B34A] mt-2 leading-relaxed">
                  {failed.join(' · ')}
                </p>
              )}
              {/* Roaming warning: history says this device uses more APs than
                  we managed to block, so it can still rejoin on one of them. */}
              {targeted.length > blocked.length && (
                <p className="text-[11px] text-[#E7B34A] mt-2 leading-relaxed">
                  Device ini pernah terlihat di {targeted.length} SSID, tapi hanya{' '}
                  {blocked.length} yang berhasil diblokir. Kalau device pindah ke
                  SSID yang gagal, blokir tidak berlaku — ulangi Kick saat
                  device sedang konek di SSID itu.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------- 3 columns */}
      <div className="grid gap-4 lg:grid-cols-3 mb-4">
        <div className="card p-5">
          <h2 className="card-title mb-4">Informasi</h2>
          <dl className="space-y-3 text-[13px]">
            <Row k="IP address" v={device.ip || '-'} mono />
            <Row k="Hostname" v={device.hostname || '-'} />
            <Row k="Vendor" v={device.vendor || 'Tidak diketahui'} />
            <Row k="Tipe" v={TYPE_LABEL[device.device_type] || device.device_type} />
            <div className="border-t border-border/70 pt-3">
              <Row k="Pertama terlihat" v={fmtTime(device.first_seen)} />
            </div>
            <Row k="Terakhir terlihat" v={fmtAge(device.last_seen)} />
            <Row k="Online terakhir" v={fmtTime(device.last_online)} />
          </dl>
        </div>

        <div className="card p-5">
          <h2 className="card-title mb-3">Identitas device</h2>
          <div className="flex gap-2">
            <input
              className="input"
              placeholder="mis. HP Adek"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
            <button className="btn btn-primary shrink-0" disabled={busy} onClick={saveNickname}>
              Simpan
            </button>
          </div>

          <label className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#58585F] mt-4 mb-1.5">
            Tipe device
          </label>
          <select
            className="input"
            value={shown.type_override || ''}
            disabled={busy}
            onChange={(e) => saveType(e.target.value)}
          >
            {/* "" clears the override; without this there is no way back to
                auto-detection once a type has been picked. */}
            <option value="" disabled={!shown.type_override}>
              Otomatis ({TYPE_LABEL[shown.guessed_type] || shown.guessed_type})
            </option>
            {DEVICE_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t] || t}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-[#58585F] mt-1.5">
            {shown.type_override ? (
              <>
                Diatur manual. Deteksi otomatis menebak{' '}
                <span className="text-[#8B8D93]">
                  {TYPE_LABEL[shown.guessed_type] || shown.guessed_type}
                </span>
                .
              </>
            ) : (
              'Terdeteksi otomatis dari hostname router dan vendor MAC.'
            )}
          </p>

          {shown.randomized_mac && (
            <p className="text-[11px] text-[#58585F] mt-1.5">
              MAC acak (private), jadi vendor tidak bisa dibaca dari OUI.
            </p>
          )}

          {!shown.type_confident && (
            <div className="rounded-[12px] border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2.5 mt-3">
              <div className="text-[11px] text-[#E7B34A] leading-relaxed">
                Tipe <strong>tidak bisa dipastikan</strong> otomatis. Device ini tidak
                mengirim hostname DHCP dan memakai MAC acak, jadi tidak ada sumber
                data yang bisa menandainya sebagai Apple device (iPhone/iPad/Mac),
                HP, laptop, atau apa pun. Kalau kamu tahu device ini apa, pilih
                manual di atas — pilihanmu tersimpan dan tidak ditimpa scan
                berikutnya.
              </div>
            </div>
          )}

          <div className="border-t border-border/70 mt-5 pt-5">
            <h2 className="card-title mb-3">Kontrol Kick</h2>
            <input
              className="input mb-3"
              placeholder="Alasan (opsional, untuk log)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {isKicked ? (
              <button className="btn btn-danger w-full" disabled={busy} onClick={doUnkick}>
                Hentikan kick (lepas dari router)
              </button>
            ) : (
              <button className="btn btn-danger w-full" disabled={busy} onClick={doKick}>
                Kick device ini
              </button>
            )}
            <p className="text-[11px] text-[#58585F] mt-3 leading-relaxed">
              Blokir <strong className="text-[#8B8D93]">permanen</strong> dilakukan di
              router (WLAN Advanced → Access Control Rule): device tidak akan bisa
              konek lagi sampai kamu tekan Hentikan Kick. Efek{' '}
              <strong className="text-[#8B8D93]">putus instan</strong> memakai ARP spoof,
              dan bisa saja tidak berlaku di semua perangkat — terutama iOS/Android
              modern yang menoleransi ARP spoofing.
              <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="text-[#58585F]">SSID:</span>
                {/* The interface comes from the router's WLAN client table, so
                    it is the AP the device is really on - not a default. */}
                <code className="mono text-[#8B8D93]">
                  {shown.ssid_name || (shown.wifi_interface || '-')}
                </code>
                {shown.wifi_interface && (
                  <span className="mono text-[#58585F]">({shown.wifi_interface})</span>
                )}
                {report?.interface_source === 'auto' && (
                  <span className="badge badge-online">terdeteksi otomatis</span>
                )}
                {report?.interface_source === 'manual' && (
                  <span className="badge badge-warn">diatur manual</span>
                )}
                {report?.interface_source === 'fallback' && (
                  <span className="badge badge-warn">default</span>
                )}
              </div>
              {report?.interface_source === 'fallback' && (
                <div className="text-[#E7B34A] mt-1">
                  Router tidak melaporkan AP untuk device ini, jadi memakai
                  default. Jika device sebenarnya di SSID lain, blokir tidak akan
                  berlaku — pilih AP di bawah.
                </div>
              )}

              {/* Manual AP override. Auto-detection normally gets this right;
                  this is for when the router reports the wrong AP (or none). */}
              <label className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#58585F] mt-3 mb-1.5">
                AP untuk blokir
              </label>
              <select
                className="input"
                value={ifaceMap[mac.toUpperCase()] ?? ''}
                disabled={busy}
                onChange={(e) => saveInterface(e.target.value)}
              >
                <option value="">
                  Otomatis ({shown.wifi_interface || shown.ssid_name || 'tidak diketahui'})
                </option>
                {IFACE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                    {o.value === shown.wifi_interface ? ' (terdeteksi)' : ''}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-[#58585F] mt-1.5">
                Rule Access Control hanya berlaku di AP yang dipilih. Pilih yang
                salah = blokir gagal diam-diam.
              </p>
              {device.is_gateway && (
                <div className="text-[#58585F] mt-1">Gateway tidak bisa di-kick.</div>
              )}
            </p>
          </div>
        </div>

        <div className="card p-5">
          <h2 className="card-title">Koneksi &amp; laju data</h2>
          <p className="card-sub mt-0.5 mb-4">Dilaporkan router</p>

          <dl className="space-y-3 text-[13px]">
            <Row k="Band" v={shown.link_band || '-'} />
            <Row k="Ke bawah (RX)" v={fmtRate(shown.rx_rate_bps)} mono />
            <Row k="Ke atas (TX)" v={fmtRate(shown.tx_rate_bps)} mono />
          </dl>

          {/* Honest limitation rather than a fabricated GB figure. */}
          <div
            className="rounded-[12px] border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2.5 mt-4"
          >
            <div className="text-[11px] text-[#E7B34A] leading-relaxed">
              Total pemakaian data per device <strong>tidak tersedia</strong> di router
              ini. Firmware ZTE F670L hanya mengekspos laju sesaat (bps) di atas —
              tidak ada penghitung byte kumulatif per klien di seluruh panel admin.
              Laptop kamu juga bukan gateway, jadi netdash tidak bisa menghitung
              trafik device lain dari jaringan.
            </div>
          </div>
        </div>

        <div className="card p-5">
          <h2 className="card-title mb-4">Riwayat kick</h2>
          {kickLog.length === 0 ? (
            <p className="text-xs text-[#8B8D93]">Belum pernah di-kick.</p>
          ) : (
            <ul className="space-y-3 text-xs max-h-64 overflow-y-auto pr-1">
              {kickLog.map((k) => (
                <li
                  key={k.id}
                  className="border-l-2 border-[#2A2A2F] pl-3 hover:border-[#33333A] transition"
                >
                  <div className="flex items-center gap-2">
                    {k.active && <span className="badge badge-kicked">aktif</span>}
                    <span className="text-[#8B8D93]">{fmtTime(k.at)}</span>
                  </div>
                  <div className="text-[#58585F] mt-0.5">
                    oleh {k.actor || '-'} ·{' '}
                    {k.active ? 'berjalan' : fmtDuration(k.duration)}
                  </div>
                  {k.reason && <div className="text-[#8B8D93] mt-0.5">{k.reason}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ------------------------------------------------- uptime + history */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-5">
          <h2 className="card-title">Riwayat koneksi</h2>
          <p className="card-sub mt-0.5 mb-4">
            Status online/offline dari transisi konek & diskon
          </p>
          {uptimeSeries.length > 1 ? (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={uptimeSeries}
                  margin={{ top: 6, right: 10, bottom: 0, left: -30 }}
                >
                  <defs>
                    <linearGradient id="gUptime" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3ED28C" stopOpacity={0.38} />
                      <stop offset="100%" stopColor="#3ED28C" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="at"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={44}
                    tickFormatter={(v: string) =>
                      new Date(v).toLocaleTimeString('id-ID', {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    }
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    domain={[0, 1]}
                    ticks={[0, 1]}
                    tickFormatter={(v) => (v ? 'online' : 'offline')}
                    width={54}
                  />
                  <Tooltip
                    cursor={{ stroke: 'rgba(255,255,255,0.14)', strokeWidth: 1 }}
                    labelFormatter={(v) => fmtTime(String(v))}
                    formatter={() => []}
                    contentStyle={{
                      background: '#17171B',
                      border: '1px solid #2A2A2F',
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                  />
                  {/* stepAfter: each transition holds until the next one, which
                      is exactly how the backend records it. */}
                  <Area
                    type="stepAfter"
                    dataKey="online"
                    stroke="#3ED28C"
                    strokeWidth={2}
                    fill="url(#gUptime)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-xs text-[#8B8D93] py-8 text-center">
              Belum ada cukup riwayat untuk menggambar grafik.
            </p>
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="p-5 pb-4">
            <h2 className="card-title">Riwayat konek / diskon</h2>
            <p className="card-sub mt-0.5">
              {events.length ? `${events.length} transisi tercatat` : 'Belum ada riwayat'}
            </p>
          </div>
          <div className="max-h-56 overflow-y-auto">
            <table className="net">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Status</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-center text-[#8B8D93] py-8">
                      Belum ada riwayat.
                    </td>
                  </tr>
                )}
                {events.map((e, i) => (
                  <tr key={`${e.at}-${i}`}>
                    <td className="text-[#8B8D93]">{fmtTime(e.at)}</td>
                    <td>
                      <span
                        className={`badge ${e.kind === 'online' ? 'badge-online' : 'badge-offline'}`}
                      >
                        {e.kind === 'online' ? 'Online' : 'Offline'}
                      </span>
                    </td>
                    <td className="mono text-[#8B8D93]">{e.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Countdown pill for the page header; ticks only while a kick is running. */
function KickedPill({ started }: { started: number }) {
  useClock()
  return (
    <span className="badge badge-kicked badge-pulse">
      Di-kick · {fmtDuration(elapsedOf(started))}
    </span>
  )
}

/** One line of the kick-result card. Soft colour, never a loud banner. */
function ResultHalf({
  ok,
  title,
  detail,
}: {
  ok: boolean
  title: string
  detail: string
}) {
  return (
    <div
      className="rounded-[12px] border px-3 py-2.5"
      style={{
        background: ok ? 'rgba(62,210,140,0.06)' : 'rgba(232,96,74,0.06)',
        borderColor: ok ? 'rgba(62,210,140,0.2)' : 'rgba(232,96,74,0.22)',
      }}
    >
      <div className="flex items-center gap-2">
        <span className={`badge ${ok ? 'badge-online' : 'badge-kicked'}`}>
          {ok ? 'berhasil' : 'gagal'}
        </span>
        <span className="text-[13px] text-[#F2F2F3] font-medium">{title}</span>
      </div>
      <div className="text-[11px] text-[#8B8D93] mt-1 break-words">{detail}</div>
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[#58585F] shrink-0">{k}</dt>
      <dd className={`text-right text-[#8B8D93] ${mono ? 'mono' : ''}`}>{v}</dd>
    </div>
  )
}

/**
 * Expand the backend's transition log into a plottable series. Events arrive
 * newest-first, so they are reversed; each event's state is held until the next
 * one and a final point pins the current state at `now`.
 */
function buildUptimeSeries(events: DeviceEvent[], now = new Date()) {
  const ordered = [...events]
    .filter((e) => e.at)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  if (!ordered.length) return []

  const series: { at: string; online: number }[] = []
  // Start from the first transition holding the opposite state, so the very
  // first segment is a flat run rather than an unexplained jump from zero.
  series.push({
    at: ordered[0].at,
    online: ordered[0].kind === 'online' ? 1 : 0,
  })
  for (const e of ordered) {
    series.push({ at: e.at, online: e.kind === 'online' ? 1 : 0 })
  }
  const last = ordered[ordered.length - 1]
  const lastMs = new Date(last.at).getTime()
  const nowMs = now.getTime()
  // Only extend if the final state is still meaningfully current, otherwise the
  // chart would claim the device has held that state for months.
  if (nowMs - lastMs < 1000 * 60 * 60 * 24) {
    series.push({ at: now.toISOString(), online: last.kind === 'online' ? 1 : 0 })
  }
  return series
}