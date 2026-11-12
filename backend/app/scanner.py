"""Background scan loop: sweeps the subnet, reconciles state into SQLite,
and pushes deltas to WebSocket subscribers."""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from sqlmodel import select

from . import profiles
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
from .net import (
    FoundHost,
    arp_scan,
    detect_active_network,
    detect_interface,
    guess_device_type,
    local_device_type,
    local_identity,
    local_os_info,
    lookup_vendor,
    normalize_mac,
    ping_ttl,
    reset_scan_health,
    scan_health,
    valid_mac,
)
from .fingerprint import (
    fingerprint,
    friendly_name,
    guess_os,
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


def _record_ap_seen(
    session, network_profile_id: int, mac: str, interface: str, ssid: str, now
) -> None:
    """Note that this MAC is associated with this AP, first/last seen and a count.

    One row per (profile, mac, interface). The union across rows is what a kick
    must cover, because a roaming client reappears on a different AP with the
    same MAC. Scoping by profile keeps two networks' AP history from mixing.
    """
    if not interface:
        return
    row = session.exec(
        select(DeviceApSeen).where(
            DeviceApSeen.network_profile_id == network_profile_id,
            DeviceApSeen.mac == mac,
            DeviceApSeen.interface == interface,
        )
    ).first()
    if row is None:
        session.add(
            DeviceApSeen(
                network_profile_id=network_profile_id,
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
        "profile_id": d.network_profile_id,
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
        # True only for the machine running this backend. ARP cannot see its
        # own sender, so the scanner injects it deliberately.
        "is_self": d.is_self,
        # Best-effort OS guess and how much evidence supports it.
        "os_guess": d.os_guess,
        "os_confidence": d.os_confidence,
        "os_evidence": d.os_evidence,
        # Effective type: the manual override when set, else the auto guess.
        "device_type": d.type_override or d.device_type,
        "guessed_type": d.device_type,
        "type_override": d.type_override,
        # Honest confidence for the type, mirroring os_confidence. A manual
        # override is certain, a fingerprint with evidence is high, a weak
        # vendor/hostname hint is medium, and a bare guess is low.
        "type_confidence": (
            "high"
            if d.type_override or d.is_self or d.is_gateway
            else (
                "high"
                if is_confident(
                    d.mac,
                    hostname=d.hostname,
                    vendor=d.vendor,
                    gateway=d.is_gateway,
                )
                else "medium"
                if (d.vendor or d.hostname)
                else "low"
            )
        ),
        # User-chosen simple-icons slug, or "" to keep auto-detection.
        "brand_override": d.brand_override,
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


# TTL probes are cached because an OS does not change between scans. A positive
# reading is good for six hours; a failure (ICMP blocked / host asleep) retries
# after ten minutes so a device that just woke up is not stuck as unknown.
_TTL_CACHE: dict[str, tuple[float, int | None]] = {}
_TTL_OK_SECONDS = 6 * 3600
_TTL_MISS_SECONDS = 10 * 60

# A device must be absent for this many consecutive scans *and* for longer
# than the grace window before it is called offline. A single lost ARP reply,
# or a router client table that briefly drops an idle phone, is common and must
# not show up as a real disconnect. A kick bypasses both.
OFFLINE_AFTER_MISSES = 2
OFFLINE_GRACE_SECONDS = 120.0


def _cached_ttl(ip: str, now: float) -> tuple[bool, int | None]:
    hit = _TTL_CACHE.get(ip)
    if hit is None:
        return False, None
    at, ttl = hit
    age = now - at
    if ttl is not None and age < _TTL_OK_SECONDS:
        return True, ttl
    if ttl is None and age < _TTL_MISS_SECONDS:
        return True, None
    return False, None


def _cached_ttls(hosts: list) -> dict[str, int | None]:
    """Return only TTLs already known, without touching the network.

    OS detection is a separate, slower probe cycle. Liveness must never wait
    on it: a 1s ping per unknown host used to stretch the scan cycle and make
    the sweep miss its own deadline.
    """
    now = time.time()
    out: dict[str, int | None] = {}
    for h in hosts:
        ip = getattr(h, "ip", "")
        if not ip or getattr(h, "is_self", False):
            continue
        cached, ttl = _cached_ttl(ip, now)
        if cached:
            out[ip] = ttl
    return out


_ttl_probe_lock = threading.Lock()
_ttl_probe_active = False


def _schedule_ttl_probes(hosts: list) -> None:
    """Probe unknown TTLs in the background, one pass at a time.

    This is the "extra" cycle the liveness scan no longer pays for. A positive
    result is cached for six hours and a miss for ten minutes, so a quiet
    network quickly stops probing altogether.
    """
    global _ttl_probe_active
    now = time.time()
    pending = []
    for h in hosts:
        ip = getattr(h, "ip", "")
        if not ip or getattr(h, "is_self", False):
            continue
        cached, _ttl = _cached_ttl(ip, now)
        if not cached:
            pending.append(ip)
    if not pending:
        return

    with _ttl_probe_lock:
        if _ttl_probe_active:
            return
        _ttl_probe_active = True

    def worker() -> None:
        global _ttl_probe_active
        try:
            with ThreadPoolExecutor(max_workers=min(6, len(pending))) as pool:
                for ip, ttl in pool.map(lambda ip: (ip, ping_ttl(ip, 1.0)), pending):
                    _TTL_CACHE[ip] = (time.time(), ttl)
        finally:
            with _ttl_probe_lock:
                _ttl_probe_active = False

    threading.Thread(target=worker, daemon=True, name="ttl-probe").start()


def _merge_router_clients(
    hosts: list[FoundHost],
    topo: dict,
    ssid_map: dict,
    subnet: str,
    skip_macs: set[str],
) -> list[FoundHost]:
    """Union the ARP sweep with the router's live client table.

    One broadcast ARP sweep is lossy for Wi-Fi clients in power save: phones
    can miss the request while remaining fully associated. That made the same
    two phones flap online/offline on every other scan. The router's client
    table is the authoritative association signal, so a MAC listed there is
    online even when this scan's ARP reply was lost.

    Entries with an address outside the scanned subnet are ignored (mesh
    backhaul pseudo-clients); a MAC currently being kicked is also skipped so
    the kick's "went offline" signal still works.
    """
    by_mac: dict[str, FoundHost] = {}
    for h in hosts:
        mac = normalize_mac(h.mac)
        if valid_mac(mac):
            by_mac[mac] = h

    try:
        net = ipaddress.ip_network(subnet, strict=False)
    except ValueError:
        return list(by_mac.values())

    def usable(ip: str) -> bool:
        if not ip:
            return True
        try:
            return ipaddress.ip_address(ip) in net
        except ValueError:
            return False

    def add(mac: str, ci) -> None:
        if not valid_mac(mac) or mac in by_mac or mac in skip_macs:
            return
        sm = ssid_map.get(mac, {})
        ip = str(getattr(ci, "ip", "") or sm.get("ip") or "")
        hostname = str(
            getattr(ci, "hostname", "") or sm.get("hostname") or ""
        )
        associated = bool(sm.get("interface") or sm.get("ssid"))
        if ip and not usable(ip):
            return
        if not ip and not associated:
            return
        by_mac[mac] = FoundHost(ip=ip, mac=mac, hostname=hostname)

    for raw_mac, ci in topo.items():
        add(normalize_mac(raw_mac), ci)
    # A client can be in the WLAN association table even when topo omitted it.
    for raw_mac in ssid_map:
        mac = normalize_mac(raw_mac)
        if mac not in by_mac:
            add(mac, topo.get(mac))
    return list(by_mac.values())


async def _run_scan(subnet: str, iface: str | None) -> list[dict]:
    global _profile_change
    _profile_change = None
    cfg = config_store.settings
    reset_scan_health()
    hosts = await asyncio.to_thread(arp_scan, subnet, 2.0, iface)
    scan_degraded, scan_reason = scan_health()

    # ARP never returns the sender's own entry, so add this machine explicitly.
    # Without this the laptop running the dashboard is the one device that can
    # never appear in its own list. It is always online: this process is alive.
    self_host = await asyncio.to_thread(local_identity, subnet, iface)
    if self_host is not None:
        hosts = [h for h in hosts if normalize_mac(h.mac) != self_host.mac]
        hosts.append(self_host)

    # Router-side client info: DHCP hostnames, link rates and the live WLAN
    # association table. Fetching this before the liveness decision lets a
    # device the router still sees stay online even when an ARP reply is lost.
    topo_client = get_topo_client()
    try:
        topo = topo_client.fetch()
    except Exception as e:  # noqa: BLE001
        log.info("router client info unavailable: %s", e)
        topo = {}
    resolver = None
    try:
        resolver = get_resolver()
        ssid_map = resolver.snapshot()
    except Exception as e:  # noqa: BLE001
        log.info("router SSID info unavailable: %s", e)
        ssid_map = {}

    # Stale caches must not keep disconnected devices online. Missing a fresh
    # router snapshot simply falls back to ARP-only liveness.
    if not topo_client.fresh:
        topo = {}
    if resolver is None or not resolver.fresh:
        ssid_map = {}

    kicked_now = {normalize_mac(m) for m in kicked_map()}
    hosts = _merge_router_clients(
        hosts,
        topo,
        ssid_map,
        subnet,
        kicked_now,
    )

    # TTL/OS probing runs on its own background cycle. The liveness scan on
    # this pass only consumes values already cached, so an unresponsive host
    # can never delay or shrink the sweep.
    ttls = _cached_ttls(hosts)
    _schedule_ttl_probes(hosts)
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

    # Router-side client info was fetched before the liveness decision above:
    # DHCP hostnames, link rates, AP association and cumulative byte counters.
    # The AP association (DEV.WIFI.APn) is the only source naming the exact AP
    # a client is on, which Access Control rules require.

    # Which network are we on? Resolve the profile before touching devices so
    # every write below is scoped to this physical network. The SSID is extra
    # display context, never the identity (two cafes can share "Free WiFi").
    gateway_ssid = ""
    if gateway_mac:
        info = ssid_map.get(gateway_mac) or ssid_map.get(gateway_mac.lower())
        if info:
            gateway_ssid = str(info.get("ssid") or "")
    with get_session() as s:
        profile, previous_profile, _created = profiles.resolve_and_activate(
            s,
            gateway_mac=gateway_mac,
            subnet=subnet,
            gateway_ip=gateway_ip,
            ssid=gateway_ssid,
        )
        profile_id = profile.id
        if previous_profile is not None and previous_profile.id != profile_id:
            _profile_change = {
                "previous_id": previous_profile.id,
                "profile_id": profile_id,
            }

    with get_session() as s:
        for host in hosts:
            mac = normalize_mac(host.mac)
            if not valid_mac(mac):
                continue
            seen_macs.add(mac)
            is_gw = gateway_mac is not None and mac == gateway_mac
            dev = s.exec(
                select(Device).where(
                    Device.network_profile_id == profile_id, Device.mac == mac
                )
            ).first()
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
            # The router's topo call can omit an idle phone's name on some
            # scans. Keep using the name already stored for this MAC so the
            # OS guess does not regress to a TTL-only "Linux/Unix".
            guess_hostname = dhcp_hostname or (dev.hostname if dev else "")
            is_wireless = ci.is_wireless if ci else None
            is_self = bool(getattr(host, "is_self", False)) or (
                self_host is not None and mac == self_host.mac
            )
            if is_self:
                # The backend host is not classified by fuzzy rules: its own
                # platform and chassis are authoritative evidence.
                guess = local_device_type()
                os_name, os_conf, os_ev = local_os_info()
            else:
                _, guess = fingerprint(
                    mac,
                    hostname=guess_hostname,
                    vendor=vendor,
                    ip=host.ip,
                    is_wireless=is_wireless,
                    gateway=is_gw,
                )
                os_name, os_conf, os_ev = guess_os(
                    hostname=guess_hostname,
                    vendor=vendor,
                    ttl=ttls.get(host.ip),
                    device_type=guess,
                )
            if dev is None:
                dev = Device(
                    network_profile_id=profile_id,
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
                    is_self=is_self,
                    os_guess=os_name,
                    os_confidence=os_conf,
                    os_evidence=os_ev,
                    first_seen=now,
                    last_seen=now,
                    last_online=now,
                    online=True,
                )
                s.add(dev)
                _record_ap_seen(s, profile_id, mac, wifi_iface, ssid_name, now)
                s.add(
                    DeviceEvent(
                        network_profile_id=profile_id,
                        mac=mac,
                        kind="online",
                        at=now,
                        ip=host.ip,
                    )
                )
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
                dev.is_self = is_self
                if os_name:
                    dev.os_guess = os_name
                    dev.os_confidence = os_conf
                    dev.os_evidence = os_ev
                # Re-type when the stored value might have come from an older,
                # weaker rule, or when gateway status changed. "router" is
                # included on purpose: clients behind a ZTE access point were
                # previously stored as router and would never be re-examined.
                # A manual type_override always wins, and the self entry is
                # pinned to the real chassis type.
                if is_self and not dev.type_override:
                    dev.device_type = guess
                elif (
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
                dev.missed_scans = 0
                # Record every AP this MAC has ever been seen on. A kick has to
                # cover all of them, not just the current one, or the device can
                # simply rejoin on the other band.
                _record_ap_seen(s, profile_id, mac, wifi_iface, ssid_name, now)
                if not was_online:
                    dev.online = True
                    dev.last_online = now
                    s.add(
                        DeviceEvent(
                            network_profile_id=profile_id,
                            mac=mac,
                            kind="online",
                            at=now,
                            ip=dev.ip,
                        )
                    )
                    changes.append({"mac": mac, "kind": "online"})

        # Anything not answering now may be offline, but a single lost ARP
        # reply is not enough: require consecutive misses and a grace window.
        # A kicked device bypasses the debounce: it stops replying once the
        # spoof takes effect, and that is the signal the kick is working.
        for dev in s.exec(
            select(Device).where(Device.network_profile_id == profile_id)
        ).all():
            # The backend moved to a different address/interface: the old
            # "self" row is no longer this machine.
            if self_host is not None and dev.is_self and dev.mac != self_host.mac:
                dev.is_self = False
                s.add(dev)
            if dev.mac not in seen_macs and dev.online:
                # A degraded sweep (OS ARP cache fallback) is not evidence
                # that a device disappeared. Keeping the state unchanged is
                # safer than flapping every device the cache happened to omit.
                if scan_degraded:
                    log.debug(
                        "scan degraded (%s); keeping %s online",
                        scan_reason,
                        dev.mac,
                    )
                    continue
                dev.missed_scans = (dev.missed_scans or 0) + 1
                # Require both a couple of consecutive misses and a grace
                # window since the last sighting. A router client table can
                # drop an idle phone for a minute, and one lost ARP reply is
                # routine; neither is a disconnect. A kick skips both checks:
                # its offline transition is the signal that the spoof works.
                last_seen = dev.last_seen or dev.first_seen
                age = (now - last_seen).total_seconds() if last_seen else 0.0
                if dev.mac not in kicked_now and (
                    dev.missed_scans < OFFLINE_AFTER_MISSES
                    or age < OFFLINE_GRACE_SECONDS
                ):
                    s.add(dev)
                    continue
                dev.online = False
                s.add(
                    DeviceEvent(
                        network_profile_id=profile_id,
                        mac=dev.mac,
                        kind="offline",
                        at=now,
                        ip=dev.ip,
                    )
                )
                changes.append({"mac": dev.mac, "kind": "offline"})

        online = s.exec(
            select(Device).where(
                Device.network_profile_id == profile_id,
                Device.online == True,  # noqa: E712
            )
        ).all()
        total = s.exec(
            select(Device).where(Device.network_profile_id == profile_id)
        ).all()
        s.add(
            ScanSample(
                network_profile_id=profile_id,
                online=len(online),
                total=len(total),
            )
        )
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
                    "vendor": d.get("vendor") or "",
                    "hostname": d.get("hostname") or "",
                    # Carry the manual brand choice so toasts show the same
                    # logo as every other device chip.
                    "brand_override": d.get("brand_override") or "",
                }
            )
        return payload, transitions


def _scan_target() -> tuple[str, str | None]:
    """Return the subnet/interface to scan, following the current network.

    An explicitly configured interface is always respected. Otherwise, when
    the saved subnet no longer has a local address (home -> campus -> home),
    adopt the active network instead of silently scanning an unreachable one.
    """
    cfg = config_store.settings
    if cfg.interface or detect_interface(cfg.subnet):
        return cfg.subnet, cfg.interface

    active = detect_active_network()
    if not active or active[0] == cfg.subnet:
        return cfg.subnet, cfg.interface

    subnet, iface, ip = active
    log.warning(
        "network changed: %s has no local interface; following %s on %s (%s)",
        cfg.subnet,
        subnet,
        iface,
        ip,
    )
    config_store.update(subnet=subnet)
    return subnet, None


_scan_lock = asyncio.Lock()
# Set by _run_scan when the physical network changed; consumed and cleared by
# _run_scan_cycle after the scan commits.
_profile_change: dict | None = None


def _mark_profile_offline(profile_id: int) -> None:
    """The laptop left this network, so none of its devices are observable.

    No device_events rows are written here: leaving a network is not a device
    disconnecting. The flag only stops a historical view from claiming stale
    devices are still online.
    """
    with get_session() as s:
        rows = s.exec(
            select(Device).where(
                Device.network_profile_id == profile_id,
                Device.online == True,  # noqa: E712
            )
        ).all()
        for dev in rows:
            dev.online = False
            s.add(dev)
        if rows:
            s.commit()


async def _run_scan_cycle(label: str) -> None:
    """Run one scan while holding the shared lock.

    Serialising both entry points matters: two overlapping ARP sweeps compete
    for the same raw socket and each one's join budget, which makes both
    answer late and pushes the scanner into its cache fallback.
    """
    subnet, iface = _scan_target()
    try:
        devices, transitions = await _run_scan(subnet, iface)
        change = _profile_change
        if change:
            _mark_profile_offline(change["previous_id"])
            # A kick only makes sense on the network it was started on. Leaving
            # it running would try to remove a router rule from a different
            # router (or none at all), so stop cleanly before switching data.
            try:
                from . import kick as kick_mod

                await asyncio.to_thread(kick_mod.stop_all)
            except Exception as e:  # noqa: BLE001
                log.warning("profile change: stopping kicks failed: %s", e)
        await hub.broadcast("devices", devices)
        await hub.broadcast("kicked", kicked_map())
        snapshot = profiles.snapshot()
        await hub.broadcast("profiles", snapshot)
        if change:
            active = next(
                (p for p in snapshot["profiles"] if p["id"] == change["profile_id"]),
                None,
            )
            await hub.broadcast(
                "network_profile_changed",
                {
                    "previous_id": change["previous_id"],
                    "profile": active,
                    **snapshot,
                },
            )
        if transitions:
            await hub.broadcast("transitions", transitions)
    except Exception as e:  # keep the loop alive through transient errors
        log.warning("%s scan failed: %s", label, e)
        await hub.broadcast("error", str(e))


async def scan_loop() -> None:
    """Runs for the app's lifetime; interval is re-read each pass so the
    settings page can change it without a restart."""
    hub.bind_loop()
    init_db()
    await asyncio.sleep(1.0)
    while True:
        cfg = config_store.settings
        async with _scan_lock:
            await _run_scan_cycle("scheduled")
        await asyncio.sleep(max(cfg.scan_interval, 5.0))


async def trigger_scan() -> None:
    """Fire a one-off scan without awaiting it."""
    asyncio.create_task(scan_loop_once())


async def scan_loop_once() -> None:
    """Run a single scan. Skipped if one is already in flight."""
    if _scan_lock.locked():
        return
    async with _scan_lock:
        await _run_scan_cycle("manual")
