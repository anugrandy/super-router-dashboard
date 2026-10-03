#!/usr/bin/env bash
# Start the netdash backend cleanly: kill stale servers, verify no duplicates,
# then run on one port. Usage:  bash run.sh [port]     (default 8000)
set -u
PORT="${1:-8000}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

echo "=== killing any netdash uvicorn still running ==="
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name like '%python%'\" | Where-Object { \$_.CommandLine -like '*super-router-dashboard*uvicorn*' } | ForEach-Object { Write-Output ('  stopping PID ' + \$_.ProcessId); Stop-Process -Id \$_.ProcessId -Force }" 2>&1 | grep -v "^$"
sleep 3

echo
echo "=== ports $PORT / 8777 still occupied? ==="
if netstat -ano | grep -E "LISTENING" | grep -qE ":($PORT|8777)\b"; then
  echo "  STILL OCCUPIED — something else is holding a port. Aborting."
  netstat -ano | grep -E "LISTENING" | grep -E ":($PORT|8777)\b"
  exit 1
fi
echo "  clean"

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
echo "=== starting backend on 127.0.0.1:$PORT ==="
cd backend || exit 1
NETDASH_PORT="$PORT" ../.venv/Scripts/python.exe -m uvicorn app.main:app \
  --host 127.0.0.1 --port "$PORT" &
BACKEND_PID=$!
sleep 6

echo
echo "=== verify on :$PORT ==="
C=$(mktemp)
curl -s -m 8 -c "$C" -X POST "http://127.0.0.1:$PORT/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"netdash"}' >/dev/null
curl -s -m 8 -b "$C" "http://127.0.0.1:$PORT/api/settings" \
  | python -c "
import json,sys
d=json.load(sys.stdin)
print('  kick_mode            =', d.get('kick_mode'))
print('  router_configured    =', d.get('router_configured'))
print('  env_file_found       =', d.get('env_file_found'))
" 2>/dev/null || echo "  (settings call failed)"
rm -f "$C"

echo
echo "=== now start the frontend against this port ==="
echo "  cd frontend && NETDASH_BACKEND=$PORT npm run dev"
echo "  then open http://localhost:5173"
wait $BACKEND_PID