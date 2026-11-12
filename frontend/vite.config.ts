import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // loadEnv picks up frontend/.env, so the port survives even if you forget to
  // export NETDASH_BACKEND in a new terminal. An explicit shell value still
  // wins because process.env is checked first.
  const fileEnv = loadEnv(mode, process.cwd(), '')
  const port = process.env.NETDASH_BACKEND || fileEnv.NETDASH_BACKEND || '8777'
  const target = `http://127.0.0.1:${port}`

  // Loud on every start: a wrong proxy target is otherwise invisible, and the
  // UI just looks like the backend is broken.
  const source = process.env.NETDASH_BACKEND
    ? 'shell env'
    : fileEnv.NETDASH_BACKEND
      ? 'frontend/.env'
      : 'default'
  console.log(`\n[netdash] vite proxy target : ${target}`)
  console.log(`[netdash] backend must listen on : ${port}  (source: ${source})\n`)

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      // Listen on the LAN too, not just localhost. The backend already accepts
      // requests from any interface in production; the dev server must do the
      // same so a phone/tablet can reach the dashboard after a network change.
      host: true,
      // Proxy so the session cookie stays same-origin (a cross-origin cookie
      // would need SameSite=None and be rejected anyway).
      proxy: {
        '/api': { target, changeOrigin: false },
        '/ws': { target: target.replace('http', 'ws'), ws: true },
      },
    },
    // Older iOS Safari (before 16.4) does not understand the modern
    // `(width <= 40rem)` range syntax that Tailwind v4 emits by default. Keep
    // media queries in the legacy min/max form so phones still get the mobile
    // layout instead of the desktop grid.
    build: { outDir: 'dist', sourcemap: false, cssTarget: 'safari15' },
  }
})
