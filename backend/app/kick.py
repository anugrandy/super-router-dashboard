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
from .db import Device, KickLog, get_session, utcnow
from .net import KickTarget, SpoofEngine, normalize_mac
from .router_client import RouterError, ZteRouter
from .ssid_map import interface_for_mac
from .ssid_map import invalidate as invalidate_ssid

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
    with get_session() as s:
        row = s.exec(
            select(KickLog)
            .where(KickLog.mac == normalize_mac(mac), KickLog.active == True)  # noqa: E712
            .order_by(KickLog.started_at.desc())
        ).first()
        if row is None:
            return
        for k, v in fields.items():
            setattr(row, k, v)
        s.add(row)
        s.commit()


# --------------------------------------------------------------- SSID / iface


def resolve_interface(mac: str) -> tuple[str, str]:
    """(interface, source) — source is 'auto', 'manual' or 'fallback'.

    Falls back to the configured default when the router won't tell us which
    SSID the device is on, so the UI can ask the user to check.
    """
    cfg = config_store.settings
    manual = cfg.wifi_interface_map.get(normalize_mac(mac))
    if manual:
        return manual, "manual"
    try:
        iface, how = interface_for_mac(mac)
        if iface and how == "auto":
            return iface, "auto"
    except Exception as e:  # noqa: BLE001
        log.warning("SSID auto-detect gagal untuk %s: %s", mac, e)
    return cfg.default_wifi_interface, "fallback"


# ------------------------------------------------------------------- halves


def _router_half(mac: str, iface: str, name: str) -> tuple[bool, str, str]:
    """Returns (ok, inst_id, error)."""
    try:
        with ZteRouter() as r:
            r.login()
            if r.is_blocked(mac):
                return True, r._find_inst_id_by_mac(mac), ""
            inst = r.block(mac, name=name, interface=iface)
        invalidate_ssid()
        return True, inst, ""
    except RouterError as e:
        return False, "", str(e)
    except Exception as e:  # noqa: BLE001
        return False, "", f"{type(e).__name__}: {e}"


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
    with get_session() as s:
        dev = s.exec(select(Device).where(Device.ip == _gateway_ip(cfg.subnet))).first()
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

    iface, iface_src = resolve_interface(mac)
    name = _log_name(mac, ip)

    # Log row first so both halves can attach their outcome to it.
    with get_session() as s:
        row = KickLog(
            mac=mac,
            ip=ip,
            actor=actor,
            reason=reason[:120],
            active=True,
            mode="both",
            wifi_interface=iface,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        log_id = row.id

    f_router = _pool.submit(_router_half, mac, iface, name)
    f_arp = _pool.submit(_arp_half, mac, ip)

    router_ok, inst_id, router_err = f_router.result(timeout=60)
    arp_ok, arp_err = f_arp.result(timeout=60)

    _update_log(
        mac,
        router_blocked=router_ok,
        router_inst_id=inst_id,
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
        "router_inst_id": inst_id,
        "router_error": router_err,
        "arp_active": arp_ok,
        "arp_error": arp_err,
        "interface": iface,
        "interface_source": iface_src,
        "log_id": log_id,
        "arp_seconds": ARP_BURST_SECONDS if arp_ok else 0,
    }


def stop_kick(mac: str, actor: str = "") -> dict:
    """Stop kicking: delete the router rule and stop/restore the ARP spoof."""
    mac = normalize_mac(mac)
    inst_id = ""
    with get_session() as s:
        row = s.exec(
            select(KickLog)
            .where(KickLog.mac == mac, KickLog.active == True)  # noqa: E712
            .order_by(KickLog.started_at.desc())
        ).first()
        if row is not None:
            inst_id = row.router_inst_id or ""

    router_err = ""
    rule_deleted = False
    try:
        with ZteRouter() as r:
            r.login()
            if inst_id or r.is_blocked(mac):
                # unblock() falls back to a MAC lookup when inst_id is empty,
                # which covers a DB reset or an upgrade that lost the column.
                r.unblock(mac, inst_id or None)
                rule_deleted = True
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
        raise KickFailed("Gagal menghapus rule dari router.", router_error=router_err)

    return {
        "rule_deleted": rule_deleted,
        "used_inst_id": inst_id,
        "arp_stopped": arp_stopped,
    }


def _log_name(mac: str, ip: str) -> str:
    with get_session() as s:
        dev = s.exec(select(Device).where(Device.mac == mac)).first()
        if dev and dev.nickname:
            return dev.nickname[:15]
    return (ip or mac)[-15:]


def _close_logs(mac: str) -> None:
    with get_session() as s:
        rows = s.exec(
            select(KickLog).where(KickLog.mac == mac, KickLog.active == True)  # noqa: E712
        ).all()
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
        _set(mac, None)