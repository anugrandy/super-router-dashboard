import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../live'
import { UiMark } from '../components/icons'

export default function Login() {
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
      setErr(e instanceof Error ? e.message : 'Login gagal')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative z-[1]">
      <form onSubmit={submit} className="card w-full max-w-sm p-5">
        <div className="flex items-center gap-2.5 mb-1">
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border bg-surface2 text-bright">
            <UiMark size={19} />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-bright">
            AN Telemetry
          </h1>
        </div>
        <p className="text-sm text-muted mt-1 mb-6">
          Dashboard &amp; device manager jaringan rumah
        </p>

        <label className="stat-label block mb-1.5">
          Username
        </label>
        <input
          className="input mb-4"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          autoComplete="username"
          required
        />

        <label className="stat-label block mb-1.5">
          Password
        </label>
        <input
          className="input mb-5"
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoComplete="current-password"
          required
          autoFocus
        />

        {err && (
          <div className="mb-4 rounded-md border border-red/40 px-3 py-2 text-sm text-red">
            {err}
          </div>
        )}

        <button className="btn btn-primary w-full" disabled={busy} type="submit">
          {busy ? 'Memproses…' : 'Masuk'}
        </button>

        <p className="mt-5 text-[11px] text-muted2 leading-relaxed">
          Hanya untuk jaringan milik sendiri. Login default: <span className="mono">admin</span> /{' '}
          <span className="mono">netdash</span> (ubah lewat Settings).
        </p>
      </form>
    </div>
  )
}