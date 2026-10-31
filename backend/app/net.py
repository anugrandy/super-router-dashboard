"""Network layer: ARP discovery, OUI vendor lookup, and bidirectional ARP spoof."""
from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

import logging

log = logging.getLogger("netdash.net")

from .config import config_store


def _oui_file() -> str | None:
    return config_store.settings.oui_file

# ---------------------------------------------------------------- vendor OUI

# Full IEEE public registry, bundled so vendor lookup works offline.
# Regenerate with tools/build_oui_table.py. A user-supplied oui_file (same
# IEEE CSV format) is merged on top and wins on conflict.
_TABLE_CACHE: dict[str, str] | None = None


def _load_oui() -> dict[str, str]:
    global _TABLE_CACHE
    if _TABLE_CACHE is None:
        from .oui_data import OUI_TABLE

        _TABLE_CACHE = dict(OUI_TABLE)
        path = _oui_file()
        if path:
            try:
                import csv

                with open(path, encoding="utf-8", errors="ignore", newline="") as fh:
                    for rec in csv.DictReader(fh):
                        prefix = (rec.get("Assignment") or "").strip().upper()
                        org = (rec.get("Organization Name") or "").strip()
                        if len(prefix) == 6 and org:
                            _TABLE_CACHE[prefix] = org
            except (OSError, KeyError) as e:
                log.warning("could not read oui_file %s: %s", path, e)
    return _TABLE_CACHE


def normalize_mac(mac: str) -> str:
    return mac.strip().upper().replace("-", ":").replace(".", ":")


def valid_mac(mac: str) -> bool:
    return bool(re.fullmatch(r"[0-9A-F]{2}(:[0-9A-F]{2}){5}", normalize_mac(mac)))


def lookup_vendor(mac: str) -> str:
    # The OUI is the first 3 octets = 6 hex chars of the bare form.
    oui = normalize_mac(mac).replace(":", "")[:6]
    return _load_oui().get(oui, "")


_PHONE_HINTS = ("samsung", "apple", "xiaomi", "redmi", "oppo", "vivo", "realme",
                "huawei", "oneplus", "motorola", "pixel", "nokia", "sony")
_PC_HINTS = ("intel", "dell", "lenovo", "asus", "acer", "hp ", "hewlett", "realtek",
             "gigabyte", "msi ", "toshiba", "apple", "asrock", "micro-star")
_IOT_HINTS = ("espressif", "tuya", "shelly", "sonoff", "tasmota", "broadlink",
              "philips", "tp-link", "d-link", "ubiquiti", "raspberry",
              "amazon", "google", "robo", "gigaset", "avm")
_SMART_HOME_HOST_HINTS = ("tv", "miio", "mihome", "band", "watch", "speaker",
                          "cam", "camera", "bulb", "plug", "sensor", "airpump")


# ------------------------------------------------------------ device typing

_ROUTER_HINTS = ("router", "gateway", "gw-", "fiber", "indihome", "zte", "huawei",
                 "modem", "ont", "openwrt", "mikrotik", "tplink", "netgear", "asus",
                 "ubnt", "ubiquiti", "d-link", "dlink", "linksys", "tp-link",
                 "cisco", "juniper", "zyxel", "eir")
_SERVER_HINTS = ("server", "nas", "synology", "qnap", "esxi", "proxmox", "vmware",
                 "truenas", "unraid", "rack", "host", "srv")
_TV_HINTS = ("tv", "chromecast", "firetv", "firestick", "shield", "appletv",
             "apple-tv", "bravia", "android-tv", "aft", "aftb")


def guess_device_type(vendor: str, hostname: str = "", ip: str = "", is_gateway: bool = False) -> str:
    blob = f"{vendor} {hostname}".lower()
    host = (hostname or "").lower()

    if is_gateway or any(h in host for h in ("gateway", "router", "gw")):
        return "router"
    if any(h in blob for h in _TV_HINTS):
        return "tv"
    if any(h in blob for h in _IOT_HINTS):
        return "iot"
    if any(h in blob for h in _PHONE_HINTS):
        # Xiaomi/Redmi make both phones and smart-home gear; the hostname decides.
        if "xiaomi" in blob or "redmi" in blob:
            if any(h in host for h in _SMART_HOME_HOST_HINTS):
                return "iot"
        return "phone"
    if any(h in blob for h in _SERVER_HINTS):
        return "server"
    # PC vendors before router vendors: Asus/TP-Link ship both laptops and
    # routers, and a laptop is the more common sighting on a home network.
    # Routers are still caught above via hostname or the gateway flag.
    if any(h in blob for h in _PC_HINTS):
        return "computer"
    if any(h in blob for h in _ROUTER_HINTS):
        return "router"
    return "unknown"


# ------------------------------------------------------------------ interface


def detect_interface(subnet: str) -> str | None:
    """Pick the interface holding a local address inside `subnet`."""
    try:
        net = ipaddress.ip_network(subnet, strict=False)
    except ValueError:
        return None
    try:
        import psutil  # type: ignore

        for name, addrs in psutil.net_if_addrs().items():
            for addr in addrs:
                if addr.family == socket.AF_INET and addr.address:
                    try:
                        if ipaddress.ip_address(addr.address) in net:
                            return name
                    except ValueError:
                        continue
    except Exception:
        pass
    return None


