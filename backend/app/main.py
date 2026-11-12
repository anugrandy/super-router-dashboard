"""netdash — home network dashboard & device manager (LAN-reachable)."""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlmodel import delete, select

from . import auth, kick, mdns, net
from .config import BASE_DIR, config_store
from .db import (
    Device,
    DeviceApSeen,
    DeviceEvent,
    KickLog,
    NetworkProfile,
    ScanSample,
    SpeedtestRun,
    WanEvent,
    engine,
    get_session,
    init_db,
    utcnow,
)
from . import fingerprint
from . import profiles
from . import router_health, topo_client, wan_monitor, wan_status
from . import speedtest as speedtest_mod
from .router_client import RouterError
from .scanner import device_to_dict, hub, kicked_map, scan_loop, scan_loop_once

log = logging.getLogger("netdash")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

FRONTEND_DIST = __import__("pathlib").Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    _log_startup_diagnostics()
    # Publish http://netdash.local:<port> so phones do not need the laptop's IP.
    mdns.start()
    task = asyncio.create_task(scan_loop())
    # WAN is polled in its own thread on a 2-minute cadence, so it never adds
    # latency to the device scan or to any API request.
    wan_monitor.start(loop=asyncio.get_running_loop())
    yield
    # Never leave a spoof or a router block behind when the server exits.
    try:
        kick.stop_all()
    except Exception as e:  # noqa: BLE001
        log.warning("shutdown cleanup: %s", e)
    mdns.stop()
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass


app = FastAPI(title="netdash", version="1.0.0", lifespan=lifespan)
# In development the browser talks to Vite, which proxies /api and /ws, so the
# cookie stays same-origin. These origins still matter when a phone opens the
# backend directly or when another local tool calls the API from a LAN address.
# Private ranges are allowed deliberately: this is a dashboard for the owner's
# own network, never a public service.
_LOCAL_ORIGIN = (
    r"^https?://("
    r"localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|"
    r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
    r"192\.168\.\d{1,3}\.\d{1,3}|"
    r"172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
    r")(?::\d+)?$"
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_origin_regex=_LOCAL_ORIGIN,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _log_startup_diagnostics() -> None:
    """Print backend identity and router-credential availability at startup.

    Values are never logged - only whether each variable is set. The backend
    port is included because a stale second server on another port is the
    easiest way to lose requests without noticing.
    """
    import os as _os

    port = _os.environ.get("NETDASH_PORT", "(uvicorn --port)")
    env = BASE_DIR / ".env"
    log.info("=" * 62)
    log.info("netdash backend starting")
    log.info("  listening port      : %s", port)
    log.info("  backend/.env found  : %s", env.exists())
    for key in ("NETDASH_ROUTER_USER", "NETDASH_ROUTER_PASS", "NETDASH_ROUTER_URL"):
        log.info("  %-20s: %s", key, "set" if _os.environ.get(key) else "NOT SET")
    log.info("  router credentials  : %s",
             "available" if _router_configured() else "MISSING")
    raw_ok = net.raw_socket_available()
    log.info("  raw socket (ARP)    : %s", "available" if raw_ok else "BLOCKED")
    if not raw_ok:
        log.warning(
            "  raw socket error    : %s", net.raw_socket_error()
        )
        if os.name != "nt":
            log.warning(
                "  ARP scan cannot run: device scan will fall back to `arp -an` "
                "and most devices will look offline."
            )
            log.warning(
                "  fix: sudo setcap cap_net_raw+ep \"$(readlink -f .venv/bin/python)\" "
                "then restart the backend"
            )
    log.info("=" * 62)


# --------------------------------------------------------------- schemas


class LoginIn(BaseModel):
    username: str
    password: str


class ProfileIn(BaseModel):
    username: str | None = None
    display_name: str | None = None


# Single-user accounts: keep the login name predictable and safe in a cookie.
USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$")


def _clean_display_name(value: str | None) -> str:
    # Display names are free text, but never allow newlines or control junk to
    # leak into the sidebar. Empty means "fall back to the username".
    return " ".join((value or "").split())[:48]


class DevicePatch(BaseModel):
    nickname: str | None = None
    is_static: bool | None = None
    # "" clears the override and falls back to the automatic guess.
    type_override: str | None = None
    # simple-icons slug, e.g. "samsung". "" clears it and returns to auto.
    brand_override: str | None = None


class ProfileRenameIn(BaseModel):
    name: str


class ProfileResetIn(BaseModel):
    """Type the profile's own name to confirm a destructive reset."""

    confirm_name: str


class LogDeleteIn(BaseModel):
    """Filter for deleting history rows.

    At least one filter is required. ``all=True`` is the explicit opt-in for
    wiping a whole log type; without it a request with no filter is rejected so
    a mistyped call can never erase everything by accident.
    """

    scope: Literal[
        "device_events",
        "kick_logs",
        "wan_events",
        "speedtest_runs",
        "all",
    ] = "all"
    mac: str | None = None
    ids: list[int] | None = None
    before: datetime | None = None
    after: datetime | None = None
    all: bool = False
    # Scope device/kick history to one network profile. Omitted means active.
    profile: int | None = None


class KickIn(BaseModel):
    reason: str = ""
    max_seconds: int | None = Field(default=None, ge=10, le=86400)


class SettingsIn(BaseModel):
    subnet: str | None = None
    interface: str | None = None
    scan_interval: float | None = None
    gateway_mac: str | None = None
    whitelist_macs: list[str] | None = None
    kick_max_seconds: int | None = None
    oui_file: str | None = None
    username: str | None = None
    display_name: str | None = None
    kick_mode: str | None = None
    default_wifi_interface: str | None = None
    wifi_interface_map: dict[str, str] | None = None


# --------------------------------------------------------------- auth


@app.post("/api/auth/login")
def login(body: LoginIn, request: Request, response: Response):
    auth.check_rate_limit(request)
    cfg = config_store.settings
    if body.username != cfg.username or not config_store.check_password(body.password):
        auth.record_failure(request)
        raise HTTPException(status_code=401, detail="Username atau password salah")
    auth.clear_failures(request)
    auth.issue_session(response, cfg.username)
    return {"ok": True, "username": cfg.username, "display_name": cfg.display_name}


@app.post("/api/auth/logout")
def logout(response: Response):
    auth.clear_session(response)
    return {"ok": True}


@app.get("/api/auth/me")
def me(username: str = Depends(auth.require_auth)):
    cfg = config_store.settings
    return {"username": cfg.username, "display_name": cfg.display_name}


@app.patch("/api/auth/profile")
def update_profile(
    body: ProfileIn,
    response: Response,
    username: str = Depends(auth.require_auth),
):
    """Edit the signed-in account's own login name and display name."""
    changes = body.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail="Tidak ada perubahan")

    cfg = config_store.settings
    new_username = cfg.username
    if "username" in changes:
        raw = (changes["username"] or "").strip()
        if not USERNAME_RE.match(raw):
            raise HTTPException(
                status_code=400,
                detail="Username 3-32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung",
            )
        new_username = raw

    new_display = cfg.display_name
    if "display_name" in changes:
        raw = (changes["display_name"] or "").strip()
        if len(raw) > 48:
            raise HTTPException(status_code=400, detail="Nama maksimal 48 karakter")
        new_display = _clean_display_name(raw)

    config_store.update(username=new_username, display_name=new_display)
    if new_username != username:
        # The token carries the username; re-issue so this browser stays signed
        # in after a rename. Other sessions deliberately have to sign in again.
        auth.issue_session(response, new_username)
    return {"ok": True, "username": new_username, "display_name": new_display}


