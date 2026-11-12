import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Trash2 } from 'lucide-react'

const location = globalThis.location
import { api, type IfaceReport, type NetworkProfile, type RouterStatus, type Settings } from '../api'
import { useAuth, useLive } from '../live'
import { PageHeader } from '../components/Layout'
import { LANGS, setLanguage, type Lang } from '../i18n'

export default function SettingsPage() {
  const { t, i18n } = useTranslation()
  const { username, updateProfile } = useAuth()
  const [s, setS] = useState<Settings | null>(null)
  const [displayNameDraft, setDisplayNameDraft] = useState('')
  const [usernameDraft, setUsernameDraft] = useState('')
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
      setUsernameDraft(got.username)
      setDisplayNameDraft(got.display_name ?? '')
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('settings.loadError'))
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setMsg(t('settings.saved'))
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('settings.saveError'))
    } finally {
      setBusy(false)
    }
  }

  async function saveProfile() {
    setBusy(true)
    setMsg(null)
    setErr(null)
    try {
      await updateProfile({
        username: usernameDraft.trim(),
        display_name: displayNameDraft.trim(),
      })
      setMsg(t('settings.profileSaved'))
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('settings.profileError'))
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
      setMsg(t('settings.passwordChanged'))
      setPw('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('settings.passwordError'))
    } finally {
      setBusy(false)
    }
  }

  if (!s) {
    return (
      <p className="py-6 text-sm text-muted2">{err ?? t('settings.loading')}</p>
    )
  }

  const current: Lang = i18n.language === 'en' ? 'en' : 'id'
  const langLabel: Record<Lang, string> = {
    id: t('settings.languageId'),
    en: t('settings.languageEn'),
  }

  return (
    <div>
      <PageHeader
        title={t('settings.title')}
        subtitle={
          <>
            <span className="mono">backend: {location.host}</span>
          </>
        }
      />

      {msg && <div className="notice notice-success mb-5">{msg}</div>}
      {err && <div className="notice notice-danger mb-5">{err}</div>}

      <NetworkProfilesCard onMessage={setMsg} onError={setErr} />

      <div className="mt-10 grid items-start gap-x-10 gap-y-12 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        {/* Left: operational settings changed while tuning the network. */}
        <div className="space-y-12">
          <section className="space-y-4">
            <div>
              <h2 className="card-title">{t('settings.scan')}</h2>
              <p className="card-sub mt-1">{t('settings.scanHint')}</p>
            </div>

            <Field
              label={t('settings.subnet')}
              hint={t('settings.subnetHint', {
                ip: s.local_ip ?? t('settings.localIpUnknown'),
              })}
            >
              <input
                className="input mono"
                value={s.subnet}
                onChange={(e) => setS({ ...s, subnet: e.target.value })}
              />
            </Field>

            <Field
              label={t('settings.interface')}
              hint={t('settings.interfaceHint', {
                name: net?.chosen?.name ?? '—',
                ip: net?.chosen?.ip ?? t('settings.noIp'),
              })}
            >
              <select
                className="input"
                value={s.interface ?? ''}
                onChange={(e) => setS({ ...s, interface: e.target.value || null })}
              >
                <option value="">{t('settings.interfaceAuto')}</option>
                {(net?.interfaces ?? []).map((i) => (
                  <option key={i.guid || i.name} value={i.name}>
                    {i.name}
                    {i.ip ? ` — ${i.ip}` : ''}
                    {i.is_virtual ? ' (virtual)' : ''}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={t('settings.interval')} hint={t('settings.intervalHint')}>
              <input
                className="input mono"
                type="number"
                min={5}
                max={3600}
                value={s.scan_interval}
                onChange={(e) => setS({ ...s, scan_interval: Number(e.target.value) })}
              />
            </Field>
          </section>

          <section className="space-y-4">
            <div>
              <h2 className="card-title">{t('settings.kick')}</h2>
              <p className="card-sub mt-1">{t('settings.kickHint')}</p>
            </div>

            <Field label={t('settings.kickMethod')} hint={t('settings.kickMethodHint')}>
              <select
                className="input"
                value={s.kick_mode}
                onChange={(e) =>
                  setS({ ...s, kick_mode: e.target.value as 'router' | 'arp' })
                }
              >
                <option value="router">{t('settings.kickRouter')}</option>
                <option value="arp">{t('settings.kickArp')}</option>
              </select>
            </Field>

            <Field label={t('settings.defaultSsid')} hint={t('settings.defaultSsidHint')}>
              <input
                className="input mono"
                placeholder="DEV.WIFI.AP6"
                value={s.default_wifi_interface}
                onChange={(e) => setS({ ...s, default_wifi_interface: e.target.value })}
              />
            </Field>

            {!s.router_configured && (
              <div className="notice notice-danger">
                <span>
                  <strong>{t('settings.routerCredentialsMissing')}</strong>{' '}
                  {s.env_file_found
                    ? t('settings.routerEnvEmpty')
                    : t('settings.routerEnvMissing')}
                </span>
              </div>
            )}

            {router && (
              <div className={`notice ${router.reachable ? 'notice-success' : 'notice-danger'}`}>
                <span className="min-w-0">
                  {router.reachable
                    ? t('settings.routerConnected')
                    : t('settings.routerUnreachable')}{' '}
                  {router.message}
                </span>
                <button
                  className="btn btn-sm shrink-0"
                  onClick={async () =>
                    setRouter(await api.routerStatus().catch(() => null))
                  }
                >
                  {t('settings.checkAgain')}
                </button>
              </div>
            )}

            <Field label={t('settings.gatewayMac')} hint={t('settings.gatewayMacHint')}>
              <input
                className="input mono"
                placeholder="AA:BB:CC:DD:EE:FF"
                value={s.gateway_mac ?? ''}
                onChange={(e) => setS({ ...s, gateway_mac: e.target.value })}
              />
            </Field>

            <Field label={t('settings.kickDuration')} hint={t('settings.kickDurationHint')}>
              <input
                className="input mono"
                type="number"
                min={10}
                max={86400}
                value={s.kick_max_seconds}
                onChange={(e) => setS({ ...s, kick_max_seconds: Number(e.target.value) })}
              />
            </Field>

            <Field label={t('settings.whitelist')} hint={t('settings.whitelistHint')}>
              <textarea
                className="input mono"
                rows={4}
                value={whitelistText}
                onChange={(e) => setWhitelistText(e.target.value)}
              />
            </Field>
          </section>

          <section className="space-y-4">
            <div>
              <h2 className="card-title">{t('settings.vendorLookup')}</h2>
              <p className="card-sub mt-1">{t('settings.vendorHint')}</p>
            </div>
            <Field label={t('settings.ouiFile')} hint={t('settings.ouiHint')}>
              <input
                className="input mono"
                placeholder="C:/path/oui.csv"
                value={s.oui_file ?? ''}
                onChange={(e) => setS({ ...s, oui_file: e.target.value })}
              />
            </Field>
          </section>

          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" disabled={busy} onClick={save}>
              {busy ? t('common.saving') : t('settings.save')}
            </button>
            <span className="text-[11px] text-muted2">{t('settings.saveHint')}</span>
          </div>
        </div>

        {/* Right: rarely changed account, language, and diagnostic settings. */}
        <div className="space-y-12">
          <section className="space-y-3">
            <div>
              <h2 className="card-title">{t('settings.languageSection')}</h2>
              <p className="card-sub mt-1">{t('settings.languageHint')}</p>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-muted mb-1.5">
                {t('settings.language')}
              </label>
              <div className="flex gap-1 p-1 rounded-md bg-surface border border-border w-fit">
                {LANGS.map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => setLanguage(lang)}
                    aria-pressed={current === lang}
                    className={`px-3 py-2 min-h-9 rounded-[4px] text-[12px] font-medium transition ${
                      current === lang
                        ? 'bg-bright text-bg'
                        : 'text-muted hover:text-ink hover:bg-surface2'
                    }`}
                  >
                    {langLabel[lang]}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <div>
              <h2 className="card-title">{t('settings.account')}</h2>
              <p className="card-sub mt-1">{t('settings.accountHint')}</p>
            </div>

            <Field label={t('settings.displayName')} hint={t('settings.displayNameHint')}>
              <input
                className="input"
                value={displayNameDraft}
                maxLength={48}
                onChange={(e) => setDisplayNameDraft(e.target.value)}
                placeholder={t('settings.displayNamePlaceholder')}
              />
            </Field>

            <Field label={t('settings.username')} hint={t('settings.usernameHint')}>
              <input
                className="input mono"
                value={usernameDraft}
                maxLength={32}
                autoComplete="username"
                onChange={(e) => setUsernameDraft(e.target.value)}
              />
            </Field>

            <button
              className="btn"
              disabled={busy || usernameDraft.trim().length < 3}
              onClick={saveProfile}
            >
              {t('settings.saveProfile')}
            </button>

            <div className="border-t border-border pt-4 space-y-4">
              <Field
                label={t('settings.passwordFor', { username })}
                hint={t('settings.passwordHint')}
              >
                <input
                  className="input"
                  type="password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="••••••••"
                />
              </Field>
              <button className="btn" disabled={busy || pw.length < 6} onClick={changePw}>
                {t('settings.changePassword')}
              </button>
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <h2 className="card-title">{t('settings.kickDiagnostics')}</h2>
              <p className="card-sub mt-1">{t('settings.diagnosticsHint')}</p>
            </div>
            {net?.raw_socket === false || net?.is_admin === false ? (
              <div className="notice notice-muted">
                <span className="min-w-0">
                  {t('settings.noRawSocket')}{' '}
                  <code className="mono text-ink">
                    sudo setcap cap_net_raw+ep &quot;$(readlink -f .venv/bin/python)&quot;
                  </code>
                  {net?.raw_socket_error ? (
                    <span className="mono mt-1.5 block text-xs text-muted2">
                      {net.raw_socket_error}
                    </span>
                  ) : null}
                </span>
              </div>
            ) : net?.is_admin ? (
              <div className="notice notice-success">{t('settings.rawSocketOk')}</div>
            ) : null}

            <div className="text-sm">
              <div className="text-muted text-xs mb-1.5">{t('settings.adapterUsed')}</div>
              <div className="mono text-ink">
                {net?.chosen?.name ?? '—'}{' '}
                <span className="text-muted2">
                  {net?.chosen?.ip ?? t('settings.noIp')} · {net?.chosen?.mac ?? '—'}
                </span>
              </div>
            </div>

            {net?.interfaces && net.interfaces.length > 0 && (
              <div>
                <div className="text-muted text-xs mb-1.5">
                  {t('settings.allAdapters')}
                </div>
                <ul className="space-y-1 text-xs">
                  {net.interfaces.map((i) => (
                    <li key={i.guid || i.name} className="flex flex-wrap items-center gap-2">
                      <span
                        className={`badge ${
                          i.name === net.chosen?.name
                            ? 'badge-online'
                            : i.is_virtual
                              ? 'badge-offline'
                              : 'badge-gateway'
                        }`}
                      >
                        {i.name === net.chosen?.name
                          ? t('settings.adapterUsedBadge')
                          : i.is_virtual
                            ? t('settings.adapterVirtual')
                            : t('settings.adapterAvailable')}
                      </span>
                      <span className="text-ink">{i.name}</span>
                      <span className="mono text-muted2">{i.ip ?? '-'}</span>
                      {i.is_default && (
                        <span className="text-muted">{t('settings.defaultScapy')}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-[11px] text-muted2 leading-relaxed">
              {t('settings.adapterNote')}
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}

/**
 * Network profiles: rename, browse, and reset.
 *
 * "Lihat" only changes which data is displayed. The green dot marks the
 * profile the laptop is physically on, because kick/scan are bound to it.
 */
function NetworkProfilesCard({
  onMessage,
  onError,
}: {
  onMessage: (message: string) => void
  onError: (message: string) => void
}) {
  const { t } = useTranslation()
  const {
    profiles,
    activeProfile,
    activeProfileId,
    viewProfileId,
    isViewingActive,
    setViewProfile,
    reloadProfiles,
  } = useLive()
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetText, setResetText] = useState('')
  const [dialogErr, setDialogErr] = useState('')

  useEffect(() => {
    void reloadProfiles()
  }, [reloadProfiles])

  function startEdit(p: NetworkProfile) {
    setEditingId(p.id)
    setDraft(p.name)
    setDialogErr('')
  }

  async function saveName(id: number) {
    const name = draft.trim()
    if (!name) return
    setBusy(true)
    onError('')
    try {
      await api.renameProfile(id, name)
      setEditingId(null)
      await reloadProfiles()
      onMessage(t('settings.profileRenamed'))
    } catch (e) {
      onError(e instanceof Error ? e.message : t('settings.profileRenameError'))
    } finally {
      setBusy(false)
    }
  }

  function openReset() {
    setResetText('')
    setDialogErr('')
    setResetOpen(true)
  }

  async function doReset() {
    if (!activeProfile) return
    if (resetText !== activeProfile.name) {
      setDialogErr(
        t('settings.resetNameMismatch', { name: activeProfile.name }),
      )
      return
    }
    setBusy(true)
    setDialogErr('')
    try {
      await api.resetProfile(activeProfile.id, resetText)
      setResetOpen(false)
      setResetText('')
      setViewProfile(null)
      await reloadProfiles()
      onMessage(t('settings.resetDone', { name: activeProfile.name }))
    } catch (e) {
      setDialogErr(e instanceof Error ? e.message : t('settings.resetError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="card-title">{t('settings.networkProfiles')}</h2>
        <p className="card-sub mt-1">{t('settings.networkProfilesHint')}</p>
      </div>

      {profiles.length === 0 ? (
        <p className="text-[12px] text-muted2">{t('settings.profilesEmpty')}</p>
      ) : (
        <ul className="rounded-md border border-border divide-y divide-border overflow-hidden">
          {profiles.map((p) => {
            const selected =
              p.id === (isViewingActive ? activeProfileId : viewProfileId ?? activeProfileId)
            return (
              <li key={p.id} className="px-4 py-3">
                {editingId === p.id ? (
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void saveName(p.id)
                    }}
                  >
                    <input
                      className="input flex-1 min-w-[160px]"
                      value={draft}
                      maxLength={48}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="btn btn-primary btn-sm"
                      disabled={busy || !draft.trim()}
                    >
                      {busy ? t('common.saving') : t('common.save')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => setEditingId(null)}
                    >
                      {t('common.cancel')}
                    </button>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        background: p.active
                          ? 'var(--color-green)'
                          : 'var(--color-muted2)',
                      }}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] text-ink truncate">{p.name}</span>
                        <span
                          className={`badge ${p.active ? 'badge-online' : 'badge-offline'}`}
                        >
                          {p.active ? t('profiles.active') : t('profiles.history')}
                        </span>
                        {selected && (
                          <span className="badge badge-accent">
                            {t('profiles.shown')}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted2 truncate">
                        {t('settings.profileMeta', {
                          online: p.online_count,
                          total: p.device_count,
                        })}
                        {p.ssid ? ` · ${p.ssid}` : ''}
                        {p.subnet ? ` · ${p.subnet}` : ''}
                      </div>
                    </div>
                    <div className="ml-auto flex items-center gap-1.5">
                      {/* The active row needs no "view" action while it is
                          already the one on screen; only offer it as a way
                          back when a historical profile is being browsed. */}
                      {(!p.active || !isViewingActive) && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setViewProfile(p.active ? null : p.id)}
                        >
                          {p.active ? t('profiles.backToActive') : t('profiles.view')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => startEdit(p)}
                      >
                        <Pencil size={13} />
                        {t('profiles.rename')}
                      </button>
                      {p.active && (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger-quiet"
                          onClick={openReset}
                        >
                          <Trash2 size={13} />
                          {t('settings.resetNetwork')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <p className="text-[11px] text-muted2 leading-relaxed">
        {t('settings.resetOnlyActive')}
      </p>

      {resetOpen && activeProfile && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center px-4 glass-scrim"
          role="dialog"
          aria-modal="true"
          aria-label={t('settings.resetTitle')}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setResetOpen(false)
          }}
        >
          <div className="glass-panel w-full max-w-md rounded-lg p-5">
            <h2 className="card-title">
              {t('settings.resetTitleWithName', { name: activeProfile.name })}
            </h2>
            <p className="card-sub mt-1 mb-3">{t('settings.resetBody')}</p>
            <div className="rounded-md border border-red/40 bg-surface2 px-3 py-2.5 mb-3">
              <p className="text-[12px] text-red leading-relaxed">
                {t('settings.resetWarning')}
              </p>
            </div>
            <label className="block text-[11px] font-medium text-muted mb-1.5">
              {t('settings.resetConfirmLabel', { name: activeProfile.name })}
            </label>
            <input
              className="input mb-1"
              value={resetText}
              disabled={busy}
              autoFocus
              onChange={(e) => setResetText(e.target.value)}
              placeholder={activeProfile.name}
            />
            <p className="text-[11px] text-muted2 mb-3">
              {t('settings.resetConfirmHint', { name: activeProfile.name })}
            </p>
            {dialogErr && (
              <p className="text-[12px] text-red mb-3">{dialogErr}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setResetOpen(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || resetText !== activeProfile.name}
                onClick={doReset}
              >
                {busy ? t('common.saving') : t('settings.resetButton')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
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
      <label className="block text-[11px] font-medium text-muted mb-1.5">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted2 mt-1.5">{hint}</p>}
    </div>
  )
}
