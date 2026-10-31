#!/usr/bin/env node
/**
 * anrouter — cross-platform interactive launcher for AN Telemetry.
 *
 * Works on Windows, Linux, and macOS. Installed as a global command through
 * package.json ("bin"), so `npm link` / `npm install -g .` is enough — no
 * PowerShell profile edit or OS-specific shell script.
 *
 *   anrouter              interactive menu (development: backend + Vite)
 *   anrouter --doctor     print interpreter/dependency/port diagnostics
 *   anrouter --version
 *   anrouter --help
 *
 * For headless servers use run-pm2.js instead; it never needs a TTY.
 */
import fs from 'node:fs'
import path from 'node:path'
import prompts from 'prompts'
import open from 'open'
import {
  BACKEND_DIR,
  DEFAULT_HOST,
  DEFAULT_PORT,
  FRONTEND_DIR,
  FRONTEND_PORT,
  ROOT,
  describePythonFailure,
  isPortFree,
  isPortFreeAny,
  npmCommand,
  readPackageVersion,
  resolvePython,
  signalProcessTree,
  sleep,
  spawnService,
} from '../lib/runtime.js'

const VERSION = readPackageVersion()

function parseArgs(argv) {
  let port = DEFAULT_PORT
  let host = DEFAULT_HOST
  let action = 'menu'

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        action = 'help'
        break
      case '--version':
      case '-v':
        action = 'version'
        break
      case '--doctor':
        action = 'doctor'
        break
      case '--port': {
        const value = argv[i + 1]
        if (!value || !/^\d+$/.test(value)) {
          console.error('anrouter: --port butuh angka, contoh: --port 8777')
          process.exit(1)
        }
        port = Number(value)
        i += 1
        break
      }
      case '--host': {
        const value = argv[i + 1]
        if (!value) {
          console.error('anrouter: --host butuh alamat, contoh: --host 127.0.0.1')
          process.exit(1)
        }
        host = value
        i += 1
        break
      }
      default:
        console.error(`anrouter: argumen tidak dikenal: ${arg}`)
        process.exit(1)
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`anrouter: port tidak valid: ${port}`)
    process.exit(1)
  }
  return { action, port, host }
}