# --------------------------------------------------------------- profiles


def _resolve_scope(
    s, profile_id: int | None
) -> tuple[int | None, NetworkProfile | None, bool]:
    """Resolve a requested profile id (or the active profile when omitted).

    Returns ``(profile_id, profile, is_active)``. A request that names an
    unknown profile is a 404 rather than a silent fallback, so a stale link
    cannot show another network's data.
    """
    if profile_id is not None:
        chosen = s.get(NetworkProfile, profile_id)
        if chosen is None:
            raise HTTPException(status_code=404, detail="Profil jaringan tidak ditemukan")
    else:
        chosen = profiles.active(s)
    current = profiles.active(s)
    pid = chosen.id if chosen else None
    is_active = bool(chosen and current and chosen.id == current.id)
    return pid, chosen, is_active


def _require_scope(s, profile_id: int | None) -> tuple[int, NetworkProfile, bool]:
    pid, chosen, is_active = _resolve_scope(s, profile_id)
    if pid is None or chosen is None:
        raise HTTPException(
            status_code=409,
            detail="Belum ada profil jaringan aktif. Jalankan scan dulu.",
        )
    return pid, chosen, is_active


@app.get("/api/profiles")
def list_profiles(username: str = Depends(auth.require_auth)):
    return profiles.snapshot()


