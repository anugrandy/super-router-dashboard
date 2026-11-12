#!/usr/bin/env bash
# FALLBACK ONLY. The recommended development launcher is the cross-platform
# `anrouter` command (bin/anrouter.js, installed with `npm link`).
#
# Start the netdash backend cleanly on Linux/macOS: kill stale servers, verify
# no duplicates, then run on one port. Windows uses run.ps1 instead.
#
# Usage:  ./run.sh [port]        (default 8777)
set -uo pipefail

PORT="${1:-8777}"
# Listen on every interface by default so a changed LAN address (or a phone on
# the same Wi-Fi) can still reach the dashboard. Set NETDASH_HOST=127.0.0.1 to
# keep it loopback-only.
HOST="${NETDASH_HOST:-0.0.0.0}"
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

# Prefer the project venv, then the backend-local one, then whatever python3 is
# on PATH. The backend needs uvicorn, so fail early with an actionable message.
PYTHON=""
for candidate in "$ROOT/.venv/bin/python" "$ROOT/backend/.venv/bin/python"; do
    if [ -x "$candidate" ]; then
        PYTHON="$candidate"
        break
    fi
done
if [ -z "$PYTHON" ]; then
    PYTHON="$(command -v python3 || true)"
fi
if [ -z "$PYTHON" ]; then
    echo "run.sh: python3 tidak ditemukan di PATH." >&2
    exit 1
fi
if ! "$PYTHON" -c 'import fastapi, uvicorn, cryptography, scapy, sqlmodel, httpx, psutil, dotenv, itsdangerous, speedtest, websockets' >/dev/null 2>&1; then
    echo "run.sh: dependency Python belum lengkap untuk $PYTHON" >&2
    echo "  $PYTHON -m pip install -r backend/requirements.txt" >&2
    exit 1
fi

BACKEND_PID=""
COOKIE=""
cleanup() {
    if [ -n "$COOKIE" ]; then rm -f "$COOKIE"; fi
    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo
        echo "=== stopping backend (PID $BACKEND_PID) ==="
        kill "$BACKEND_PID" 2>/dev/null || true
        wait "$BACKEND_PID" 2>/dev/null || true
    fi
    rm -f "$ROOT/backend/server.pid"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# True when PID is a uvicorn for *this* checkout. Matching the command line
# alone is not enough: another project may run the same app name.
is_our_backend() {
    local pid="$1" cmd cwd
    cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    case "$cmd" in
        *"uvicorn app.main:app"*) ;;
        *) return 1 ;;
    esac
    if [ -e "/proc/$pid/cwd" ]; then
        cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
        if [ "$cwd" = "$ROOT/backend" ] || [ "$cwd" = "$ROOT" ]; then
            return 0
        fi
        return 1
    fi
    # macOS has no /proc: fall back to the repo path in the command line.
    case "$cmd" in
        *"$ROOT"*) return 0 ;;
        *) return 1 ;;
    esac
}

port_busy() {
    local port="$1" listeners
    if command -v ss >/dev/null 2>&1; then
        listeners="$(ss -ltn 2>/dev/null | awk '{print $4}')" || true
    elif command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
        return
    else
        listeners="$(netstat -ltn 2>/dev/null | awk '{print $4}')" || true
    fi
    grep -qE "[:.]${port}$" <<<"$listeners"
}

echo "=== killing any netdash uvicorn still running ==="
FOUND=0
for pid in $(pgrep -f 'uvicorn app.main:app' 2>/dev/null || true); do
    if is_our_backend "$pid"; then
        echo "  stopping PID $pid"
        kill "$pid" 2>/dev/null || true
        FOUND=1
    fi
done
if [ "$FOUND" -eq 0 ]; then
    echo "  none running"
else
    # Give uvicorn a moment to release the sockets, then force leftovers.
    for _ in 1 2 3 4 5 6; do
        sleep 0.5
        ALIVE=0
        for pid in $(pgrep -f 'uvicorn app.main:app' 2>/dev/null || true); do
            if is_our_backend "$pid"; then ALIVE=1; fi
        done
        [ "$ALIVE" -eq 0 ] && break
    done
    for pid in $(pgrep -f 'uvicorn app.main:app' 2>/dev/null || true); do
        if is_our_backend "$pid"; then
            echo "  force-killing PID $pid"
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
fi
sleep 1

echo
echo "=== ports $PORT / 8777 still occupied? ==="
BUSY=0
for p in "$PORT" 8777; do
    if port_busy "$p"; then
        echo "  port $p STILL OCCUPIED"
        BUSY=1
    fi
done
if [ "$BUSY" -eq 1 ]; then
    echo "  something else holds a port. Aborting." >&2
    exit 1
fi
echo "  clean"

# A production build left in frontend/dist is served by the backend's SPA
# fallback on :8777 and silently shadows every route added since it was built.
# Move it aside so a stale bundle can never masquerade as the current app.
STALE_DIST="$ROOT/frontend/dist"
if [ -d "$STALE_DIST" ]; then
    STASH="$ROOT/frontend/dist.stale"
    rm -rf "$STASH"
    mv "$STALE_DIST" "$STASH"
    echo
    echo "=== stale frontend/dist moved aside ==="
    echo "  moved to frontend/dist.stale"
    echo "  (:8777 no longer serves an out-of-date bundle; use :5173)"
fi

echo
echo "=== router credentials (values never printed) ==="
for k in NETDASH_ROUTER_USER NETDASH_ROUTER_PASS NETDASH_ROUTER_URL; do
    if grep -qE "^${k}=." backend/.env 2>/dev/null; then
        echo "  $k: set (from backend/.env)"
    else
        echo "  $k: NOT SET in backend/.env"
    fi
done

echo
echo "=== starting backend on $HOST:$PORT ==="
cd backend || exit 1
NETDASH_PORT="$PORT" "$PYTHON" -m uvicorn app.main:app \
    --host "$HOST" --port "$PORT" >server.log 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" >server.pid
sleep 6

echo
echo "=== verify on :$PORT ==="
COOKIE="$(mktemp)"
curl -s -m 8 -c "$COOKIE" -X POST "http://127.0.0.1:$PORT/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"netdash"}' >/dev/null || true
curl -s -m 8 -b "$COOKIE" "http://127.0.0.1:$PORT/api/settings" \
    | "$PYTHON" -c "
import json,sys
d=json.load(sys.stdin)
print('  kick_mode            =', d.get('kick_mode'))
print('  router_configured    =', d.get('router_configured'))
print('  env_file_found       =', d.get('env_file_found'))
" 2>/dev/null || echo "  (settings call failed - check backend/server.log)"
rm -f "$COOKIE"
COOKIE=""

echo
echo "=== now start the frontend against this port ==="
echo "  cd frontend && NETDASH_BACKEND=$PORT npm run dev"
echo "  then open http://localhost:5173"
for ip in $(hostname -I 2>/dev/null || true); do
    case "$ip" in
        *:*) ;;
        *) echo "  or from another device: http://$ip:5173" ;;
    esac
done

if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo
    echo "backend exited early - last log lines:" >&2
    tail -n 20 server.log >&2
    exit 1
fi

wait "$BACKEND_PID"
STATUS=$?
BACKEND_PID=""
rm -f server.pid
exit "$STATUS"
