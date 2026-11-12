"""Network profile identity and scoping checks.

The subtle part of this feature is deciding when two scans describe the same
network. Gateway MAC wins; subnet + gateway IP is only a fallback and may be
upgraded once a MAC becomes known — but two different MACs must never merge.

Run: .venv/bin/python backend/test_profiles.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# Never touch the live dashboard database from a test run.
os.environ["NETDASH_DATA"] = tempfile.mkdtemp(prefix="netdash-profiles-test-")

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlmodel import select  # noqa: E402

from app import profiles  # noqa: E402
from app.db import (  # noqa: E402
    Device,
    NetworkProfile,
    get_session,
    init_db,
)

PASS = FAIL = 0
FAILURES: list[str] = []


def check(name: str, got, want) -> None:
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        FAILURES.append(f"{name}: got {got!r}, want {want!r}")
        print(f"FAIL  {name}: got {got!r}, want {want!r}")


init_db()

print("--- fingerprint identity ---")
check(
    "gateway MAC wins over subnet",
    profiles.fingerprint_key("aa:bb:cc:dd:ee:ff", "10.0.0.0/24", "10.0.0.1"),
    "gw:AA:BB:CC:DD:EE:FF",
)
check(
    "no MAC falls back to subnet + gateway IP",
    profiles.fingerprint_key("", "192.168.1.0/24", "192.168.1.1"),
    "net:192.168.1.0/24|192.168.1.1",
)
check(
    "different subnets differ without a MAC",
    profiles.fingerprint_key("", "192.168.1.0/24")
    != profiles.fingerprint_key("", "10.0.0.0/24"),
    True,
)
check(
    "different gateway MACs differ on the same subnet",
    profiles.fingerprint_key("AA:AA:AA:AA:AA:01", "192.168.1.0/24")
    != profiles.fingerprint_key("BB:BB:BB:BB:BB:02", "192.168.1.0/24"),
    True,
)

print("--- create, reuse, activate ---")
with get_session() as s:
    p1, prev, created = profiles.resolve_and_activate(
        s,
        gateway_mac="AA:AA:AA:AA:AA:01",
        subnet="192.168.1.0/24",
        gateway_ip="192.168.1.1",
        ssid="Rumah",
    )
    check("first scan creates a profile", created, True)
    check("auto name starts at Jaringan 1", p1.name, "Jaringan 1")
    check("first profile is active", p1.is_active, True)
    check("no previous active profile", prev, None)

with get_session() as s:
    p1b, prev, created = profiles.resolve_and_activate(
        s,
        gateway_mac="aa:aa:aa:aa:aa:01",
        subnet="192.168.1.0/24",
        gateway_ip="192.168.1.1",
        ssid="Rumah",
    )
    check("same gateway reuses the profile", created, False)
    check("same gateway keeps the id", p1b.id, p1.id)
    check("same gateway is not a change", prev is None or prev.id == p1.id, True)

print("--- switching networks ---")
with get_session() as s:
    p2, prev, created = profiles.resolve_and_activate(
        s,
        gateway_mac="BB:BB:BB:BB:BB:02",
        subnet="10.20.0.0/24",
        gateway_ip="10.20.0.1",
        ssid="Kafe",
    )
    check("second gateway creates a profile", created, True)
    check("second auto name increments", p2.name, "Jaringan 2")
    check("previous active is reported", prev.id if prev else None, p1.id)
    check("new profile is active", p2.is_active, True)
    check(
        "old profile is deactivated",
        s.get(NetworkProfile, p1.id).is_active,
        False,
    )

print("--- fallback adoption rules ---")
with get_session() as s:
    fallback = NetworkProfile(
        name="Jaringan 3",
        fingerprint=profiles.fingerprint_key("", "172.16.0.0/24", "172.16.0.1"),
        gateway_mac="",
        subnet="172.16.0.0/24",
        gateway_ip="172.16.0.1",
        is_active=False,
    )
    s.add(fallback)
    s.commit()
    s.refresh(fallback)
    fid = fallback.id

with get_session() as s:
    adopted, _prev, created = profiles.resolve_and_activate(
        s,
        gateway_mac="CC:CC:CC:CC:CC:03",
        subnet="172.16.0.0/24",
        gateway_ip="172.16.0.1",
    )
    check("fallback profile is adopted when its MAC appears", adopted.id, fid)
    check("adoption does not create a row", created, False)
    check(
        "adopted fingerprint upgrades to the MAC",
        adopted.fingerprint,
        "gw:CC:CC:CC:CC:CC:03",
    )
    check("adopted profile gains the MAC", adopted.gateway_mac, "CC:CC:CC:CC:CC:03")

with get_session() as s:
    other, _prev, created = profiles.resolve_and_activate(
        s,
        gateway_mac="DD:DD:DD:DD:DD:04",
        subnet="172.16.0.0/24",
        gateway_ip="172.16.0.1",
    )
    check("a different MAC on the same subnet is a new profile", created, True)
    check("a different MAC never merges into an existing one", other.id != fid, True)

print("--- per-profile device rows ---")
SHARED = "11:22:33:44:55:66"
with get_session() as s:
    s.add(Device(network_profile_id=p1.id, mac=SHARED, ip="192.168.1.9"))
    s.add(Device(network_profile_id=p2.id, mac=SHARED, ip="10.20.0.9"))
    s.commit()
    rows = s.exec(select(Device).where(Device.mac == SHARED)).all()
    check("same MAC exists once per profile", len(rows), 2)
    check(
        "the two rows belong to different profiles",
        {r.network_profile_id for r in rows},
        {p1.id, p2.id},
    )

print("--- list ordering ---")
with get_session() as s:
    ordered = profiles.all_profiles(s)
    current = profiles.active(s)
    check("active profile is listed first", ordered[0].id, current.id)
    check("the remaining profiles keep id order", [p.id for p in ordered[1:]], sorted(p.id for p in ordered[1:]))
    snap = profiles.snapshot()
    check("snapshot reports the active id", snap["active_id"], current.id)
    check(
        "snapshot counts devices per profile",
        next(p["device_count"] for p in snap["profiles"] if p["id"] == p1.id),
        1,
    )

print()
if FAILURES:
    print(f"{FAIL} failure(s):")
    for f in FAILURES:
        print("  -", f)
print(f"PASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
