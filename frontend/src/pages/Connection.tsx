import { useCallback, useEffect, useState } from 'react'
import { api, fmtTime, type WanEvent, type WanStatus } from '../api'
import { PageHeader } from '../components/Layout'
import { IconPlug, IconUnplug, UiRefresh } from '../components/icons'
import { useWanEvent } from '../components/Toasts'

function Row({
  label,
  value,
  mono = true,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 border-b border-[rgba(255,255,255,0.04)] last:border-0">
      <span className="text-[12px] text-[#7c8798] shrink-0">{label}</span>
      <span
        className={`text-[13px] text-[#e6eaf2] text-right truncate ${mono ? 'mono' : ''}`}
        title={value}
      >
        {value || '—'}
      </span>
    </div>
  )
}

function StatusPill({
  status,
  label,
}: {
  status: 'connected' | 'disconnected' | 'unknown'
  label: string
}) {
  const up = status === 'connected'
  const color = up ? '#6fd9b8' : status === 'disconnected' ? '#f295aa' : '#7c8798'
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium"
      style={{ color, background: `${color}1f` }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  )
}

/**
 * Internet (WAN) connection status.
 *
 * Deliberately does NOT poll. The backend already polls the router every two
 * minutes and pushes a socket event when the state changes; this page loads
 * once and then updates when that arrives. Adding a timer here would mean two
 * pollers for one number.
 */
