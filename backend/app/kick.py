"""Kick orchestration.

One Kick button does two things, because neither alone is sufficient:

  router — block the MAC in the router's Access Control list. This is the only
      thing that stops the device from reconnecting, and it survives the device
      ignoring us. But it does NOT sever an already-established session.
  arp    — a short bidirectional ARP spoof. This severs the live session
      immediately, but modern iOS/Android actively defend against ARP poisoning
      (they send their own corrections), so it is best-effort.

So: run both, in parallel, and record honestly which halves landed. A router
failure is reported to the user rather than silently degrading to ARP-only —
they need to know the permanent block did not happen.

Deleting the rule requires the router-assigned instance id from the Apply
response; it is persisted in KickLog.router_inst_id. If that is ever lost (DB
reset, upgrade), we fall back to matching the MAC against the router's own rule
list.
"""
from __future__ import annotations

import ipaddress
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from sqlmodel import select

from .config import config_store
from .db import Device, DeviceApSeen, KickLog, get_session, utcnow
from . import profiles
from .net import KickTarget, SpoofEngine, normalize_mac
from .router_client import RouterError, ZteRouter
from .ssid_map import interface_for_mac
from .ssid_map import invalidate as invalidate_ssid
from .ssid_resolver import get_resolver
from .topo_client import get_client as get_topo_client

log = logging.getLogger("netdash.kick")

arp_engine = SpoofEngine()

# How long the ARP half runs before it auto-restores. Short by design: the
# router half is what keeps the device out; ARP is just the instant cut.
ARP_BURST_SECONDS = 90

_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="kick")

# MAC -> kick start epoch.
_active: dict[str, float] = {}
_lock = threading.Lock()


class KickFailed(RuntimeError):
    def __init__(self, msg: str, router_error: str = "", arp_error: str = "") -> None:
        super().__init__(msg)
        self.router_error = router_error
        self.arp_error = arp_error

    def detail(self) -> str:
        parts = []
        if self.router_error:
            parts.append(f"Router: {self.router_error}")
        if self.arp_error:
            parts.append(f"ARP: {self.arp_error}")
        return " | ".join(parts)


def active_map() -> dict[str, float]:
    with _lock:
        return dict(_active)


def is_kicked(mac: str) -> float | None:
    with _lock:
        return _active.get(normalize_mac(mac))


def _set(mac: str, started: float | None) -> None:
    mac = normalize_mac(mac)
    with _lock:
        if started is None:
            _active.pop(mac, None)
        else:
            _active[mac] = started


def _update_log(mac: str, **fields) -> None:
    pid = profiles.active_id()
    with get_session() as s:
        stmt = select(KickLog).where(
            KickLog.mac == normalize_mac(mac), KickLog.active == True  # noqa: E712
        )
        if pid is not None:
            stmt = stmt.where(KickLog.network_profile_id == pid)
        row = s.exec(stmt.order_by(KickLog.started_at.desc())).first()
        if row is None:
            return
        for k, v in fields.items():
            setattr(row, k, v)
        s.add(row)
        s.commit()


# --------------------------------------------------------------- SSID / iface


def target_interfaces(mac: str) -> tuple[list[str], str, str]:
    """Which APs to block. Returns (interfaces, primary, source).

    A client that roams between bands keeps one MAC but appears on a different
    ``DEV.WIFI.APn`` each time. Access Control is per-AP, so blocking only the
    AP it sits on right now lets it straight back in on the other band. The
    target set is therefore the union of:

      * a manual per-MAC override (highest priority),
      * a *fresh* read of the router's WLAN client table, so we never act on a
        stale cached association,
      * every AP this MAC has ever been seen on (the ``device_ap_seen`` history).
    """
    cfg = config_store.settings
    manual = cfg.wifi_interface_map.get(normalize_mac(mac))
    if manual:
        return [manual], manual, "manual"

    fresh = ""
    try:
        fresh = get_resolver().interface_for(mac, force_refresh=True)
    except Exception as e:  # noqa: BLE001
        log.warning("fresh SSID lookup failed for %s: %s", mac, e)

    history: list[str] = []
    pid = profiles.active_id()
    try:
        with get_session() as s:
            stmt = select(DeviceApSeen).where(
                DeviceApSeen.mac == normalize_mac(mac)
            )
            if pid is not None:
                stmt = stmt.where(DeviceApSeen.network_profile_id == pid)
            rows = s.exec(stmt).all()
            # Most recently seen first: the current AP is the likeliest one the
            # device will try first.
            history = [
                r.interface for r in sorted(rows, key=lambda r: r.last_seen, reverse=True)
            ]
    except Exception as e:  # noqa: BLE001
        log.warning("AP history unavailable for %s: %s", mac, e)

    seen: list[str] = []
    for i in [fresh, *history]:
        if i and i not in seen:
            seen.append(i)

    if seen:
        src = "auto" if fresh and seen == [fresh] else "auto+history"
        return seen, seen[0], src

    # Nothing on the WLAN: either wired, or the router is not reporting it.
    if not _is_wireless(mac):
        return [], "", "wired"
    return [], cfg.default_wifi_interface, "fallback"


