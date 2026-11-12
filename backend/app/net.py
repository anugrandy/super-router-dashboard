"""Network layer: ARP discovery, OUI vendor lookup, and bidirectional ARP spoof."""
from __future__ import annotations

import asyncio
import ipaddress
import platform
import re
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

import logging

log = logging.getLogger("netdash.net")

# scapy prints a retry storm of "No route found" warnings when its cached
# route table is stale. The scanner reports one actionable warning instead.
logging.getLogger("scapy.runtime").setLevel(logging.ERROR)

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


def detect_active_network() -> tuple[str, str, str] | None:
    """Return (subnet, interface, local_ip) for the network this host is on.

    The saved subnet is a preference, not a promise: laptops move between home
    and campus, and DHCP can hand out a different address. This looks at the
    address the OS would use for outbound traffic and reads its netmask, so the
    scanner can follow the machine instead of sweeping a network it left.
    """
    try:
        import psutil  # type: ignore
    except Exception:
        return None

    # A UDP connect does not send packets, but the kernel still chooses the
    # source address of the default route.
    preferred_ip = None
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.settimeout(0.3)
        probe.connect(("1.1.1.1", 80))
        preferred_ip = probe.getsockname()[0]
    except OSError:
        pass
    finally:
        probe.close()

    virtual_prefixes = (
        "lo", "docker", "br-", "veth", "virbr", "tun", "tap", "wg",
        "zt", "tailscale",
    )
    candidates: list[tuple[ipaddress.IPv4Network, str, str]] = []
    try:
        interfaces = psutil.net_if_addrs()
    except Exception:
        return None
    for name, addrs in interfaces.items():
        if name.startswith(virtual_prefixes):
            continue
        for addr in addrs:
            if addr.family != socket.AF_INET or not addr.address or not addr.netmask:
                continue
            if addr.address.startswith(("127.", "169.254.")):
                continue
            try:
                network = ipaddress.ip_network(
                    f"{addr.address}/{addr.netmask}", strict=False
                )
            except ValueError:
                continue
            candidates.append((network, name, addr.address))

    if not candidates:
        return None
    if preferred_ip:
        for network, name, ip in candidates:
            if ip == preferred_ip:
                return str(network), name, ip
    network, name, ip = candidates[0]
    return str(network), name, ip


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
    is_self: bool = False


def ping_ttl(ip: str, timeout: float = 1.0) -> int | None:
    """TTL of one ICMP echo reply, or None when the host does not answer.

    Uses the OS `ping` binary instead of a raw socket: ping is commonly granted
    CAP_NET_RAW itself (or is setuid), so this still works when the backend
    process is not privileged. No shell is involved.
    """
    if not ip:
        return None
    seconds = max(1, int(round(timeout)))
    if sys.platform == "win32":
        cmd = ["ping", "-n", "1", "-w", str(seconds * 1000), ip]
    elif sys.platform == "darwin":
        cmd = ["ping", "-n", "-c", "1", "-W", str(seconds * 1000), ip]
    else:
        cmd = ["ping", "-n", "-c", "1", "-W", str(seconds), ip]
    try:
        res = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout + 1.5
        )
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"ttl[=:]\s*(\d+)", res.stdout + res.stderr, re.IGNORECASE)
    return int(m.group(1)) if m else None


def local_identity(subnet: str, iface_name: str | None = None) -> FoundHost | None:
    """This host's own address/MAC on the scan interface, as a FoundHost.

    ARP broadcast asks *other* stations who owns an IP; the sender never gets
    an entry for itself. Without injecting this explicitly, the laptop running
    the dashboard is the one device that can never appear in its own list.
    """
    local_ip = detect_local_ip(subnet)
    if not local_ip:
        return None

    mac = ""
    try:
        from .scapy_arp import resolve_iface

        iface = resolve_iface(local_ip, iface_name)
        mac = normalize_mac(getattr(iface, "mac", "") or "")
    except Exception as e:  # noqa: BLE001 - fall back to psutil below
        log.debug("could not resolve local MAC via scapy: %s", e)

    # Loopback reports an all-zero MAC and still passes valid_mac(). Treating
    # it as this host would create a phantom "self" device on 127.0.0.1.
    if mac == "00:00:00:00:00:00":
        mac = ""

    if not valid_mac(mac):
        try:
            import psutil  # type: ignore

            link_family = getattr(psutil, "AF_LINK", socket.AF_PACKET)
            for _name, addrs in psutil.net_if_addrs().items():
                has_ip = any(
                    a.family == socket.AF_INET and a.address == local_ip
                    for a in addrs
                )
                if not has_ip:
                    continue
                for a in addrs:
                    candidate = normalize_mac(a.address or "") if a.family == link_family else ""
                    if valid_mac(candidate):
                        mac = candidate
                        break
                if mac:
                    break
        except Exception as e:  # noqa: BLE001
            log.debug("could not resolve local MAC via psutil: %s", e)

    if not valid_mac(mac):
        return None

    hostname = socket.gethostname().strip()
    if hostname and hostname.lower() in ("localhost", "localhost.localdomain"):
        hostname = ""
    return FoundHost(ip=local_ip, mac=mac, hostname=hostname, is_self=True)


