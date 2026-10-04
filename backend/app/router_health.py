"""Router health: uptime, CPU and memory, read from the admin Status page.

Source: Management & Diagnosis > Status (``devmgr_statusmgr_lua.lua``), which
returns three objects. Verified live on the F670L:

    OBJ_DEVINFO_ID     SoftwareVer, ModelName, SerialNumber ...
    OBJ_CPUMEMUSAGE_ID CpuUsage1..CpuUsage4, MemUsage
    OBJ_POWERONTIME_ID PowerOnTime   (seconds)

Unlike the device scan this is cached for a few minutes: none of these values
move quickly, and re-reading the router on every render would be pointless load.

The CPU is multi-core, so ``CpuUsage1..4`` are reported individually rather than
summed (a sum across 4 cores reads as "300%" and is meaningless).
"""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import asdict, dataclass, field

from .router_client import ZteRouter

log = logging.getLogger(__name__)

STATUS_PAGE = "/?_type=menuView&_tag=statusMgr&Menu3Location=0"
STATUS_TAG = "devmgr_statusmgr_lua.lua"

# Uptime and load change slowly; three minutes is plenty and keeps the router
# from being polled on every dashboard render.
CACHE_SECONDS = 180.0


@dataclass
class RouterHealth:
    available: bool = False
    model: str = ""
    software_version: str = ""
    serial_number: str = ""
    uptime_seconds: int = 0
    cpu_cores: list[int] = field(default_factory=list)
    cpu_max: int = 0
    mem_pct: int | None = None
    error: str = ""
    fetched_at: float = 0.0

    def to_dict(self) -> dict:
        d = asdict(self)
        d["cpu_cores"] = self.cpu_cores or []
        d["uptime_human"] = format_uptime(self.uptime_seconds)
        return d


def format_uptime(seconds: int) -> str:
    """Human uptime, e.g. "1 hari 16j 35m".

    Separators are non-breaking spaces. A plain space would be squeezed shut by
    the tight negative letter-spacing the UI applies to these numbers, which
    made the value read as one run-on word, and could also wrap mid-value.
    """
    if not seconds or seconds < 0:
        return "-"
    nb = "\u00a0"
    d, rem = divmod(int(seconds), 86400)
    h, rem = divmod(rem, 3600)
    m, _ = divmod(rem, 60)
    if d:
        return f"{d}{nb}hari{nb}{h}j{nb}{m}m"
    if h:
        return f"{h}j{nb}{m}m"
    return f"{m}m"


_lock = threading.Lock()
_cache: RouterHealth | None = None
_router: ZteRouter | None = None


def _parse(payload: str) -> RouterHealth:
    insts = re.findall(r"<Instance>(.*?)</Instance>", payload, re.S)
    health = RouterHealth(available=True)

    cores: list[int] = []
    for inst in insts:
        d = dict(
            re.findall(r"<ParaName>([^<]+)</ParaName><ParaValue>([^<]*)</ParaValue>", inst)
        )
        if "ModelName" in d:
            health.model = d.get("ModelName", "")
            health.software_version = d.get("SoftwareVer", "")
            health.serial_number = d.get("SerialNumber", "")
        for key, val in d.items():
            m = re.fullmatch(r"CpuUsage(\d+)", key)
            if m:
                try:
                    cores.append((int(m.group(1)), int(val)))
                except ValueError:
                    pass
            elif key == "MemUsage":
                try:
                    health.mem_pct = int(val)
                except ValueError:
                    pass
            elif key == "PowerOnTime":
                try:
                    health.uptime_seconds = int(val)
                except ValueError:
                    pass

    if cores:
        cores.sort()
        health.cpu_cores = [v for _, v in cores]
        health.cpu_max = max(health.cpu_cores)
    return health


def _fetch() -> RouterHealth:
    global _router
    try:
        if _router is None:
            _router = ZteRouter()
            _router.login()
        else:
            _router.ensure_login()
        payload = _router.page_post(STATUS_PAGE, STATUS_TAG)
    except Exception as e:  # noqa: BLE001
        log.warning("router health failed: %s", e)
        return RouterHealth(available=False, error=f"{type(e).__name__}: {e}")

    if not payload or "SessionTimeout" in payload:
        # Drop the cached session so the next call re-logs in.
        try:
            if _router is not None:
                _router.close()
        except Exception:  # noqa: BLE001
            pass
        _router = None
        return RouterHealth(available=False, error="Sesi router habis")

    h = _parse(payload)
    h.fetched_at = time.time()
    return h


def get(force: bool = False) -> RouterHealth:
    """Cached health read. Never raises."""
    global _cache
    with _lock:
        fresh = _cache and (time.time() - _cache.fetched_at) < CACHE_SECONDS
        if fresh and not force:
            return _cache
    result = _fetch()
    with _lock:
        _cache = result
    return result


def invalidate() -> None:
    global _cache
    with _lock:
        _cache = None