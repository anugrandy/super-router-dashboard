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
import {
  api,
  AuthError,
  type Device,
  type KickedMap,
  type NetworkProfile,
  type ProfileSnapshot,
  type Transition,
  type WanEvent,
} from './api'
import { publishTransitions, publishWan } from './components/Toasts'

type ProfileChange = { profile: NetworkProfile | null; at: number }

type LiveState = {
  connected: boolean
  devices: Device[]
  kicked: KickedMap
  lastEventAt: number | null
  /** Bumped whenever history rows are deleted, so open lists can reload. */
  logsChangedAt: number | null
  error: string | null
  /** Every network profile recorded so far, newest state from the server. */
  profiles: NetworkProfile[]
  activeProfileId: number | null
  /** null follows the physically active network; an id is a historical view. */
  viewProfileId: number | null
  activeProfile: NetworkProfile | null
  /** The profile currently shown: active, or the chosen historical one. */
  viewProfile: NetworkProfile | null
  isViewingActive: boolean
  /** Non-null briefly after the physical network changed under the user. */
  profileChange: ProfileChange | null
  setViewProfile: (id: number | null) => void
  dismissProfileChange: () => void
  reloadProfiles: () => Promise<void>
}

const noop = () => {}
const asyncNoop = async () => {}

const LiveCtx = createContext<LiveState>({
  connected: false,
  devices: [],
  kicked: {},
  lastEventAt: null,
  logsChangedAt: null,
  error: null,
  profiles: [],
  activeProfileId: null,
  viewProfileId: null,
  activeProfile: null,
  viewProfile: null,
  isViewingActive: true,
  profileChange: null,
  setViewProfile: noop,
  dismissProfileChange: noop,
  reloadProfiles: asyncNoop,
})

export function useLive() {
  return useContext(LiveCtx)
}

/**
 * Second-by-second clock for kick countdowns, in its own context.
 *
 * It used to be a `tick` field on LiveState, which meant every consumer of
 * useLive() re-rendered once per second - all device rows included - even when
 * nothing was being kicked. Keeping it separate means only the components that
 * actually display a countdown subscribe to it.
 */
const ClockCtx = createContext<number>(0)

/** Returns a counter that advances once per second. Use only for countdowns. */
export function useClock() {
  return useContext(ClockCtx)
}

