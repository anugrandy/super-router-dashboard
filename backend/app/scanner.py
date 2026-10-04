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
from .db import (
    Device,
    DeviceApSeen,
    DeviceEvent,
    ScanSample,
    get_session,
    init_db,
    utcnow,
)
from .net import arp_scan, guess_device_type, lookup_vendor, normalize_mac, valid_mac
from .fingerprint import (
    fingerprint,
    friendly_name,
    is_confident,
    is_randomized_mac,
)
from .topo_client import get_client as get_topo_client
from .ssid_resolver import get_resolver

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


def _record_ap_seen(session, mac: str, interface: str, ssid: str, now) -> None:
    """Note that this MAC is associated with this AP, first/last seen and a count.

    One row per (mac, interface). The union across rows is what a kick must
    cover, because a roaming client reappears on a different AP with the same
    MAC.
    """
    if not interface:
        return
    row = session.exec(
        select(DeviceApSeen).where(
            DeviceApSeen.mac == mac, DeviceApSeen.interface == interface
        )
    ).first()
    if row is None:
        session.add(
            DeviceApSeen(
                mac=mac,
                interface=interface,
                ssid_name=ssid,
                first_seen=now,
                last_seen=now,
                times_seen=1,
            )
        )
    else:
        row.last_seen = now
        row.times_seen = (row.times_seen or 0) + 1
        if ssid:
            row.ssid_name = ssid
        session.add(row)