def detect_local_ip(subnet: str) -> str | None:
    """Guess this host's own IPv4 in the target subnet (used as the spoof source)."""
    try:
        net = ipaddress.ip_network(subnet, strict=False)
    except ValueError:
        return None
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.settimeout(0.3)
        probe.connect((str(net.network_address + 1), 53))
        ip = probe.getsockname()[0]
        return ip if ipaddress.ip_address(ip) in net else None
    except OSError:
        return None
    finally:
        probe.close()


def default_gateway_iface() -> str | None:
    try:
        import psutil  # type: ignore

        for name, addrs in psutil.net_if_addrs().items():
            for addr in addrs:
                if addr.family == socket.AF_INET and addr.address and not addr.address.startswith("127."):
                    return name
    except Exception:
        pass
    return None


# -------------------------------------------------------------------- scanner


@dataclass
class FoundHost:
    ip: str
    mac: str
    hostname: str = ""


def _resolve_scan_iface(subnet: str, iface_name: str | None):
    """scapy interface for the ARP sweep: prefer the one holding our LAN IP."""
    try:
        from .scapy_arp import resolve_iface

        local_ip = detect_local_ip(subnet)
        return resolve_iface(local_ip, iface_name)
    except Exception as e:
        log.warning("could not resolve scan interface: %s", e)
        return None


def arp_scan(subnet: str, timeout: float = 2.0, iface: str | None = None) -> list[FoundHost]:
    """Active ARP sweep of `subnet`. Blocks; call from a worker thread.

    `iface` is an adapter *name* (e.g. "Wi-Fi"). It is resolved to the scapy
    interface holding the subnet, because scapy's default iface is whatever
    adapter it happens to pick first — on a VMware host that's a virtual
    adapter with no route to the real LAN, so the sweep returns nothing.

    Falls back to the OS neighbour/ARP cache when scapy is unavailable or the
    process lacks raw-socket rights, so the dashboard still lists devices.
    """
    try:
        from scapy.all import ARP, Ether, srp  # type: ignore
    except Exception:
        return arp_table_fallback(subnet)

    try:
        net = ipaddress.ip_network(subnet, strict=False)
    except ValueError:
        return []
    targets = [str(h) for h in net.hosts()][:1024]

    # Pin the sweep to the LAN adapter.
    scan_iface = _resolve_scan_iface(subnet, iface)

    def _run() -> list[FoundHost]:
        try:
            ans, _ = srp(
                Ether(dst="ff:ff:ff:ff:ff:ff") / ARP(pdst=targets),
                timeout=timeout,
                retry=1,
                verbose=False,
                iface=scan_iface,
            )
        except Exception:
            return arp_table_fallback(subnet)
        out: dict[str, FoundHost] = {}
        for _, pkt in ans:
            mac = normalize_mac(pkt[Ether].src)
            ip = pkt[ARP].psrc
            if valid_mac(mac) and _is_unicast(mac):
                out[ip] = FoundHost(ip=ip, mac=mac, hostname=reverse_dns(ip))
        if not out:
            # No replies: almost always missing raw-socket rights (Npcap on
            # Windows, CAP_NET_RAW elsewhere) rather than an empty network. The
            # OS neighbour cache still has real devices, so use it.
            return arp_table_fallback(subnet)
        return list(out.values())

    # Cap the sweep to something a UI can wait on. srp walks the target list
    # serially-ish and, with no raw-socket rights, just blocks until the very
    # end — so on timeout we fall back to the OS neighbour cache instead.
    out: list[FoundHost] = []
    budget = min(timeout + 4.0, 8.0)
    t = threading.Thread(target=lambda: out.extend(_run()), daemon=True)
    t.start()
    t.join(budget)
    if t.is_alive():
        log.warning("ARP sweep exceeded %.0fs, using OS ARP cache", budget)
        return arp_table_fallback(subnet)
    return out


def arp_table_fallback(subnet: str) -> list[FoundHost]:
    """Read the OS ARP cache. Windows: `arp -a`. Linux/macOS: `arp -an`."""
    import subprocess
    import sys

    try:
        net = ipaddress.ip_network(subnet, strict=False)
    except ValueError:
        return []
    cmd = ["arp", "-a"] if sys.platform == "win32" else ["arp", "-an"]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=6)
    except Exception:
        return []
    out: dict[str, FoundHost] = {}
    for line in res.stdout.splitlines():
        m_ip = re.search(r"(\d{1,3}(?:\.\d{1,3}){3})", line)
        m_mac = re.search(r"([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5})", line)
        if not (m_ip and m_mac):
            continue
        ip = m_ip.group(1)
        try:
            if ipaddress.ip_address(ip) not in net:
                continue
        except ValueError:
            continue
        mac = normalize_mac(m_mac.group(1))
        if not valid_mac(mac) or not _is_unicast(mac):
            continue
        out[ip] = FoundHost(ip=ip, mac=mac, hostname=reverse_dns(ip))
    return list(out.values())


