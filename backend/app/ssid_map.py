"""Auto-detect which SSID a device is on, via the router's DHCP lease table.

The ZTE web UI exposes the lease table under
Local Network > LAN > Allocated Address, with a Port column that names the SSID
(SSID1/SSID5/SSID6...). We scrape that page and map the SSID to the
DEV.WIFI.APn interface used by the Access Control rule endpoint.

Everything here is best-effort: if the router won't tell us, the caller falls
back to a manually configured interface and says so in the UI.
"""
from __future__ import annotations

import logging
import re
import time

log = logging.getLogger("netdash.ssid")

# SSID number -> Access Control Interface name.
#
# This mapping is firmware-dependent and was NOT verified against your router:
# the F670L exposes more AP interfaces than it has user-visible SSIDs, so
# SSID6 does not necessarily mean DEV.WIFI.AP6. Guessing here would silently
# write rules against the wrong SSID, so the default is an identity mapping
# (SSIDn -> DEV.WIFI.APn) and the real mapping is a setting you can correct in
# Settings -> "Interface SSID default" or per device.
#
# Override with NETDASH_SSID_MAP='{"1":"DEV.WIFI.AP4","6":"DEV.WIFI.AP6"}'.
import json
import os as _os

_DEFAULT_AP = {n: f"DEV.WIFI.AP{n}" for n in range(1, 9)}


def _load_ap_map() -> dict[int, str]:
    raw = _os.environ.get("NETDASH_SSID_MAP", "").strip()
    if raw:
        try:
            data = json.loads(raw)
            return {int(k): str(v) for k, v in data.items()}
        except Exception:  # noqa: BLE001
            log.warning("NETDASH_SSID_MAP tidak valid, memakai default")
    return dict(_DEFAULT_AP)


AP_BY_SSID = _load_ap_map()

# Reverse map, for displaying the interface back to a human.
IFACE_TO_SSID = {v: f"SSID{k}" for k, v in AP_BY_SSID.items()}

# Endpoints that answer on this firmware. Verified live: accessdev and
# wlan_homepage return SUCC with the LOGIN token; landhcp_server and
# wlanapconfig answer SessionTimeout, so they are only tried for completeness.
#
# Note: none of these expose an SSID/Port column on this firmware - they
# return HostName/IPAddress/MACAddress only. SSID auto-detect therefore has no
# data source here and falls back to settings.default_wifi_interface.
DHCP_TAGS = [
    "accessdev_homepage_lua.lua",
    "wlan_homepage_lua.lua",
    "landhcp_server_lua.lua",
]

MAC_RE = re.compile(r"([0-9A-F]{2}(?::[0-9A-F]{2}){5})", re.I)
SSID_RE = re.compile(r"SSID\s*([0-9]+)", re.I)

# Short-lived cache: a kick burst shouldn't re-login per device.
_cache_ttl = 8.0


def ssid_to_interface(ssid_label: str) -> str | None:
    """'SSID6' / 'SSID 6' / '6' -> 'DEV.WIFI.AP6'."""
    m = SSID_RE.search(ssid_label or "")
    if not m:
        return None
    return AP_BY_SSID.get(int(m.group(1)))


def interface_to_ssid(iface: str) -> str:
    return IFACE_TO_SSID.get(iface, iface)


def parse_leases(html: str) -> dict[str, str]:
    """MAC -> SSID label, from the DHCP lease page.

    The ZTE renders each lease as a table row: MAC | IP | Hostname | Port/SSID.
    We walk row by row and take the first MAC plus any SSID token in the row.
    """
    out: dict[str, str] = {}
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S | re.I):
        macs = MAC_RE.findall(row)
        if not macs:
            continue
        mac = macs[0].upper()
        ssids = SSID_RE.findall(row)
        if ssids:
            out[mac] = f"SSID{ssids[0]}"
            continue
        # Some firmware shows "WLAN-AP6" or the raw interface name instead.
        iface = re.search(r"DEV\.WIFI\.AP(\d+)", row, re.I)
        if iface:
            out[mac] = f"SSID{iface.group(1)}"
    return out


def fetch_leases(router=None) -> dict[str, str]:
    """Read the lease table from the router. Returns {} if unavailable."""
    own_client = router is None
    if own_client:
        from .router_client import ZteRouter

        router = ZteRouter()
    try:
        router.ensure_login()
        tok = router.session_token  # the LOGIN token, not the ACL page token
        for tag in DHCP_TAGS:
            url = f"/?_type=menuData&_tag={tag}"
            try:
                # GET: cookie only. Sending _sessionTOKEN as a query param makes
                # the router serve the 188 KB shell instead of data.
                resp = router.client.get(url, headers=router._headers())
                if resp.status_code == 200 and "SessionTimeout" not in resp.text:
                    leases = parse_leases(resp.text)
                    if leases:
                        log.info("lease table from GET %s: %d leases", tag, len(leases))
                        return leases
                # POST fallback with the login token.
                body, headers = router._encode_body(
                    {"IF_ACTION": "Read", "_sessionTOKEN": tok}
                )
                resp = router.client.post(url, content=body, headers=headers)
            except Exception as e:  # noqa: BLE001
                log.debug("lease fetch %s failed: %s", tag, e)
                continue
            if resp.status_code != 200 or "SessionTimeout" in resp.text:
                continue
            leases = parse_leases(resp.text)
            if leases:
                log.info("lease table from POST %s: %d leases", tag, len(leases))
                return leases
    except Exception as e:  # noqa: BLE001
        log.warning("could not read DHCP lease table: %s", e)
    finally:
        if own_client:
            router.close()
    return {}


def interface_for_mac(mac: str, router=None) -> tuple[str | None, str]:
    """(interface, how) for a MAC.

    how is 'auto' when detected from the lease table, or 'fallback' when the
    caller should tell the user to pick an SSID manually.
    """
    mac = mac.upper()
    leases = _leases_cached(router)
    label = leases.get(mac)
    if not label:
        return None, "fallback"
    iface = ssid_to_interface(label)
    if not iface:
        return None, "fallback"
    return iface, "auto"


def _leases_cached(router=None) -> dict[str, str]:
    """fetch_leases() memoised for a few seconds."""
    global _leases
    now = time.time()
    if _leases and now - _fetched_at < _cache_ttl:
        return _leases
    _leases = fetch_leases(router)
    _fetched_at = now
    return _leases


_leases: dict[str, str] = {}
_fetched_at: float = 0.0


def invalidate() -> None:
    """Force the next lookup to re-read the router (used after a kick)."""
    global _leases, _fetched_at
    _leases = {}
    _fetched_at = 0.0