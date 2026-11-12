/**
 * Shared runtime helpers for the cross-platform launchers.
 *
 * Both bin/anrouter.js (interactive development) and run-pm2.js (background
 * production) use this module, so Python/venv detection and child-process
 * cleanup cannot drift apart again.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BACKEND_DIR = path.join(ROOT, 'backend')
export const FRONTEND_DIR = path.join(ROOT, 'frontend')
export const FRONTEND_DIST = path.join(FRONTEND_DIR, 'dist')
export const isWindows = process.platform === 'win32'

export const DEFAULT_PORT = Number(process.env.NETDASH_PORT || 8777)
// Wildcard by default: the dashboard must be reachable from a phone on the
// same Wi-Fi, not just from the machine running it. Set NETDASH_HOST to a
// concrete address (for example 127.0.0.1) to restrict it.
export const DEFAULT_HOST = process.env.NETDASH_HOST || '0.0.0.0'
export const FRONTEND_PORT = 5173

// Direct imports used by backend/app and the regression tests. Keeping the
// list here means a launcher can tell the user *which* venv is incomplete
// instead of letting uvicorn start and fail later with a cryptic warning.
export const REQUIRED_PYTHON_MODULES = [
  'fastapi',
  'uvicorn',
  'sqlmodel',
  'pydantic',
  'scapy',
  'httpx',
  'dotenv',
  'itsdangerous',
  'psutil',
  'cryptography',
  'speedtest', // speedtest-cli: app/speedtest.py
  'websockets',
]

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Human-readable URLs for a server bound to `host`.
 *
 * A wildcard bind is the reason the dashboard survives DHCP changes: the
 * process listens on every interface, so the current LAN address always works.
 * Printing the concrete addresses at startup makes the change discoverable
 * instead of leaving the user to guess which IP replaced the old bookmark.
 */
export function accessUrls(host, port) {
  const wildcard = !host || host === '0.0.0.0' || host === '::'
  const urls = new Set()

  if (wildcard) {
    urls.add(`http://localhost:${port}`)
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const addr of addrs || []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          urls.add(`http://${addr.address}:${port}`)
        }
      }
    }
  } else {
    urls.add(`http://${host}:${port}`)
  }

  return [...urls]
}

export function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function pythonCandidates() {
  const candidates = []
  if (process.env.NETDASH_PYTHON) {
    candidates.push({ command: process.env.NETDASH_PYTHON, label: 'NETDASH_PYTHON' })
  }

  const rootVenv = isWindows
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python')
  const backendVenv = isWindows
    ? path.join(ROOT, 'backend', '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, 'backend', '.venv', 'bin', 'python')

  candidates.push({ command: rootVenv, label: 'project .venv' })
  candidates.push({ command: backendVenv, label: 'backend/.venv (legacy)' })
  candidates.push({ command: isWindows ? 'python' : 'python3', label: 'PATH' })
  return candidates
}

function runnable(command) {
  return path.isAbsolute(command) ? fs.existsSync(command) : true
}

export function missingPythonModules(command) {
  const script = [
    'import importlib.util, json',
    `mods = ${JSON.stringify(REQUIRED_PYTHON_MODULES)}`,
    'print(json.dumps([m for m in mods if importlib.util.find_spec(m) is None]))',
  ].join('\n')
  const result = spawnSync(command, ['-c', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error || result.status !== 0) return [...REQUIRED_PYTHON_MODULES]
  try {
    return JSON.parse(result.stdout.trim())
  } catch {
    return [...REQUIRED_PYTHON_MODULES]
  }
}

/**
 * Pick the first interpreter that can actually import every runtime module.
 * The root .venv is canonical; backend/.venv and PATH are fallbacks for old
 * checkouts. Returns { ok, command, label, missing, checked }.
 */
export function resolvePython() {
  const checked = []
  for (const candidate of pythonCandidates()) {
    if (!runnable(candidate.command)) {
      checked.push({ ...candidate, missing: ['(interpreter not found)'] })
      continue
    }
    const missing = missingPythonModules(candidate.command)
    checked.push({ ...candidate, missing })
    if (missing.length === 0) {
      return { ok: true, ...candidate, missing, checked }
    }
  }
  return { ok: false, checked }
}

export function pythonInstallHint(python = '<python>') {
  return `${python} -m pip install -r backend/requirements.txt`
}

export function npmCommand(args) {
  if (isWindows) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', ['npm', ...args].join(' ')],
    }
  }
  return { command: 'npm', args }
}

/** Spawn a long-lived service in its own process group on POSIX. */
export function spawnService(command, args, options) {
  return spawn(command, args, {
    ...options,
    detached: !isWindows,
    windowsHide: true,
  })
}

/** Kill the whole tree, not just the leader (npm -> sh -> vite, uvicorn). */
export function signalProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return

  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }

  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }
}

/** True when nothing is listening on host:port. */
export function isPortFree(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (error) => {
      resolve(error.code !== 'EADDRINUSE')
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen({ host, port, exclusive: true })
  })
}

/**
 * Vite binds `localhost`, which resolves to ::1 on many Linux systems while
 * uvicorn binds 127.0.0.1. Checking only one family produces a false "free".
 */
export async function isPortFreeAny(port, hosts = ['127.0.0.1', '::1']) {
  for (const host of hosts) {
    if (!(await isPortFree(host, port))) return false
  }
  return true
}

export function describePythonFailure(resolution) {
  const lines = ['Python yang punya semua dependency tidak ditemukan.']
  for (const entry of resolution.checked) {
    const missing = entry.missing?.length ? ` (kurang: ${entry.missing.join(', ')})` : ''
    lines.push(`  - ${entry.label}: ${entry.command}${missing}`)
  }
  lines.push('')
  lines.push('Buat/rapikan virtual environment utama:')
  lines.push('  python3 -m venv .venv')
  lines.push('  .venv/bin/python -m pip install -r backend/requirements.txt')
  lines.push('')
  lines.push('Atau tunjuk interpreter lain lewat NETDASH_PYTHON=/path/to/python')
  return lines.join('\n')
}
