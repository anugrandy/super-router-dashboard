import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../live'
import { UiMark } from '../components/icons'
import { LANGS, setLanguage, type Lang } from '../i18n'

export default function Login() {
  const { t, i18n } = useTranslation()
  const { login, username } = useAuth()
  const nav = useNavigate()
  const [user, setUser] = useState('admin')
  const [pass, setPass] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (username) nav('/dashboard', { replace: true })
  }, [username, nav])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      await login(user, pass)
      nav('/dashboard', { replace: true })
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('login.error'))
    } finally {
      setBusy(false)
    }
  }

  const current: Lang = i18n.language === 'en' ? 'en' : 'id'

  return (
    <div className="min-h-dvh flex items-center justify-center px-4 py-10">
      <form onSubmit={submit} className="card w-full max-w-sm p-5">
        <div className="flex items-center gap-2.5 mb-1">
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border bg-surface2 text-bright">
            <UiMark size={19} />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-bright">
            {t('app.name')}
          </h1>
        </div>
        <p className="text-sm text-muted mt-1 mb-6">{t('login.subtitle')}</p>

        <label className="stat-label block mb-1.5">{t('login.username')}</label>
        <input
          className="input mb-4"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          autoComplete="username"
          required
        />

        <label className="stat-label block mb-1.5">{t('login.password')}</label>
        <input
          className="input mb-5"
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoComplete="current-password"
          required
          autoFocus
        />

        {err && <div className="notice notice-danger mb-4">{err}</div>}

        <button className="btn btn-primary w-full" disabled={busy} type="submit">
          {busy ? t('login.busy') : t('login.submit')}
        </button>

        <p className="mt-5 text-[11px] text-muted2 leading-relaxed">{t('login.note')}</p>

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
          <span className="text-[11px] text-muted2">{t('common.language')}</span>
          <div className="flex gap-0.5 p-0.5 rounded-md bg-surface border border-border">
            {LANGS.map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => setLanguage(lang)}
                aria-pressed={current === lang}
                className={`px-3 py-2 min-h-9 rounded-[5px] text-[11px] font-medium transition ${
                  current === lang
                    ? 'bg-bright text-bg'
                    : 'text-muted hover:text-ink hover:bg-surface2'
                }`}
              >
                {lang.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </form>
    </div>
  )
}