/**
 * Holds the live device list from the WebSocket, with a reconnecting loop.
 * The kicked timers are ticked locally every second so the countdown on the
 * badge advances between backend pushes.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const { username } = useAuth()
  const [state, setState] = useState<LiveState>({
    connected: false,
    devices: [],
    kicked: {},
    lastEventAt: null,
    logsChangedAt: null,
    error: null,
    profiles: [],
    activeProfileId: null,
    viewProfileId: null,
    activeProfile: null,
    viewProfile: null,
    isViewingActive: true,
    profileChange: null,
    setViewProfile: noop,
    dismissProfileChange: noop,
    reloadProfiles: asyncNoop,
  })
  const [tick, setTick] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef(0)
  const closedRef = useRef(false)

  const applySnapshot = useCallback((snapshot: ProfileSnapshot) => {
    setState((s) => {
      const stillExists =
        s.viewProfileId != null &&
        snapshot.profiles.some((p) => p.id === s.viewProfileId)
      const viewProfileId =
        s.viewProfileId == null || !stillExists ? null : s.viewProfileId
      const activeProfile =
        snapshot.profiles.find((p) => p.id === snapshot.active_id) ?? null
      const viewProfile =
        viewProfileId == null
          ? activeProfile
          : snapshot.profiles.find((p) => p.id === viewProfileId) ?? null
      return {
        ...s,
        profiles: snapshot.profiles,
        activeProfileId: snapshot.active_id,
        viewProfileId,
        activeProfile,
        viewProfile,
        isViewingActive:
          viewProfileId == null || viewProfileId === snapshot.active_id,
      }
    })
  }, [])

  const reloadProfiles = useCallback(async () => {
    try {
      applySnapshot(await api.profiles())
    } catch {
      // The WS push will retry; a profile list failure must not blank the app.
    }
  }, [applySnapshot])

  const setViewProfile = useCallback((id: number | null) => {
    setState((s) => {
      if (id !== null && !s.profiles.some((p) => p.id === id)) return s
      const viewProfile =
        id == null
          ? s.activeProfile
          : s.profiles.find((p) => p.id === id) ?? null
      return {
        ...s,
        viewProfileId: id,
        viewProfile,
        isViewingActive: id == null || id === s.activeProfileId,
      }
    })
  }, [])

  const dismissProfileChange = useCallback(() => {
    setState((s) => ({ ...s, profileChange: null }))
  }, [])

  useEffect(() => {
    if (!username) return
    void reloadProfiles()
  }, [username, reloadProfiles])

  useEffect(() => {
    closedRef.current = false

    // The WS endpoint authenticates with the session cookie and rejects
    // anonymous clients with 1008. Connecting before AuthProvider has resolved
    // /api/auth/me therefore closed the socket permanently: logging in later
    // did not remount this effect, so the device list stayed frozen. Wait for
    // a username and reconnect whenever the session identity changes.
    if (!username) {
      setState({
        connected: false,
        devices: [],
        kicked: {},
        lastEventAt: null,
        logsChangedAt: null,
        error: null,
        profiles: [],
        activeProfileId: null,
        viewProfileId: null,
        activeProfile: null,
        viewProfile: null,
        isViewingActive: true,
        profileChange: null,
        setViewProfile: noop,
        dismissProfileChange: noop,
        reloadProfiles: asyncNoop,
      })
      return () => {
        closedRef.current = true
      }
    }

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
          setState((s) => {
            // A historical edit must not touch the live active-network list.
            if (
              d.profile_id != null &&
              s.activeProfileId != null &&
              d.profile_id !== s.activeProfileId
            ) {
              return s
            }
            return {
              ...s,
              devices: s.devices.some((x) => x.mac === d.mac)
                ? s.devices.map((x) => (x.mac === d.mac ? d : x))
                : [...s.devices, d],
            }
          })
        } else if (msg.event === 'device_deleted') {
          const payload = msg.data as { mac?: string; profile_id?: number | null }
          const mac = String(payload?.mac || '')
          setState((s) => {
            if (
              payload?.profile_id != null &&
              s.activeProfileId != null &&
              payload.profile_id !== s.activeProfileId
            ) {
              return s
            }
            return { ...s, devices: s.devices.filter((x) => x.mac !== mac) }
          })
        } else if (msg.event === 'logs_deleted') {
          // History pages subscribe to this instead of reloading on a timer.
          setState((s) => ({ ...s, logsChangedAt: Date.now() }))
        } else if (msg.event === 'profiles') {
          applySnapshot(msg.data as ProfileSnapshot)
        } else if (msg.event === 'network_profile_changed') {
          const data = msg.data as ProfileSnapshot & {
            previous_id: number
            profile: NetworkProfile | null
          }
          applySnapshot({ profiles: data.profiles, active_id: data.active_id })
          // A real network switch takes precedence over a historical browse:
          // follow the network the laptop is actually on again.
          setState((s) => ({
            ...s,
            viewProfileId: null,
            viewProfile: data.profile,
            isViewingActive: true,
            profileChange: { profile: data.profile, at: Date.now() },
          }))
        } else if (msg.event === 'transitions') {
          // Published straight to the toast subscribers. Deliberately not put
          // into LiveState: every consumer of useLive() would re-render on
          // each connect/disconnect.
          publishTransitions(msg.data as Transition[])
        } else if (msg.event === 'wan') {
          // An internet outage is a different kind of event from one device
          // dropping off, so it gets its own louder alert channel.
          publishWan(msg.data as WanEvent)
        } else if (msg.event === 'error') {
          setState((s) => ({ ...s, error: String(msg.data) }))
        }
      }
      ws.onclose = (ev) => {
        setState((s) => ({ ...s, connected: false }))
        if (closedRef.current) return
        // 1008 = our auth check rejected it. The session may have expired while
        // the page stayed open, so retry slowly instead of dying. A fresh login
        // changes `username`, which also restarts this effect.
        if (ev.code === 1008) {
          retryRef.current = 0
          window.setTimeout(connect, 5000)
          return
        }
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
  }, [username])

  // Local 1 Hz tick so the kicked countdown animates without server pushes.
  // It stops entirely when nothing is kicked: an always-on timer forced a
  // context update per second, which re-rendered the whole app for no visible
  // change. Only countdown consumers subscribe to this now.
  const anyKicked = Object.keys(state.kicked).length > 0
  useEffect(() => {
    if (!anyKicked) return
    const id = window.setInterval(() => setTick((t) => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [anyKicked])

  // Merge the kicked map onto devices so every view shows consistent badges.
  // The kicked value stays the *epoch second* the kick began: computing
  // elapsed seconds here would tie every row's identity to the 1 Hz clock.
  // KickedBadge derives the countdown locally instead.
  const devices = useMemo(
    () =>
      state.devices.map((d) => {
        const started = state.kicked[d.mac]
        return {
          ...d,
          // null = not kicked; otherwise the epoch second it started.
          kicked: started == null ? null : started,
        }
      }),
    [state.devices, state.kicked],
  )

  const value = useMemo<LiveState>(() => {
    const activeProfile =
      state.profiles.find((p) => p.id === state.activeProfileId) ?? null
    const viewProfile =
      state.viewProfileId == null
        ? activeProfile
        : state.profiles.find((p) => p.id === state.viewProfileId) ?? null
    return {
      ...state,
      devices,
      activeProfile,
      viewProfile,
      isViewingActive:
        state.viewProfileId == null ||
        state.viewProfileId === state.activeProfileId,
      setViewProfile,
      dismissProfileChange,
      reloadProfiles,
    }
  }, [
    state,
    devices,
    setViewProfile,
    dismissProfileChange,
    reloadProfiles,
  ])
  return (
    <ClockCtx.Provider value={tick}>
      <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>
    </ClockCtx.Provider>
  )
}

/** Seconds elapsed since a kick started, recomputed once per second. */
export function elapsedOf(startedEpoch: number): number {
  return Math.max(0, Date.now() / 1000 - startedEpoch)
}

/** Session state, used by the router guard and the header. */
type AuthState = { username: string | null; displayName: string; loading: boolean }

const AuthCtx = createContext<AuthState & {
  login: (u: string, p: string) => Promise<void>
  logout: () => Promise<void>
  updateProfile: (body: { username?: string; display_name?: string }) => Promise<void>
}>({
  username: null,
  displayName: '',
  loading: true,
  login: async () => {},
  logout: async () => {},
  updateProfile: async () => {},
})

export function useAuth() {
  return useContext(AuthCtx)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const me = await api.me()
      setUsername(me.username)
      setDisplayName(me.display_name)
    } catch (e) {
      setUsername(null)
      setDisplayName('')
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
    setDisplayName(res.display_name)
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      setUsername(null)
      setDisplayName('')
    }
  }, [])

  const updateProfile = useCallback(
    async (body: { username?: string; display_name?: string }) => {
      const res = await api.updateProfile(body)
      setUsername(res.username)
      setDisplayName(res.display_name)
    },
    [],
  )

  const value = useMemo(
    () => ({ username, displayName, loading, login, logout, updateProfile }),
    [username, displayName, loading, login, logout, updateProfile],
  )
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}