def local_device_type() -> str:
    """Laptop vs desktop for the host running the backend.

    A battery or a portable DMI chassis type is reliable evidence; otherwise a
    machine that runs a server is most honestly a desktop. This only applies to
    the injected self entry, never to remote devices.
    """
    system = platform.system()
    if system not in ("Linux", "Darwin", "Windows"):
        return "desktop"
    try:
        import psutil  # type: ignore

        if psutil.sensors_battery() is not None:
            return "laptop"
    except Exception:
        pass

    if system == "Linux":
        try:
            from pathlib import Path

            chassis = Path("/sys/class/dmi/id/chassis_type").read_text().strip()
            # SMBIOS chassis types: 8 portable, 9 laptop, 10 notebook,
            # 14 sub-notebook. Everything else is treated as a desktop.
            if chassis in ("8", "9", "10", "14"):
                return "laptop"
            supply = Path("/sys/class/power_supply")
            if supply.exists() and any(supply.glob("BAT*")):
                return "laptop"
        except Exception:
            pass

    return "desktop"


def local_os_info() -> tuple[str, str, str]:
    """OS of the machine running the backend (certain, unlike remote guesses)."""
    system = platform.system()
    if system == "Windows":
        os_name = "Windows"
    elif system == "Darwin":
        os_name = "macOS"
    elif system == "Linux":
        os_name = "Linux"
    else:
        os_name = system or ""
    if not os_name:
        return "", "", ""
    release = platform.release()
    ev = f"host ini (backend {os_name} {release})".strip()
    return os_name, "high", ev



_RAW_SOCKET_STATE: bool | None = None
_RAW_SOCKET_ERROR = ""


def raw_socket_available() -> bool:
    """Whether this process may open a raw L2 socket (ARP scan and spoof).

    On Linux that is exactly the CAP_NET_RAW check: opening an AF_PACKET raw
    socket fails with EPERM when the capability is missing. The result is
    cached because capabilities only change across a restart.
    """
    global _RAW_SOCKET_STATE, _RAW_SOCKET_ERROR
    if sys.platform == "win32":
        # Npcap/Administrator is checked separately; the socket probe below is
        # POSIX-specific.
        return True
    if _RAW_SOCKET_STATE is not None:
        return _RAW_SOCKET_STATE
    try:
        if sys.platform == "darwin":
            # scapy uses /dev/bpf* on macOS; opening the L2 socket is the test.
            from scapy.all import conf  # type: ignore

            probe = conf.L2socket()
        else:
            # ETH_P_ALL (3), no interface bound: enough to trigger the EPERM
            # check without sending anything.
            probe = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3))
        probe.close()
    except Exception as e:  # noqa: BLE001 - reported to the UI
        _RAW_SOCKET_ERROR = f"{type(e).__name__}: {e}"
        _RAW_SOCKET_STATE = False
        return False
    _RAW_SOCKET_STATE = True
    return True


def raw_socket_error() -> str:
    """Why raw sockets are unavailable, or '' when they work."""
    return _RAW_SOCKET_ERROR


_last_arp_fallback_reason: str | None = None
_scan_degraded = False
_scan_degraded_reason = ""


def reset_scan_health() -> None:
    """Clear the degraded flag before a new sweep starts."""
    global _scan_degraded, _scan_degraded_reason
    _scan_degraded = False
    _scan_degraded_reason = ""


def scan_health() -> tuple[bool, str]:
    """(degraded, reason) for the most recent ARP sweep.

    Degraded means the answer came from the OS neighbour cache rather than a
    fresh sweep. The scanner must not treat absence from that list as proof a
    device went offline.
    """
    return _scan_degraded, _scan_degraded_reason