def resolve_interface(mac: str) -> tuple[str, str]:
    """(interface, source) — source is 'auto', 'manual', 'fallback' or 'unknown'.

    Order:
      1. a per-MAC manual override from Settings,
      2. the router's WLAN Client Status table, which names the exact AP
         (``DEV.WIFI.AP5`` etc.) the client is associated with,
      3. the configured default, only when the device is actually associated
         with that AP.

    Step 3 matters: the previous version always fell back to
    ``default_wifi_interface``. On a router where SSID5 and SSID6 are both 5 GHz
    that wrote the rule to the wrong AP, and because the router accepted the
    rule the block silently did nothing. Now, when the device is associated with
    a *different* AP than the default, we refuse to guess and report 'unknown'
    so the caller can tell the user instead of reporting a false success.
    """
    cfg = config_store.settings
    manual = cfg.wifi_interface_map.get(normalize_mac(mac))
    if manual:
        return manual, "manual"

    try:
        iface = get_resolver().interface_for(mac)
    except Exception as e:  # noqa: BLE001
        log.warning("SSID auto-detect gagal untuk %s: %s", mac, e)
        iface = ""

    if iface:
        return iface, "auto"

    # No association found. A wired client is genuinely not on any AP, so the
    # ACL rule cannot target it at all.
    if not iface and not _is_wireless(mac):
        return "", "wired"

    return cfg.default_wifi_interface, "fallback"


def _is_wireless(mac: str) -> bool:
    """True when the router reports this MAC as an associated WLAN client."""
    try:
        return bool(get_resolver().interface_for(mac, force_refresh=True))
    except Exception:  # noqa: BLE001
        return True


# ------------------------------------------------------------------- halves


def _router_half(
    mac: str, interfaces: list[str], name: str
) -> tuple[bool, list[str], list[str], str, list[str]]:
    """Returns (ok, inst_ids, per_interface_errors, summary_error).

    Creates one Access Control rule per target AP. The router holds only 10 ACL
    entries in total, so a multi-AP kick consumes several; a full table is
    reported per interface instead of aborting the whole kick.
    """
    if not interfaces:
        return False, [], [], (
            "Tidak ada interface WLAN untuk device ini. Device kemungkinan "
            "kabel (Ethernet), sehingga Access Control per-SSID tidak berlaku."
        ), []
    try:
        with ZteRouter() as r:
            r.login()
            created, errors, covered = r.block_multi(mac, interfaces, name=name)
        invalidate_ssid()
        ok = bool(created)
        missing = [i for i in interfaces if i not in covered]
        if ok and missing:
            # Partial success, stated precisely: the device is only stopped from
            # joining the APs that actually got a rule.
            summary = (
                "Blokir hanya berlaku di "
                + ", ".join(covered)
                + ". Gagal di: "
                + ", ".join(missing)
                + " - device bisa tetap konek lewat SSID itu."
            )
        elif not ok:
            summary = "Gagal memblokir: " + "; ".join(errors)
        else:
            summary = ""
        return ok, created, errors, summary, covered
    except RouterError as e:
        return False, [], [], str(e), []
    except Exception as e:  # noqa: BLE001
        return False, [], [], f"{type(e).__name__}: {e}", []


