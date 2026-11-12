#!/usr/bin/env node
/**
 * run-pm2.js — non-interactive PM2 entrypoint for AN Telemetry.
 *
 * This is the production/server path, not the daily development launcher.
 * It never touches stdin, never needs a TTY, and never renders a menu, so PM2
 * can run it in the background and restart it automatically.
 *
 *   node run-pm2.js                 # development: backend + Vite dev server
 *   node run-pm2.js --prod          # production: backend serves frontend/dist
 *   node run-pm2.js --build         # build frontend/dist, then production
 *   node run-pm2.js --port 8777     # override backend port
 *
 * PM2:
 *   pm2 start run-pm2.js --name "Dashboard-Router"
 *   pm2 start run-pm2.js --name "Dashboard-Router" -- --prod
 *
 * Interpreter selection is shared with bin/anrouter.js (lib/runtime.js): it
 * picks the first venv that can import every runtime dependency, preferring
 * the project's root .venv. This is what prevents the old
 * "No module named 'cryptography'" failure when PM2 picked a different venv
 * than the one the user installed packages into.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  FRONTEND_DIR,
  FRONTEND_DIST,
  ROOT,
  accessUrls,
  describePythonFailure,
  isPortFree,
  npmCommand,
  resolvePython,
  signalProcessTree,
  sleep,
  spawnService,
} from './lib/runtime.js'

// Keep shutdown inside PM2's default kill_timeout (1600 ms). If PM2 SIGKILLs
// this parent before we finish, detached children could survive as ghosts, so
// escalate to SIGKILL quickly instead of waiting a long time.
const GRACE_MS = 1000
const FORCE_WAIT_MS = 250

const services = new Map()
let shuttingDown = false

function log(message) {
  process.stdout.write(`[run-pm2] ${message}\n`)
}

function fail(message) {
  process.stderr.write(`[run-pm2] ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  let mode =
    process.env.NETDASH_MODE === 'production' || process.env.NODE_ENV === 'production'
      ? 'production'
      : 'development'
  let build = false
  let port = DEFAULT_PORT
  let host = DEFAULT_HOST
  // An explicit --host or NETDASH_HOST wins. Otherwise production listens on
  // every interface: the dashboard must keep working when the machine moves
  // between networks and DHCP hands it a different LAN address.
  let hostExplicit = Boolean(process.env.NETDASH_HOST)

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--prod':
      case '--production':
      case '-p':
        mode = 'production'
        break
      case '--dev':
      case '--development':
        mode = 'development'
        break
      case '--build':
        build = true
        mode = 'production'
        break
      case '--port': {
        const value = argv[i + 1]
        if (!value || !/^\d+$/.test(value)) fail('--port butuh angka, contoh: --port 8777')
        port = Number(value)
        i += 1
        break
      }
      case '--host': {
        const value = argv[i + 1]
        if (!value) fail('--host butuh alamat, contoh: --host 0.0.0.0')
        host = value
        hostExplicit = true
        i += 1
        break
      }
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        fail(`argumen tidak dikenal: ${arg} (pakai --help untuk bantuan)`)
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`port tidak valid: ${port}`)
  }
  if (!hostExplicit && mode === 'production') host = '0.0.0.0'
  return { mode, build, port, host }
}

function printHelp() {
  process.stdout.write(
    [
      'run-pm2.js — PM2 entrypoint untuk AN Telemetry (non-interaktif)',
      '',
      'Usage:',
      '  node run-pm2.js                 development: backend + Vite (:5173)',
      '  node run-pm2.js --prod          production: backend menyajikan frontend/dist',
      '  node run-pm2.js --build         build frontend, lalu mode production',
      '  node run-pm2.js --port 8777     ganti port backend',
      '  node run-pm2.js --host 0.0.0.0  dengarkan semua interface (default produksi)',
      '  node run-pm2.js --host 127.0.0.1  batasi ke mesin ini saja',
      '',
      'PM2:',
      '  pm2 start run-pm2.js --name "Dashboard-Router"',
      '  pm2 start run-pm2.js --name "Dashboard-Router" -- --prod',
      '',
      'Environment: NODE_ENV=production, NETDASH_PORT, NETDASH_HOST, NETDASH_PYTHON',
      '',
    ].join('\n'),
  )
}

function startService(name, command, args, options) {
  log(`starting ${name}: ${command} ${args.join(' ')}`)

  const child = spawnService(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  services.set(name, { name, child })

  child.once('error', (error) => {
    process.stderr.write(`[run-pm2] ${name} gagal start: ${error.message}\n`)
    void shutdown(1)
  })

  child.once('exit', (code, signal) => {
    services.delete(name)
    if (shuttingDown) return
    const reason = signal ? `signal ${signal}` : `kode ${code}`
    process.stderr.write(`[run-pm2] ${name} berhenti (${reason}); mematikan pasangannya.\n`)
    // Non-zero exit so PM2 restarts the whole group instead of leaving a
    // half-running app (backend alive but frontend gone, or vice versa).
    void shutdown(1)
  })

  return child
}

async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true

  const entries = [...services.values()]
  if (entries.length > 0) {
    log(`menghentikan ${entries.length} proses anak…`)
    for (const entry of entries) signalProcessTree(entry.child, 'SIGTERM')

    const deadline = Date.now() + GRACE_MS
    while (services.size > 0 && Date.now() < deadline) {
      await sleep(50)
    }

    // Anything still alive gets SIGKILL so PM2 never leaves ghosts behind.
    for (const entry of services.values()) signalProcessTree(entry.child, 'SIGKILL')
    if (services.size > 0) await sleep(FORCE_WAIT_MS)
  }

  process.exit(code)
}

function runBuild() {
  const { command, args } = npmCommand(['run', 'build'])
  log('building frontend (npm run build)…')
  const result = spawnSync(command, args, {
    cwd: FRONTEND_DIR,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) fail(`build gagal: ${result.error.message}`)
  if (result.status !== 0) fail(`build gagal (exit ${result.status}).`)
  log('build selesai.')
}

async function main() {
  const { mode, build, port, host } = parseArgs(process.argv.slice(2))

  const python = resolvePython()
  if (!python.ok) {
    fail(describePythonFailure(python))
  }
  log(`python: ${python.command} (${python.label})`)

  if (build) runBuild()

  if (mode === 'production' && !fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))) {
    fail(
      'mode production butuh frontend/dist/index.html. Jalankan `npm run build` di frontend, atau pakai `--build`.',
    )
  }

  if (mode !== 'production' && !fs.existsSync(path.join(FRONTEND_DIR, 'node_modules', 'vite'))) {
    fail('node_modules frontend belum ada. Jalankan: cd frontend && npm install')
  }

  // A stale duplicate on the same port is the classic "backend is online but
  // the UI talks to the old process" trap. Fail loudly instead of looping.
  if (!(await isPortFree(host, port))) {
    fail(
      `port ${port} sudah dipakai proses lain. Hentikan proses/PM2 lama ` +
        `(pm2 list, pm2 delete <nama>) atau jalankan dengan --port lain.`,
    )
  }

  log(`mode: ${mode}`)
  for (const url of accessUrls(host, port)) log(`access: ${url}`)

  startService(
    'backend',
    python.command,
    [
      '-m',
      'uvicorn',
      'app.main:app',
      '--app-dir',
      'backend',
      '--host',
      host,
      '--port',
      String(port),
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NETDASH_PORT: String(port),
        PYTHONUNBUFFERED: '1',
      },
    },
  )

  if (mode === 'production') {
    log('frontend: frontend/dist (disajikan oleh backend, tanpa Vite)')
  } else {
    const { command, args } = npmCommand(['run', 'dev'])
    startService('frontend', command, args, {
      cwd: FRONTEND_DIR,
      env: { ...process.env, NETDASH_BACKEND: String(port) },
    })
    log('frontend: Vite dev server — akses dari device lain di Wi-Fi yang sama:')
    // Vite always binds every interface (server.host = true), regardless of the
    // backend bind address, so these are the addresses a phone can open.
    for (const url of accessUrls('0.0.0.0', FRONTEND_PORT)) log(`  ${url}`)
  }

  log('siap. Hentikan lewat PM2 untuk shutdown bersih.')
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    log(`menerima ${signal}, shutdown…`)
    void shutdown(0)
  })
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`[run-pm2] uncaught exception: ${error.stack || error.message}\n`)
  void shutdown(1)
})

process.on('unhandledRejection', (error) => {
  process.stderr.write(`[run-pm2] unhandled rejection: ${error?.stack || error}\n`)
  void shutdown(1)
})

// Last-resort synchronous cleanup for normal exits. SIGKILL cannot be caught,
// which is why GRACE_MS is kept short enough for PM2's default kill_timeout.
process.on('exit', () => {
  for (const entry of services.values()) signalProcessTree(entry.child, 'SIGKILL')
})

main()
