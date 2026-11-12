"""Network profile identity and activation.

A profile is one physical network. The gateway MAC is the primary identity
because it survives a DHCP subnet change and is unique per router. The SSID is
stored for display only, and ``subnet + gateway IP`` is used as the fallback
identity when no gateway MAC can be resolved (for example, right after an
upgrade or when the router hides its ARP reply).
"""
from __future__ import annotations

from datetime import datetime

from sqlmodel import Session, select

from .db import NetworkProfile, get_session, utcnow

AUTO_NAME_PREFIX = "Jaringan"
LEGACY_NAME = "Rumah"


def normalize_mac(mac: str | None) -> str:
    return (mac or "").strip().upper()


def default_gateway_ip(subnet: str) -> str:
    try:
        import ipaddress

        return str(ipaddress.ip_network(subnet, strict=False).network_address + 1)
    except ValueError:
        return "192.168.1.1"


def fingerprint_key(
    gateway_mac: str | None, subnet: str, gateway_ip: str | None = None
) -> str:
    """Stable key for a network.

    Gateway MAC wins. Only when it is unavailable do subnet + gateway IP form
    the identity — that combination can collide between unrelated routers, which
    is exactly why it is the fallback rather than the primary key.
    """
    mac = normalize_mac(gateway_mac)
    if mac:
        return f"gw:{mac}"
    return f"net:{subnet}|{gateway_ip or default_gateway_ip(subnet)}"


def active(session: Session) -> NetworkProfile | None:
    return session.exec(
        select(NetworkProfile)
        .where(NetworkProfile.is_active == True)  # noqa: E712
        .order_by(NetworkProfile.last_seen_at.desc())
    ).first()


def active_id() -> int | None:
    with get_session() as s:
        profile = active(s)
        return profile.id if profile else None


def _next_name(session: Session) -> str:
    """`Jaringan N`, one past the highest existing auto name."""
    names = [
        p.name
        for p in session.exec(select(NetworkProfile)).all()
        if p.name.startswith(f"{AUTO_NAME_PREFIX} ")
    ]
    highest = 0
    for name in names:
        tail = name[len(AUTO_NAME_PREFIX) + 1 :].strip()
        if tail.isdigit():
            highest = max(highest, int(tail))
    return f"{AUTO_NAME_PREFIX} {highest + 1}"


def _set_active(session: Session, profile: NetworkProfile) -> None:
    for other in session.exec(
        select(NetworkProfile).where(NetworkProfile.is_active == True)  # noqa: E712
    ).all():
        if other.id != profile.id:
            other.is_active = False
            session.add(other)
    profile.is_active = True
    profile.last_seen_at = utcnow()
    session.add(profile)


def resolve_and_activate(
    session: Session,
    *,
    gateway_mac: str | None,
    subnet: str,
    gateway_ip: str | None = None,
    ssid: str = "",
) -> tuple[NetworkProfile, NetworkProfile | None, bool]:
    """Find or create the profile for this network and make it active.

    Returns ``(profile, previous_active, created)``. ``previous_active`` lets
    the scanner tell the UI that the physical network changed.
    """
    mac = normalize_mac(gateway_mac)
    gateway_ip = gateway_ip or default_gateway_ip(subnet)
    fingerprint = fingerprint_key(mac, subnet, gateway_ip)

    profile = session.exec(
        select(NetworkProfile).where(NetworkProfile.fingerprint == fingerprint)
    ).first()

    if profile is None:
        if mac:
            # Adopt a fallback profile that was created before the gateway MAC
            # was known. Never adopt a profile that already has a *different*
            # MAC: that is a different physical router.
            profile = session.exec(
                select(NetworkProfile).where(
                    NetworkProfile.subnet == subnet,
                    NetworkProfile.gateway_ip == gateway_ip,
                    NetworkProfile.gateway_mac == "",
                )
            ).first()
        else:
            # Without a MAC we cannot distinguish two routers on the same
            # subnet, so reuse the most recent one rather than piling up a new
            # profile on every scan.
            profile = session.exec(
                select(NetworkProfile)
                .where(
                    NetworkProfile.subnet == subnet,
                    NetworkProfile.gateway_ip == gateway_ip,
                )
                .order_by(NetworkProfile.last_seen_at.desc())
            ).first()

    created = False
    if profile is None:
        profile = NetworkProfile(
            name=_next_name(session),
            fingerprint=fingerprint,
            gateway_mac=mac,
            ssid=ssid,
            subnet=subnet,
            gateway_ip=gateway_ip,
            created_at=utcnow(),
            last_seen_at=utcnow(),
            is_active=False,
        )
        session.add(profile)
        session.commit()
        session.refresh(profile)
        created = True
    else:
        if mac:
            profile.gateway_mac = mac
            # Upgrade the fallback fingerprint to the MAC-based one. Safe here:
            # no other profile with this fingerprint exists (checked above).
            profile.fingerprint = fingerprint
        if subnet:
            profile.subnet = subnet
        if gateway_ip:
            profile.gateway_ip = gateway_ip
        if ssid:
            profile.ssid = ssid
        profile.last_seen_at = utcnow()

    previous = active(session)
    _set_active(session, profile)
    session.add(profile)
    session.commit()
    session.refresh(profile)
    return profile, previous, created


def all_profiles(session: Session) -> list[NetworkProfile]:
    # Active first so the switcher always opens on the network in use; the rest
    # follow creation order for a stable list.
    return session.exec(
        select(NetworkProfile).order_by(
            NetworkProfile.is_active.desc(), NetworkProfile.id.asc()
        )
    ).all()


def to_dict(
    profile: NetworkProfile, device_count: int = 0, online_count: int = 0
) -> dict:
    return {
        "id": profile.id,
        "name": profile.name,
        "fingerprint": profile.fingerprint,
        "gateway_mac": profile.gateway_mac,
        "ssid": profile.ssid,
        "subnet": profile.subnet,
        "gateway_ip": profile.gateway_ip,
        "created_at": profile.created_at.isoformat() if profile.created_at else None,
        "last_seen_at": profile.last_seen_at.isoformat()
        if isinstance(profile.last_seen_at, datetime)
        else None,
        "active": bool(profile.is_active),
        "device_count": device_count,
        "online_count": online_count,
    }


def snapshot() -> dict:
    """Every profile with device counts plus the currently active id.

    Used by the REST endpoint and by the scanner's WebSocket push.
    """
    from .db import Device

    with get_session() as s:
        profiles = all_profiles(s)
        devices = s.exec(select(Device)).all()
        totals: dict[int, int] = {}
        online: dict[int, int] = {}
        for d in devices:
            pid = d.network_profile_id
            if pid is None:
                continue
            totals[pid] = totals.get(pid, 0) + 1
            if d.online:
                online[pid] = online.get(pid, 0) + 1
        current = active(s)
        return {
            "profiles": [
                to_dict(p, totals.get(p.id, 0), online.get(p.id, 0))
                for p in profiles
            ],
            "active_id": current.id if current else None,
        }