def device_to_dict(d: Device, kicked: float | None = None) -> dict:
    return {
        "mac": d.mac,
        "ip": d.ip,
        "hostname": d.hostname,
        "vendor": d.vendor,
        "nickname": d.nickname,
        "is_gateway": d.is_gateway,
        "online": d.online,
        "first_seen": d.first_seen.isoformat() if d.first_seen else None,
        "last_seen": d.last_seen.isoformat() if d.last_seen else None,
        "last_online": d.last_online.isoformat() if d.last_online else None,
        "is_static": d.is_static,
        # Effective type: the manual override when set, else the auto guess.
        "device_type": d.type_override or d.device_type,
        "guessed_type": d.device_type,
        "type_override": d.type_override,
        # Router-reported link info. Rates only - see app/fingerprint.py on
        # why there is no cumulative byte counter for this firmware.
        "rx_rate_bps": d.rx_rate_bps,
        "tx_rate_bps": d.tx_rate_bps,
        "link_band": d.link_band,
        # The AP this device is really on, and its SSID name. Access Control
        # rules must target this interface, not a default.
        "wifi_interface": d.wifi_interface,
        "ssid_name": d.ssid_name,
        # Cumulative bytes from the router (RXBytes/TXBytes), not rates.
        "rx_bytes": d.rx_bytes,
        "tx_bytes": d.tx_bytes,
        "data_total_bytes": d.rx_bytes + d.tx_bytes,
        "randomized_mac": is_randomized_mac(d.mac),
        # False when there is no hostname, no vendor and no link-type evidence,
        # so the UI can ask the user to pick a type instead of implying it knows.
        "type_confident": is_confident(
            d.mac,
            hostname=d.hostname,
            vendor=d.vendor,
            gateway=d.is_gateway,
        ),
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

    # Validate a manually pinned gateway. Auto-detection (the host answering
    # .1) is authoritative; a pinned MAC is a user override and is honoured,
    # but only when that MAC is actually present in this scan. A stale value
    # would otherwise put the Gateway badge on an unrelated device.
    if gateway_mac and gateway_ip:
        live_macs = {normalize_mac(h.mac) for h in hosts}
        if gateway_mac not in live_macs:
            log.warning(
                "pinned gateway_mac %s not seen in this scan; "
                "falling back to auto-detection",
                gateway_mac,
            )
            gateway_mac = next(
                (normalize_mac(h.mac) for h in hosts if h.ip == gateway_ip), None
            )

    # Router-side client info: DHCP hostnames and link rates. Best-effort -
    # a router that is down or does not expose the page must not stop a scan.
    try:
        topo = get_topo_client().fetch()
    except Exception as e:  # noqa: BLE001
        log.info("router client info unavailable: %s", e)
        topo = {}

    # Per-device AP association + cumulative byte counters, from the router's
    # WLAN Client Status table. This is the only source that names the exact AP
    # (DEV.WIFI.APn) a client is on, which Access Control rules require.
    try:
        ssid_map = get_resolver().snapshot()
    except Exception as e:  # noqa: BLE001
        log.info("router SSID info unavailable: %s", e)
        ssid_map = {}

    with get_session() as s:
        for host in hosts:
            mac = normalize_mac(host.mac)
            if not valid_mac(mac):
                continue
            seen_macs.add(mac)
            is_gw = gateway_mac is not None and mac == gateway_mac
            dev = s.exec(select(Device).where(Device.mac == mac)).first()
            vendor = lookup_vendor(mac)
            # Prefer the router's DHCP hostname over the ARP-scan reverse DNS:
            # the router is authoritative for the name the device advertises.
            ci = topo.get(mac)
            router_hostname = ci.hostname if ci else ""
            # AP association + cumulative usage from wlan_client_stat.
            sm = ssid_map.get(mac, {})
            wifi_iface = str(sm.get("interface") or "")
            ssid_name = str(sm.get("ssid") or "")
            rx_bytes = int(sm.get("rx_bytes") or 0)
            tx_bytes = int(sm.get("tx_bytes") or 0)
            dhcp_hostname = router_hostname or host.hostname
            is_wireless = ci.is_wireless if ci else None
            _, guess = fingerprint(
                mac,
                hostname=dhcp_hostname,
                vendor=vendor,
                ip=host.ip,
                is_wireless=is_wireless,
                gateway=is_gw,
            )
            if dev is None:
                dev = Device(
                    mac=mac,
                    ip=host.ip,
                    hostname=dhcp_hostname,
                    vendor=vendor,
                    device_type=guess,
                    rx_rate_bps=ci.rx_rate_bps if ci else 0,
                    tx_rate_bps=ci.tx_rate_bps if ci else 0,
                    link_band=ci.band if ci else "",
                    wifi_interface=wifi_iface,
                    ssid_name=ssid_name,
                    rx_bytes=rx_bytes,
                    tx_bytes=tx_bytes,
                    is_gateway=is_gw,
                    first_seen=now,
                    last_seen=now,
                    last_online=now,
                    online=True,
                )
                s.add(dev)
                _record_ap_seen(s, mac, wifi_iface, ssid_name, now)
                s.add(DeviceEvent(mac=mac, kind="online", at=now, ip=host.ip))
                changes.append({"mac": mac, "kind": "new"})
            else:
                was_online = dev.online
                gw_changed = is_gw != dev.is_gateway
                if host.ip:
                    dev.ip = host.ip
                if dhcp_hostname and dhcp_hostname != dev.hostname:
                    dev.hostname = dhcp_hostname
                if vendor and not dev.vendor:
                    dev.vendor = vendor
                if ci is not None:
                    dev.rx_rate_bps = ci.rx_rate_bps
                    dev.tx_rate_bps = ci.tx_rate_bps
                    dev.link_band = ci.band
                if wifi_iface:
                    dev.wifi_interface = wifi_iface
                if ssid_name:
                    dev.ssid_name = ssid_name
                if rx_bytes:
                    dev.rx_bytes = rx_bytes
                if tx_bytes:
                    dev.tx_bytes = tx_bytes
                dev.is_gateway = is_gw
                # Re-type when the stored value might have come from an older,
                # weaker rule, or when gateway status changed. "router" is
                # included on purpose: clients behind a ZTE access point were
                # previously stored as router and would never be re-examined.
                # A manual type_override always wins.
                if (
                    not dev.type_override
                    and dev.device_type in ("unknown", "other", "router", "")
                ) or gw_changed:
                    dev.device_type = fingerprint(
                        mac,
                        hostname=dev.hostname,
                        vendor=dev.vendor,
                        ip=dev.ip,
                        is_wireless=is_wireless,
                        gateway=is_gw,
                    )[1]
                dev.last_seen = now
                # Record every AP this MAC has ever been seen on. A kick has to
                # cover all of them, not just the current one, or the device can
                # simply rejoin on the other band.
                _record_ap_seen(s, mac, wifi_iface, ssid_name, now)
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

        # Return the transitions alongside the device list. The UI could diff
        # the list itself, but the scanner already knows exactly what changed
        # (including which device is genuinely new), so sending it avoids every
        # client re-deriving the same information on every scan.
        payload = [device_to_dict(d) for d in total]
        by_mac = {d["mac"]: d for d in payload}
        transitions = []
        for ch in changes:
            d = by_mac.get(ch["mac"])
            if d is None:
                continue
            transitions.append(
                {
                    "mac": ch["mac"],
                    "kind": ch["kind"],
                    "name": friendly_name(
                        hostname=d.get("hostname") or "",
                        vendor=d.get("vendor") or "",
                        ip=d.get("ip") or "",
                        mac=ch["mac"],
                        device_type=d.get("device_type") or "other",
                    ),
                    "ip": d.get("ip") or "",
                    "device_type": d.get("device_type") or "other",
                }
            )
        return payload, transitions


async def scan_loop() -> None:
    """Runs for the app's lifetime; interval is re-read each pass so the
    settings page can change it without a restart."""
    hub.bind_loop()
    init_db()
    await asyncio.sleep(1.0)
    while True:
        cfg = config_store.settings
        try:
            devices, transitions = await _run_scan(cfg.subnet, cfg.interface)
            await hub.broadcast("devices", devices)
            await hub.broadcast("kicked", kicked_map())
            if transitions:
                await hub.broadcast("transitions", transitions)
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
            devices, transitions = await _run_scan(cfg.subnet, cfg.interface)
            await hub.broadcast("devices", devices)
            await hub.broadcast("kicked", kicked_map())
            if transitions:
                await hub.broadcast("transitions", transitions)
        except Exception as e:
            log.warning("manual scan failed: %s", e)
