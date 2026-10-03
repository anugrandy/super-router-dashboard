import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api, AuthError, type Device, type KickedMap } from './api'

type LiveState = {
  connected: boolean
  devices: Device[]
  kicked: KickedMap
  lastEventAt: number | null
  error: string | null
  /** Increments every second so elapsed-time UI can recompute. */
  tick: number
}

const LiveCtx = createContext<LiveState>({
  connected: false,
  devices: [],
  kicked: {},
  lastEventAt: null,
  error: null,
  tick: 0,
})

export function useLive() {
  return useContext(LiveCtx)
}

/**
 * Holds the live device list from the WebSocket, with a reconnecting loop.
 * The kicked timers are ticked locally every second so the countdown on the
 * badge advances between backend pushes.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LiveState>({
    connected: false,
    devices: [],
    kicked: {},
    lastEventAt: null,
    error: null,
    tick: 0,
  })
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef(0)
  const closedRef = useRef(false)

  useEffect(() => {
    closedRef.current = false

    const connect = () => {
      if (closedRef.current) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      let ws: WebSocket
      try {
        ws = new WebSocket(`${proto}://${location.host}/ws/live`)
      } catch {
        window.setTimeout(connect, 3000)
        return
      }
      wsRef.current = ws

      ws.onopen = () => {
        retryRef.current = 0
        setState((s) => ({ ...s, connected: true, error: null }))
      }
      ws.onmessage = (ev) => {
        let msg: { event: string; data: unknown }
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        if (msg.event === 'devices') {
          setState((s) => ({
            ...s,
            devices: msg.data as Device[],
            lastEventAt: Date.now(),
          }))
        } else if (msg.event === 'kicked') {
          setState((s) => ({ ...s, kicked: msg.data as KickedMap, lastEventAt: Date.now() }))
        } else if (msg.event === 'device_update') {
          const d = msg.data as Device
          setState((s) => ({
            ...s,
            devices: s.devices.some((x) => x.mac === d.mac)
              ? s.devices.map((x) => (x.mac === d.mac ? d : x))
              : [...s.devices, d],
          }))
        } else if (msg.event === 'error') {
          setState((s) => ({ ...s, error: String(msg.data) }))
        }
      }
      ws.onclose = (ev) => {
        setState((s) => ({ ...s, connected: false }))
        if (closedRef.current) return
        // 1008 = our auth check rejected it; retrying won't help.
        if (ev.code === 1008) return
        retryRef.current = Math.min(retryRef.current + 1, 6)
        window.setTimeout(connect, Math.min(1000 * 2 ** retryRef.current, 20000))
      }
      ws.onerror = () => ws.close()
    }

    connect()
    return () => {
      closedRef.current = true
      wsRef.current?.close()
    }
  }, [])

  // Local 1 Hz tick so the kicked countdown animates without server pushes.
  useEffect(() => {
    const id = window.setInterval(
      () => setState((s) => ({ ...s, tick: s.tick + 1 })),
      1000,
    )
    return () => window.clearInterval(id)
  }, [])

  // Merge the kicked map onto devices so every view shows consistent badges.
  // `state.kicked` holds the epoch second each kick started; the UI wants
  // elapsed seconds, recomputed on the 1 Hz tick above so the timer advances.
  const devices = useMemo(
    () =>
      state.devices.map((d) => {
        const started = state.kicked[d.mac]
        return {
          ...d,
          kicked: started == null ? null : Math.max(0, Date.now() / 1000 - started),
        }
      }),
    // state.tick forces a recompute every second for the countdown.
    [state.devices, state.kicked, state.tick],
  )

  const value = useMemo<LiveState>(
    () => ({ ...state, devices }),
    [state, devices],
  )
  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>
}

/** Session state, used by the router guard and the header. */
type AuthState = { username: string | null; loading: boolean }

const AuthCtx = createContext<AuthState & {
  login: (u: string, p: string) => Promise<void>
  logout: () => Promise<void>
}>({ username: null, loading: true, login: async () => {}, logout: async () => {} })

export function useAuth() {
  return useContext(AuthCtx)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const me = await api.me()
      setUsername(me.username)
    } catch (e) {
      setUsername(null)
      if (!(e instanceof AuthError)) {
        // A non-auth failure still means we can't render the app shell yet.
        setUsername(null)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const login = useCallback(async (u: string, p: string) => {
    const res = await api.login(u, p)
    setUsername(res.username)
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      setUsername(null)
    }
  }, [])

  const value = useMemo(
    () => ({ username, loading, login, logout }),
    [username, loading, login, logout],
  )
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}