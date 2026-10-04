"""WAN / internet connection status from the router.

Source: Internet > Status > WAN (``ethWanStatus``), whose data endpoint is
``wan_internetstatus_lua.lua``. It needs two query parameters
(``TypeUplink=2&pageType=1``) and is read with GET, unlike most of the router's
other endpoints. Verified live on the F670L, which returns three connections:

    TR069      IP / dhcp   10.16.16.137
    INTERNET   PPPoE        10.27.5.55   <- the one that matters
    IPTV       bridge       (VLAN 111)

``INTERNET`` is the default WAN because it is the routing, NAT-enabled,
default-gateway connection; the name is configurable in the router UI, so
``DEFAULT_NAMES`` lists the usual candidates and the first enabled, routed,
IPv4 connection wins if none of them match.

Polling is deliberately slow (see ``CACHE_SECONDS``). WAN state changes on the
order of hours; asking the router every few seconds would be pointless load and
would delay noticing an outage for no benefit.

Credentials: the PPPoE username is never returned. The router exposes it, but
there is no reason to copy a credential into this app's API or database.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import asdict, dataclass, field

from .router_client import ZteRouter

log = logging.getLogger(__name__)

STATUS_PAGE = "/?_type=menuView&_tag=ethWanStatus&Menu3Location=0"
STATUS_DATA = (
    "/?_type=menuData&_tag=wan_internetstatus_lua.lua&TypeUplink=2&pageType=1"
)

# Two minutes. Long enough that a flapping link does not spam history, short
# enough that an outage is noticed promptly.
CACHE_SECONDS = 120.0

# Usual names for the primary WAN, most specific first.
DEFAULT_NAMES = ("INTERNET", "INTERNET_PPPOE", "INTERNET_IPOE", "wan", "pppoe_0")


def _num(v: object) -> int:
    try:
        return int(float(str(v).strip() or 0))
    except (TypeError, ValueError):
        return 0


def _norm_status(v: object) -> str:
    s = str(v or "").strip().lower()
    return "connected" if s == "connected" else ("disconnected" if s else "unknown")


@dataclass
class WanStatus:
    available: bool = False
    connection_name: str = ""
    connection_type: str = ""
    auth_type: str = ""
    # IPv4
    ipv4_status: str = "unknown"
    ipv4_address: str = ""
    subnet_mask: str = ""
    gateway: str = ""
    dns: list[str] = field(default_factory=list)
    online_seconds: int = 0
    disconnect_reason: str = ""
    # IPv6
    ipv6_status: str = "unknown"
    ipv6_address: str = ""
    ipv6_gateway: str = ""
    ipv6_dns: list[str] = field(default_factory=list)
    ipv6_online_seconds: int = 0
    vlan_id: str = ""
    mtu: str = ""
    is_nat: bool = False
    is_default_gateway: bool = False
    # Every connection the router reported, for context.
    connections: list[dict] = field(default_factory=list)
    error: str = ""
    fetched_at: float = 0.0

    @property
    def connected(self) -> bool:
        return self.ipv4_status == "connected"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["connected"] = self.connected
        d["online_human"] = format_duration(self.online_seconds)
        d["ipv6_online_human"] = format_duration(self.ipv6_online_seconds)
        return d


def format_duration(seconds: int) -> str:
    """Uptime as '2h 14j 3m' — Indonesian, matching the router card's style."""
    if not seconds or seconds < 0:
        return "-"
    d, rem = divmod(int(seconds), 86400)
    h, rem = divmod(rem, 3600)
    m, _ = divmod(rem, 60)
    if d:
        return f"{d}h {h}j {m}m"
    if h:
        return f"{h}j {m}m"
    return f"{m}m"


def _instances(payload: str) -> list[dict[str, str]]:
    out = []
    for inst in re.findall(r"<Instance>(.*?)</Instance>", payload, re.S):
        d = dict(
            re.findall(r"<ParaName>([^<]+)</ParaName><ParaValue>([^<]*)</ParaValue>", inst)
        )
        if d.get("WANCName"):
            out.append(d)
    return out


def _is_live(d: dict[str, str]) -> bool:
    """Routed and enabled.

    Deliberately does NOT require an IP address: a WAN that has just dropped
    still reports its name with no lease, and that is exactly the state this
    app has to surface. Requiring an address would hide the outage.
    """
    if d.get("Enable") not in ("1", "true", "True"):
        return False
    return (d.get("mode") or "").strip() == "route"


def _is_public(d: dict[str, str]) -> bool:
    """Live *and* currently holding an IPv4 lease."""
    return _is_live(d) and bool(d.get("IPAddress"))