@app.patch("/api/profiles/{profile_id}")
async def rename_profile(
    profile_id: int,
    body: ProfileRenameIn,
    username: str = Depends(auth.require_auth),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nama jaringan tidak boleh kosong")
    if len(name) > 48:
        raise HTTPException(status_code=400, detail="Nama jaringan maksimal 48 karakter")
    with get_session() as s:
        profile = s.get(NetworkProfile, profile_id)
        if profile is None:
            raise HTTPException(status_code=404, detail="Profil jaringan tidak ditemukan")
        profile.name = name
        s.add(profile)
        s.commit()
        s.refresh(profile)
        payload = profiles.to_dict(profile)
    await hub.broadcast("profiles", profiles.snapshot())
    return {"ok": True, "profile": payload}


@app.post("/api/profiles/{profile_id}/reset")
async def reset_profile(
    profile_id: int,
    body: ProfileResetIn,
    username: str = Depends(auth.require_auth),
):
    """Wipe one *active* network's devices and history, then rescan it.

    Historical profiles are deliberately excluded: their data is the only copy
    of a network that is no longer physically reachable. The typed name is a
    second confirmation because this cannot be undone.
    """
    with get_session() as s:
        profile = s.get(NetworkProfile, profile_id)
        if profile is None:
            raise HTTPException(status_code=404, detail="Profil jaringan tidak ditemukan")
        current = profiles.active(s)
        if current is None or profile.id != current.id:
            raise HTTPException(
                status_code=409,
                detail="Hanya jaringan yang sedang aktif yang bisa di-reset.",
            )
        name = profile.name

    if body.confirm_name.strip() != name:
        raise HTTPException(
            status_code=400,
            detail=f"Nama jaringan tidak cocok. Ketik '{name}' untuk konfirmasi.",
        )

    # A live router rule belongs to the data being deleted; stop it first so no
    # orphan Access Control entry is left on the router.
    try:
        await asyncio.to_thread(kick.stop_all)
    except Exception as e:  # noqa: BLE001
        log.warning("reset %s: stopping kicks failed: %s", profile_id, e)

    deleted: dict[str, int] = {}
    with get_session() as s:
        for model in (DeviceEvent, KickLog, DeviceApSeen, ScanSample, Device):
            result = s.exec(
                delete(model).where(model.network_profile_id == profile_id)
            )
            deleted[model.__tablename__] = int(getattr(result, "rowcount", 0) or 0)
        s.commit()

    await hub.broadcast("logs_deleted", {"scope": "all", "deleted": deleted})
    await hub.broadcast("profiles", profiles.snapshot())
    # Repopulate from the live network immediately; the scan runs in the
    # background so this request still returns promptly.
    asyncio.create_task(scan_loop_once())
    return {
        "ok": True,
        "deleted": deleted,
        "total": sum(deleted.values()),
        "profile_id": profile_id,
    }


def _get_device_or_404(mac: str, profile_id: int | None = None) -> Device:
    m = net.normalize_mac(mac)
    if not net.valid_mac(m):
        raise HTTPException(status_code=400, detail="Format MAC tidak valid")
    with get_session() as s:
        pid, _profile, _is_active = _require_scope(s, profile_id)
        dev = s.exec(
            select(Device).where(
                Device.network_profile_id == pid, Device.mac == m
            )
        ).first()
        if dev is None:
            raise HTTPException(status_code=404, detail="Device tidak ditemukan")
        s.expunge(dev)
        return dev


@app.get("/api/devices")
def list_devices(
    profile: int | None = None,
    username: str = Depends(auth.require_auth),
):
    with get_session() as s:
        pid, _chosen, _is_active = _resolve_scope(s, profile)
        devices = (
            s.exec(select(Device).where(Device.network_profile_id == pid)).all()
            if pid is not None
            else []
        )
        kicked = kick.active_map() if _is_active else {}
        out = [device_to_dict(d, kicked.get(d.mac)) for d in devices]
    out.sort(key=lambda d: (not d["online"], d["ip"]))
    return {"devices": out, "count": len(out), "profile_id": pid}


@app.get("/api/devices/{mac}")
def device_detail(
    mac: str,
    profile: int | None = None,
    username: str = Depends(auth.require_auth),
):
    dev = _get_device_or_404(mac, profile)
    with get_session() as s:
        pid, _chosen, is_active = _require_scope(s, profile)
    kicked = kick.active_map().get(dev.mac) if is_active else None
    with get_session() as s:
        events = s.exec(
            select(DeviceEvent)
            .where(
                DeviceEvent.network_profile_id == pid,
                DeviceEvent.mac == dev.mac,
            )
            .order_by(DeviceEvent.at.desc())
            .limit(100)
        ).all()
        kicks = s.exec(
            select(KickLog)
            .where(
                KickLog.network_profile_id == pid,
                KickLog.mac == dev.mac,
            )
            .order_by(KickLog.started_at.desc())
            .limit(50)
        ).all()
    return {
        "device": device_to_dict(dev, kicked),
        "profile_id": pid,
        "is_active": is_active,
        "events": [{"kind": e.kind, "at": e.at.isoformat(), "ip": e.ip} for e in events],
        "kicks": [
            {
                "id": k.id,
                "at": k.started_at.isoformat(),
                "ended_at": k.ended_at.isoformat() if k.ended_at else None,
                "duration": k.duration_seconds,
                "actor": k.actor,
                "reason": k.reason,
                "active": k.active,
                "mode": k.mode,
                "router_blocked": k.router_blocked,
                "router_inst_id": k.router_inst_id,
                "arp_active": k.arp_active,
                "wifi_interface": k.wifi_interface,
                "router_error": k.router_error,
            }
            for k in kicks
        ],
    }


@app.patch("/api/devices/{mac}")
async def patch_device(
    mac: str,
    body: DevicePatch,
    profile: int | None = None,
    username: str = Depends(auth.require_auth),
):
    m = net.normalize_mac(mac)
    with get_session() as s:
        pid, _chosen, _is_active = _require_scope(s, profile)
        dev = s.exec(
            select(Device).where(
                Device.network_profile_id == pid, Device.mac == m
            )
        ).first()
        if dev is None:
            raise HTTPException(status_code=404, detail="Device tidak ditemukan")
        if body.nickname is not None:
            dev.nickname = body.nickname.strip()[:64]
        if body.is_static is not None:
            dev.is_static = body.is_static
        if body.type_override is not None:
            val = body.type_override.strip()
            if val and val not in fingerprint.ALL_TYPES:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Tipe '{val}' tidak dikenal. Pilihan: "
                        + ", ".join(fingerprint.ALL_TYPES)
                    ),
                )
            dev.type_override = val
        if body.brand_override is not None:
            val = body.brand_override.strip().lower()
            # Store a simple-icons slug, never arbitrary HTML/text. The
            # frontend validates against its catalog too; this keeps the API
            # safe when called directly.
            if val and not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", val):
                raise HTTPException(status_code=400, detail="Brand override tidak valid")
            dev.brand_override = val
        s.add(dev)
        s.commit()
        s.refresh(dev)
        payload = device_to_dict(dev, kick.active_map().get(m))
    await hub.broadcast("device_update", payload)
    return payload


