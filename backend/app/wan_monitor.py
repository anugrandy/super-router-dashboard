"""Background WAN monitor.

Polls the router every ``CACHE_SECONDS`` (2 min), writes a row whenever the
internet link changes state, and pushes a transition to the socket so the
dashboard can show a toast.

Two rules keep this from being a performance problem:

* One poll per two minutes, not per device scan. The device scan runs far more
  often and must not be slowed down by a router round-trip, so this runs in its
  own daemon thread and shares nothing with the scanner.
* A transition is only broadcast when the status actually flips. A steady link
  means no broadcast at all, so the toast code stays quiet in normal operation.

"Router unreachable" is deliberately NOT reported as "internet down": the router
being unreachable tells you nothing about the ISP, and claiming otherwise would
be a false alarm during every router reboot.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from datetime import datetime

from sqlmodel import col, select

from . import wan_status
from .db import WanEvent, get_session, utcnow
from .scanner import hub

log = logging.getLogger(__name__)

POLL_SECONDS = wan_status.CACHE_SECONDS

_lock = threading.Lock()
_last_status: str | None = None  # None = not yet observed, so no event on start
_thread: threading.Thread | None = None
_loop: asyncio.AbstractEventLoop | None = None


def _record(kind: str, w: wan_status.WanStatus) -> None:
    try:
        with get_session() as s:
            s.add(
                WanEvent(
                    kind=kind,
                    at=utcnow(),
                    ipv4_address=w.ipv4_address,
                    connection_name=w.connection_name,
                    reason=w.disconnect_reason,
                    online_seconds=w.online_seconds,
                )
            )
            s.commit()
    except Exception as e:  # noqa: BLE001
        log.warning("could not record wan event: %s", e)


def history(limit: int = 60) -> list[dict]:
    limit = max(1, min(limit, 300))
    with get_session() as s:
        rows = s.exec(
            select(WanEvent)
            .order_by(col(WanEvent.at).desc(), col(WanEvent.id).desc())
            .limit(limit)
        ).all()
        return [
            {
                "id": e.id,
                "at": e.at.isoformat() if e.at else None,
                "kind": e.kind,
                "ipv4_address": e.ipv4_address,
                "connection_name": e.connection_name,
                "reason": e.reason,
                "online_seconds": e.online_seconds,
            }
            for e in rows
        ]


def poll_once() -> dict:
    """One poll: fetch, detect a flip, persist and broadcast if needed.

    Returns the status dict. Safe to call from tests.
    """
    global _last_status

    w = wan_status.get()
    status = w.ipv4_status if w.available else "unavailable"
    payload = w.to_dict()

    with _lock:
        previous = _last_status
        changed = previous is not None and previous != status
        _last_status = status

    if not w.available:
        # Router unreachable: keep the last known state, record nothing.
        if previous is not None and previous != "unavailable":
            log.warning("router unreachable while WAN was %s", previous)
        return payload

    if previous is None:
        # First observation after startup: record it as the baseline so history
        # opens with the current state, but do not raise a toast.
        _record(status, w)
    elif changed:
        _record(status, w)
        if _loop is not None:
            event = {
                "kind": status,
                "reason": w.disconnect_reason,
                "ipv4_address": w.ipv4_address,
                "connection_name": w.connection_name,
            }
            try:
                asyncio.run_coroutine_threadsafe(
                    hub.broadcast("wan", event), _loop
                )
            except RuntimeError as e:
                log.warning("could not broadcast wan transition: %s", e)

    return payload


def _worker() -> None:
    while True:
        try:
            poll_once()
        except Exception as e:  # noqa: BLE001
            log.warning("wan poll failed: %s", e)
        time.sleep(POLL_SECONDS)


def start(loop: asyncio.AbstractEventLoop | None = None) -> None:
    global _thread, _loop
    _loop = loop
    if _thread is not None and _thread.is_alive():
        return
    _thread = threading.Thread(target=_worker, name="wan-monitor", daemon=True)
    _thread.start()
    log.info("wan monitor started, polling every %ds", POLL_SECONDS)


def stop() -> None:
    global _thread
    _thread = None


def reset() -> None:
    """Forget the last known status, so the next poll records a fresh baseline."""
    global _last_status
    with _lock:
        _last_status = None