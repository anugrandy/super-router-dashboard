import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  api,
  TYPE_LABEL,
  displayName,
  fmtAge,
  fmtDuration,
  fmtTime,
  type Device,
  type DeviceEvent,
  type KickLog,
  type KickReport,
} from '../api'
import { useLive } from '../live'

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
  const [iface, setIface] = useState<string>('')
  const [report, setReport] = useState<KickReport | null>(null)

  // Use the live row so the kicked badge and its countdown come from the
  // merged/ticked view state rather than the one-shot REST payload.
  const live = devices.find((d) => d.mac === mac) ?? null
  const liveKicked = live?.kicked ?? null

  async function load() {
    try {
      const st = await api.settings().catch(() => null)
      if (st) {
        setIface(st.wifi_interface_map?.[mac.toUpperCase()] ?? st.default_wifi_interface)
      }
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

  if (!device) {
    return (
      <div className="card p-6">
        {err ? (
          <p className="text-rose-300 text-sm">{err}</p>
        ) : (
          <p className="text-slate-500 text-sm">Memuat device…</p>
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

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link to="/devices" className="btn">
          &larr; Devices
        </Link>
        <h1 className="text-lg font-semibold">{displayName(shown)}</h1>
        <span className="mono text-slate-500">{shown.mac}</span>
        {isKicked ? (
          <span className="badge badge-kicked badge-pulse">
            Di-kick · {fmtDuration(liveKicked)}
          </span>
        ) : shown.online ? (
          <span className="badge badge-online badge-pulse">Online</span>
        ) : (
          <span className="badge badge-offline">Offline</span>
        )}
        {shown.is_gateway && <span className="badge badge-gateway">Gateway</span>}
      </div>

      {err && (
        <div className="card px-4 py-3 border-rose-500/40 bg-rose-500/10 text-sm text-rose-200">
          {err}
        </div>
      )}

      {report && (report.router_blocked || report.arp_active) && (
        <div className="card px-4 py-3 text-xs space-y-1">
          <div className="font-semibold text-slate-300 mb-1.5">Hasil kick terakhir</div>
          <div className="flex items-center gap-2">
            <span className={`badge ${report.router_blocked ? 'badge-online' : 'badge-offline'}`}>
              {report.router_blocked ? 'berhasil' : 'gagal'}
            </span>
            <span className="text-slate-400">
              Blokir router (Access Control)
              {report.router_inst_id ? ` — rule ${report.router_inst_id}` : ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`badge ${report.arp_active ? 'badge-online' : 'badge-offline'}`}>
              {report.arp_active ? 'berhasil' : 'gagal'}
            </span>
            <span className="text-slate-400">
              ARP spoof (putus instan{report.arp_active ? `, ${report.arp_seconds}s` : ''})
            </span>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-1">
          <h2 className="text-sm font-semibold mb-4">Informasi</h2>
          <dl className="space-y-2.5 text-sm">
            <Row k="IP address" v={device.ip || '-'} mono />
            <Row k="Hostname" v={device.hostname || '-'} />
            <Row k="Vendor" v={device.vendor || 'Tidak diketahui'} />
            <Row k="Tipe" v={TYPE_LABEL[device.device_type] || device.device_type} />
            <Row k="Pertama terlihat" v={fmtTime(device.first_seen)} />
            <Row k="Terakhir terlihat" v={fmtAge(device.last_seen)} />
            <Row k="Online terakhir" v={fmtTime(device.last_online)} />
          </dl>
        </div>

        <div className="card p-5 lg:col-span-1">
          <h2 className="text-sm font-semibold mb-4">Nama panggilan</h2>
          <input
            className="input mb-3"
            placeholder="mis. HP Adek"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
          <button className="btn btn-primary" disabled={busy} onClick={saveNickname}>
            Simpan nama
          </button>

          <h2 className="text-sm font-semibold mt-6 mb-3">Kontrol Kick</h2>
          <input
            className="input mb-3"
            placeholder="Alasan (opsional, untuk log)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {isKicked ? (
            <button className="btn btn-danger w-full" disabled={busy} onClick={doUnkick}>
              Hentikan kick ( lepas dari router)
            </button>
          ) : (
            <button className="btn btn-danger w-full" disabled={busy} onClick={doKick}>
              Kick device ini
            </button>
          )}
          <p className="text-xs text-slate-500 mt-3 leading-relaxed">
            Blokir <strong>permanen</strong> dilakukan di router (WLAN Advanced →
                Access Control Rule): device tidak akan bisa konek lagi sampai
                kamu tekan Hentikan Kick. Efek <strong>putus instan</strong>{' '}
                memakai ARP spoof, dan bisa saja tidak berlaku di semua
                perangkat — terutama iOS/Android modern yang menoleransi ARP
                spoofing.{' '}
                <br />
                <br />
                SSID: <code className="mono">{iface || 'DEV.WIFI.AP?'}</code>{' '}
                {report?.interface_source === 'auto' ? '(terdeteksi otomatis)' :
                 report?.interface_source === 'fallback' ? '(default — cek SSID device)' : ''}
            {device.is_gateway && ' Gateway tidak bisa di-kick.'}
          </p>
        </div>

        <div className="card p-5 lg:col-span-1">
          <h2 className="text-sm font-semibold mb-4">Riwayat kick</h2>
          {kickLog.length === 0 ? (
            <p className="text-xs text-slate-500">Belum pernah di-kick.</p>
          ) : (
            <ul className="space-y-2.5 text-xs max-h-64 overflow-y-auto">
              {kickLog.map((k) => (
                <li key={k.id} className="border-l-2 border-ink-600 pl-3">
                  <div className="flex items-center gap-2">
                    {k.active && <span className="badge badge-kicked">aktif</span>}
                    <span className="text-slate-400">{fmtTime(k.at)}</span>
                  </div>
                  <div className="text-slate-500 mt-0.5">
                    oleh {k.actor || '-'} ·{' '}
                    {k.active ? 'berjalan' : fmtDuration(k.duration)}
                  </div>
                  {k.reason && <div className="text-slate-400 mt-0.5">{k.reason}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-ink-700">
          <h2 className="text-sm font-semibold">Riwayat konek / diskon</h2>
        </div>
        <div className="max-h-80 overflow-y-auto">
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
                  <td colSpan={3} className="text-center text-slate-500 py-8">
                    Belum ada riwayat.
                  </td>
                </tr>
              )}
              {events.map((e, i) => (
                <tr key={`${e.at}-${i}`}>
                  <td className="text-slate-400">{fmtTime(e.at)}</td>
                  <td>
                    <span className={`badge ${e.kind === 'online' ? 'badge-online' : 'badge-offline'}`}>
                      {e.kind === 'online' ? 'Online' : 'Offline'}
                    </span>
                  </td>
                  <td className="mono">{e.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500 shrink-0">{k}</dt>
      <dd className={`text-right ${mono ? 'mono' : ''}`}>{v}</dd>
    </div>
  )
}