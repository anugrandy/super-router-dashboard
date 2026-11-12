"""Router-side device info: hostnames, and real-time link rates.

Source: the router's own Topology page ("Access Devices Information" panel),
which is the only place this firmware exposes a per-client record. Two endpoints
matter:

* ``topo_lua.lua``                 -> the whole client list, one object per MAC.
* ``topo_lua.lua&Action=More``     -> clients under one AP, per radio band.

Both are plain JSON GETs (no ``Check`` signature, unlike the ACL POSTs), but they
answer ``SessionTimeout`` unless the Topology menuView has been loaded first, so
``ensure_topo`` refreshes that page before reading them.

Important limitation, verified against this firmware: the per-device fields are
``RxRateBps`` / ``TxRateBps`` — instantaneous throughput in bits per second.
There is no cumulative byte counter anywhere in the admin UI, so total data usage
per device is NOT available from the router.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass, field

from .router_client import ZteRouter

log = logging.getLogger(__name__)

# AccessType values as used by the Topology page.
ACCESS_LAN = 0
ACCESS_2G = 1
ACCESS_5G = 2


@dataclass
class ClientInfo:
    """One entry from the router's client list.

    ``access_type`` only tells us the *band* (2.4/5 GHz), which is not enough to
    pick the right Access Control interface: SSID5 and SSID6 are both 5 GHz on
    this router. ``ap_interface`` comes from wlan_client_stat and names the
    exact AP the client is associated with, so it is what the ACL rule needs.
    """

    mac: str = ""
    ip: str = ""
    hostname: str = ""
    access_type: int = ACCESS_LAN
    wireless_mode: str = ""
    link_speed: str = ""
    rssi: str = ""
    snr: str = ""
    assoc_time: str = ""
    rx_rate_bps: int = 0
    tx_rate_bps: int = 0
    # From wlan_client_stat_lua.lua:
    ap_interface: str = ""      # e.g. DEV.WIFI.AP5
    ssid_name: str = ""         # e.g. AgraSec
    rx_bytes: int = 0           # cumulative, unlike topo's instantaneous bps
    tx_bytes: int = 0

    @property
    def is_wireless(self) -> bool:
        return self.access_type != ACCESS_LAN or bool(self.ap_interface)

    @property
    def band(self) -> str:
        return {ACCESS_2G: "2.4 GHz", ACCESS_5G: "5 GHz"}.get(self.access_type, "LAN")

    @property
    def ssid_label(self) -> str:
        """Human SSID for display: the real name when known, else APn."""
        if self.ssid_name:
            return self.ssid_name
        if self.ap_interface:
            n = self.ap_interface.split("AP")[-1]
            if n:
                return f"SSID{n}"
        return self.band


def _int(v: object) -> int:
    try:
        return int(float(str(v).strip() or 0))
    except (TypeError, ValueError):
        return 0


def _norm_mac(v: object) -> str:
    raw = re.sub(r"[^0-9a-fA-F]", "", str(v or ""))
    if len(raw) != 12:
        return ""
    return ":".join(raw[i : i + 2] for i in range(0, 12, 2)).upper()


class TopoClient:
    """Reads the router's client list, with a short-lived cache.

    The router is a single-threaded CGI on a home router; hammering it on every
    scan is both slow and rude. Results are cached for a few seconds and one
    login is reused across calls.
    """

    def __init__(self, cache_seconds: float = 8.0) -> None:
        self._cache_seconds = cache_seconds
        self._lock = threading.Lock()
        self._clients: dict[str, ClientInfo] = {}
        self._fetched_at: float = 0.0
        self._router: ZteRouter | None = None
        self._topo_loaded = False
        self._last_ok = 0.0

    @property
    def fresh(self) -> bool:
        """True when the last successful client-list fetch is recent.

        Liveness callers must not trust a stale snapshot: if the router is
        unreachable, ``fetch`` returns the previous list and treating that as
        "still online" would keep disconnected devices online indefinitely.
        The window matches the scanner's 120s offline grace: a router that is
        briefly slow must not drop every idle Wi-Fi client from one scan.
        """
        return self._last_ok > 0 and (time.time() - self._last_ok) < 120.0

    # ------------------------------------------------------------- internals
    def _ensure_router(self) -> ZteRouter | None:
        if self._router is None:
            try:
                r = ZteRouter()
                r.login()
                self._router = r
                self._topo_loaded = False
            except Exception as e:  # noqa: BLE001
                log.warning("topo: router login failed: %s", e)
                return None
        return self._router

    def _ensure_topo_page(self, r: ZteRouter) -> bool:
        """Load the Topology menuView so its session token is fresh.

        Without this the JSON endpoints answer SessionTimeout even though the
        session itself is valid — same trap as the ACL page token.
        """
        if self._topo_loaded and (time.time() - self._fetched_at) < 60:
            return True
        try:
            resp = r.client.get(
                "/?_type=menuView&_tag=mmTopology&Menu3Location=0",
                headers=r._headers(),
            )
            ok = resp.status_code == 200 and "SessionTimeout" not in resp.text
            self._topo_loaded = bool(ok)
            if not ok:
                log.info("topo: menuView did not return the page (len=%s)",
                         len(getattr(resp, "text", "")))
            return bool(ok)
        except Exception as e:  # noqa: BLE001
            log.warning("topo: menuView failed: %s", e)
            self._topo_loaded = False
            return False

    def _fetch_json(self, r: ZteRouter, url: str) -> dict | None:
        try:
            resp = r.client.get(url, headers=r._headers())
        except Exception as e:  # noqa: BLE001
            log.debug("topo: GET %s failed: %s", url, e)
            return None
        if resp.status_code != 200:
            return None
        text = resp.text
        if "SessionTimeout" in text:
            # Page token went stale: reload once, then give up this round.
            self._topo_loaded = False
            if self._ensure_topo_page(r):
                try:
                    resp = r.client.get(url, headers=r._headers())
                    text = resp.text
                except Exception:  # noqa: BLE001
                    return None
            if "SessionTimeout" in text:
                return None
        if not text.strip().startswith("{"):
            return None
        try:
            import json

            return json.loads(text)
        except ValueError:
            return None

    @staticmethod
    def _collect(data: dict, into: dict[str, ClientInfo]) -> None:
        """Merge every client object out of one topo response."""
        ad = data.get("ad")
        if not isinstance(ad, dict):
            return
        for key, val in ad.items():
            if key == "MGET_INST_NUM" or not isinstance(val, dict):
                continue
            mac = _norm_mac(val.get("MacAddr"))
            if not mac:
                continue
            prev = into.get(mac)
            ci = prev or ClientInfo(mac=mac)
            ci.ip = val.get("IpAddr") or ci.ip
            # The router echoes the MAC back as HostName when DHCP has no name.
            host = str(val.get("HostName") or "").strip()
            if host and _norm_mac(host) != mac:
                ci.hostname = host
            ci.access_type = _int(val.get("AccessType")) or ci.access_type
            ci.wireless_mode = val.get("WirelessMode") or ci.wireless_mode
            ci.link_speed = str(val.get("LinkSpeed") or "")
            ci.rssi = str(val.get("Rssi") or "")
            ci.snr = str(val.get("SNR") or "")
            ci.assoc_time = str(val.get("AssocTime") or "")
            ci.rx_rate_bps = _int(val.get("RxRateBps"))
            ci.tx_rate_bps = _int(val.get("TxRateBps"))
            into[mac] = ci

    # ---------------------------------------------------------------- public
    def fetch(self, force: bool = False) -> dict[str, ClientInfo]:
        """Return MAC -> ClientInfo, cached for a few seconds."""
        with self._lock:
            fresh = (time.time() - self._fetched_at) < self._cache_seconds
            if fresh and not force and self._clients:
                return self._clients

            r = self._ensure_router()
            if r is None:
                return self._clients
            if not self._ensure_topo_page(r):
                return self._clients

            merged: dict[str, ClientInfo] = {}
            # The plain call returns every client; the banded calls are a
            # fallback for firmware variants that only populate them.
            base = "/?_type=menuData&_tag=topo_lua.lua"
            data = self._fetch_json(r, base)
            if data:
                self._collect(data, merged)
            if not merged:
                parent = "MESH.CONTROLLER"
                for atype in (ACCESS_2G, ACCESS_5G):
                    d = self._fetch_json(
                        r,
                        f"{base}&AccessType={atype}&ParentID={parent}&Action=More",
                    )
                    if d:
                        self._collect(d, merged)

            if merged:
                self._clients = merged
                self._fetched_at = time.time()
                self._last_ok = self._fetched_at
            return self._clients

    def hostnames(self) -> dict[str, str]:
        """MAC -> hostname, for devices the router actually knows by name."""
        return {mac: c.hostname for mac, c in self.fetch().items() if c.hostname}

    def close(self) -> None:
        if self._router is not None:
            try:
                self._router.close()
            except Exception:  # noqa: BLE001
                pass
            self._router = None


# Module-level singleton: one login, one cache, reused by the scanner.
_shared: TopoClient | None = None
_shared_lock = threading.Lock()


def get_client() -> TopoClient:
    global _shared
    with _shared_lock:
        if _shared is None:
            _shared = TopoClient()
        return _shared