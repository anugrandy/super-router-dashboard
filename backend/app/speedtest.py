"""Manual, on-demand internet speedtest.

Deliberate design choices, all in service of not hurting performance:

* **Never automatic.** Nothing here runs on a timer. A speedtest saturates the
  link, so it must only happen when the user asks.
* **One test at a time, in a worker thread.** The FastAPI event loop is never
  blocked: the POST returns immediately with a job id and the UI polls status.
* **Results are cached.** Asking for the current result never re-runs a test.

Ping note: ``speedtest-cli`` derives ping from its own download probe, and on
this connection it saturates and returns a sentinel of 1800000.0 ms. Latency is
therefore measured independently as the median TCP-connect time to the same
speedtest server, which is cheap and does not consume bandwidth.
"""

from __future__ import annotations

import logging
import socket
import statistics
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# Hard cap so a wedged server cannot leave a thread running forever.
MAX_SECONDS = 120


@dataclass
class SpeedtestResult:
    download_mbps: float = 0.0
    upload_mbps: float = 0.0
    ping_ms: float = 0.0
    server_name: str = ""
    server_sponsor: str = ""
    server_host: str = ""
    server_country: str = ""
    client_isp: str = ""
    client_ip: str = ""
    at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    error: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["at"] = self.at.isoformat()
        return d


@dataclass
class _Job:
    """State of the one allowed in-flight run."""

    running: bool = False
    started_at: float | None = None
    phase: str = ""
    result: SpeedtestResult | None = None
    error: str = ""
    log_lines: list[str] = field(default_factory=list)

    def status(self) -> dict:
        return {
            "running": self.running,
            "phase": self.phase,
            "elapsed": round(time.time() - self.started_at, 1)
            if self.started_at and self.running
            else 0,
            "log": self.log_lines[-6:],
            "result": self.result.to_dict() if self.result else None,
            "error": self.error,
        }


_lock = threading.Lock()
_job = _Job()
_last: SpeedtestResult | None = None


def _measure_ping(host: str, samples: int = 5) -> float:
    """Median TCP-connect latency to the speedtest server, in ms."""
    h, _, p = host.rpartition(":")
    port = int(p) if p.isdigit() else 80
    vals: list[float] = []
    for _ in range(samples):
        t0 = time.perf_counter()
        try:
            s = socket.create_connection((h, port), timeout=5)
            s.close()
        except OSError:
            continue
        vals.append((time.perf_counter() - t0) * 1000)
    return round(statistics.median(vals), 1) if vals else 0.0


def _run() -> None:
    """Worker body. Never raises past the lock."""
    try:
        import speedtest

        with _lock:
            _job.phase = "Mencari server terdekat…"
        st = speedtest.Speedtest(secure=False)
        st.get_best_server()
        srv = st.results.server
        host = srv.get("host", "")

        with _lock:
            _job.phase = "Mengukur ping…"
        ping = _measure_ping(host) if host else 0.0

        with _lock:
            _job.phase = "Menguji download…"
        started = time.perf_counter()
        down = st.download() / 1e6  # bits/s -> Mbps

        with _lock:
            _job.phase = "Menguji upload…"
        up = st.upload() / 1e6
        if time.time() - (started or 0) > MAX_SECONDS:
            log.warning("speedtest exceeded budget; keeping partial result")

        res = SpeedtestResult(
            download_mbps=round(down, 2),
            upload_mbps=round(up, 2),
            ping_ms=ping,
            server_name=srv.get("name", ""),
            server_sponsor=srv.get("sponsor", ""),
            server_host=host,
            server_country=srv.get("country", ""),
            client_isp=(st.results.client or {}).get("isp", ""),
            client_ip=(st.results.client or {}).get("ip", ""),
        )
        with _lock:
            globals()["_last"] = res
            _job.result = res
            _job.error = ""
        _persist(res)
    except Exception as e:  # noqa: BLE001
        log.warning("speedtest failed: %s", e)
        with _lock:
            _job.error = f"{type(e).__name__}: {e}"
    finally:
        with _lock:
            _job.running = False
            _job.started_at = None
            _job.phase = ""


def start() -> dict:
    """Kick off a test. Returns immediately; the UI polls status()."""
    with _lock:
        if _job.running:
            return {"started": False, "reason": "Test sudah berjalan"}
        _job.running = True
        _job.started_at = time.time()
        _job.phase = "Memulai…"
        _job.error = ""
        _job.log_lines = []
    threading.Thread(target=_run, name="speedtest", daemon=True).start()
    return {"started": True}


def _persist(res: SpeedtestResult) -> None:
    """Store a finished run. Never raises - a DB hiccup must not lose the test."""
    try:
        from .db import SpeedtestRun, get_session

        with get_session() as s:
            s.add(
                SpeedtestRun(
                    at=res.at,
                    download_mbps=res.download_mbps,
                    upload_mbps=res.upload_mbps,
                    ping_ms=res.ping_ms,
                    server_name=res.server_name,
                    server_sponsor=res.server_sponsor,
                    client_isp=res.client_isp,
                    ok=not bool(res.error),
                    error=res.error[:200],
                )
            )
            s.commit()
    except Exception as e:  # noqa: BLE001
        log.warning("speedtest: could not store result: %s", e)


def history(limit: int = 20) -> list[dict]:
    """Past runs, newest first. Read-only, cheap."""
    try:
        from sqlmodel import select

        from .db import SpeedtestRun, get_session

        with get_session() as s:
            rows = s.exec(
                select(SpeedtestRun)
                .order_by(SpeedtestRun.at.desc())
                .limit(max(1, min(limit, 100)))
            ).all()
            return [
                {
                    "id": r.id,
                    "at": r.at.isoformat() if r.at else None,
                    "download_mbps": r.download_mbps,
                    "upload_mbps": r.upload_mbps,
                    "ping_ms": r.ping_ms,
                    "server_name": r.server_name,
                    "server_sponsor": r.server_sponsor,
                    "client_isp": r.client_isp,
                    "ok": r.ok,
                    "error": r.error,
                }
                for r in rows
            ]
    except Exception as e:  # noqa: BLE001
        log.warning("speedtest history failed: %s", e)
        return []


def status() -> dict:
    with _lock:
        return _job.status()


def last_result() -> SpeedtestResult | None:
    with _lock:
        return _job.result or _last