def _is_unicast(mac: str) -> bool:
    """Drop broadcast/multicast and the all-zero placeholder."""
    first = int(mac[:2], 16)
    if first == 0x00 or first & 0x01:  # 00:00:00:00:00:00, and multicast bit
        return False
    return True


def reverse_dns(ip: str) -> str:
    try:
        socket.setdefaulttimeout(0.4)
        return socket.gethostbyaddr(ip)[0]
    except (socket.herror, OSError):
        return ""


# ------------------------------------------------------------- ARP spoof / kick


@dataclass
class KickTarget:
    mac: str
    ip: str
    gateway_ip: str
    gateway_mac: str
    local_ip: str
    started_at: float = field(default_factory=time.time)
    reason: str = ""
    # Explicit scapy adapter name (from settings.interface). None = auto-detect.
    interface: str | None = None
    _stop: threading.Event = field(default_factory=threading.Event, repr=False)

    @property
    def elapsed(self) -> float:
        return time.time() - self.started_at

    def stop(self) -> None:
        self._stop.set()


class SpoofEngine:
    """Bidirectional ARP spoof: poison the target's cache AND the gateway's."""

    def __init__(self) -> None:
        self._targets: dict[str, KickTarget] = {}
        self._lock = threading.Lock()

    def active(self) -> list[KickTarget]:
        with self._lock:
            return list(self._targets.values())

    def is_active(self, mac: str) -> KickTarget | None:
        with self._lock:
            return self._targets.get(normalize_mac(mac))

    def start(self, target: KickTarget, max_seconds: int) -> KickTarget:
        stop_old = self.stop(normalize_mac(target.mac))
        with self._lock:
            self._targets[target.mac] = target
        threading.Thread(
            target=self._loop, args=(target, max_seconds), daemon=True, name="arp-spoof"
        ).start()
        return target

    def stop(self, mac: str) -> KickTarget | None:
        key = normalize_mac(mac)
        with self._lock:
            t = self._targets.pop(key, None)
        if t:
            t.stop()
            self._restore(t)
        return t

    def stop_all(self) -> None:
        for mac in list(self._targets):
            self.stop(mac)

    # -- internals ---------------------------------------------------------
    def _loop(self, t: KickTarget, max_seconds: int) -> None:
        """Heartbeat spoof until stopped or max_seconds elapses, then restore."""
        import asyncio

        from .scapy_arp import send_restore, send_spoof

        try:
            while not t._stop.is_set() and t.elapsed < max_seconds:
                try:
                    send_spoof(t)
                except Exception as e:
                    # A failed send must not leave a "kicked" badge on a device
                    # that was never actually blocked.
                    log.warning("spoof send failed for %s: %s", t.mac, e)
                    break
                # 1 Hz heartbeat; wait() returns early if a stop is requested.
                t._stop.wait(1.0)
        except Exception as e:
            log.warning("spoof loop error for %s: %s", t.mac, e)
        finally:
            # Mark stopped even on auto-expiry or a send failure, so callers can
            # trust _stop / is_active.
            t._stop.set()
            try:
                send_restore(t)
            except Exception as e:
                log.warning("restore failed for %s: %s", t.mac, e)
            with self._lock:
                self._targets.pop(t.mac, None)
            # The frontend counts the kick timer locally, so it needs an
            # explicit push or the "Di-kick" badge would never clear.
            self._notify_kick_ended(t)

    def _notify_kick_ended(self, t: KickTarget) -> None:
        """Close the DB log row and push a kicked-map refresh.

        Runs on the spoof worker thread, so the broadcast is scheduled onto the
        serving loop rather than awaited here.
        """
        import asyncio

        from .scanner import hub, kicked_map, set_kicked

        self._close_log_rows(t)
        set_kicked(t.mac, None)
        try:
            loop = hub.loop
            if loop is not None and loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    hub.broadcast("kicked", kicked_map()), loop
                )
            else:
                log.debug("no running loop to broadcast kick end for %s", t.mac)
        except Exception as e:
            log.warning("could not broadcast kick end for %s: %s", t.mac, e)

    def _close_log_rows(self, t: KickTarget) -> None:
        """Mark any still-active KickLog for this MAC as finished."""
        try:
            from sqlmodel import select

            from .db import KickLog, get_session, utcnow

            with get_session() as s:
                rows = s.exec(
                    select(KickLog).where(
                        KickLog.mac == t.mac, KickLog.active == True  # noqa: E712
                    )
                ).all()
                for row in rows:
                    row.active = False
                    row.ended_at = utcnow()
                    row.duration_seconds = max(
                        0, int((row.ended_at - row.started_at).total_seconds())
                    )
                    s.add(row)
                s.commit()
        except Exception as e:
            log.warning("could not close kick log for %s: %s", t.mac, e)

    def _restore(self, t: KickTarget) -> None:
        from .scapy_arp import send_restore

        try:
            send_restore(t)
        except Exception:
            pass


engine = SpoofEngine()
