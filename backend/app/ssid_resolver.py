"""Resolve which SSID / Access Control interface a device is really on.

Why this module exists
----------------------
The ZTE F670L exposes Access Control as a *per-AP* rule, so a block only works
if the rule targets the AP the client is associated with. The ACL form offers
``DEV.WIFI.AP1`` .. ``DEV.WIFI.AP8``, and on a typical config SSID5 and SSID6
are both on the 5 GHz radio - so the band is not enough to choose.

Where the data comes from
-------------------------
``topo_lua.lua`` only reports ``AccessType`` (0=LAN, 1=2.4 GHz, 2=5 GHz). That
cannot separate SSID5 from SSID6, which is exactly the failure this replaces.

``wlan_client_stat_lua.lua`` (Local Network > Status > WLAN Client Status) is
the real source: one instance per associated client carrying ``AliasName`` -
the exact AP interface (``DEV.WIFI.AP5``) - plus ``ESSID`` looked up from the AP
table, and cumulative ``RXBytes``/``TXBytes``. Verified on this router:

    76:09:9E:D7:88:FD  TECNO-SPARK-Go-1   DEV.WIFI.AP5  SSID5  AgraSec
    C2:4A:22:70:1C:C8  OPPO-A16          DEV.WIFI.AP5  SSID5  AgraSec
    26:E3:D2:DE:86:84  A52-milik-Nur     DEV.WIFI.AP5  SSID5  AgraSec
    04:6C:59:7D:73:14  UNKNOWN-PC        DEV.WIFI.AP6  SSID6  FAIZ

SSID names come from ``wlan_macfilteraclpolicy_lua.lua``, which is also the list
of APs whose ACL policy is not ``Disabled`` - i.e. the ones a block can target.
"""

from __future__ import annotations

import logging
import re
import threading
import time

from .router_client import ZteRouter
from .topo_client import _int, _norm_mac

log = logging.getLogger(__name__)

CLIENT_STAT_TAG = "wlan_client_stat_lua.lua"
ACL_POLICY_TAG = "wlan_macfilteraclpolicy_lua.lua"


def _para_map(payload: str) -> list[dict[str, str]]:
    """Split an <Instance> blob into {ParaName: ParaValue} dicts."""
    out: list[dict[str, str]] = []
    for inst in re.findall(r"<Instance>(.*?)</Instance>", payload, re.S):
        out.append(
            dict(re.findall(r"<ParaName>([^<]+)</ParaName><ParaValue>([^<]*)</ParaValue>", inst))
        )
    return out