@app.delete("/api/devices/{mac}")
async def delete_device(
    mac: str,
    profile: int | None = None,
    username: str = Depends(auth.require_auth),
):
    """Remove a device and every row that belongs to it.

    This is for stale, test, or ghost entries that will never come back. It is
    deliberately narrow: the backend host and the gateway are never deletable,
    and a device that is being kicked must be un-kicked first so no router
    Access Control rule is left behind. All related history is removed in the
    same transaction, otherwise the device would reappear in the activity feed.
    The operation is scoped to one profile, so deleting a stale row in a
    historical network leaves the active network untouched.
    """
    m = net.normalize_mac(mac)
    if not net.valid_mac(m):
        raise HTTPException(status_code=400, detail="Format MAC tidak valid")
    cfg = config_store.settings

    with get_session() as s:
        pid, _chosen, is_active = _require_scope(s, profile)
        dev = s.exec(
            select(Device).where(
                Device.network_profile_id == pid, Device.mac == m
            )
        ).first()
        if dev is None:
            raise HTTPException(status_code=404, detail="Perangkat tidak ditemukan")
        if dev.is_self:
            raise HTTPException(
                status_code=400,
                detail="Perangkat ini menjalankan backend dan tidak bisa dihapus.",
            )
        if is_active and (
            dev.is_gateway
            or (cfg.gateway_mac and m == net.normalize_mac(cfg.gateway_mac))
        ):
            raise HTTPException(status_code=400, detail="Gateway tidak bisa dihapus.")
        # A kick is a live router action on the active network only; a matching
        # MAC in a historical profile must not inherit that guard.
        if is_active and (
            kick.is_kicked(m) is not None
            or kick.arp_engine.is_active(m) is not None
        ):
            raise HTTPException(
                status_code=409,
                detail="Perangkat sedang di-kick. Hentikan kick dulu sebelum menghapus.",
            )
        active_kick = s.exec(
            select(KickLog).where(
                KickLog.network_profile_id == pid,
                KickLog.mac == m,
                KickLog.active == True,  # noqa: E712
            )
        ).first()
        if active_kick is not None:
            raise HTTPException(
                status_code=409,
                detail="Masih ada kick aktif untuk perangkat ini. Hentikan kick dulu.",
            )

        s.exec(
            delete(DeviceEvent).where(
                DeviceEvent.network_profile_id == pid, DeviceEvent.mac == m
            )
        )
        s.exec(
            delete(DeviceApSeen).where(
                DeviceApSeen.network_profile_id == pid, DeviceApSeen.mac == m
            )
        )
        s.exec(
            delete(KickLog).where(
                KickLog.network_profile_id == pid, KickLog.mac == m
            )
        )
        s.delete(dev)
        s.commit()

    await hub.broadcast("device_deleted", {"mac": m, "profile_id": pid})
    return {"ok": True, "mac": m, "profile_id": pid}


@app.get("/api/devices/{mac}/history")
def device_history(
    mac: str,
    profile: int | None = None,
    username: str = Depends(auth.require_auth),
):
    dev = _get_device_or_404(mac, profile)
    with get_session() as s:
        pid, _chosen, _is_active = _require_scope(s, profile)
        events = s.exec(
            select(DeviceEvent)
            .where(
                DeviceEvent.network_profile_id == pid,
                DeviceEvent.mac == dev.mac,
            )
            .order_by(DeviceEvent.at.desc())
            .limit(200)
        ).all()
    return {
        "events": [
            {"id": e.id, "kind": e.kind, "at": e.at.isoformat(), "ip": e.ip}
            for e in events
        ]
    }


@app.post("/api/logs/delete")
async def delete_logs(
    body: LogDeleteIn, username: str = Depends(auth.require_auth)
):
    """Delete history rows by type, device, time range, or explicit ids.

    Covers every history table: device connect/disconnect events, kick logs,
    WAN events, and speedtest runs. A request without a filter is rejected
    unless ``all`` is explicitly true, so a mistyped call cannot wipe the
    database. Active kick rows are preserved: their router rule ids are still
    needed to un-kick, so they must be stopped first.
    """
    if body.ids and body.scope == "all":
        raise HTTPException(
            status_code=400, detail="Hapus berdasarkan id butuh jenis log tertentu."
        )
    if not body.all and not body.ids and not body.mac and not body.before and not body.after:
        raise HTTPException(
            status_code=400,
            detail="Pilih minimal satu filter, atau set 'all' untuk menghapus semua.",
        )

    mac = None
    if body.mac:
        mac = net.normalize_mac(body.mac)
        if not net.valid_mac(mac):
            raise HTTPException(status_code=400, detail="Format MAC tidak valid")

    # type key -> (model, mac column or None, time column, id column)
    specs = {
        "device_events": (DeviceEvent, DeviceEvent.mac, DeviceEvent.at, DeviceEvent.id),
        "kick_logs": (KickLog, KickLog.mac, KickLog.started_at, KickLog.id),
        "wan_events": (WanEvent, None, WanEvent.at, WanEvent.id),
        "speedtest_runs": (SpeedtestRun, None, SpeedtestRun.at, SpeedtestRun.id),
    }
    targets = (
        list(specs) if body.scope == "all" else [body.scope]
    )

    deleted: dict[str, int] = {}
    skipped_active = 0
    with get_session() as s:
        pid, _chosen, _is_active = _resolve_scope(s, body.profile)
        for key in targets:
            model, mac_col, at_col, id_col = specs[key]
            if mac and mac_col is None:
                # A per-device delete cannot apply to WAN/speedtest history.
                continue
            # Per-id deletes must name exactly one log type.
            if body.ids and body.scope in ("all",):
                continue

            conditions = []
            if key in ("device_events", "kick_logs") and pid is not None:
                conditions.append(model.network_profile_id == pid)
            if body.ids:
                conditions.append(id_col.in_(body.ids))
            if mac and mac_col is not None:
                conditions.append(mac_col == mac)
            if body.before is not None:
                conditions.append(at_col < body.before)
            if body.after is not None:
                conditions.append(at_col >= body.after)

            if key == "kick_logs":
                if body.ids:
                    active = s.exec(
                        select(KickLog).where(
                            KickLog.id.in_(body.ids),
                            KickLog.active == True,  # noqa: E712
                        )
                    ).first()
                    if active is not None:
                        raise HTTPException(
                            status_code=409,
                            detail=(
                                "Salah satu log kick masih aktif. Hentikan kick "
                                "perangkat itu dulu."
                            ),
                        )
                else:
                    # Never delete the row that owns a live router rule.
                    active_count = len(
                        s.exec(
                            select(KickLog).where(
                                *conditions, KickLog.active == True  # noqa: E712
                            )
                        ).all()
                    )
                    skipped_active += active_count
                    conditions.append(KickLog.active == False)  # noqa: E712

            if not conditions:
                if not body.all:
                    continue
                # An explicit "all for this type" delete.
                result = s.exec(delete(model))
            else:
                result = s.exec(delete(model).where(*conditions))
            deleted[key] = int(getattr(result, "rowcount", 0) or 0)
        s.commit()

    total = sum(deleted.values())
    if total:
        await hub.broadcast(
            "logs_deleted",
            {"scope": body.scope, "deleted": deleted, "total": total},
        )
    return {
        "ok": True,
        "deleted": deleted,
        "total": total,
        "skipped_active_kicks": skipped_active,
    }


