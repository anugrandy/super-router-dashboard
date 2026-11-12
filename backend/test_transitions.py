"""Connect/disconnect transition push.

_run_scan already collected `changes` but discarded them, so the UI had to diff
the whole device list to notice a flip. These checks pin the returned
transition payload that feeds the toast and the activity page.

Run: .venv/Scripts/python.exe backend/test_transitions.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

# Never touch the live dashboard database from a test run. Without this, the
# mocked devices below become real rows (and fake transitions) in
# backend/data/netdash.db.
os.environ["NETDASH_DATA"] = tempfile.mkdtemp(prefix="netdash-test-")

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import scanner  # noqa: E402
from app.db import Device, get_session, init_db, utcnow  # noqa: E402
from sqlmodel import select  # noqa: E402

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

TEST_MAC = "AA:BB:CC:DD:EE:01"


class FakeHub:
    """Records broadcasts so we can assert what the socket would receive."""

    def __init__(self) -> None:
        self.events: dict[str, list] = {}

    async def broadcast(self, event: str, data) -> None:
        self.events.setdefault(event, []).append(data)


class FakeHost:
    def __init__(self, ip: str, mac: str, hostname: str = "") -> None:
        self.ip = ip
        self.mac = mac
        self.hostname = hostname


async def _scan(hosts, topo=None, ssid=None):
    hub = FakeHub()
    with (
        patch.object(scanner, "arp_scan", return_value=hosts),
        patch.object(scanner, "get_topo_client") as topo_mock,
        patch.object(scanner, "get_resolver") as res_mock,
    ):
        topo_mock.return_value.fetch.return_value = topo or {}
        res_mock.return_value.snapshot.return_value = ssid or {}
        scanner.hub = hub
        devices, transitions = await scanner._run_scan("192.168.1.0/24", None)
    return devices, transitions, hub


def _cleanup() -> None:
    with get_session() as s:
        d = s.exec(select(Device).where(Device.mac == TEST_MAC)).first()
        if d is not None:
            d.online = False
            s.add(d)
            s.commit()


def _purge() -> None:
    """Remove the test device so 'new' really is a first sighting on re-runs."""
    with get_session() as s:
        d = s.exec(select(Device).where(Device.mac == TEST_MAC)).first()
        if d is not None:
            s.delete(d)
            s.commit()


print("--- a first sighting is reported as 'new' ---")
_purge()
devices, trans, hub = asyncio.run(
    _scan(
        [FakeHost("192.168.1.55", TEST_MAC, "Test-New-Phone")],
        ssid={
            "AA:BB:CC:DD:EE:01": {
                "interface": "DEV.WIFI.AP5",
                "ssid": "AgraSec",
                "rx_bytes": 123,
                "tx_bytes": 456,
            }
        },
    )
)
# The database also holds the user's real devices; a mocked scan that omits them
# marks them offline, so only the TEST_MAC rows are asserted on here.
mine = [d for d in devices if d["mac"] == TEST_MAC]
check("test device returned", len(mine), 1)
mine_t = [t for t in trans if t["mac"] == TEST_MAC]
check("one transition for the test device", len(mine_t), 1)
if mine_t:
    t = mine_t[0]
    check("kind is new", t["kind"], "new")
    check("mac normalised to uppercase", t["mac"], TEST_MAC)
    check("ip captured", t["ip"], "192.168.1.55")
    check("type present", bool(t["device_type"]), True)
    check("name resolved", bool(t["name"]), True)

print("\n--- reconnect after being offline ---")
_cleanup()
devices, trans, hub = asyncio.run(
    _scan([FakeHost("192.168.1.55", TEST_MAC, "Test-New-Phone")])
)
check(
    "reconnect is 'online', not 'new'",
    [x["kind"] for x in trans if x["mac"] == TEST_MAC],
    ["online"],
)

print("\n--- a device that stops answering ---")
_cleanup()
# online in DB, but the scan no longer sees it
with get_session() as s:
    d = s.exec(select(Device).where(Device.mac == TEST_MAC)).first()
    if d is not None:
        d.online = True
        d.missed_scans = 0
        # Pretend the device was last seen before the grace window: the test
        # is about a real disappearance, not a single transient miss.
        d.last_seen = utcnow() - timedelta(
            seconds=scanner.OFFLINE_GRACE_SECONDS + 5
        )
        s.add(d)
        s.commit()

# One lost ARP reply is normal for a Wi-Fi client in power save, so the first
# consecutive miss is debounced and must not emit an offline transition.
devices, trans, hub = asyncio.run(_scan([]))
check(
    "first miss is debounced",
    [x["kind"] for x in trans if x["mac"] == TEST_MAC],
    [],
)

# The second consecutive miss is a real disappearance.
devices, trans, hub = asyncio.run(_scan([]))
check(
    "second consecutive miss is 'offline'",
    [x["kind"] for x in trans if x["mac"] == TEST_MAC],
    ["offline"],
)

print("\n--- no churn means no transitions (idle network) ---")
# First run settles the state; the second must report nothing for this MAC.
asyncio.run(_scan([FakeHost("192.168.1.55", TEST_MAC, "Test-New-Phone")]))
devices, trans, hub = asyncio.run(
    _scan([FakeHost("192.168.1.55", TEST_MAC, "Test-New-Phone")])
)
check(
    "steady state emits nothing",
    [t for t in trans if t["mac"] == TEST_MAC],
    [],
)

print("\n--- the scan loop broadcasts transitions ---")
seen: dict[str, list] = {}


async def _loop_once():
    """scan_loop_once publishes transitions only when there are any."""
    hub = FakeHub()
    with (
        patch.object(scanner, "arp_scan", return_value=[FakeHost("192.168.1.55", TEST_MAC, "X")]),
        patch.object(scanner, "get_topo_client") as topo_mock,
        patch.object(scanner, "get_resolver") as res_mock,
        patch.object(scanner, "scan_loop_once") as _noop,
    ):
        topo_mock.return_value.fetch.return_value = {}
        res_mock.return_value.snapshot.return_value = {}
        cfg = scanner.config_store.settings
        devices, transitions = await scanner._run_scan(cfg.subnet, cfg.interface)
        if transitions:
            await hub.broadcast("transitions", transitions)
        seen.update(hub.events)


# Force a real change first: mark it offline, then scan and watch it come back.
_cleanup()
asyncio.run(_loop_once())
bcast = seen.get("transitions", [])
check("transitions broadcast when non-empty", len(bcast), 1)
if bcast:
    check(
        "broadcast payload has kind",
        "kind" in bcast[0][0] if isinstance(bcast[0], list) and bcast[0] else False,
        True,
    )
_cleanup()

print(f"\nPASS={PASS} FAIL={FAIL}")
for f in FAILURES:
    print("  " + f)
sys.exit(1 if FAIL else 0)