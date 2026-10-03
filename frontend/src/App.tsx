import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import Layout from './components/Layout'
import DashboardPage from './pages/Dashboard'
import Devices from './pages/Devices'
import DeviceDetail from './pages/DeviceDetail'
import Login from './pages/Login'
import SettingsPage from './pages/Settings'
import { AuthProvider, LiveProvider, useAuth } from './live'

function RequireAuth({ children }: { children: ReactNode }) {
  const { username, loading } = useAuth()
  if (loading) {
    return <div className="min-h-screen grid place-items-center text-sm text-slate-500">Memuat…</div>
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
              path="/settings"
              element={
                <RequireAuth>
                  <SettingsPage />
                </RequireAuth>
              }
            />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </LiveProvider>
      </AuthProvider>
    </Router>
  )
}