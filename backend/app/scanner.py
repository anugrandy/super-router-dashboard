"""Background scan loop: sweeps the subnet, reconciles state into SQLite,
and pushes deltas to WebSocket subscribers."""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import time
from typing import Any

from sqlmodel import select

from .config import config_store
from .db import Device, DeviceEvent, ScanSample, get_session, init_db, utcnow
from .net import arp_scan, guess_device_type, lookup_vendor, normalize_mac, valid_mac

log = logging.getLogger("netdash.scanner")


class Hub:
    """Fan-out to connected WebSocket clients."""

    def __init__(self) -> None:
        self._clients: set[WebSocketClient] = set()
        self._lock = asyncio.Lock()
        self.loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self) -> None:
        """Remember the serving loop so worker threads can schedule broadcasts."""
        self.loop = asyncio.get_running_loop()

    async def connect(self, ws) -> None:
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, event: str, data: Any) -> None:
        payload = json.dumps({"event": event, "data": data}, default=str)
        dead = []
        for ws in list(self._clients):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)

    @property
    def count(self) -> int:
        return len(self._clients)


hub = Hub()

# The authoritative "who is being kicked right now" registry lives in kick.py,
# because it covers both the router-block and ARP-spoof backends. These are thin
# aliases so the scan loop can keep broadcasting without importing kick (which
# imports scanner for the hub -> circular import).


def kicked_map() -> dict[str, float]:
    """MAC -> kick start time (epoch seconds)."""
    from .kick import active_map

    return active_map()


def set_kicked(mac: str, started_at: float | None) -> None:
    from .kick import _set

    _set(mac, started_at)


def device_to_dict(d: Device, kicked: float | None = None) -> dict:
    return {
        "mac": d.mac,
        "ip": d.ip,
        "hostname": d.hostname,
        "vendor": d.vendor,
        "device_type": d.device_type,
        "nickname": d.nickname,
        "is_gateway": d.is_gateway,
        "online": d.online,
        "first_seen": d.first_seen.isoformat() if d.first_seen else None,
        "last_seen": d.last_seen.isoformat() if d.last_seen else None,
        "last_online": d.last_online.isoformat() if d.last_online else None,
        "is_static": d.is_static,
        "kicked": kicked,
    }


async def _run_scan(subnet: str, iface: str | None) -> list[dict]:
    cfg = config_store.settings
    hosts = await asyncio.to_thread(arp_scan, subnet, 2.0, iface)
    now = utcnow()
    seen_macs: set[str] = set()
    changes: list[dict] = []

    # The gateway is the first usable host in the subnet; the ARP cache is
    # authoritative for which MAC that is.
    try:
        gateway_ip = str(ipaddress.ip_network(subnet, strict=False).network_address + 1)
    except ValueError:
        gateway_ip = ""
    gateway_mac = cfg.gateway_mac or next(
        (h.mac for h in hosts if gateway_ip and h.ip == gateway_ip), None
    )
    gateway_mac = normalize_mac(gateway_mac) if gateway_mac else None

    with get_session() as s:
        for host in hosts:
            mac = normalize_mac(host.mac)
            if not valid_mac(mac):
                continue
            seen_macs.add(mac)
            is_gw = gateway_mac is not None and mac == gateway_mac
            dev = s.exec(select(Device).where(Device.mac == mac)).first()
            vendor = lookup_vendor(mac)
            if dev is None:
                dev = Device(
                    mac=mac,
                    ip=host.ip,
                    hostname=host.hostname,
                    vendor=vendor,
                    device_type=guess_device_type(
                        vendor, host.hostname, host.ip, is_gw
                    ),
                    is_gateway=is_gw,
                    first_seen=now,
                    last_seen=now,
                    last_online=now,
                    online=True,
                )
                s.add(dev)
                s.add(DeviceEvent(mac=mac, kind="online", at=now, ip=host.ip))
                changes.append({"mac": mac, "kind": "new"})
            else:
                was_online = dev.online
                gw_changed = is_gw != dev.is_gateway
                if host.ip:
                    dev.ip = host.ip
                if host.hostname:
                    dev.hostname = host.hostname
                if vendor and not dev.vendor:
                    dev.vendor = vendor
                dev.is_gateway = is_gw
                # Re-type when the device was unclassified, or when its
                # gateway status changed. Manual nicknames are untouched.
                if dev.device_type == "unknown" or gw_changed:
                    dev.device_type = guess_device_type(
                        dev.vendor, dev.hostname, dev.ip, is_gw
                    )
                dev.last_seen = now
                if not was_online:
                    dev.online = True
                    dev.last_online = now
                    s.add(DeviceEvent(mac=mac, kind="online", at=now, ip=dev.ip))
                    changes.append({"mac": mac, "kind": "online"})

        # Anything not answering now is offline — including a kicked device,
        # which stops replying once the spoof takes effect. That's the signal
        # the kick is working, so don't special-case it.
        for dev in s.exec(select(Device)).all():
            if dev.mac not in seen_macs and dev.online:
                dev.online = False
                s.add(DeviceEvent(mac=dev.mac, kind="offline", at=now, ip=dev.ip))
                changes.append({"mac": dev.mac, "kind": "offline"})

        online = s.exec(select(Device).where(Device.online == True)).all()  # noqa: E712
        total = s.exec(select(Device)).all()
        s.add(ScanSample(online=len(online), total=len(total)))
        s.commit()

        return [device_to_dict(d) for d in total]


async def scan_loop() -> None:
    """Runs for the app's lifetime; interval is re-read each pass so the
    settings page can change it without a restart."""
    hub.bind_loop()
    init_db()
    await asyncio.sleep(1.0)
    while True:
        cfg = config_store.settings
        try:
            devices = await _run_scan(cfg.subnet, cfg.interface)
            await hub.broadcast("devices", devices)
            await hub.broadcast("kicked", kicked_map())
        except Exception as e:  # keep the loop alive through transient errors
            log.warning("scan failed: %s", e)
            await hub.broadcast("error", str(e))
        await asyncio.sleep(max(cfg.scan_interval, 5.0))


async def trigger_scan() -> None:
    """Fire a one-off scan without awaiting it."""
    asyncio.create_task(scan_loop_once())


_scan_lock = asyncio.Lock()


async def scan_loop_once() -> None:
    """Run a single scan. Skipped if one is already in flight."""
    if _scan_lock.locked():
        return
    async with _scan_lock:
        cfg = config_store.settings
        try:
            devices = await _run_scan(cfg.subnet, cfg.interface)
            await hub.broadcast("devices", devices)
            await hub.broadcast("kicked", kicked_map())
        except Exception as e:
            log.warning("manual scan failed: %s", e)