@app.post("/api/scan")
async def scan_now(username: str = Depends(auth.require_auth)):
    # Don't block: an ARP sweep takes several seconds and the UI just needs an
    # ack. The result arrives over the WebSocket.
    asyncio.create_task(scan_loop_once())
    return {"ok": True, "queued": True}


# --------------------------------------------------------------- kick


@app.post("/api/devices/{mac}/kick")
async def kick_device(
    mac: str,
    body: KickIn,
    profile: int | None = None,
    username: str = Depends(auth.require_auth),
):
    """Combined kick: router Access Control block + a short ARP burst.

    Returns 200 with a per-half report so the UI can say exactly what worked.
    A total failure is a 502 carrying the router's own message — we never
    silently degrade to "ARP only" without saying so.

    Only the network the backend is physically connected to can be kicked: the
    router credentials and ARP path belong to this subnet, not to a historical
    profile the user is merely browsing.
    """
    cfg = config_store.settings
    with get_session() as s:
        pid, _chosen, is_active = _require_scope(s, profile)
    if not is_active:
        raise HTTPException(
            status_code=409,
            detail="Tidak bisa blokir — jaringan ini sedang tidak aktif.",
        )
    dev = _get_device_or_404(mac, pid)
    m = net.normalize_mac(mac)

    # --- safety checks (apply to both halves) ------------------------------
    if not dev.ip:
        raise HTTPException(status_code=400, detail="Device belum pernah terlihat di scan")
    whitelist = {net.normalize_mac(x) for x in cfg.whitelist_macs}
    if (cfg.gateway_mac and m == net.normalize_mac(cfg.gateway_mac)) or dev.is_gateway:
        raise HTTPException(status_code=400, detail="Tidak boleh kick gateway")
    if m in whitelist:
        raise HTTPException(status_code=400, detail="MAC ini ada di whitelist")
    if kick.is_kicked(m) is not None or kick.arp_engine.is_active(m) is not None:
        raise HTTPException(status_code=409, detail="Device sudah sedang di-kick")

    try:
        report = await asyncio.to_thread(
            kick.start_kick, m, dev.ip, username, body.reason
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except kick.KickFailed as e:
        await hub.broadcast("kicked", kick.active_map())
        raise HTTPException(status_code=502, detail=f"{e}. {e.detail()}")
    except Exception as e:  # noqa: BLE001
        await hub.broadcast("kicked", kick.active_map())
        raise HTTPException(status_code=502, detail=f"Gagal kick: {type(e).__name__}: {e}")

    await hub.broadcast("kicked", kick.active_map())
    return {"ok": True, **report}


@app.post("/api/devices/{mac}/unkick")
async def unkick_device(
    mac: str,
    profile: int | None = None,
    username: str = Depends(auth.require_auth),
):
    """Stop kicking: delete the router rule (by stored _InstID) and restore ARP."""
    with get_session() as s:
        _pid, _chosen, is_active = _require_scope(s, profile)
    if not is_active:
        raise HTTPException(
            status_code=409,
            detail="Tidak bisa blokir — jaringan ini sedang tidak aktif.",
        )
    m = net.normalize_mac(mac)
    was_active = kick.is_kicked(m) is not None or kick.arp_engine.is_active(m) is not None
    try:
        res = await asyncio.to_thread(kick.stop_kick, m, username)
    except kick.KickFailed as e:
        await hub.broadcast("kicked", kick.active_map())
        raise HTTPException(status_code=502, detail=f"{e}. {e.detail()}")
    await hub.broadcast("kicked", kick.active_map())
    return {"ok": True, "was_active": was_active, **res}


@app.get("/api/router/status")
async def router_status(username: str = Depends(auth.require_auth)):
    """Health of the router backend, for the Settings page."""
    ok, msg = await asyncio.to_thread(kick.router_reachable)
    cfg = config_store.settings
    return {
        "reachable": ok,
        "message": msg,
        "kick_mode": cfg.kick_mode,
        "default_wifi_interface": cfg.default_wifi_interface,
        "active_rules": kick.active_map(),
    }


# --------------------------------------------------------------- activity


@app.get("/api/activity")
async def activity(
    limit: int = 100,
    mac: str = "",
    profile: int | None = None,
    username: str = Depends(auth.require_auth),
):
    """Cross-device connect/disconnect feed, newest first.

    Reads the `device_events` rows the scanner has always been writing, joined
    to the current device so the UI gets a name and type without a second call.
    Scoped to one network profile: the same MAC can be a different device on
    another network.
    """
    from .fingerprint import friendly_name

    limit = max(1, min(limit, 300))
    with get_session() as s:
        pid, _chosen, _is_active = _resolve_scope(s, profile)
        if pid is None:
            return {"events": [], "profile_id": None}
        stmt = select(DeviceEvent).where(
            DeviceEvent.network_profile_id == pid
        )
        if mac:
            stmt = stmt.where(DeviceEvent.mac == net.normalize_mac(mac))
        rows = s.exec(
            stmt.order_by(DeviceEvent.at.desc(), DeviceEvent.id.desc()).limit(limit)
        ).all()
        devs = {
            d.mac: d
            for d in s.exec(
                select(Device).where(Device.network_profile_id == pid)
            ).all()
        }

        out = []
        for e in rows:
            d = devs.get(e.mac)
            out.append(
                {
                    "id": e.id,
                    "at": e.at.isoformat() if e.at else None,
                    "mac": e.mac,
                    "kind": e.kind,
                    "ip": e.ip,
                    "name": friendly_name(
                        hostname=(d.hostname if d else "") or "",
                        vendor=(d.vendor if d else "") or "",
                        ip=e.ip,
                        mac=e.mac,
                        device_type=(d.device_type if d else "other"),
                    ),
                    "device_type": (d.type_override or d.device_type)
                    if d
                    else "other",
                }
            )
    return {"events": out}


# --------------------------------------------------------------- wan


@app.get("/api/wan")
async def wan_status_endpoint(username: str = Depends(auth.require_auth)):
    """Current internet (WAN) status plus its outage history."""
    from . import wan_monitor

    return {
        "status": wan_status.get().to_dict(),
        "history": wan_monitor.history(60),
        "poll_seconds": wan_monitor.POLL_SECONDS,
    }


# --------------------------------------------------------------- speedtest


class SpeedtestStartBody(BaseModel):
    """Optional manual server. ``None`` means "closest server" as before."""

    server_id: int | None = None


@app.post("/api/speedtest/start")
async def speedtest_start(
    body: SpeedtestStartBody | None = None,
    username: str = Depends(auth.require_auth),
):
    """Kick off a manual speedtest. Returns immediately.

    Never automatic: a speedtest saturates the link, so it only runs when the
    user presses the button. The work happens in a daemon thread
    (app/speedtest.py) so the event loop is never blocked.
    """
    started = speedtest_mod.start(body.server_id if body else None)
    if not started.get("started"):
        await hub.broadcast("speedtest", speedtest_mod.status())
    return started


@app.get("/api/speedtest/status")
async def speedtest_status(username: str = Depends(auth.require_auth)):
    return speedtest_mod.status()


@app.get("/api/speedtest/history")
async def speedtest_history(limit: int = 20, username: str = Depends(auth.require_auth)):
    return {"runs": speedtest_mod.history(limit)}


@app.get("/api/speedtest/servers")
async def speedtest_servers(
    limit: int = 25, username: str = Depends(auth.require_auth)
):
    """Speedtest.net servers, for the manual server dropdown.

    The lookup is a network call and is cached server-side, so opening the
    dropdown repeatedly does not hammer speedtest.net.
    """
    return await asyncio.to_thread(speedtest_mod.list_servers, limit)


@app.get("/api/speedtest/public-ip")
async def speedtest_public_ip(username: str = Depends(auth.require_auth)):
    """Public/WAN IP plus ISP, as seen by speedtest.net."""
    return await asyncio.to_thread(speedtest_mod.public_info)


# ------------------------------------------------------------ router health


@app.get("/api/router/health")
async def get_router_health(username: str = Depends(auth.require_auth)):
    """Uptime / CPU / memory from the router's Status page.

    Cached server-side for three minutes: the UI may call this on every render,
    but the router itself is only actually asked occasionally.
    """
    return router_health.get().to_dict()


@app.post("/api/router/sync")
async def router_sync(username: str = Depends(auth.require_auth)):
    """Re-read the router blacklist so netdash matches reality."""
    try:
        res = await asyncio.to_thread(kick.router_sync)
    except RouterError as e:
        raise HTTPException(status_code=502, detail=f"Router: {e}")
    await hub.broadcast("kicked", kick.active_map())
    return {"ok": True, **res}


def _lookup_gateway_mac(ip: str) -> str | None:
    with get_session() as s:
        dev = s.exec(select(Device).where(Device.ip == ip)).first()
        if dev:
            return dev.mac
    for host in net.arp_table_fallback(f"{ip}/32"):
        return host.mac
    return None


# --------------------------------------------------------------- dashboard


@app.get("/api/dashboard")
def dashboard(
    profile: int | None = None,
    username: str = Depends(auth.require_auth),
):
    with get_session() as s:
        pid, chosen, is_active = _resolve_scope(s, profile)
        if pid is None:
            devices: list[Device] = []
            samples: list[ScanSample] = []
            kicks: list[KickLog] = []
        else:
            devices = s.exec(
                select(Device).where(Device.network_profile_id == pid)
            ).all()
            samples = s.exec(
                select(ScanSample)
                .where(ScanSample.network_profile_id == pid)
                .order_by(ScanSample.at.desc())
                .limit(288)
            ).all()
            kicks = s.exec(
                select(KickLog)
                .where(KickLog.network_profile_id == pid)
                .order_by(KickLog.started_at.desc())
                .limit(20)
            ).all()
        gateway_subnet = chosen.subnet if chosen else config_store.settings.subnet
        gateway_mac = chosen.gateway_mac if chosen else config_store.settings.gateway_mac
        profile_payload = (
            profiles.to_dict(
                chosen,
                sum(1 for d in devices),
                sum(1 for d in devices if d.online),
            )
            if chosen
            else None
        )
    kicked = kick.active_map() if is_active else {}
    by_type: dict[str, int] = {}
    for d in devices:
        if d.online:
            by_type[d.device_type] = by_type.get(d.device_type, 0) + 1
    recent = sorted(
        (d for d in devices if d.last_online),
        key=lambda d: d.last_online,
        reverse=True,
    )[:8]
    return {
        "total": len(devices),
        "online": sum(1 for d in devices if d.online),
        "offline": sum(1 for d in devices if not d.online),
        "kicked": sum(1 for d in devices if d.mac in kicked),
        "by_type": by_type,
        "profile": profile_payload,
        "profile_id": pid,
        "is_active": is_active,
        "chart": [
            {"at": s_.at.isoformat(), "online": s_.online, "total": s_.total}
            for s_ in reversed(samples)
        ],
        "recent": [device_to_dict(d, kicked.get(d.mac)) for d in recent],
        "kick_log": [
            {
                "id": k.id,
                "mac": k.mac,
                "ip": k.ip,
                "at": k.started_at.isoformat(),
                "actor": k.actor,
                "active": k.active,
                "reason": k.reason,
                "router_blocked": k.router_blocked,
                "arp_active": k.arp_active,
                "router_inst_id": k.router_inst_id,
            }
            for k in kicks
        ],
        "gateway": {
            "subnet": gateway_subnet,
            "gateway_mac": gateway_mac,
            "interface": config_store.settings.interface
            or net.detect_interface(gateway_subnet),
        },
    }


@app.get("/api/kicks")
def kick_list(
    profile: int | None = None,
    username: str = Depends(auth.require_auth),
):
    with get_session() as s:
        pid, _chosen, _is_active = _resolve_scope(s, profile)
        rows = (
            s.exec(
                select(KickLog)
                .where(KickLog.network_profile_id == pid)
                .order_by(KickLog.started_at.desc())
                .limit(100)
            ).all()
            if pid is not None
            else []
        )
    return {
        "kicks": [
            {
                "id": k.id,
                "mac": k.mac,
                "ip": k.ip,
                "at": k.started_at.isoformat(),
                "ended_at": k.ended_at.isoformat() if k.ended_at else None,
                "duration": k.duration_seconds,
                "actor": k.actor,
                "reason": k.reason,
                "active": k.active,
                "mode": k.mode,
                "router_blocked": k.router_blocked,
                "router_inst_id": k.router_inst_id,
                "arp_active": k.arp_active,
                "wifi_interface": k.wifi_interface,
                "router_error": k.router_error,
            }
            for k in rows
        ]
    }


# --------------------------------------------------------------- settings


@app.get("/api/interfaces")
def list_interfaces(username: str = Depends(auth.require_auth)):
    """Interface inventory + which one the kick engine will actually use.

    Exposed because the classic "kick silently does nothing" failure is sending
    on a virtual adapter: scapy's default iface on a VMware host is VMnet1,
    which has no path to the LAN.
    """
    from .scapy_arp import describe_interfaces, resolve_iface

    cfg = config_store.settings
    local_ip = net.detect_local_ip(cfg.subnet)
    chosen = resolve_iface(local_ip, cfg.interface)
    if os.name == "nt":
        raw_ok = _is_windows_admin()
        raw_error = "" if raw_ok else "butuh Administrator + Npcap"
    else:
        raw_ok = net.raw_socket_available()
        raw_error = net.raw_socket_error()
    return {
        "interfaces": describe_interfaces(),
        "chosen": {
            "name": getattr(chosen, "name", None),
            "guid": getattr(chosen, "guid", None),
            "ip": getattr(chosen, "ip", None),
            "mac": getattr(chosen, "mac", None),
        },
        "local_ip": local_ip,
        "configured_interface": cfg.interface,
        # On POSIX this is the real CAP_NET_RAW check, not just "uid != 0":
        # a normal user with setcap can scan and spoof, and an unprivileged
        # service must not be told it has permission when it does not.
        "is_admin": raw_ok,
        "raw_socket": raw_ok,
        "raw_socket_error": raw_error,
    }


def _is_windows_admin() -> bool:
    try:
        import ctypes

        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


@app.get("/api/settings")
def get_settings(username: str = Depends(auth.require_auth)):
    cfg = config_store.settings
    # Surface the effective kick config so the UI can show it instead of
    # guessing, and flag a missing router config loudly.
    return {
        "subnet": cfg.subnet,
        "interface": cfg.interface,
        "detected_interface": net.detect_interface(cfg.subnet),
        "local_ip": net.detect_local_ip(cfg.subnet),
        "scan_interval": cfg.scan_interval,
        "gateway_mac": cfg.gateway_mac,
        "whitelist_macs": cfg.whitelist_macs,
        "kick_max_seconds": cfg.kick_max_seconds,
        "oui_file": cfg.oui_file,
        "username": cfg.username,
        "display_name": cfg.display_name,
        "kick_mode": cfg.kick_mode,
        "default_wifi_interface": cfg.default_wifi_interface,
        "wifi_interface_map": cfg.wifi_interface_map,
        # Whether router credentials are actually available (never the values).
        "router_configured": _router_configured(),
        "env_file_found": (BASE_DIR / ".env").exists(),
    }


def _router_configured() -> bool:
    """True when NETDASH_ROUTER_USER/PASS are set, from .env or the shell."""
    from .router_client import router_credentials

    try:
        _url, user, pw = router_credentials()
        return bool(user and pw)
    except Exception:
        return False


@app.post("/api/settings")
async def post_settings(
    body: SettingsIn,
    response: Response,
    username: str = Depends(auth.require_auth),
):
    # exclude_unset is essential: model_dump() would report every field, and
    # since config.update() treats None as "clear this", an omitted setting
    # would silently wipe itself. Only fields actually sent are changed.
    changes = body.model_dump(exclude_unset=True)
    if "username" in changes:
        raw = (changes["username"] or "").strip()
        if not USERNAME_RE.match(raw):
            raise HTTPException(
                status_code=400,
                detail="Username 3-32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung",
            )
        changes["username"] = raw
    if "display_name" in changes:
        raw = changes["display_name"] or ""
        if len(raw) > 48:
            raise HTTPException(status_code=400, detail="Nama maksimal 48 karakter")
        changes["display_name"] = _clean_display_name(raw)
    if changes.get("subnet"):
        try:
            ipaddress.ip_network(changes["subnet"], strict=False)
        except ValueError:
            raise HTTPException(status_code=400, detail="Subnet tidak valid, contoh: 192.168.1.0/24")
    # "" or None explicitly clears the pin so auto-detection takes over again.
    if "gateway_mac" in changes:
        raw = (changes["gateway_mac"] or "").strip()
        changes["gateway_mac"] = (
            net.normalize_mac(raw) if raw else None
        )
        if changes["gateway_mac"] and not net.valid_mac(changes["gateway_mac"]):
            raise HTTPException(status_code=400, detail="MAC gateway tidak valid")
    if changes.get("whitelist_macs") is not None:
        wl = [net.normalize_mac(m) for m in changes["whitelist_macs"] if m.strip()]
        bad = [m for m in wl if not net.valid_mac(m)]
        if bad:
            raise HTTPException(status_code=400, detail=f"MAC whitelist tidak valid: {', '.join(bad)}")
        changes["whitelist_macs"] = wl
    if changes.get("kick_mode") not in (None, "router", "arp"):
        raise HTTPException(status_code=400, detail="kick_mode harus 'router' atau 'arp'")
    if changes.get("wifi_interface_map") is not None:
        changes["wifi_interface_map"] = {
            net.normalize_mac(k): str(v) for k, v in changes["wifi_interface_map"].items()
        }
    cfg = config_store.update(**changes)
    if changes.get("username") and changes["username"] != username:
        auth.issue_session(response, cfg.username)
    await hub.broadcast("settings", {"subnet": cfg.subnet, "scan_interval": cfg.scan_interval})
    # Rescan in the background: an ARP sweep can take ~10s, and the user should
    # not have to stare at a spinner for that just to save a setting.
    asyncio.create_task(scan_loop_once())
    return {"ok": True}


@app.post("/api/settings/password")
def post_password(body: LoginIn, username: str = Depends(auth.require_auth)):
    if not body.password or len(body.password) < 6:
        raise HTTPException(status_code=400, detail="Password minimal 6 karakter")
    config_store.set_password(body.password)
    return {"ok": True}


# --------------------------------------------------------------- websocket


@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    # The cookie is the only credential; browsers don't allow custom WS headers.
    token = ws.cookies.get(auth.COOKIE)
    if not token or not _valid_session(token):
        await ws.close(code=1008)
        return
    await ws.accept()
    await hub.connect(ws)
    with get_session() as s:
        current = profiles.active(s)
        pid = current.id if current else None
        devices = (
            s.exec(
                select(Device).where(Device.network_profile_id == pid)
            ).all()
            if pid is not None
            else []
        )
        await ws.send_json(
            {
                "event": "devices",
                "data": [
                    device_to_dict(d, kick.active_map().get(d.mac))
                    for d in devices
                ],
            }
        )
        await ws.send_json({"event": "kicked", "data": kick.active_map()})
    await ws.send_json({"event": "profiles", "data": profiles.snapshot()})
    try:
        while True:
            # Client sends periodic pings; we also use this to notice disconnects.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await hub.disconnect(ws)


def _valid_session(token: str) -> bool:
    from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

    s = URLSafeTimedSerializer(config_store.settings.session_secret, salt="netdash")
    try:
        data = s.loads(token, max_age=7 * 24 * 3600)
        return data.get("u") == config_store.settings.username
    except (BadSignature, SignatureExpired):
        return False


# --------------------------------------------------------------- static SPA

if FRONTEND_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        # An unmatched /api/ or /ws/ path must NOT fall through to index.html.
        # Returning HTML at status 200 made every missing endpoint look like a
        # corrupt response ("invalid response from server (200)") instead of
        # the honest 404 it actually is.
        if full_path.startswith(("api/", "ws/")):
            raise HTTPException(status_code=404, detail="Endpoint tidak ditemukan")

        # Flag the served bundle. A production build kept in frontend/dist is
        # days out of date during development and looks like a working app
        # while silently missing every route added since it was built - which is
        # exactly how a stale page produced an "invalid response" error that had
        # nothing to do with the backend.
        if (FRONTEND_DIST / "index.html").exists():
            return FileResponse(
                FRONTEND_DIST / "index.html",
                headers={"X-Netdash-Served-By": "production-build (stale?) use http://localhost:5173"},
            )

        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