def _pick_primary(insts: list[dict[str, str]]) -> dict[str, str] | None:
    for name in DEFAULT_NAMES:
        for d in insts:
            # Name match, but still skip a disabled or bridged connection.
            if d.get("WANCName", "").upper() == name and _is_live(d):
                return d
    # No known name: rank by what actually identifies a user-facing uplink. A
    # management connection (TR069) is routed and has an address too, so name
    # and routability alone are not enough - NAT plus default-gateway is what
    # marks the connection that carries user traffic.
    # Only the default-gateway connection carries user traffic; TR069 is a
    # management VLAN that is also routed and has an address of its own.
    cands = [d for d in insts if _is_public(d) and d.get("IsDefGW") == "1"]
    if not cands:
        cands = [d for d in insts if _is_public(d) and d.get("IsNAT") == "1"]
    if not cands:
        return None
    for d in cands:
        if d.get("IsDefGW") == "1" and d.get("IsNAT") == "1":
            return d
    for d in cands:
        if d.get("IsDefGW") == "1":
            return d
    for d in cands:
        if d.get("IsNAT") == "1":
            return d
    return cands[0]


def _parse(payload: str) -> WanStatus:
    insts = _instances(payload)
    wan = WanStatus(available=True, fetched_at=time.time())
    wan.connections = [
        {
            "name": d.get("WANCName", ""),
            "type": d.get("TransType") or d.get("linkMode") or "",
            "ipv4_status": _norm_status(d.get("ConnStatus")),
            "ipv4_address": d.get("IPAddress", ""),
            "uptime": _num(d.get("UpTime")),
            "is_default_gateway": d.get("IsDefGW") == "1",
        }
        for d in insts
    ]

    primary = _pick_primary(insts)
    if primary is None:
        wan.error = "Router tidak melaporkan koneksi WAN yang bisa dipakai"
        return wan

    wan.connection_name = primary.get("WANCName", "")
    wan.connection_type = (
        primary.get("TransType") or primary.get("wantype") or primary.get("linkMode") or ""
    )
    wan.auth_type = primary.get("AuthType", "")
    wan.ipv4_status = _norm_status(primary.get("ConnStatus"))
    wan.ipv4_address = primary.get("IPAddress", "")
    wan.subnet_mask = primary.get("SubnetMask", "")
    wan.gateway = primary.get("GateWay", "")
    wan.dns = [
        v
        for v in (primary.get("DNS1", ""), primary.get("DNS2", ""), primary.get("DNS3", ""))
        if v and v not in ("0.0.0.0", "::")
    ]
    wan.online_seconds = _num(primary.get("UpTime"))

    err = (primary.get("ConnError") or "").strip()
    # ERROR_NONE means no error; anything else is the ISP-side reason.
    wan.disconnect_reason = "" if err in ("", "ERROR_NONE", "NULL", "0") else err

    wan.ipv6_status = _norm_status(primary.get("ConnStatus6"))
    wan.ipv6_address = primary.get("Pd", "") or primary.get("IPAddress6", "")
    wan.ipv6_gateway = primary.get("Gateway6", "")
    wan.ipv6_dns = [
        v
        for v in (
            primary.get("Dns1v6", ""),
            primary.get("Dns2v6", ""),
            primary.get("Dns3v6", ""),
        )
        if v and v not in ("0.0.0.0", "::")
    ]
    wan.ipv6_online_seconds = _num(primary.get("UpTimeV6"))

    wan.vlan_id = primary.get("VLANID", "")
    wan.mtu = primary.get("MTU", "")
    wan.is_nat = primary.get("IsNAT") == "1"
    wan.is_default_gateway = primary.get("IsDefGW") == "1"
    return wan


_lock = threading.Lock()
_cache: WanStatus | None = None
_router: ZteRouter | None = None


def _drop_session() -> None:
    """Forget the router session so the next fetch logs in again."""
    global _router
    if _router is not None:
        try:
            _router.close()
        except Exception:  # noqa: BLE001
            pass
    _router = None


def _fetch() -> WanStatus:
    global _router
    try:
        if _router is None:
            _router = ZteRouter()
            _router.login()
        else:
            _router.ensure_login()
        payload = _router.page_get(STATUS_PAGE, STATUS_DATA)
    except Exception as e:  # noqa: BLE001
        log.warning("wan status failed: %s", e)
        return WanStatus(available=False, error=f"{type(e).__name__}: {e}")

    if not payload or "SessionTimeout" in payload:
        # Drop the session so the next call logs in fresh.
        _drop_session()
        return WanStatus(available=False, error="Sesi router habis")

    return _parse(payload)


def get(force: bool = False) -> WanStatus:
    """Cached WAN status. Never raises.

    The fetch happens while holding the lock. The router session is a single
    shared object with a single login, so two concurrent cache-miss callers
    would otherwise race each other's login and trip the router's
    login-failure lockout - which makes every WAN read fail at once until it
    expires. Serialising here costs one router round-trip at worst, once per
    two minutes.
    """
    global _cache
    with _lock:
        fresh = _cache and (time.time() - _cache.fetched_at) < CACHE_SECONDS
        if fresh and not force:
            return _cache
        _cache = _fetch()
        return _cache


def invalidate() -> None:
    global _cache
    with _lock:
        _cache = None