class SsidResolver:
    """Caches the AP table and per-client AP associations for a few seconds.

    The router is a single-threaded CGI; both calls are cached so a scan or a
    kick does not re-hit it repeatedly.
    """

    def __init__(self, cache_seconds: float = 10.0) -> None:
        self._cache_seconds = cache_seconds
        self._lock = threading.Lock()
        self._fetched_at = 0.0
        self._router: ZteRouter | None = None
        self._token: str | None = None
        # interface -> {"alias": SSID name, "band": .., "blockable": bool}
        self._aps: dict[str, dict[str, object]] = {}
        # MAC -> ap interface
        self._client_ap: dict[str, str] = {}
        # MAC -> {"rx_bytes": int, "tx_bytes": int, "ssid": str}
        self._usage: dict[str, dict[str, object]] = {}
        self._last_ok = 0.0

    @property
    def fresh(self) -> bool:
        """True when the WLAN client table was actually read recently.

        ``_refresh`` keeps the previous table when the router is unreachable;
        liveness callers must not mistake that stale copy for a live one.
        The window matches the scanner's 120s offline grace so a transient
        router hiccup cannot drop idle clients from a single scan.
        """
        return self._last_ok > 0 and (time.time() - self._last_ok) < 120.0

    # ------------------------------------------------------------- internals
    def _ensure_router(self) -> ZteRouter | None:
        if self._router is None:
            try:
                r = ZteRouter()
                r.login()
                self._router = r
            except Exception as e:  # noqa: BLE001
                log.warning("ssid: router login failed: %s", e)
                return None
        return self._router

    def _load_localnet_page(self, r: ZteRouter) -> None:
        """Local Network > Status owns the WLAN client table; its page token is
        required or the endpoint answers SessionTimeout."""
        try:
            resp = r.client.get(
                "/?_type=menuView&_tag=localNetStatus&Menu3Location=0",
                headers=r._headers(),
            )
        except Exception as e:  # noqa: BLE001
            log.debug("ssid: localNetStatus page failed: %s", e)
            return
        text = getattr(resp, "text", "")
        m = re.search(r'id="_sessionTmpToken"[^>]*>([^<]+)<', text)
        if not m:
            m = re.search(r'_sessionTmpToken["\']?\s*[:=]\s*["\']([A-Za-z0-9+/=]+)', text)
        if m:
            self._token = m.group(1).strip()

    def _post(self, r: ZteRouter, tag: str) -> str | None:
        for token in (self._token, r.session_token):
            if not token:
                continue
            try:
                body, headers = r._encode_body(
                    {"IF_ACTION": "Read", "_sessionTOKEN": token}
                )
                resp = r.client.post(
                    f"/?_type=menuData&_tag={tag}", content=body, headers=headers
                )
            except Exception as e:  # noqa: BLE001
                log.debug("ssid: POST %s failed: %s", tag, e)
                continue
            text = getattr(resp, "text", "")
            if resp.status_code == 200 and "SessionTimeout" not in text:
                return text
        return None

    def _refresh(self) -> None:
        r = self._ensure_router()
        if r is None:
            return

        # 1. AP table: interface -> SSID name + radio. Same source the router UI
        #    uses for the ACL form's Interface dropdown.
        acl = self._post(r, ACL_POLICY_TAG)
        if acl is None:
            # The policy endpoint wants the WLAN-Advanced page token.
            try:
                resp = r.client.get(
                    "/?_type=menuView&_tag=wlanAdvanced&Menu3Location=0",
                    headers=r._headers(),
                )
                m = re.search(
                    r'id="_sessionTmpToken"[^>]*>([^<]+)<', getattr(resp, "text", "")
                )
                if m:
                    self._token = m.group(1).strip()
            except Exception:  # noqa: BLE001
                pass
            acl = self._post(r, ACL_POLICY_TAG)

        if acl:
            for d in _para_map(acl):
                iid = (d.get("_InstID") or "").strip()
                if not iid.startswith("DEV.WIFI.AP"):
                    continue
                self._aps[iid] = {
                    "alias": (d.get("Alias") or "").strip(),
                    "radio": (d.get("WLANViewName") or "").strip(),
                    "essid": (d.get("ESSID") or "").strip(),
                    "blockable": (d.get("ACLPolicy") or "").strip() not in
                    ("Disabled", "", None),
                }
            # Band comes from the radio table in the same payload.
            for d in _para_map(acl):
                if (d.get("_InstID") or "").startswith("DEV.WIFI.RD"):
                    band = (d.get("Band") or "").strip()
                    for ap in self._aps.values():
                        if ap.get("radio") == d["_InstID"]:
                            ap["band"] = band

        # 2. Per-client association.
        if self._client_ap and self._token is None:
            self._load_localnet_page(r)
        stat = self._post(r, CLIENT_STAT_TAG)
        if stat is None:
            self._load_localnet_page(r)
            stat = self._post(r, CLIENT_STAT_TAG)

        if stat:
            self._client_ap.clear()
            self._usage.clear()
            for d in _para_map(stat):
                mac = _norm_mac(d.get("MACAddress"))
                if not mac:
                    continue
                ap = (d.get("AliasName") or "").strip()
                if ap:
                    self._client_ap[mac] = ap
                self._usage[mac] = {
                    "rx_bytes": _int(d.get("RXBytes")),
                    "tx_bytes": _int(d.get("TXBytes")),
                    "hostname": (d.get("HostName") or "").strip(),
                    "ip": (d.get("IPAddress") or "").strip(),
                    "essid": (d.get("ESSID") or "").strip(),
                    "current_mode": (d.get("CurrentMode") or "").strip(),
                    "link_time": _int(d.get("LinkTime")),
                }
            self._last_ok = time.time()

        self._fetched_at = time.time()

    def _ensure(self, force: bool = False) -> None:
        with self._lock:
            if not force and (time.time() - self._fetched_at) < self._cache_seconds:
                return
            if force or not (self._client_ap or self._aps):
                self._refresh()

    # ---------------------------------------------------------------- public
    def interface_for(self, mac: str, force_refresh: bool = False) -> str:
        """The AP interface (e.g. DEV.WIFI.AP5) this MAC is associated with.

        Returns '' when the device is not associated with this router's WLAN -
        a wired client, or a client the router is not reporting. Callers must
        treat '' as "unknown" and must NOT silently substitute a default.

        ``force_refresh`` bypasses the cache. A kick uses it so the block targets
        where the device is *now*, not where it was up to 10 seconds ago - it
        may have roamed to the other band in between.
        """
        m = _norm_mac(mac)
        if not m:
            return ""
        self._ensure(force=force_refresh)
        return self._client_ap.get(m, "")

    def ssid_name_for(self, mac: str) -> str:
        m = _norm_mac(mac)
        self._ensure()
        iface = self._client_ap.get(m, "")
        if not iface:
            return ""
        ap = self._aps.get(iface, {})
        return str(ap.get("alias") or "") or str(self._usage.get(m, {}).get("essid") or "")

    def blockable_interfaces(self) -> list[str]:
        """APs whose ACL policy is not Disabled - the ones a rule can target."""
        self._ensure()
        return [i for i, ap in sorted(self._aps.items()) if ap.get("blockable")]

    def usage_for(self, mac: str) -> dict[str, object]:
        m = _norm_mac(mac)
        self._ensure()
        return dict(self._usage.get(m, {}))

    def snapshot(self) -> dict[str, dict[str, object]]:
        """MAC -> {interface, ssid, rx_bytes, tx_bytes} for every known client."""
        self._ensure()
        out: dict[str, dict[str, object]] = {}
        for mac, iface in self._client_ap.items():
            ap = self._aps.get(iface, {})
            u = self._usage.get(mac, {})
            out[mac] = {
                "interface": iface,
                "ssid": str(ap.get("alias") or u.get("essid") or ""),
                "rx_bytes": int(u.get("rx_bytes") or 0),
                "tx_bytes": int(u.get("tx_bytes") or 0),
                # topo_lua sometimes omits an idle phone while it is still in
                # the WLAN client table; carrying these here keeps its name
                # (and therefore its OS guess) from falling back to TTL-only.
                "hostname": str(u.get("hostname") or ""),
                "ip": str(u.get("ip") or ""),
            }
        return out

    def close(self) -> None:
        if self._router is not None:
            try:
                self._router.close()
            except Exception:  # noqa: BLE001
                pass
            self._router = None


_shared: SsidResolver | None = None
_shared_lock = threading.Lock()


def get_resolver() -> SsidResolver:
    global _shared
    with _shared_lock:
        if _shared is None:
            _shared = SsidResolver()
        return _shared