def _mark_raw_socket_blocked(exc: BaseException) -> None:
    """Reflect a send-time EPERM in the Settings diagnostics."""
    global _RAW_SOCKET_STATE, _RAW_SOCKET_ERROR
    _RAW_SOCKET_STATE = False
    _RAW_SOCKET_ERROR = f"{type(exc).__name__}: {exc}"


def _arp_fallback(subnet: str, reason: str) -> list[FoundHost]:
    """Use the OS neighbour cache, but say so once per distinct reason.

    A silent fallback is dangerous: `arp -an` usually contains only the
    gateway, so every other device is marked offline while the scan looks
    healthy. Warn once, then stay quiet so the 15s loop cannot flood the log.
    """
    global _last_arp_fallback_reason, _scan_degraded, _scan_degraded_reason
    _scan_degraded = True
    _scan_degraded_reason = reason
    if reason != _last_arp_fallback_reason:
        log.warning(
            "ARP scan unavailable (%s); falling back to OS ARP cache. "
            "This cycle is treated as degraded, not as proof a device is offline.",
            reason,
        )
        _last_arp_fallback_reason = reason
    return arp_table_fallback(subnet)


def _resolve_scan_iface(subnet: str, iface_name: str | None):
    """scapy interface for the ARP sweep: prefer the one holding our LAN IP.

    ``resolve_iface`` refreshes scapy's cached interface table when the adapter
    has a different address than the one the OS currently reports, so a Wi-Fi
    reconnect cannot leave the sweep pinned to loopback.
    """
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

    Reverse DNS is deliberately NOT part of this hot path. A 0.4s lookup per
    reply pushed a 254-target sweep past its join budget, which made the
    scanner discard a good answer and fall back to the cache. Hostnames come
    from the router's client table instead.
    """
    reset_scan_health()
    try:
        from scapy.all import ARP, Ether, srp  # type: ignore
    except Exception as e:
        return _arp_fallback(subnet, f"scapy import failed: {e}")

    try:
        net = ipaddress.ip_network(subnet, strict=False)
    except ValueError:
        return []
    targets = [str(h) for h in net.hosts()][:1024]

    # Pin the sweep to the LAN adapter.
    scan_iface = _resolve_scan_iface(subnet, iface)

    def _run() -> list[FoundHost]:
        global _last_arp_fallback_reason, _scan_degraded
        try:
            ans, _ = srp(
                Ether(dst="ff:ff:ff:ff:ff:ff") / ARP(pdst=targets),
                timeout=timeout,
                retry=1,
                verbose=False,
                iface=scan_iface,
            )
        except Exception as e:  # noqa: BLE001 - EPERM when CAP_NET_RAW is absent
            text = f"{type(e).__name__}: {e}"
            if "permission" in text.lower() or "operation not permitted" in text.lower():
                _mark_raw_socket_blocked(e)
                text = f"raw socket denied ({text})"
            return _arp_fallback(subnet, text)
        out: dict[str, FoundHost] = {}
        for _, pkt in ans:
            mac = normalize_mac(pkt[Ether].src)
            ip = pkt[ARP].psrc
            if valid_mac(mac) and _is_unicast(mac):
                out[ip] = FoundHost(ip=ip, mac=mac)
        if not out:
            # No replies is not proof of missing CAP_NET_RAW: a sweep pinned to
            # the wrong adapter, an empty subnet, or a very quiet Wi-Fi network
            # all look the same. Say that plainly instead of guessing.
            return _arp_fallback(
                subnet,
                "no ARP replies (wrong interface, empty subnet, or raw socket denied)",
            )
        _last_arp_fallback_reason = None
        _scan_degraded = False
        return list(out.values())

    # Cap the sweep to something a UI can wait on. srp sends two rounds at
    # `timeout`, so 2.0s needs roughly 4s; 9s leaves room for a slow adapter
    # without letting a wedged socket block the next cycle forever.
    out: list[FoundHost] = []
    budget = min(timeout + 6.0, 9.0)
    t = threading.Thread(target=lambda: out.extend(_run()), daemon=True)
    t.start()
    t.join(budget)
    if t.is_alive():
        return _arp_fallback(
            subnet, f"ARP sweep exceeded {budget:.0f}s"
        )
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
        out[ip] = FoundHost(ip=ip, mac=mac)
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