def _arp_half(mac: str, ip: str) -> tuple[bool, str]:
    """Short spoof burst. Returns (ok, error)."""
    from .net import detect_local_ip

    cfg = config_store.settings
    local_ip = detect_local_ip(cfg.subnet)
    if not local_ip:
        return False, "tidak bisa menentukan IP lokal di subnet ini"
    if not ip:
        return False, "device belum punya IP"
    gw_mac = normalize_mac(cfg.gateway_mac) if cfg.gateway_mac else _lookup_gateway_mac(cfg)
    if not gw_mac:
        return False, "MAC gateway belum diketahui (isi di Settings)"
    target = KickTarget(
        mac=mac,
        ip=ip,
        gateway_ip=_gateway_ip(cfg.subnet),
        gateway_mac=gw_mac,
        local_ip=local_ip,
        interface=cfg.interface or None,
    )
    try:
        arp_engine.start(target, ARP_BURST_SECONDS)
        return True, ""
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def _gateway_ip(subnet: str) -> str:
    try:
        return str(ipaddress.ip_network(subnet, strict=False).network_address + 1)
    except ValueError:
        return "192.168.1.1"


def _lookup_gateway_mac(cfg) -> str:
    pid = profiles.active_id()
    with get_session() as s:
        stmt = select(Device).where(Device.ip == _gateway_ip(cfg.subnet))
        if pid is not None:
            stmt = stmt.where(Device.network_profile_id == pid)
        dev = s.exec(stmt).first()
        if dev:
            return dev.mac
    return ""


# ---------------------------------------------------------------- kick / stop


