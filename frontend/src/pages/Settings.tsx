import { useEffect, useState } from 'react'

const location = globalThis.location
import { api, type IfaceReport, type RouterStatus, type Settings } from '../api'
import { useAuth } from '../live'
import { PageHeader } from '../components/Layout'

export default function SettingsPage() {
  const { username } = useAuth()
  const [s, setS] = useState<Settings | null>(null)
  const [net, setNet] = useState<IfaceReport | null>(null)
  const [router, setRouter] = useState<RouterStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pw, setPw] = useState('')
  const [whitelistText, setWhitelistText] = useState('')

  async function load() {
    try {
      const got = await api.settings()
      setS(got)
      setWhitelistText(got.whitelist_macs.join('\n'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal memuat settings')
    }
    // Interface report is diagnostic-only; a failure here must not break the page.
    try {
      setNet(await api.interfaces())
    } catch {
      setNet(null)
    }
    try {
      setRouter(await api.routerStatus())
    } catch {
      setRouter(null)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function save() {
    if (!s) return
    setBusy(true)
    setMsg(null)
    setErr(null)
    try {
      const whitelist = whitelistText
        .split(/[\n,]/)
        .map((x) => x.trim())
        .filter(Boolean)
      await api.saveSettings({
        subnet: s.subnet.trim(),
        interface: s.interface || null,
        scan_interval: Number(s.scan_interval),
        gateway_mac: s.gateway_mac?.trim() || null,
        kick_max_seconds: Number(s.kick_max_seconds),
        oui_file: s.oui_file?.trim() || null,
        whitelist_macs: whitelist,
        kick_mode: s.kick_mode,
        default_wifi_interface: s.default_wifi_interface?.trim() || undefined,
      })
      setMsg('Settings disimpan. Scan ulang sudah dijalankan.')
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal menyimpan settings')
    } finally {
      setBusy(false)
    }
  }

  async function changePw() {
    setBusy(true)
    setMsg(null)
    setErr(null)
    try {
      await api.changePassword(pw)
      setMsg('Password diubah.')
      setPw('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Gagal mengubah password')
    } finally {
      setBusy(false)
    }
  }

  if (!s) {
    return (
      <div className="card p-6 text-sm text-muted2">
        {err ?? 'Memuat settings…'}
      </div>
    )
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Settings"
        subtitle={
          <>
            <span className="mono">backend: {location.host}</span>
          </>
        }
      />

      {msg && (
        <div className="card px-4 py-3 border-[rgba(62,210,140,0.28)] bg-[rgba(62,210,140,0.07)] text-sm text-[#3ED28C] mb-4">
          {msg}
        </div>
      )}
      {err && (
        <div className="card px-4 py-3 border-[rgba(232,96,74,0.3)] bg-[rgba(232,96,74,0.07)] text-sm text-[#E8604A] mb-4">
          {err}
        </div>
      )}

      <section className="card card-hover p-5 space-y-4">
        <h2 className="card-title">Scan</h2>

        <Field label="Subnet target" hint={`Default 192.168.1.0/24 · IP lokal kamu: ${s.local_ip ?? 'tidak terdeteksi'}`}>
          <input
            className="input mono"
            value={s.subnet}
            onChange={(e) => setS({ ...s, subnet: e.target.value })}
          />
        </Field>

        <Field
          label="Interface untuk scan & kick"
          hint={`Dipakai: ${net?.chosen?.name ?? '—'} (${net?.chosen?.ip ?? 'tanpa IP'}). Kosongkan untuk auto.`}
        >
          <select
            className="input"
            value={s.interface ?? ''}
            onChange={(e) => setS({ ...s, interface: e.target.value || null })}
          >
            <option value="">Otomatis (paling aman)</option>
            {(net?.interfaces ?? []).map((i) => (
              <option key={i.guid} value={i.name}>
                {i.name}
                {i.ip ? ` — ${i.ip}` : ''}
                {i.is_virtual ? ' (virtual)' : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Interval scan (detik)" hint="Minimal 5 detik">
          <input
            className="input"
            type="number"
            min={5}
            max={3600}
            value={s.scan_interval}
            onChange={(e) => setS({ ...s, scan_interval: Number(e.target.value) })}
          />
        </Field>
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="card-title">Diagnostik kick</h2>
        {net?.is_admin === false ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200">
            <strong>Backend tidak berjalan sebagai Administrator.</strong> ARP spoof
            butuh raw socket, jadi kick tidak akan memblokir traffic apa pun sampai
            server dijalankan ulang dengan &ldquo;Run as Administrator&rdquo;.
          </div>
        ) : net?.is_admin ? (
          <div className="rounded-[12px] border border-[rgba(62,210,140,0.28)] bg-[rgba(62,210,140,0.07)] px-3 py-2.5 text-sm text-[#3ED28C]">
            Backend berjalan dengan hak Administrator — spoof bisa dikirim.
          </div>
        ) : null}

        <div className="text-sm">
          <div className="text-muted text-xs uppercase tracking-wider mb-1.5">
            Adapter yang dipakai
          </div>
          <div className="mono text-ink">
            {net?.chosen?.name ?? '—'}{' '}
            <span className="text-muted2">
              {net?.chosen?.ip ?? 'tanpa IP'} · {net?.chosen?.mac ?? '—'}
            </span>
          </div>
        </div>

        {net?.interfaces && net.interfaces.length > 0 && (
          <div>
            <div className="text-muted text-xs uppercase tracking-wider mb-1.5">
              Semua adapter
            </div>
            <ul className="space-y-1 text-xs">
              {net.interfaces.map((i) => (
                <li key={i.guid} className="flex items-center gap-2">
                  <span
                    className={`badge ${
                      i.name === net.chosen?.name
                        ? 'badge-online'
                        : i.is_virtual
                          ? 'badge-offline'
                          : 'badge-gateway'
                    }`}
                  >
                    {i.name === net.chosen?.name ? 'dipakai' : i.is_virtual ? 'virtual' : 'tersedia'}
                  </span>
                  <span className="text-ink">{i.name}</span>
                  <span className="mono text-muted2">{i.ip ?? '-'}</span>
                  {i.is_default && (
                    <span className="text-amber-400">
                      · default scapy (berisiko; diabaikan aplikasi)
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-[11px] text-[#58585F] leading-relaxed">
          Aplikasi ini selalu mengirim lewat adapter yang memegang IP lokal kamu, bukan
          default scapy — di mesin dengan VMware/VirtualBox, default scapy bisa
          menunjuk adapter virtual sehingga frame tidak pernah sampai ke LAN.
        </p>
      </section>

      <section className="card card-hover p-5 space-y-4">
        <h2 className="card-title">Kick</h2>

        <Field
          label="Metode kick"
          hint="Router = blokir MAC lewat Access Control router (default, works on iOS/Android). ARP = spoofing lama (fallback, butuh Administrator)."
        >
          <select
            className="input"
            value={s.kick_mode}
            onChange={(e) => setS({ ...s, kick_mode: e.target.value as 'router' | 'arp' })}
          >
            <option value="router">Router Access Control (disarankan)</option>
            <option value="arp">ARP spoof (fallback)</option>
          </select>
        </Field>

        <Field
          label="Interface SSID default"
          hint="Dipakai untuk rule Access Control, mis. DEV.WIFI.AP6 = SSID ke-6. Cek di router: WLAN → SSID ke-n."
        >
          <input
            className="input mono"
            placeholder="DEV.WIFI.AP6"
            value={s.default_wifi_interface}
            onChange={(e) => setS({ ...s, default_wifi_interface: e.target.value })}
          />
        </Field>

        {!s.router_configured && (
          <div className="rounded-[12px] border border-[rgba(232,96,74,0.3)] bg-[rgba(232,96,74,0.07)] px-3 py-2.5 text-sm text-[#E8604A] mb-4">
            <strong>Kredensial router tidak ditemukan.</strong>{' '}
            {s.env_file_found
              ? 'backend/.env ada tapi NETDASH_ROUTER_USER/PASS kosong di dalamnya.'
              : 'File backend/.env tidak ada — buat dengan isi NETDASH_ROUTER_USER, NETDASH_ROUTER_PASS, NETDASH_ROUTER_URL lalu restart backend.'}
          </div>
        )}

        {router && (
          <div
            className={`rounded-[12px] border px-3 py-2.5 text-sm ${
              router.reachable
                ? 'border-[rgba(62,210,140,0.28)] bg-[rgba(62,210,140,0.07)] text-[#3ED28C]'
                : 'border-[rgba(232,96,74,0.3)] bg-[rgba(232,96,74,0.07)] text-[#E8604A]'
            }`}
          >
            {router.reachable ? 'Router terhubung.' : 'Router tidak bisa dihubungi.'}{' '}
            {router.message}
            <button
              className="btn ml-2 py-0.5 text-xs"
              onClick={async () => setRouter(await api.routerStatus().catch(() => null))}
            >
              Cek lagi
            </button>
          </div>
        )}

        <Field
          label="MAC gateway"
          hint="Kick butuh MAC gateway. Kosongkan hanya jika gateway terdeteksi otomatis."
        >
          <input
            className="input mono"
            placeholder="AA:BB:CC:DD:EE:FF"
            value={s.gateway_mac ?? ''}
            onChange={(e) => setS({ ...s, gateway_mac: e.target.value })}
          />
        </Field>

        <Field label="Batas durasi kick (detik)" hint="Auto-stop sebagai pengaman">
          <input
            className="input"
            type="number"
            min={10}
            max={86400}
            value={s.kick_max_seconds}
            onChange={(e) => setS({ ...s, kick_max_seconds: Number(e.target.value) })}
          />
        </Field>

        <Field label="Whitelist MAC" hint="Satu MAC per baris. Device ini tidak akan bisa di-kick.">
          <textarea
            className="input mono"
            rows={4}
            value={whitelistText}
            onChange={(e) => setWhitelistText(e.target.value)}
          />
        </Field>
      </section>

      <section className="card card-hover p-5 space-y-4">
        <h2 className="card-title">Vendor lookup</h2>
        <Field
          label="File oui.csv opsional"
          hint="Kosongkan untuk memakai database IEEE bawaan (~40k entri, offline)."
        >
          <input
            className="input mono"
            placeholder="C:/path/oui.csv"
            value={s.oui_file ?? ''}
            onChange={(e) => setS({ ...s, oui_file: e.target.value })}
          />
        </Field>
      </section>

      <section className="card card-hover p-5 space-y-4">
        <h2 className="card-title">Akun</h2>
        <Field label={`Password untuk "${username}"`} hint="Minimal 6 karakter">
          <input
            className="input"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="••••••••"
          />
        </Field>
        <button className="btn" disabled={busy || pw.length < 6} onClick={changePw}>
          Ubah password
        </button>
      </section>

      <div className="flex gap-3">
        <button className="btn btn-primary" disabled={busy} onClick={save}>
          {busy ? 'Menyimpan…' : 'Simpan settings'}
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#58585F] mb-1.5">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted2 mt-1.5">{hint}</p>}
    </div>
  )
}