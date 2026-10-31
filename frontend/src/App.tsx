import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom'
import { Suspense, lazy, type ReactNode } from 'react'
import Layout from './components/Layout'
import DashboardPage from './pages/Dashboard'
import Devices from './pages/Devices'
import DeviceDetail from './pages/DeviceDetail'
import Login from './pages/Login'
import SettingsPage from './pages/Settings'
// Code-split: the topology SVG and the speedtest page are not needed on the
// first paint, so they are fetched on demand rather than bloating the bundle
// that every page loads.
const TopologyPage = lazy(() => import('./pages/Topology'))
const SpeedtestPage = lazy(() => import('./pages/Speedtest'))
const ActivityPage = lazy(() => import('./pages/Activity'))
const ConnectionPage = lazy(() => import('./pages/Connection'))
import { AuthProvider, LiveProvider, useAuth } from './live'

function RequireAuth({ children }: { children: ReactNode }) {
  const { username, loading } = useAuth()
  if (loading) {
    return <div className="min-h-screen grid place-items-center text-sm text-muted2">Memuat…</div>
  }
  if (!username) return <Navigate to="/login" replace />
  return <Layout>{children}</Layout>
}

export default function App() {
  return (
    <Router>
      <AuthProvider>
        {/* The live socket is only useful once authenticated; the WS handler
            rejects anonymous clients with 1008. */}
        <LiveProvider>
          <Suspense
            fallback={
              <div className="min-h-screen grid place-items-center text-sm text-muted">
                Memuat…
              </div>
            }
          >
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/dashboard"
              element={
                <RequireAuth>
                  <DashboardPage />
                </RequireAuth>
              }
            />
            <Route
              path="/devices"
              element={
                <RequireAuth>
                  <Devices />
                </RequireAuth>
              }
            />
            <Route
              path="/devices/:mac"
              element={
                <RequireAuth>
                  <DeviceDetail />
                </RequireAuth>
              }
            />
            <Route
              path="/topology"
              element={
                <RequireAuth>
                  <TopologyPage />
                </RequireAuth>
              }
            />
            <Route
              path="/connection"
              element={
                <RequireAuth>
                  <ConnectionPage />
                </RequireAuth>
              }
            />
            <Route
              path="/activity"
              element={
                <RequireAuth>
                  <ActivityPage />
                </RequireAuth>
              }
            />
            <Route
              path="/speedtest"
              element={
                <RequireAuth>
                  <SpeedtestPage />
                </RequireAuth>
              }
            />
            <Route
              path="/settings"
              element={
                <RequireAuth>
                  <SettingsPage />
                </RequireAuth>
              }
            />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
          </Suspense>
        </LiveProvider>
      </AuthProvider>
    </Router>
  )
}