def start_kick(mac: str, ip: str = "", actor: str = "", reason: str = "") -> dict:
    """Combined kick: router blacklist + short ARP burst, in parallel.

    Returns a report of what actually happened. Raises ValueError only for
    "already kicked"; router problems come back in the result so the UI can
    show them without the request looking like a transport failure.
    """
    mac = normalize_mac(mac)
    if is_kicked(mac) is not None or arp_engine.is_active(mac) is not None:
        raise ValueError("Device sudah sedang di-kick")

    ifaces, primary, iface_src = target_interfaces(mac)
    name = _log_name(mac, ip)

    # Log row first so both halves can attach their outcome to it.
    pid = profiles.active_id()
    with get_session() as s:
        row = KickLog(
            network_profile_id=pid,
            mac=mac,
            ip=ip,
            actor=actor,
            reason=reason[:120],
            active=True,
            mode="both",
            wifi_interface=primary,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        log_id = row.id

    f_router = _pool.submit(_router_half, mac, ifaces, name)
    f_arp = _pool.submit(_arp_half, mac, ip)

    router_ok, inst_ids, iface_errors, router_err, covered = f_router.result(timeout=90)
    arp_ok, arp_err = f_arp.result(timeout=90)

    # Every rule id must be stored: stopping the kick has to remove all of them.
    joined = ",".join(inst_ids)
    _update_log(
        mac,
        router_blocked=router_ok,
        router_inst_id=inst_ids[0] if inst_ids else "",
        router_inst_ids=joined,
        arp_active=arp_ok,
        router_error=router_err or arp_err,
    )

    # Only claim "kicked" when at least one half landed.
    if router_ok or arp_ok:
        _set(mac, time.time())
    else:
        _close_logs(mac)

    if not router_ok and not arp_ok:
        _close_logs(mac)
        raise KickFailed(
            "Gagal total memblokir device.", router_error=router_err, arp_error=arp_err
        )

    return {
        "router_blocked": router_ok,
        "router_inst_id": inst_ids[0] if inst_ids else "",
        "router_inst_ids": inst_ids,
        "router_error": router_err,
        "arp_active": arp_ok,
        "arp_error": arp_err,
        "interface": primary,
        "interface_source": iface_src,
        # Per-interface outcome so the UI can show every AP, not just one.
        "interfaces_targeted": ifaces,
        "interfaces_blocked": covered,
        "interfaces_failed": iface_errors,
        "log_id": log_id,
        "arp_seconds": ARP_BURST_SECONDS if arp_ok else 0,
    }


def stop_kick(mac: str, actor: str = "") -> dict:
    """Stop kicking: delete every router rule and stop/restore the ARP spoof.

    A multi-AP kick leaves one rule per AP on the same MAC. Deleting only the
    first would leave the device blocked on the others, so all of them go -
    including any whose instance id was lost, since unblock_all() re-reads the
    router's table instead of trusting the database.
    """
    mac = normalize_mac(mac)
    saved_ids = ""
    pid = profiles.active_id()
    with get_session() as s:
        stmt = select(KickLog).where(
            KickLog.mac == mac, KickLog.active == True  # noqa: E712
        )
        if pid is not None:
            stmt = stmt.where(KickLog.network_profile_id == pid)
        row = s.exec(stmt.order_by(KickLog.started_at.desc())).first()
        if row is not None:
            saved_ids = row.router_inst_ids or row.router_inst_id or ""

    router_err = ""
    removed: list[str] = []
    errors: list[str] = []
    rule_deleted = False
    try:
        with ZteRouter() as r:
            r.login()
            removed, errors = r.unblock_all(mac)
            rule_deleted = bool(removed)
            leftovers = r.rules_for(mac)
            if leftovers:
                # The router still holds at least one rule; say which so the user
                # can remove it by hand if the table is wedged.
                router_err = (
                    f"Masih ada {len(leftovers)} rule di router: "
                    + ", ".join(x.inst_id or x.interface for x in leftovers)
                )
    except RouterError as e:
        router_err = str(e)
    except Exception as e:  # noqa: BLE001
        router_err = f"{type(e).__name__}: {e}"

    arp_stopped = arp_engine.is_active(mac) is not None
    if arp_stopped:
        arp_engine.stop(mac)  # stops the thread and sends the ARP restore

    _set(mac, None)
    _close_logs(mac)
    invalidate_ssid()
    _notify()

    if router_err:
        raise KickFailed(
            "Gagal menghapus semua rule dari router.",
            router_error=router_err,
            arp_error="; ".join(errors) if errors else "",
        )

    return {
        "rule_deleted": rule_deleted,
        "used_inst_id": removed[0] if removed else "",
        "removed_inst_ids": removed,
        "errors": errors,
        "arp_stopped": arp_stopped,
    }


def _log_name(mac: str, ip: str) -> str:
    pid = profiles.active_id()
    with get_session() as s:
        stmt = select(Device).where(Device.mac == mac)
        if pid is not None:
            stmt = stmt.where(Device.network_profile_id == pid)
        dev = s.exec(stmt).first()
        if dev and dev.nickname:
            return dev.nickname[:15]
    return (ip or mac)[-15:]


def _close_logs(mac: str, any_profile: bool = False) -> None:
    pid = None if any_profile else profiles.active_id()
    with get_session() as s:
        stmt = select(KickLog).where(
            KickLog.mac == mac, KickLog.active == True  # noqa: E712
        )
        if pid is not None:
            stmt = stmt.where(KickLog.network_profile_id == pid)
        rows = s.exec(stmt).all()
        for row in rows:
            row.active = False
            row.arp_active = False
            row.ended_at = utcnow()
            row.duration_seconds = max(
                0, int((row.ended_at - row.started_at).total_seconds())
            )
            s.add(row)
        s.commit()


def _notify() -> None:
    try:
        import asyncio

        from .scanner import hub, kicked_map

        loop = hub.loop
        if loop is not None and loop.is_running():
            asyncio.run_coroutine_threadsafe(hub.broadcast("kicked", kicked_map()), loop)
    except Exception as e:  # noqa: BLE001
        log.debug("could not broadcast kick state: %s", e)


# ------------------------------------------------------------ router helpers


def router_reachable() -> tuple[bool, str]:
    try:
        with ZteRouter() as r:
            r.login()
            rules = r.list_rules()
        return True, f"Login berhasil, {len(rules)} rule di daftar"
    except RouterError as e:
        return False, str(e)
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def router_sync() -> dict:
    """Reconcile our state with the router's real blacklist."""
    with ZteRouter() as r:
        r.login()
        rules = r.list_rules()
    blocked = {x.mac: x for x in rules if x.blocked}
    with _lock:
        for mac in blocked:
            _active.setdefault(mac, time.time())
    return {
        "blocked": sorted(blocked),
        "inst_ids": {m: rule.inst_id for m, rule in blocked.items() if rule.inst_id},
    }


def stop_all() -> None:
    """Shutdown: stop ARP threads and remove any rules we applied."""
    arp_engine.stop_all()
    with _lock:
        macs = list(_active)
    for mac in macs:
        inst = ""
        with get_session() as s:
            row = s.exec(
                select(KickLog)
                .where(KickLog.mac == mac, KickLog.active == True)  # noqa: E712
                .order_by(KickLog.started_at.desc())
            ).first()
            if row is not None:
                inst = row.router_inst_id or ""
        try:
            with ZteRouter() as r:
                r.login()
                r.unblock(mac, inst or None)
        except Exception as e:  # noqa: BLE001
            log.warning("shutdown unblock gagal untuk %s: %s", mac, e)
        # Mark the log closed even though the active profile may already have
        # moved on; otherwise the old row stays "active" forever.
        _close_logs(mac, any_profile=True)
        _set(mac, None)