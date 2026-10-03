# Start the netdash backend cleanly. PowerShell version of run.sh.
#   .\run.ps1            -> port 8000
#   .\run.ps1 -Port 9000
#
# Kills stale uvicorn processes first, so you never end up with two backends
# and a UI silently talking to the wrong one.

param([int]$Port = 8000)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host "=== killing any netdash uvicorn still running ===" -ForegroundColor Cyan
$procs = Get-CimInstance Win32_Process -Filter "Name like '%python%'" |
    Where-Object { $_.CommandLine -like '*super-router-dashboard*uvicorn*' }
if ($procs) {
    foreach ($p in $procs) {
        Write-Host ("  stopping PID {0}" -f $p.ProcessId)
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "  none running"
}
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "=== ports $Port / 8777 still occupied? ===" -ForegroundColor Cyan
$busy = netstat -ano | Select-String "LISTENING" | Select-String ":($Port|8777)\s"
if ($busy) {
    Write-Host "  STILL OCCUPIED - something else holds a port. Aborting." -ForegroundColor Red
    $busy | ForEach-Object { Write-Host "    $_" }
    exit 1
}
Write-Host "  clean"

Write-Host ""
Write-Host "=== router credentials (values never printed) ===" -ForegroundColor Cyan
foreach ($k in @("NETDASH_ROUTER_USER", "NETDASH_ROUTER_PASS", "NETDASH_ROUTER_URL")) {
    $hit = Select-String -Path "backend\.env" -Pattern "^${k}=." -Quiet -ErrorAction SilentlyContinue
    if ($hit) {
        Write-Host ("  {0}: set (from backend/.env)" -f $k)
    } else {
        Write-Host ("  {0}: NOT SET in backend/.env" -f $k) -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "=== starting backend on 127.0.0.1:$Port ===" -ForegroundColor Cyan
$env:NETDASH_PORT = "$Port"
Set-Location backend

# Launch detached. Start-Process on cmd.exe (not -NoNewWindow) returns
# immediately; launching python.exe directly with -NoNewWindow would keep this
# script's process alive and the script would never return.
$cmd = "cd /d `"$Root\backend`" && `"$Root\.venv\Scripts\python.exe`" -m uvicorn app.main:app --host 127.0.0.1 --port $Port > server.log 2>&1"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd -WindowStyle Minimized

Start-Sleep -Seconds 8
Set-Location $Root

Write-Host ""
Write-Host "=== verify on :$Port ===" -ForegroundColor Cyan
$cj = Join-Path $env:TEMP "netdash_verify.txt"
$login = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/auth/login" `
    -Method POST -ContentType "application/json" `
    -Body '{"username":"admin","password":"netdash"}' `
    -SessionVariable s -UseBasicParsing -ErrorAction SilentlyContinue
if ($login) {
    Write-Host ("  login: {0}" -f $login.Content) -ForegroundColor Green
    $st = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/settings" `
        -WebSession $s -UseBasicParsing -ErrorAction SilentlyContinue
    if ($st) {
        $j = $st.Content | ConvertFrom-Json
        Write-Host ("  kick_mode         = {0}" -f $j.kick_mode)
        Write-Host ("  router_configured = {0}" -f $j.router_configured)
        Write-Host ("  env_file_found    = {0}" -f $j.env_file_found)
    }
} else {
    Write-Host "  backend did not answer - check the log above" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== next: start the frontend ===" -ForegroundColor Cyan
Write-Host "  cd frontend && npm run dev"
Write-Host "  then open http://localhost:5173   (localhost, not 127.0.0.1)"