export default function ConnectionPage() {
  const [data, setData] = useState<{ status: WanStatus; history: WanEvent[]; poll_seconds: number } | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const wanEvent = useWanEvent()

  const load = useCallback(async () => {
    try {
      setData(await api.wan())
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal memuat status koneksi')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Refresh when the monitor detects a change.
  useEffect(() => {
    if (wanEvent) void load()
  }, [wanEvent, load])

  const refresh = async () => {
    setBusy(true)
    await load()
    setBusy(false)
  }

  const s = data?.status
  const up = s?.ipv4_status === 'connected'
  const v6 = s?.ipv6_status === 'connected'

  return (
    <div>
      <PageHeader
        title="Status Koneksi Internet"
        subtitle={
          s?.available
            ? `${s.connection_name} · ${s.connection_type} · poll tiap ${data?.poll_seconds ?? 120}s`
            : undefined
        }
        actions={
          <button onClick={refresh} disabled={busy} className="btn-ghost">
            <UiRefresh className={busy ? 'animate-spin' : ''} />
            Muat ulang
          </button>
        }
      />

      {err && (
        <div className="card px-4 py-3 mb-4 border-rose-400/30 bg-rose-400/[0.07] text-sm text-[#f295aa]">
          {err}
        </div>
      )}

      {!s ? (
        <div className="card p-10 text-center text-[13px] text-[#7c8798]">Memuat…</div>
      ) : !s.available ? (
        <div className="card p-6 border-rose-400/30 bg-rose-400/[0.05]">
          <div className="flex items-center gap-2 text-[#f295aa] font-semibold text-[14px]">
            <IconUnplug size={16} />
            Router tidak bisa dihubungi
          </div>
          <p className="text-[12px] text-[#9aa4b3] mt-2 leading-5">
            {s.error || 'Tidak ada respons dari router.'}
          </p>
          <p className="text-[12px] text-[#7c8798] mt-2 leading-5">
            Ini <strong className="text-[#dbe1ec]">bukan</strong> berarti internet
            mati — router bisa saja sedang restart. Status internet terakhir yang
            diketahui masih dipakai sampai router merespons lagi.
          </p>
        </div>
      ) : (
        <>
          {/* Main status card */}
          <div
            className="card p-5 mb-4 flex items-center gap-4 flex-wrap"
            style={{
              borderColor: up ? 'rgba(70,201,162,0.3)' : 'rgba(242,113,139,0.35)',
              background: up ? 'rgba(12,38,32,0.5)' : 'rgba(56,17,27,0.5)',
            }}
          >
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0"
              style={{ color: up ? '#6fd9b8' : '#f295aa', background: `${up ? '#46c9a2' : '#f2718b'}1f` }}
            >
              {up ? <IconPlug size={26} /> : <IconUnplug size={26} />}
            </div>
            <div className="min-w-0 flex-1">
              <div
                className="text-[22px] font-bold leading-tight"
                style={{ color: up ? '#8fe6c9' : '#ffb3c2' }}
              >
                {up ? 'Internet Tersambung' : 'Internet Terputus'}
              </div>
              <div className="text-[12px] text-[#9aa4b3] mt-1">
                {s.connection_name} · {s.connection_type || '—'}
                {up
                  ? ` · sudah online ${s.online_human}`
                  : s.disconnect_reason
                    ? ` · ${s.disconnect_reason}`
                    : ''}
              </div>
            </div>
            <div className="flex flex-col gap-1.5 shrink-0">
              <StatusPill status={s.ipv4_status} label={`IPv4 ${up ? ' aktif' : ' mati'}`} />
              {s.ipv6_status !== 'unknown' && (
                <StatusPill status={s.ipv6_status} label={`IPv6 ${v6 ? ' aktif' : ' mati'}`} />
              )}
            </div>
          </div>

          {/* Outage reason gets its own callout when present */}
          {s.disconnect_reason && (
            <div className="card px-4 py-3 mb-4 border-rose-400/30 bg-rose-400/[0.06]">
              <div className="text-[12px] font-semibold text-[#ffb3c2]">Penyebab putusnya koneksi</div>
              <div className="mono text-[12px] text-[#e6eaf2] mt-1">{s.disconnect_reason}</div>
              <p className="text-[11px] text-[#9aa4b3] mt-1.5 leading-4">
                Kode ini berasal dari router (ISP). Wi-Fi lokal di rumah tetap
                aktif, jadi perangkat yang tersambung ke access point tidak ikut
                terputus.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <div className="card p-4">
              <h3 className="text-[13px] font-semibold text-[#dbe1ec] mb-1">IPv4</h3>
              <Row label="Status" value={s.ipv4_status} mono={false} />
              <Row label="IP WAN" value={s.ipv4_address} />
              <Row label="Gateway" value={s.gateway} />
              <Row label="Subnet mask" value={s.subnet_mask} />
              <Row label="Online duration" value={s.online_human} mono={false} />
              <Row label="DNS" value={s.dns.join(', ') || '—'} />
            </div>

            <div className="card p-4">
              <h3 className="text-[13px] font-semibold text-[#dbe1ec] mb-1">
                IPv6 {s.ipv6_status !== 'unknown' && <StatusPill status={s.ipv6_status} label={v6 ? 'aktif' : 'mati'} />}
              </h3>
              {s.ipv6_status === 'unknown' ? (
                <p className="text-[12px] text-[#7c8798] py-2">
                  ISP belum mengaktifkan IPv6 pada koneksi ini.
                </p>
              ) : (
                <>
                  <Row label="Alamat (prefix)" value={s.ipv6_address} />
                  <Row label="Gateway" value={s.ipv6_gateway} />
                  <Row label="Online duration" value={s.ipv6_online_human} mono={false} />
                  <Row label="DNS" value={s.ipv6_dns.join(', ') || '—'} />
                </>
              )}
            </div>

            <div className="card p-4">
              <h3 className="text-[13px] font-semibold text-[#dbe1ec] mb-1">Koneksi</h3>
              <Row label="Nama" value={s.connection_name} mono={false} />
              <Row label="Tipe" value={s.connection_type} mono={false} />
              <Row label="Autentikasi" value={s.auth_type || '—'} mono={false} />
              <Row label="VLAN" value={s.vlan_id} />
              <Row label="MTU" value={s.mtu} />
              <Row label="NAT" value={s.is_nat ? 'aktif' : 'nonaktif'} mono={false} />
              <Row label="Default gateway" value={s.is_default_gateway ? 'ya' : 'tidak'} mono={false} />
            </div>

            {/* Every connection the router reports, so a rename is visible */}
            <div className="card p-4">
              <h3 className="text-[13px] font-semibold text-[#dbe1ec] mb-1">
                Semua koneksi di router
              </h3>
              <ul className="text-[12px]">
                {s.connections.map((c) => (
                  <li
                    key={c.name}
                    className="flex items-center gap-2 py-1.5 border-b border-[rgba(255,255,255,0.04)] last:border-0"
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{
                        background: c.ipv4_status === 'connected' ? '#6fd9b8' : '#7c8798',
                      }}
                    />
                    <span className="text-[#e6eaf2] w-24 shrink-0">{c.name}</span>
                    <span className="text-[#7c8798] w-16 shrink-0">{c.type || '—'}</span>
                    <span className="mono text-[#9aa4b3] truncate">
                      {c.ipv4_address && c.ipv4_address !== '0.0.0.0' ? c.ipv4_address : '—'}
                    </span>
                    {c.is_default_gateway && <span className="badge badge-accent shrink-0">default</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Outage history */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-[rgba(255,255,255,0.05)]">
              <h3 className="text-[13px] font-semibold text-[#dbe1ec]">
                Riwayat putus-nyambung
              </h3>
              <p className="text-[11px] text-[#7c8798] mt-0.5">
                Dicatat otomatis setiap kali status berubah
              </p>
            </div>
            {!data || data.history.length === 0 ? (
              <p className="p-8 text-center text-[13px] text-[#7c8798]">
                Belum ada riwayat. Status saat ini dicatat sebagai titik awal.
              </p>
            ) : (
              <ul>
                {data.history.map((e) => {
                  const on = e.kind === 'connected'
                  return (
                    <li
                      key={e.id}
                      className="flex items-center gap-3 px-4 py-2.5 border-b border-[rgba(255,255,255,0.035)] last:border-0 hover:bg-[rgba(255,255,255,0.022)] transition"
                    >
                      <span
                        className="shrink-0"
                        style={{ color: on ? '#6fd9b8' : '#f295aa' }}
                      >
                        {on ? <IconPlug size={14} /> : <IconUnplug size={14} />}
                      </span>
                      <span
                        className={`badge shrink-0 ${on ? 'badge-online' : 'badge-offline'}`}
                      >
                        {on ? 'connected' : 'disconnected'}
                      </span>
                      <span className="mono text-[11px] text-[#9aa4b3] hidden sm:inline shrink-0">
                        {e.ipv4_address || '—'}
                      </span>
                      {e.reason && (
                        <span className="text-[11px] text-[#f295aa]/80 truncate flex-1" title={e.reason}>
                          {e.reason}
                        </span>
                      )}
                      <span
                        className="text-[11px] text-[#5d6675] shrink-0 ml-auto"
                        title={fmtTime(e.at)}
                      >
                        {fmtTime(e.at)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}