"""Publish this dashboard as ``netdash.local`` over mDNS.

The host allows unprivileged processes to bind UDP 5353
(``net.ipv4.ip_unprivileged_port_start = 0``), so the backend can advertise its
own name without avahi-daemon, root, or a system hostname change. The address
follows the default-route interface and is re-published when DHCP hands out a
new one, so the URL keeps working across reconnects.
"""

from __future__ import annotations

import logging
import os
import socket
import threading

log = logging.getLogger(__name__)

HOSTNAME = "netdash.local."
SERVICE_TYPE = "_http._tcp.local."
INSTANCE = f"netdash.{SERVICE_TYPE}"
REFRESH_SECONDS = 30.0
DEFAULT_PORT = 8777

_lock = threading.RLock()
_stop = threading.Event()
_zc = None
_info = None
_ip = ""
_thread: threading.Thread | None = None


def primary_ipv4() -> str:
    """Source address of the default route. A UDP connect sends no packet."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("1.1.1.1", 53))
        return s.getsockname()[0]
    except OSError:
        return ""
    finally:
        s.close()


def _publish(ip: str, port: int, *, update: bool):
    """Create or refresh the service record. Caller holds the lock.

    Must never run on the asyncio event loop: zeroconf's synchronous API blocks
    the calling thread until its own loop answers, so calling it from a
    coroutine deadlocks until the internal timeout and leaves a half-published
    record behind.
    """
    global _zc
    from zeroconf import (
        NonUniqueNameException,
        ServiceInfo,
        ServiceNameAlreadyRegistered,
        Zeroconf,
    )

    if _zc is None:
        _zc = Zeroconf()
    info = ServiceInfo(
        SERVICE_TYPE,
        INSTANCE,
        addresses=[socket.inet_aton(ip)],
        port=port,
        properties={"path": "/"},
        server=HOSTNAME,
    )
    if update:
        _zc.update_service(info)
        return info

    try:
        _zc.register_service(info)
    except (NonUniqueNameException, ServiceNameAlreadyRegistered):
        # Our own earlier announcement is still cached or still registered (a
        # previous attempt timed out halfway), so registering again is refused.
        # This process is the owner, so just replace the records in place.
        _zc.update_service(info)
    return info


def _watch(port: int) -> None:
    global _info, _ip
    while not _stop.is_set():
        ip = primary_ipv4()
        if ip:
            try:
                with _lock:
                    if _info is None:
                        _info = _publish(ip, port, update=False)
                        _ip = ip
                        log.info("mDNS: http://netdash.local:%s (via %s)", port, ip)
                    elif ip != _ip:
                        _info = _publish(ip, port, update=True)
                        _ip = ip
                        log.info("mDNS: netdash.local sekarang menunjuk ke %s", ip)
            except Exception as e:  # noqa: BLE001
                # mDNS is a convenience; never let it break the dashboard.
                log.warning("mDNS: gagal mempublikasikan netdash.local: %r", e)
        # Retry quickly while unpublished, then settle into the address check.
        if _stop.wait(2.0 if _info is None else REFRESH_SECONDS):
            return


def start(port: int | None = None) -> None:
    """Advertise ``netdash.local``. Safe to call once during app startup.

    Only the thread is started here; registering from the caller would block
    the FastAPI event loop (see ``_publish``).
    """
    global _thread
    if _thread is not None:
        return

    try:
        port = int(port or os.environ.get("NETDASH_PORT") or DEFAULT_PORT)
    except ValueError:
        port = DEFAULT_PORT

    _stop.clear()
    _thread = threading.Thread(target=_watch, args=(port,), name="mdns", daemon=True)
    _thread.start()


def stop() -> None:
    """Withdraw the record and stop the watcher."""
    global _info, _ip, _thread, _zc
    _stop.set()
    thread = _thread
    _thread = None
    if thread is not None:
        thread.join(timeout=2)
    with _lock:
        zc = _zc
        _zc = None
        _info = None
        _ip = ""
    if zc is None:
        return
    try:
        # close() withdraws every registered service and shuts its loop down;
        # it is safe to call from the app's event loop, unlike the per-service
        # unregister call.
        zc.close()
    except Exception as e:  # noqa: BLE001
        log.debug("mDNS: shutdown cleanup: %s", e)