const args = parseArgs(process.argv.slice(2))
const BACKEND_URL = `http://${args.host}:${args.port}`
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`
const DASHBOARD_URL = `${FRONTEND_URL}/dashboard`

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const ansi = (code) => (useColor ? `\x1b[${code}m` : '')
const RESET = ansi('0')
const DIM = ansi('2;37')
const BOLD = ansi('1;97')
const GREEN = ansi('32')
const YELLOW = ansi('33')
const RED = ansi('31')

const services = {
  backend: { state: 'stopped', child: null, owned: false, log: null, stopping: false },
  frontend: { state: 'stopped', child: null, owned: false, log: null, stopping: false },
}

let busy = false
let exiting = false
let python = null

function printHelp() {
  console.log(`anrouter ${VERSION} — launcher interaktif AN Telemetry

Usage:
  anrouter                 buka menu (backend + Vite dev server)
  anrouter --doctor        cek Python/venv, dependency, dan port
  anrouter --port 8777     ganti port backend
  anrouter --host 127.0.0.1
  anrouter --version
  anrouter --help

Untuk server/PM2 tanpa TTY:
  pm2 start run-pm2.js --name "Dashboard-Router" -- --prod

Menu:
  Web UI (Open in Browser)  buka dashboard di browser default
  Exit                      keluar; hentikan layanan yang dimulai sesi ini
`)
}

function banner() {
  console.log('')
  console.log(`${BOLD}AN Telemetry${RESET} ${DIM}v${VERSION}${RESET}`)
  console.log(`${DIM}Server ${RESET} ${FRONTEND_URL}`)
  console.log(`${DIM}Backend${RESET} ${BACKEND_URL}`)
  console.log(`${DIM}Python ${RESET} ${python?.command || '(belum dicek)'}`)
  console.log('')
}

function stateText(entry) {
  if (entry.state === 'running') return `${GREEN}ready${RESET}${entry.owned ? '' : ` ${DIM}(external)${RESET}`}`
  if (entry.state === 'starting') return `${YELLOW}starting${RESET}`
  if (entry.state === 'conflict') return `${RED}port in use${RESET}`
  if (entry.state === 'error') return `${RED}error${RESET}`
  return `${DIM}off${RESET}`
}

function fetchWithTimeout(url, ms = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer))
}

async function detectBackend() {
  try {
    const res = await fetchWithTimeout(`${BACKEND_URL}/openapi.json`)
    if (!res.ok) return 'conflict'
    const doc = await res.json()
    return doc?.info?.title === 'netdash' ? 'running' : 'conflict'
  } catch {
    return 'down'
  }
}

async function detectFrontend() {
  try {
    const res = await fetchWithTimeout(`${FRONTEND_URL}/`)
    if (!res.ok) return 'conflict'
    const html = await res.text()
    return html.includes('AN Telemetry') ? 'running' : 'conflict'
  } catch {
    return 'down'
  }
}

function startBackend() {
  const entry = services.backend
  if (entry.child) return
  if (!python?.ok) {
    entry.state = 'error'
    return
  }

  const log = fs.createWriteStream(path.join(BACKEND_DIR, 'server.log'), { flags: 'a' })
  const child = spawnService(
    python.command,
    [
      '-m',
      'uvicorn',
      'app.main:app',
      '--app-dir',
      'backend',
      '--host',
      args.host,
      '--port',
      String(args.port),
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NETDASH_PORT: String(args.port),
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  Object.assign(entry, {
    child,
    owned: true,
    log,
    state: 'starting',
    stopping: false,
  })

  child.once('error', (error) => {
    entry.state = 'error'
    entry.stopping = true
    log.end()
    console.error(`${RED}backend gagal start:${RESET} ${error.message}`)
    void exitApp(1)
  })

  child.once('exit', (code, signal) => {
    log.end()
    entry.child = null
    entry.log = null
    entry.owned = false
    if (exiting || entry.stopping) {
      entry.stopping = false
      return
    }
    entry.state = code === 0 ? 'stopped' : 'error'
    console.error(
      `${RED}backend berhenti${RESET}${signal ? ` (${signal})` : ` (kode ${code})`}. Lihat backend/server.log.`,
    )
    void exitApp(1)
  })
}

function startFrontend() {
  const entry = services.frontend
  if (entry.child) return

  if (!fs.existsSync(path.join(FRONTEND_DIR, 'node_modules', 'vite'))) {
    entry.state = 'error'
    console.error(
      `${RED}frontend belum siap:${RESET} node_modules tidak ada. Jalankan: cd frontend && npm install`,
    )
    return
  }

  const log = fs.createWriteStream(path.join(FRONTEND_DIR, 'dev.log'), { flags: 'a' })
  const { command, args: npmArgs } = npmCommand(['run', 'dev'])
  const child = spawnService(command, npmArgs, {
    cwd: FRONTEND_DIR,
    env: { ...process.env, NETDASH_BACKEND: String(args.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  Object.assign(entry, {
    child,
    owned: true,
    log,
    state: 'starting',
    stopping: false,
  })

  child.once('error', (error) => {
    entry.state = 'error'
    entry.stopping = true
    log.end()
    console.error(`${RED}frontend gagal start:${RESET} ${error.message}`)
    void exitApp(1)
  })

  child.once('exit', (code, signal) => {
    log.end()
    entry.child = null
    entry.log = null
    entry.owned = false
    if (exiting || entry.stopping) {
      entry.stopping = false
      return
    }
    entry.state = code === 0 ? 'stopped' : 'error'
    console.error(
      `${RED}frontend berhenti${RESET}${signal ? ` (${signal})` : ` (kode ${code})`}. Lihat frontend/dev.log.`,
    )
    void exitApp(1)
  })
}

async function waitForReady(check, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await check()
    if (state === 'running') return true
    if (state === 'conflict') return false
    if (child && child.exitCode != null) return false
    await sleep(600)
  }
  return false
}

async function ensureServices() {
  if (busy || exiting) return false
  busy = true

  try {
    const backendState = await detectBackend()
    if (backendState === 'conflict') {
      throw new Error(`Port ${args.port} dipakai layanan lain (bukan netdash).`)
    }
    if (backendState === 'down') {
      console.log(`${YELLOW}Menyalakan backend…${RESET}`)
      services.backend.state = 'starting'
      startBackend()
      if (services.backend.state === 'error') throw new Error('Backend gagal start.')
      if (!(await waitForReady(detectBackend, 45_000, services.backend.child))) {
        throw new Error('Backend tidak siap. Lihat backend/server.log.')
      }
    }
    services.backend.state = 'running'

    const frontendState = await detectFrontend()
    if (frontendState === 'conflict') {
      throw new Error(`Port ${FRONTEND_PORT} dipakai layanan lain.`)
    }
    if (frontendState === 'down') {
      console.log(`${YELLOW}Menyalakan frontend…${RESET}`)
      services.frontend.state = 'starting'
      startFrontend()
      if (services.frontend.state === 'error') throw new Error('Frontend gagal start.')
      if (!(await waitForReady(detectFrontend, 45_000, services.frontend.child))) {
        throw new Error('Frontend tidak siap. Lihat frontend/dev.log.')
      }
    }
    services.frontend.state = 'running'

    console.log(`${GREEN}Backend & frontend siap.${RESET}`)
    return true
  } catch (error) {
    stopOwnedServices()
    console.error(`${RED}${error instanceof Error ? error.message : error}${RESET}`)
    return false
  } finally {
    busy = false
  }
}

async function openWebUI() {
  const ready = await ensureServices()
  if (!ready || exiting) return

  try {
    await open(DASHBOARD_URL)
    console.log(`${GREEN}Browser dibuka:${RESET} ${DASHBOARD_URL}`)
  } catch {
    console.log(`${YELLOW}Gagal membuka browser. Buka manual:${RESET} ${DASHBOARD_URL}`)
  }
  await sleep(700)
}

function stopEntry(entry) {
  const child = entry.child
  if (!child) return
  entry.stopping = true
  entry.state = 'stopped'
  entry.child = null
  entry.owned = false
  signalProcessTree(child, 'SIGTERM')
  const timer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 1500)
  timer.unref?.()
}

function stopOwnedServices() {
  stopEntry(services.backend)
  stopEntry(services.frontend)
}

async function exitApp(code = 0) {
  if (exiting) return
  exiting = true
  stopOwnedServices()
  await sleep(300)
  for (const entry of Object.values(services)) {
    try {
      entry.log?.end()
    } catch {
      // Ignore.
    }
  }
  console.log(`${BOLD}AN Telemetry${RESET} ${DIM}ditutup.${RESET}`)
  process.exit(code)
}

async function doctor() {
  console.log(`${BOLD}AN Telemetry doctor${RESET}`)
  console.log(`  root         : ${ROOT}`)
  console.log(`  node         : ${process.version}`)
  if (python?.ok) {
    console.log(`  python       : ${python.command} (${python.label}) OK`)
  } else {
    console.log(`  python       : ${RED}NOT READY${RESET}`)
    console.log(describePythonFailure(python))
  }
  const backendFree = await isPortFree(args.host, args.port)
  const frontendFree = await isPortFreeAny(FRONTEND_PORT)
  console.log(`  backend port : ${args.port} ${backendFree ? 'free' : `${YELLOW}IN USE${RESET}`}`)
  console.log(`  frontend port: ${FRONTEND_PORT} ${frontendFree ? 'free' : `${YELLOW}IN USE${RESET}`}`)
  console.log(
    `  frontend deps: ${fs.existsSync(path.join(FRONTEND_DIR, 'node_modules', 'vite')) ? 'OK' : 'missing (cd frontend && npm install)'}`,
  )
  console.log(
    `  production   : ${fs.existsSync(path.join(FRONTEND_DIR, 'dist', 'index.html')) ? 'frontend/dist exists' : 'frontend/dist missing (npm run build)'}`,
  )
}

async function menu() {
  while (!exiting) {
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H')
    banner()
    console.log(
      `Status  backend ${stateText(services.backend)} ${DIM}·${RESET} frontend ${stateText(services.frontend)}`,
    )
    console.log('')

    const answer = await prompts(
      {
        type: 'select',
        name: 'action',
        message: 'Pilih menu',
        choices: [
          { title: 'Web UI (Open in Browser)', value: 'web' },
          { title: 'Exit', value: 'exit' },
        ],
        initial: 0,
      },
      {
        onCancel: () => {
          void exitApp(0)
          return false
        },
      },
    )

    if (exiting) return
    if (!answer?.action || answer.action === 'exit') {
      await exitApp(0)
      return
    }
    if (answer.action === 'web') await openWebUI()
  }
}

async function main() {
  if (args.action === 'help') {
    printHelp()
    return
  }
  if (args.action === 'version') {
    console.log(`anrouter ${VERSION}`)
    return
  }

  python = resolvePython()

  if (args.action === 'doctor') {
    await doctor()
    if (!python.ok) process.exitCode = 1
    return
  }

  if (!python.ok) {
    console.error(`${RED}${describePythonFailure(python)}${RESET}`)
    process.exit(1)
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      'anrouter butuh terminal interaktif (TTY). Untuk server/PM2 gunakan:\n' +
        '  node run-pm2.js --prod\n' +
        '  pm2 start run-pm2.js --name "Dashboard-Router" -- --prod',
    )
    process.exit(1)
  }

  process.on('SIGINT', () => void exitApp(0))
  process.on('SIGTERM', () => void exitApp(0))
  process.on('SIGHUP', () => void exitApp(0))
  process.on('uncaughtException', (error) => {
    console.error(`\nanrouter error: ${error.stack || error.message}`)
    void exitApp(1)
  })

  await ensureServices()
  await menu()
}

main().catch((error) => {
  console.error(`\nanrouter error: ${error instanceof Error ? error.stack : error}`)
  void exitApp(1)
})
