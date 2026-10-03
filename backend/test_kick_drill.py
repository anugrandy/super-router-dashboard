"""Live kick drill: start a spoof, watch it auto-expire, confirm restore ran.

Requires raw-socket rights to be genuinely effective. Without them scapy
falls back to broadcast L2 sends and the target is not actually cut off --
the drill still exercises start/stop/logging, and says so explicitly.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlmodel import select  # noqa: E402

from app import net  # noqa: E402
from app.db import KickLog, get_session, init_db, utcnow  # noqa: E402
from app.scapy_arp import (  # noqa: E402
    _local_mac,
    resolve_iface,
    send_restore,
    send_spoof,
)

SUBNET = "192.168.1.0/24"
TARGET_IP = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.4"
DURATION = int(sys.argv[2]) if len(sys.argv) > 2 else 10
# Each send() costs a couple of seconds on Windows, so allow generous slack
# past the requested duration before declaring the auto-stop broken.
SLACK = 20

init_db()

print(f"scanning {SUBNET} for {TARGET_IP} ...")

# The classic "kick does nothing" cause: not running as Administrator, so the
# raw socket silently fails to transmit.
import ctypes  # noqa: E402

try:
    is_admin = bool(ctypes.windll.shell32.IsUserAnAdmin())
except Exception:
    is_admin = os.name != "nt"
print(f"admin rights: {is_admin}")
if not is_admin:
    print("  WARNING: not elevated — ARP spoof frames will NOT reach the LAN.")
    print("           Restart with 'Run as Administrator' for kick to work.")

hosts = net.arp_scan(SUBNET, 2.0)
host = next((h for h in hosts if h.ip == TARGET_IP), None)
if not host:
    print(f"FAIL  {TARGET_IP} not found in ARP cache")
    raise SystemExit(1)
print(f"target       {host.ip}  {host.mac}")

local_ip = net.detect_local_ip(SUBNET)
gw_mac = next((h.mac for h in hosts if h.ip == "192.168.1.1"), None)
our_mac = _local_mac(local_ip)
iface = resolve_iface(local_ip)
print(f"local ip     {local_ip}")
print(f"gateway mac  {gw_mac}")
print(f"our mac      {our_mac}")
print(f"send iface   {getattr(iface, 'name', None)} ({getattr(iface, 'guid', None)})")

if iface is not None and "vmware" in str(getattr(iface, "name", "")).lower():
    print("FAIL  resolved to a VMware adapter; spoof would never reach the LAN")
    raise SystemExit(1)

if our_mac == "00:00:00:00:00:00":
    print("\nWARNING: could not determine this host's MAC; the spoof source will be bogus.")

if gw_mac and gw_mac.lower() == our_mac:
    print("FAIL  our MAC equals the gateway MAC; refusing to run the drill")
    raise SystemExit(1)

t = net.KickTarget(
    mac=host.mac,
    ip=host.ip,
    gateway_ip="192.168.1.1",
    gateway_mac=gw_mac or "00:00:00:00:00:00",
    local_ip=local_ip or "192.168.1.3",
    reason="automated drill",
)

with get_session() as s:
    row = KickLog(mac=t.mac, ip=t.ip, actor="drill", reason=t.reason, active=True)
    s.add(row)
    s.commit()
    s.refresh(row)
    log_id = row.id
print(f"kick log     #{log_id}")

# Time a single spoof send so we know what the heartbeat costs.
s0 = time.time()
send_spoof(t)
print(f"single spoof send costs {time.time() - s0:.2f}s")

print(f"\nstarting spoof, max {DURATION}s ...")
net.engine.start(t, max_seconds=DURATION)
assert net.engine.is_active(t.mac) is not None, "start() did not register the target"
print("  registered: True")

t0 = time.time()
while time.time() - t0 < DURATION + SLACK:
    if net.engine.is_active(t.mac) is None:
        break
    time.sleep(0.25)

elapsed = time.time() - t0
auto_stopped = net.engine.is_active(t.mac) is None
print(f"\nauto-stopped:  {auto_stopped} after {elapsed:.1f}s (budget {DURATION + SLACK}s)")
print(f"stop flag set: {t._stop.is_set()}")

with get_session() as s:
    rows = s.exec(select(KickLog).where(KickLog.id == log_id)).all()
    if rows:
        r = rows[0]
        r.active = False
        r.ended_at = utcnow()
        r.duration_seconds = int((r.ended_at - r.started_at).total_seconds())
        s.add(r)
        s.commit()
        s.refresh(r)
        print(f"log closed:    active={r.active} duration={r.duration_seconds}s")

print("\nforcing a final restore (idempotent) ...")
send_restore(t)
time.sleep(2.0)
back = [h for h in net.arp_table_fallback(SUBNET) if h.ip == TARGET_IP]
print(f"target in ARP cache after restore: {bool(back)} -> {back}")

net.engine.stop_all()
checks = {
    "auto-stopped within budget": auto_stopped,
    "stop flag set": t._stop.is_set(),
    "no targets left registered": len(net.engine.active()) == 0,
    "our mac is real (not all-zero)": our_mac != "00:00:00:00:00:00",
    "target back in arp cache": bool(back),
    "send iface is the LAN adapter": getattr(iface, "ip", None) == local_ip,
    "send iface is not virtual": "vmware" not in str(getattr(iface, "name", "")).lower(),
}
print()
for name, ok in checks.items():
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
result = all(checks.values())
print(f"\nRESULT: {'PASS' if result else 'FAIL'}")
if not is_admin:
    print("\nnote: this run was NOT elevated, so the iPhone may well keep working")
    print("      regardless. Re-run as Administrator for a true test.")
else:
    print("\nnote: the target should have lost internet access during the spoof.")
    print("      If it didn't, check that the client isn't on a separate VLAN/band.")
raise SystemExit(0 if result else 1)