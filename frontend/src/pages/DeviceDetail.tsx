import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
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
  typeLabel,
  osConfidenceLabel,
  typeConfidenceLabel,
  currentLocale,
  fmtRate,
  displayName,
  fmtAge,
  fmtDuration,
  fmtTime,
  osLabel,
  type Device,
  type DeviceEvent,
  type KickLog,
  type KickReport,
} from '../api'
import { elapsedOf, useClock, useLive } from '../live'
import { BackLink } from '../components/Layout'
import {
  BRAND_CATALOG,
  DeviceChip,
  DeviceTypeChip,
  brandBySlug,
  brandMatchFor,
  type BrandEntry,
} from '../components/icons'
import { DeleteLogButton, LogDeleteDialog } from '../components/LogDelete'

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

type LogDialogState = { scope: 'device_events' | 'kick_logs'; mac: string } | null

export default function DeviceDetail() {
  const { mac = '' } = useParams()
  const nav = useNavigate()
  const { t } = useTranslation()
  const {
    devices,
    isViewingActive,
    viewProfileId,
  } = useLive()
  const profileParam = isViewingActive ? null : viewProfileId
  const [device, setDevice] = useState<Device | null>(null)
  const [events, setEvents] = useState<DeviceEvent[]>([])
  const [kickLog, setKickLog] = useState<KickLog[]>([])
  const [nickname, setNickname] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [ifaceMap, setIfaceMap] = useState<Record<string, string>>({})
  const [report, setReport] = useState<KickReport | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [brandQ, setBrandQ] = useState('')
  const [logDialog, setLogDialog] = useState<LogDialogState>(null)

  // Use the live row so the kicked badge and its countdown come from the
  // merged/ticked view state rather than the one-shot REST payload. A
  // historical profile has no live row by definition.
  const live = isViewingActive ? devices.find((d) => d.mac === mac) ?? null : null
  const liveKicked = live?.kicked ?? null

  async function load() {
    try {
      const st = await api.settings().catch(() => null)
      if (st) setIfaceMap(st.wifi_interface_map ?? {})
      const res = await api.device(mac, profileParam)
      setDevice(res.device)
      setEvents(res.events)
      setKickLog(res.kicks)
      setNickname(res.device.nickname)
      // A failed attempt against the wrong profile (e.g. before the user
      // switched to the historical network) must not leave a stale banner
      // once the retry succeeds.
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('deviceDetail.loadError'))
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mac, profileParam])

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
      const d = await api.rename(mac, nickname, profileParam)
      setDevice((prev) => (prev ? { ...prev, ...d } : d))
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('deviceDetail.saveError'))
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
      setErr(e instanceof Error ? e.message : t('deviceDetail.ifaceSaveError'))
    } finally {
      setBusy(false)
    }
  }

  async function saveType(next: string) {
    setBusy(true)
    setErr(null)
    try {
      const d = await api.setType(mac, next, profileParam)
      setDevice((prev) => (prev ? { ...prev, ...d } : d))
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('deviceDetail.typeSaveError'))
    } finally {
      setBusy(false)
    }
  }

  async function saveBrand(next: string) {
    setBusy(true)
    setErr(null)
    try {
      const d = await api.setBrand(mac, next, profileParam)
      setDevice((prev) => (prev ? { ...prev, ...d } : d))
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('deviceDetail.brandSaveError'))
    } finally {
      setBusy(false)
    }
  }

  async function doKick() {
    if (!isViewingActive) {
      setErr(t('profiles.kickInactive'))
      return
    }
    setBusy(true)
    setErr(null)
    setReport(null)
    try {
      const res = await api.kick(mac, reason, undefined, profileParam)
      setReport(res)
      // Say plainly when only one half worked - a silent partial success is
      // the failure mode that got the user here in the first place.
      if (!res.router_blocked || !res.arp_active) {
        const missing = []
        if (!res.router_blocked) missing.push(t('deviceDetail.kickRouterFailed'))
        if (!res.arp_active) missing.push(t('deviceDetail.kickArpFailed'))
        setErr(
          t('deviceDetail.kickPartial', {
            missing: missing.join(', '),
            router: res.router_error
              ? t('deviceDetail.kickRouterPrefix', { error: res.router_error })
              : '',
            arp: res.arp_error ? t('deviceDetail.kickArpPrefix', { error: res.arp_error }) : '',
          }),
        )
      }
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('deviceDetail.kickError'))
    } finally {
      setBusy(false)
    }
  }

  async function doUnkick() {
    if (!isViewingActive) {
      setErr(t('profiles.kickInactive'))
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const res = await api.unkick(mac, profileParam)
      if (!res.rule_deleted) {
        setErr(t('deviceDetail.unkickRuleMissing'))
      }
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('deviceDetail.unkickError'))
    } finally {
      setBusy(false)
    }
  }

  async function doDelete() {
    setDeleting(true)
    setErr(null)
    try {
      await api.deleteDevice(mac, profileParam)
      nav('/devices', { replace: true })
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('deviceDetail.deleteError'))
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  // Uptime history derived from the existing connect/disconnect events. The
  // backend stores transitions, not samples, so the series is built by holding
  // each state until the next transition - no new backend endpoint needed.
  const uptimeSeries = useMemo(() => buildUptimeSeries(events), [events])

  if (!device) {
    return (
      <div className="max-w-md">
        {err ? (
          <div className="notice notice-danger">{err}</div>
        ) : (
          <p className="text-muted text-sm py-6">{t('deviceDetail.loading')}</p>
        )}
        <BackLink to="/devices" label={t('deviceDetail.back')} className="mt-4" />
      </div>
    )
  }

  const isKicked = liveKicked != null
  // Past the `if (!device)` guard above, this is non-null; prefer the live row.
  const shown = live ?? device

  const detectedBrand = brandMatchFor(shown.vendor, shown.hostname)
  const overrideBrand = brandBySlug(shown.brand_override)
  const currentBrand = overrideBrand ?? detectedBrand

  const brandNeedle = brandQ.trim().toLowerCase()
  const brandHits = brandNeedle
    ? BRAND_CATALOG.filter(
        (b) =>
          b.title.toLowerCase().includes(brandNeedle) ||
          b.slug.includes(brandNeedle),
      )
    : BRAND_CATALOG

  // Per-AP outcome of the last kick. interfaces_blocked is ordered against
  // interfaces_targeted, so anything missing from the first list failed.
  const targeted = report?.interfaces_targeted ?? []
  const blocked = report?.interfaces_blocked ?? []
  const failed = report?.interfaces_failed ?? []

  function onLogsDeleted(total: number) {
    setMsg(total ? t('logs.deleted', { n: total }) : t('logs.nothing'))
    void load()
  }

  return (
    <div>
      {/* ------------------------------------------------------------ header */}
      <div className="mb-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <BackLink to="/devices" label={t('deviceDetail.back')} />
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {isKicked ? (
              <KickedPill started={liveKicked} />
            ) : shown.online ? (
              <span className="badge badge-online badge-pulse">{t('status.online')}</span>
            ) : (
              <span className="badge badge-offline">{t('status.offline')}</span>
            )}
            {shown.is_self && <span className="badge badge-accent">{t('devices.self')}</span>}
            {shown.is_gateway && <span className="badge badge-gateway">{t('devices.gateway')}</span>}
          </div>
        </div>
        <div className="flex items-start gap-3">
          <DeviceChip
            type={shown.device_type}
            vendor={shown.vendor}
            hostname={shown.hostname}
            brandOverride={shown.brand_override}
          />
          <div className="min-w-0">
            <h1 className="section-title truncate">{displayName(shown)}</h1>
            <div className="mono text-muted2">{shown.mac}</div>
          </div>
        </div>
      </div>

      {msg && <div className="notice notice-success mb-4">{msg}</div>}
      {err && <div className="notice notice-danger mb-4">{err}</div>}

      {report && (report.router_blocked || report.arp_active) && (
        <section className="mb-8 border-t border-border pt-6">
          <div className="card-title mb-4">{t('deviceDetail.kickResult')}</div>
          <div className="grid gap-5 sm:grid-cols-2">
            <ResultHalf
              ok={report.router_blocked}
              title={t('deviceDetail.routerBlock')}
              detail={
                report.router_blocked
                  ? t('deviceDetail.accessActive', {
                      rules: report.router_inst_ids?.length
                        ? t('deviceDetail.rulesSuffix', {
                            n: report.router_inst_ids.length,
                            ids: report.router_inst_ids.join(', '),
                          })
                        : '',
                    })
                  : report.router_error || t('deviceDetail.failed')
              }
            />
            <ResultHalf
              ok={report.arp_active}
              title={t('deviceDetail.arpSpoof')}
              detail={
                report.arp_active
                  ? t('deviceDetail.instantDrop', { seconds: report.arp_seconds })
                  : report.arp_error || t('deviceDetail.failed')
              }
            />
          </div>

          {/* One line per AP. A roaming device needs a rule on every AP it has
              ever used, so a single-interface summary would be misleading. */}
          {targeted.length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] font-medium text-muted mb-1.5">
                {t('deviceDetail.blockedSsids', {
                  blocked: blocked.length,
                  targeted: targeted.length,
                })}
              </div>
              <ul className="space-y-1">
                {targeted.map((iface) => {
                  const ok = blocked.includes(iface)
                  return (
                    <li key={iface} className="flex items-center gap-2 text-[12px]">
                      <span className={`badge ${ok ? 'badge-online' : 'badge-kicked'}`}>
                        {ok ? t('status.blocked') : t('status.failed')}
                      </span>
                      <code className="mono text-muted">{iface}</code>
                      <span className="text-[11px] text-muted2">
                        {ssidLabelFor(iface)}
                      </span>
                    </li>
                  )
                })}
              </ul>
              {failed.length > 0 && (
                <p className="text-[11px] text-muted mt-2 leading-relaxed">
                  {failed.join(' · ')}
                </p>
              )}
              {/* Roaming warning: history says this device uses more APs than
                  we managed to block, so it can still rejoin on one of them. */}
              {targeted.length > blocked.length && (
                <p className="text-[11px] text-muted mt-2 leading-relaxed">
                  {t('deviceDetail.roamWarning', {
                    targeted: targeted.length,
                    blocked: blocked.length,
                  })}
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {/* ------------------------------------------------------- 3 columns */}
      <div className="grid gap-8 md:grid-cols-3 lg:gap-10 mb-10">
        <section>
          <h2 className="card-title mb-4">{t('deviceDetail.info')}</h2>
          <dl className="space-y-3 text-[13px]">
            <Row k={t('deviceDetail.ip')} v={device.ip || '-'} mono />
            <Row k={t('deviceDetail.hostname')} v={device.hostname || '-'} />
            <Row k={t('deviceDetail.vendor')} v={device.vendor || t('deviceDetail.vendorUnknown')} />
            <Row k={t('deviceDetail.type')} v={typeLabel(device.device_type)} />
            <Row
              k={t('typeConfidence.label')}
              v={typeConfidenceLabel(device.type_confidence)}
            />
            <Row
              k={t('deviceDetail.os')}
              v={
                device.os_guess
                  ? `${osLabel(device)} · ${osConfidenceLabel(device.os_confidence)}`
                  : t('deviceDetail.osUnknown')
              }
            />
            {device.os_evidence && <Row k={t('deviceDetail.osEvidence')} v={device.os_evidence} />}
            <div className="border-t border-border/70 pt-3">
              <Row k={t('deviceDetail.firstSeen')} v={fmtTime(device.first_seen)} mono />
            </div>
            <Row k={t('deviceDetail.lastSeen')} v={fmtAge(device.last_seen)} mono />
            <Row k={t('deviceDetail.lastOnline')} v={fmtTime(device.last_online)} mono />
          </dl>
        </section>

        <section>
          <h2 className="card-title mb-3">{t('deviceDetail.identity')}</h2>
          <div className="flex gap-2">
            <input
              className="input"
              placeholder={t('deviceDetail.nicknamePlaceholder')}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
            <button className="btn btn-primary shrink-0" disabled={busy} onClick={saveNickname}>
              {t('common.save')}
            </button>
          </div>

          <label className="block text-[11px] font-medium text-muted mt-4 mb-1.5">
            {t('deviceDetail.typeLabel')}
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
              {t('deviceDetail.typeAuto', { type: typeLabel(shown.guessed_type) })}
            </option>
            {DEVICE_TYPES.map((type) => (
              <option key={type} value={type}>
                {typeLabel(type)}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted2 mt-1.5">
            {shown.type_override
              ? t('deviceDetail.typeManualHint', { type: typeLabel(shown.guessed_type) })
              : t('deviceDetail.typeAutoHint')}
          </p>

          {/* Brand override. A search box plus a scrollable list, because the
              simple-icons catalog has dozens of marks and a plain <select>
              would be unusable. */}
          <label className="block text-[11px] font-medium text-muted mt-4 mb-1.5">
            {t('deviceDetail.brand')}
          </label>
          <div className="flex items-center gap-2 mb-2">
            <DeviceChip
              type={shown.device_type}
              vendor={shown.vendor}
              hostname={shown.hostname}
              brandOverride={shown.brand_override}
              size={26}
            />
            <span className="text-[11px] text-muted2 min-w-0 truncate">
              {shown.brand_override
                ? t('deviceDetail.brandOverrideActive')
                : currentBrand
                  ? t('deviceDetail.brandDetected', { brand: currentBrand.title })
                  : t('deviceDetail.brandNone')}
            </span>
          </div>
          <input
            className="input mb-2"
            placeholder={t('deviceDetail.brandSearchPlaceholder')}
            value={brandQ}
            onChange={(e) => setBrandQ(e.target.value)}
          />
          <div className="max-h-44 overflow-y-auto rounded-md border border-border">
            <BrandOption
              active={!shown.brand_override}
              label={t('deviceDetail.brandAuto')}
              onClick={() => saveBrand('')}
              disabled={busy}
              auto
              type={shown.device_type}
            />
            {brandHits.map((brand) => (
              <BrandOption
                key={brand.slug}
                active={shown.brand_override === brand.slug}
                label={brand.title}
                brand={brand}
                onClick={() => saveBrand(brand.slug)}
                disabled={busy}
              />
            ))}
            {brandHits.length === 0 && (
              <p className="px-3 py-2 text-[12px] text-muted2">
                {t('deviceDetail.brandNoMatch')}
              </p>
            )}
          </div>
          <p className="text-[11px] text-muted2 mt-1.5">
            {t('deviceDetail.brandHint')}
          </p>

          {shown.os_guess && shown.os_confidence !== 'high' && (
            <p className="text-[11px] text-muted2 mt-1.5">
              {t('deviceDetail.osWeak', {
                os: shown.os_guess,
                weak:
                  shown.os_confidence === 'low' ? t('deviceDetail.weakSuffix') : '',
              })}
            </p>
          )}

          {shown.randomized_mac && (
            <p className="text-[11px] text-muted2 mt-1.5">
              {t('deviceDetail.randomMac')}
            </p>
          )}

          {!shown.type_confident && (
            <div className="notice notice-muted mt-3">
              <span className="text-[11px] leading-relaxed">
                <strong>{t('deviceDetail.typeUnknownTitle')}</strong>{' '}
                {t('deviceDetail.typeUnknown')}
              </span>
            </div>
          )}

          <div className="border-t border-border/70 mt-5 pt-5">
            <h2 className="card-title mb-3">{t('deviceDetail.kickTitle')}</h2>
            {!isViewingActive && (
              <div className="notice notice-muted mb-3 text-[11.5px]">
                {t('profiles.kickInactive')}
              </div>
            )}
            <input
              className="input mb-3"
              placeholder={t('deviceDetail.kickReason')}
              value={reason}
              disabled={!isViewingActive}
              onChange={(e) => setReason(e.target.value)}
            />
            {isKicked ? (
              <button
                className="btn btn-danger w-full"
                disabled={busy || !isViewingActive}
                onClick={doUnkick}
              >
                {t('deviceDetail.stopKick')}
              </button>
            ) : (
              <button
                className="btn btn-danger w-full"
                disabled={busy || !isViewingActive}
                onClick={doKick}
              >
                {t('deviceDetail.startKick')}
              </button>
            )}
            <div className="text-[11px] text-muted2 mt-3 leading-relaxed">
              {t('deviceDetail.kickHelp')}
              <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="text-muted2">{t('deviceDetail.ssid')}</span>
                {/* The interface comes from the router's WLAN client table, so
                    it is the AP the device is really on - not a default. */}
                <code className="mono text-muted">
                  {shown.ssid_name || (shown.wifi_interface || '-')}
                </code>
                {shown.wifi_interface && (
                  <span className="mono text-muted2">({shown.wifi_interface})</span>
                )}
                {report?.interface_source === 'auto' && (
                  <span className="badge badge-online">{t('deviceDetail.detectedAuto')}</span>
                )}
                {report?.interface_source === 'manual' && (
                  <span className="badge badge-warn">{t('deviceDetail.setManual')}</span>
                )}
                {report?.interface_source === 'fallback' && (
                  <span className="badge badge-warn">{t('deviceDetail.default')}</span>
                )}
              </div>
              {report?.interface_source === 'fallback' && (
                <div className="text-muted mt-1">
                  {t('deviceDetail.fallbackWarning')}
                </div>
              )}

              {/* Manual AP override. Auto-detection normally gets this right;
                  this is for when the router reports the wrong AP (or none). */}
              <label className="block text-[11px] font-medium text-muted mt-3 mb-1.5">
                {t('deviceDetail.apForBlock')}
              </label>
              <select
                className="input"
                value={ifaceMap[mac.toUpperCase()] ?? ''}
                disabled={busy}
                onChange={(e) => saveInterface(e.target.value)}
              >
                <option value="">
                  {t('deviceDetail.apAuto', {
                    value:
                      shown.wifi_interface ||
                      shown.ssid_name ||
                      t('deviceDetail.vendorUnknown'),
                  })}
                </option>
                {IFACE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                    {o.value === shown.wifi_interface ? t('deviceDetail.apDetected') : ''}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted2 mt-1.5">
                {t('deviceDetail.apHint')}
              </p>
              {device.is_gateway && (
                <div className="text-muted2 mt-1">{t('deviceDetail.gatewayNoKick')}</div>
              )}
            </div>
          </div>
        </section>

        <div className="space-y-10">
          <section>
            <h2 className="card-title">{t('deviceDetail.connectionRate')}</h2>
            <p className="card-sub mt-0.5 mb-4">{t('deviceDetail.reportedByRouter')}</p>

            <dl className="space-y-3 text-[13px]">
              <Row k={t('deviceDetail.band')} v={shown.link_band || '-'} />
              <Row k={t('deviceDetail.rx')} v={fmtRate(shown.rx_rate_bps)} mono />
              <Row k={t('deviceDetail.tx')} v={fmtRate(shown.tx_rate_bps)} mono />
            </dl>

            {/* Honest limitation rather than a fabricated GB figure. */}
            <div className="notice notice-muted mt-4">
              <span className="text-[11px] leading-relaxed">
                {t('deviceDetail.dataUnavailable')}
              </span>
            </div>
          </section>

          <section>
          <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
            <h2 className="card-title">{t('deviceDetail.kickHistory')}</h2>
            {kickLog.length > 0 && (
              <button
                className="btn btn-sm btn-danger-quiet"
                onClick={() => setLogDialog({ scope: 'kick_logs', mac: shown.mac })}
              >
                <Trash2 size={13} />
                {t('logs.deleteAllKicks')}
              </button>
            )}
          </div>
          {kickLog.length === 0 ? (
            <p className="text-xs text-muted">{t('deviceDetail.neverKicked')}</p>
          ) : (
            <ul className="space-y-3 text-xs max-h-64 overflow-y-auto pr-1">
              {kickLog.map((k) => (
                <li
                  key={k.id}
                  className="border-l border-border pl-3 hover:border-border-strong transition"
                >
                  <div className="flex items-center gap-2">
                    {k.active && (
                      <span className="badge badge-kicked">{t('status.active')}</span>
                    )}
                    <span className="mono text-[11px] text-muted">{fmtTime(k.at)}</span>
                    <DeleteLogButton
                      scope="kick_logs"
                      id={k.id}
                      className="ml-auto"
                      onDeleted={(r) => onLogsDeleted(r.total)}
                      onError={(m) => setErr(m)}
                    />
                  </div>
                  <div className="text-muted2 mt-0.5">
                    {t('deviceDetail.by', {
                      actor: k.actor || '-',
                      state: k.active
                        ? t('deviceDetail.running')
                        : k.duration != null
                          ? fmtDuration(k.duration)
                          : t('status.finished'),
                    })}
                  </div>
                  {k.reason && <div className="text-muted mt-0.5">{k.reason}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>
        </div>
      </div>

      {/* ------------------------------------------------- uptime + history */}
      <div className="grid gap-10 lg:grid-cols-2">
        <section className="min-w-0">
          <h2 className="card-title">{t('deviceDetail.availability')}</h2>
          <p className="card-sub mt-0.5 mb-4">
            {t('deviceDetail.connectionHistorySub')}
          </p>
          {uptimeSeries.length > 1 ? (
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={uptimeSeries}
                  margin={{ top: 8, right: 10, bottom: 0, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="at"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={44}
                    tickFormatter={(v: string) =>
                      new Date(v).toLocaleString(currentLocale(), {
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
                    /* A little padding keeps a flat offline run visibly above
                       the axis instead of looking like an empty chart. */
                    domain={[-0.08, 1.08]}
                    ticks={[0, 1]}
                    tickFormatter={(v) => (v ? t('status.online') : t('status.offline'))}
                    width={54}
                  />
                  <Tooltip
                    cursor={{ stroke: 'rgba(255,255,255,0.14)', strokeWidth: 1 }}
                    labelFormatter={(v) => fmtTime(String(v))}
                    formatter={() => []}
                    contentStyle={{
                      background: '#0A0A0A',
                      border: '1px solid #2E2E2E',
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  />
                  {/* stepAfter: each transition holds until the next one, which
                      is exactly how the backend records it. */}
                  <Area
                    type="stepAfter"
                    dataKey="online"
                    stroke="#22C55E"
                    strokeWidth={2}
                    fill="#22C55E"
                    fillOpacity={0.08}
                    dot={{ r: 2.5, fill: '#22C55E', strokeWidth: 0 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-xs text-muted py-8 text-center">
              {t('deviceDetail.notEnoughHistory')}
            </p>
          )}
        </section>

        <section className="min-w-0">
          <div className="pb-4 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="card-title">{t('deviceDetail.connectionHistory')}</h2>
              <p className="card-sub mt-0.5">
                {events.length
                  ? t('deviceDetail.transitions', { n: events.length })
                  : t('deviceDetail.noHistory')}
              </p>
            </div>
            {events.length > 0 && (
              <button
                className="btn btn-sm btn-danger-quiet"
                onClick={() => setLogDialog({ scope: 'device_events', mac: shown.mac })}
              >
                <Trash2 size={13} />
                {t('logs.deleteAllDevice')}
              </button>
            )}
          </div>
          <div className="max-h-56 overflow-y-auto overflow-x-auto border-t border-border">
            <table className="net min-w-[320px]">
              <thead>
                <tr>
                  <th>{t('deviceDetail.time')}</th>
                  <th>{t('deviceDetail.status')}</th>
                  <th className="hidden sm:table-cell">{t('deviceDetail.ipShort')}</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-center text-muted py-8">
                      {t('deviceDetail.noHistory')}
                    </td>
                  </tr>
                )}
                {events.map((e) => (
                  <tr key={e.id ?? `${e.at}-${e.ip}`}>
                    <td className="mono text-[11px] text-muted whitespace-nowrap">{fmtTime(e.at)}</td>
                    <td>
                      <span
                        className={`badge ${e.kind === 'online' ? 'badge-online' : 'badge-offline'}`}
                      >
                        {e.kind === 'online' ? t('status.online') : t('status.offline')}
                      </span>
                    </td>
                    <td className="hidden mono text-muted sm:table-cell">{e.ip}</td>
                    <td>
                      {e.id != null && (
                        <DeleteLogButton
                          scope="device_events"
                          id={e.id}
                          onDeleted={(r) => onLogsDeleted(r.total)}
                          onError={(m) => setErr(m)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* ------------------------------------------------------ delete device */}
      <section className="mt-12 border-t border-border pt-8">
        <h2 className="card-title">{t('deviceDetail.deleteTitle')}</h2>
        <p className="card-sub mt-1 max-w-2xl leading-relaxed">
          {t('deviceDetail.deleteBody')}
        </p>

        {shown.is_self ? (
          <p className="text-[12px] text-muted mt-3">
            {t('deviceDetail.deleteSelf')}
          </p>
        ) : shown.is_gateway ? (
          <p className="text-[12px] text-muted mt-3">
            {t('deviceDetail.deleteGateway')}
          </p>
        ) : isKicked ? (
          <p className="text-[12px] text-muted mt-3">
            {t('deviceDetail.deleteKicked')}
          </p>
        ) : !confirmDelete ? (
          <button
            className="btn btn-danger mt-3"
            disabled={deleting || busy}
            onClick={() => setConfirmDelete(true)}
          >
            {t('deviceDetail.deleteButton')}
          </button>
        ) : (
          <div className="notice notice-danger mt-4">
            <div className="min-w-0">
              <p className="text-[13px] text-ink">
                {t('deviceDetail.deleteConfirm', {
                  name: displayName(shown),
                  mac: shown.mac,
                })}
              </p>
              <p className="text-[11px] text-muted mt-1">
                {t('deviceDetail.deletePermanent')}
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <button
                  className="btn btn-danger"
                  disabled={deleting}
                  onClick={doDelete}
                >
                  {deleting ? t('common.deleting') : t('deviceDetail.deleteYes')}
                </button>
                <button
                  className="btn"
                  disabled={deleting}
                  onClick={() => setConfirmDelete(false)}
                >
                  {t('deviceDetail.deleteNo')}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <LogDeleteDialog
        open={logDialog !== null}
        initialScope={logDialog?.scope ?? 'all'}
        initialMac={logDialog?.mac ?? ''}
        devices={device ? [device] : devices}
        profile={profileParam}
        onClose={() => setLogDialog(null)}
        onDeleted={(r) => onLogsDeleted(r.total)}
        onError={(m) => setErr(m)}
      />
    </div>
  )
}

/** Countdown pill for the page header; ticks only while a kick is running. */
function KickedPill({ started }: { started: number }) {
  const { t } = useTranslation()
  useClock()
  return (
    <span className="badge badge-kicked badge-pulse mono">
      {t('devices.kickedFor', { duration: fmtDuration(elapsedOf(started)) })}
    </span>
  )
}

/** One line of the kick result; a state rule in the margin, not a card. */
function ResultHalf({
  ok,
  title,
  detail,
}: {
  ok: boolean
  title: string
  detail: string
}) {
  const { t } = useTranslation()
  return (
    <div
      className="border-l-2 pl-3 py-0.5"
      style={{
        borderColor: ok ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.55)',
      }}
    >
      <div className="flex items-center gap-2">
        <span className={`badge ${ok ? 'badge-online' : 'badge-kicked'}`}>
          {ok ? t('status.ok') : t('status.failed')}
        </span>
        <span className="text-[13px] text-ink font-medium">{title}</span>
      </div>
      <div className="text-[11px] text-muted mt-1 break-words">{detail}</div>
    </div>
  )
}

/** One row in the brand picker: automatic option, or a simple-icons mark. */
function BrandOption({
  active,
  label,
  brand,
  type,
  auto = false,
  disabled = false,
  onClick,
}: {
  active: boolean
  label: string
  brand?: BrandEntry
  type?: string
  auto?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition ${
        active
          ? 'bg-surface2 text-ink'
          : 'text-muted hover:text-ink hover:bg-surface2'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span className="w-4 h-4 inline-flex items-center justify-center shrink-0">
        {brand ? (
          <svg
            viewBox="0 0 24 24"
            width={14}
            height={14}
            fill="currentColor"
            aria-hidden="true"
          >
            <path d={brand.icon.path} />
          </svg>
        ) : auto ? (
          <DeviceTypeChip type={type ?? 'other'} size={16} />
        ) : null}
      </span>
      <span className="min-w-0 truncate">{label}</span>
      {active && <span className="ml-auto text-[10px] text-muted2">✓</span>}
    </button>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted2 shrink-0">{k}</dt>
      <dd className={`text-right text-muted ${mono ? 'mono' : ''}`}>{v}</dd>
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
  // The first transition already defines the starting state, so seed the
  // series from it rather than duplicating the same timestamp. A duplicate
  // point put two identical labels on the time axis.
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
