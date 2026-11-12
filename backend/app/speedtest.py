"""Manual, on-demand internet speedtest.

Deliberate design choices, all in service of not hurting performance:

* **Never automatic.** Nothing here runs on a timer. A speedtest saturates the
  link, so it must only happen when the user asks.
* **One test at a time, in a worker thread.** The FastAPI event loop is never
  blocked: the POST returns immediately with a job id and the UI polls status.
* **Results are cached.** Asking for the current result never re-runs a test.

Accuracy: the official Ookla CLI is used when it is installed. The old Python
``speedtest-cli`` package is kept as a fallback. Its own legacy server feed is
geo-thin on some ISPs (it returned only Malaysian servers here and produced
250-700 ms tests), so the fallback now pulls the nearby server list from the
current speedtest.net API and lets the library pick the fastest of those instead
of trusting the stale XML feed. The official client still matches the browser
test most closely because it uses the same protocol and latency probing.

Install the official client from https://www.speedtest.net/apps/cli, or point
``NETDASH_SPEEDTEST_BIN`` at the binary. Without it the page still works, but the
result is explicitly labelled as an estimate.

Ping note: the official client reports latency and jitter directly. The fallback
measures median TCP-connect time to the selected server because speedtest-cli's
own ping can be a sentinel (1800000.0 ms) on some connections.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import statistics
import subprocess
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# Hard cap so a wedged server cannot leave a thread running forever.
MAX_SECONDS = 120
SERVER_CACHE_SECONDS = 300.0
CLIENT_CACHE_SECONDS = 300.0
OOKLA_ENV = "NETDASH_SPEEDTEST_BIN"
# The Python library defaults to 8 download / 2 upload threads. On a fast,
# high-latency link the download test finishes before the pipe is filled, so a
# few more streams give a more representative fallback figure.
FALLBACK_DOWNLOAD_THREADS = 16
FALLBACK_UPLOAD_THREADS = 4


@dataclass
class SpeedtestResult:
    download_mbps: float = 0.0
    upload_mbps: float = 0.0
    ping_ms: float = 0.0
    ping_jitter_ms: float = 0.0
    server_id: str = ""
    server_name: str = ""
    server_sponsor: str = ""
    server_host: str = ""
    server_country: str = ""
    server_city: str = ""
    client_isp: str = ""
    client_ip: str = ""
    # "ookla-cli" when the official binary ran, "speedtest-cli" for the fallback.
    engine: str = ""
    packet_loss: float = 0.0
    at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    error: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["at"] = self.at.isoformat()
        return d


def _server_preview(server: dict | None) -> dict | None:
    """Normalise a speedtest-cli server dict for the frontend."""
    if not server:
        return None
    return {
        "id": str(server.get("id", "")),
        "name": server.get("name", "") or "",
        "sponsor": server.get("sponsor", "") or "",
        "country": server.get("country", "") or "",
        "cc": server.get("cc", "") or "",
        "city": server.get("city", "") or server.get("name", "") or "",
        "host": server.get("host", "") or "",
        "distance": server.get("distance"),
    }


def _official_preview(server: dict | None) -> dict | None:
    """Normalise a server from the official CLI (``name`` is the provider)."""
    if not server:
        return None
    host = server.get("host", "") or ""
    port = server.get("port")
    if port and ":" not in host:
        host = f"{host}:{port}"
    provider = server.get("name", "") or ""
    location = server.get("location", "") or server.get("city", "") or ""
    return {
        "id": str(server.get("id", "")),
        "name": location or provider,
        "sponsor": provider,
        "country": server.get("country", "") or "",
        "cc": server.get("cc", "") or "",
        "city": location,
        "host": host,
        "distance": None,
    }


@dataclass
class _Job:
    """State of the one allowed in-flight run."""

    running: bool = False
    started_at: float | None = None
    phase_started_at: float | None = None
    phase: str = ""
    progress: float = 0.0
    live_download_mbps: float = 0.0
    live_upload_mbps: float = 0.0
    live_ping_ms: float = 0.0
    live_jitter_ms: float = 0.0
    client_ip: str = ""
    client_isp: str = ""
    server: dict | None = None
    result: SpeedtestResult | None = None
    error: str = ""
    log_lines: list[str] = field(default_factory=list)

    def _phase_progress(self) -> float:
        """Rough, monotonic progress for the progress bars.

        The official CLI reports sub-progress per phase; the UI only needs a
        smooth overall arc, so this stays time-based and snaps to 100% when the
        final result arrives.
        """
        if not self.running:
            return 1.0 if self.result else 0.0
        if not self.phase_started_at:
            return self.progress
        elapsed = max(0.0, time.time() - self.phase_started_at)
        if self.phase == "server":
            return min(0.10, 0.02 + elapsed * 0.02)
        if self.phase == "ping":
            return min(0.16, 0.10 + elapsed * 0.03)
        if self.phase == "download":
            return min(0.66, 0.16 + elapsed * 0.035)
        if self.phase == "upload":
            return min(0.97, 0.66 + elapsed * 0.03)
        return min(0.99, self.progress)

    def status(self) -> dict:
        return {
            "running": self.running,
            "phase": self.phase,
            "phase_elapsed": round(
                time.time() - self.phase_started_at, 1
            )
            if self.phase_started_at and self.running
            else 0,
            "elapsed": round(time.time() - self.started_at, 1)
            if self.started_at and self.running
            else 0,
            "progress": round(self._phase_progress(), 3),
            "live_download_mbps": round(self.live_download_mbps, 2),
            "live_upload_mbps": round(self.live_upload_mbps, 2),
            "live_ping_ms": round(self.live_ping_ms, 1),
            "live_jitter_ms": round(self.live_jitter_ms, 1),
            "client_ip": self.client_ip,
            "client_isp": self.client_isp,
            "server": self.server,
            "log": self.log_lines[-6:],
            "result": self.result.to_dict() if self.result else None,
            "error": self.error,
        }


_lock = threading.Lock()
_job = _Job()
_last: SpeedtestResult | None = None

_server_cache: dict = {"at": 0.0, "servers": [], "error": ""}
_client_cache: dict = {"at": 0.0, "ip": "", "isp": "", "country": "", "error": ""}
_ookla_cache: dict = {"checked": False, "path": "", "at": 0.0}

# The legacy XML feed that speedtest-cli reads is geo-thin on some ISPs: here it
# returned ten servers, all in Malaysia, so the fallback picked a 250-700 ms
# server and reported a fraction of the real throughput. The current JS API
# returns the same nearby servers the browser test uses, so the fallback selects
# from that list instead.
MODERN_SERVERS_URL = "https://www.speedtest.net/api/js/servers?engine=js&limit={limit}"


def _set_phase(phase: str, progress: float | None = None) -> None:
    with _lock:
        if _job.phase != phase:
            _job.phase = phase
            _job.phase_started_at = time.time()
        if progress is not None:
            _job.progress = progress


def _reset_live() -> None:
    with _lock:
        _job.live_download_mbps = 0.0
        _job.live_upload_mbps = 0.0
        _job.live_ping_ms = 0.0
        _job.live_jitter_ms = 0.0


def _ookla_binary() -> str:
    """Path to the official Ookla CLI, or '' when only the Python lib exists.

    ``speedtest-cli`` installs a ``speedtest-cli`` command, never ``speedtest``,
    so a plain ``speedtest`` on PATH is safe to probe. The version string is
    checked anyway to avoid picking up an unrelated binary with that name.

    A miss is cached briefly, not forever, so installing the CLI while the
    backend is running is picked up on the next test instead of requiring a
    restart. Besides PATH we look where a per-user install usually lands
    (``~/.local/bin``) and at a binary bundled into this checkout's ``bin/``.
    """
    if _ookla_cache["checked"] and (
        _ookla_cache["path"] or time.time() - _ookla_cache["at"] < 60
    ):
        return _ookla_cache["path"]

    home = os.path.expanduser("~")
    project_bin = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "bin",
    )
    candidates = [
        os.environ.get(OOKLA_ENV, "").strip(),
        shutil.which("speedtest") or "",
        shutil.which("speedtest.exe") or "",
        os.path.join(home, ".local", "bin", "speedtest"),
        os.path.join(project_bin, "speedtest"),
        os.path.join(project_bin, "speedtest.exe"),
        "/usr/local/bin/speedtest",
        "/usr/bin/speedtest",
    ]

    path = ""
    for candidate in dict.fromkeys(c for c in candidates if c):
        try:
            proc = subprocess.run(
                [candidate, "--version"],
                capture_output=True,
                text=True,
                timeout=8,
            )
            text = f"{proc.stdout or ''}\n{proc.stderr or ''}"
            if "ookla" in text.lower():
                path = candidate
                break
            log.info("speedtest: %s is not the official Ookla CLI", candidate)
        except Exception as e:  # noqa: BLE001
            log.info("speedtest: could not probe %s: %s", candidate, e)

    _ookla_cache.update(checked=True, path=path, at=time.time())
    return path


def _modern_server_list(limit: int = 20) -> list[dict]:
    """Nearby servers from speedtest.net's current API.

    Returns the same shape speedtest-cli uses (``id``, ``host``, ``url`` plus the
    preview fields), so ``get_best_server`` and ``download`` accept it directly.
    """
    import urllib.request

    url = MODERN_SERVERS_URL.format(limit=max(1, min(limit, 100)))
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "netdash-speedtest/1.0"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = json.loads(resp.read().decode("utf-8"))

    servers: list[dict] = []
    for s in raw if isinstance(raw, list) else []:
        host = str(s.get("host", "") or "")
        upload = str(s.get("url", "") or "")
        if not host or not upload:
            continue
        servers.append(
            {
                "id": str(s.get("id", "")),
                "name": s.get("name", "") or "",
                "sponsor": s.get("sponsor", "") or "",
                "country": s.get("country", "") or "",
                "cc": s.get("cc", "") or "",
                "city": s.get("name", "") or "",
                "host": host,
                "url": upload,
                "distance": s.get("distance"),
            }
        )
    return servers


def _measure_ping(host: str, samples: int = 5) -> tuple[float, float]:
    """Median TCP-connect latency and jitter to the speedtest server, in ms."""
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
    if not vals:
        return 0.0, 0.0
    jitter = statistics.pstdev(vals) if len(vals) > 1 else 0.0
    return round(statistics.median(vals), 1), round(jitter, 1)


def _monitor_throughput(stop: threading.Event, phase: str) -> None:
    """Sample interface counters until the phase finishes.

    Only used by the Python fallback: its download/upload methods do not publish
    byte counts. The official CLI streams real test bandwidth instead, so this
    monitor is not started for it.
    """
    try:
        import psutil
    except Exception:  # noqa: BLE001
        return

    try:
        prev = psutil.net_io_counters()
        prev_t = time.perf_counter()
        while not stop.wait(0.4):
            cur = psutil.net_io_counters()
            now = time.perf_counter()
            dt = now - prev_t
            if dt <= 0:
                continue
            if phase == "download":
                delta = cur.bytes_recv - prev.bytes_recv
            else:
                delta = cur.bytes_sent - prev.bytes_sent
            mbps = max(0.0, (delta * 8.0) / dt / 1e6)
            with _lock:
                if phase == "download":
                    _job.live_download_mbps = mbps
                elif phase == "upload":
                    _job.live_upload_mbps = mbps
            prev, prev_t = cur, now
    except Exception:  # noqa: BLE001
        # The monitor is decorative; never let it take down the test.
        log.debug("speedtest live monitor stopped", exc_info=True)


def _start_monitor(phase: str) -> threading.Event:
    stop = threading.Event()
    threading.Thread(
        target=_monitor_throughput,
        args=(stop, phase),
        name=f"speedtest-monitor-{phase}",
        daemon=True,
    ).start()
    return stop


def _flatten_servers(groups: dict) -> list[dict]:
    return [server for server_list in (groups or {}).values() for server in server_list]


def _official_servers(limit: int) -> list[dict]:
    """Nearest servers from the official CLI, normalised for the dropdown."""
    binary = _ookla_binary()
    if not binary:
        return []
    proc = subprocess.run(
        [binary, "--accept-license", "--accept-gdpr", "-L", "-f", "json"],
        capture_output=True,
        text=True,
        timeout=45,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "server list failed").strip())
    body = json.loads(proc.stdout)
    raw = body.get("servers", []) if isinstance(body, dict) else body
    servers = [
        preview
        for preview in (_official_preview(s) for s in raw)
        if preview is not None
    ]
    return servers[: max(1, min(limit, 100))]


def list_servers(limit: int = 25) -> dict:
    """Closest speedtest.net servers, cached for a few minutes.

    Prefers the official client's list, which matches the browser's nearby
    servers. The Python library is only the fallback when the official binary is
    not installed.
    """
    now = time.time()
    if now - _server_cache["at"] < SERVER_CACHE_SECONDS:
        return {
            "servers": _server_cache["servers"][:limit],
            "cached": True,
            "error": _server_cache["error"],
        }

    try:
        servers = _official_servers(limit)
        if servers:
            _server_cache.update(at=now, servers=servers, error="")
            return {"servers": servers, "cached": False, "error": ""}
    except Exception as e:  # noqa: BLE001
        log.warning("official speedtest server list failed: %s", e)

    try:
        modern = _modern_server_list(limit)
        servers = [
            preview
            for preview in (_server_preview(s) for s in modern)
            if preview is not None
        ][: max(1, min(limit, 100))]
        if servers:
            _server_cache.update(at=now, servers=servers, error="")
            return {"servers": servers, "cached": False, "error": ""}
    except Exception as e:  # noqa: BLE001
        log.warning("modern speedtest server list failed: %s", e)

    try:
        import speedtest

        st = speedtest.Speedtest(secure=False)
        groups = st.get_servers()
        servers = [
            preview
            for preview in (_server_preview(s) for s in _flatten_servers(groups))
            if preview is not None
        ][: max(1, min(limit, 100))]
        _server_cache.update(at=now, servers=servers, error="")
        return {"servers": servers, "cached": False, "error": ""}
    except Exception as e:  # noqa: BLE001
        msg = f"{type(e).__name__}: {e}"
        log.warning("speedtest server list failed: %s", e)
        _server_cache.update(at=now, servers=[], error=msg)
        return {"servers": [], "cached": False, "error": msg}


def public_info() -> dict:
    """Public IP/ISP as seen by speedtest.net, cached briefly.

    Shown on the page before the first test so the WAN identity is never a
    mystery. The test result refreshes the same values when it completes.
    """
    now = time.time()
    if now - _client_cache["at"] < CLIENT_CACHE_SECONDS:
        return {k: _client_cache[k] for k in ("ip", "isp", "country", "error")}

    if _last and _last.client_ip:
        return {
            "ip": _last.client_ip,
            "isp": _last.client_isp,
            "country": "",
            "error": "",
        }

    try:
        import speedtest

        st = speedtest.Speedtest(secure=False)
        client = st.results.client or {}
        _client_cache.update(
            at=now,
            ip=client.get("ip", ""),
            isp=client.get("isp", ""),
            country=client.get("country", ""),
            error="",
        )
    except Exception as e:  # noqa: BLE001
        log.warning("speedtest public IP lookup failed: %s", e)
        _client_cache.update(
            at=now,
            ip="",
            isp="",
            country="",
            error=f"{type(e).__name__}: {e}",
        )
        # Short retry window after failure.
        _client_cache["at"] = now - CLIENT_CACHE_SECONDS + 30

    return {k: _client_cache[k] for k in ("ip", "isp", "country", "error")}


def _run_python(server_id: int | None = None) -> None:
    """Fallback worker body using the Python ``speedtest-cli`` package."""
    import speedtest

    _set_phase("server")
    st = speedtest.Speedtest(secure=False)
    client = st.results.client or {}
    with _lock:
        _job.client_ip = client.get("ip", "") or _job.client_ip
        _job.client_isp = client.get("isp", "") or _job.client_isp

    if server_id is not None:
        # The selected id normally comes from the modern list, which the legacy
        # XML feed cannot always resolve, so try that first.
        try:
            candidates = [
                s for s in _modern_server_list(50) if s["id"] == str(server_id)
            ]
        except Exception as e:  # noqa: BLE001
            log.info("speedtest: modern server lookup failed: %s", e)
            candidates = []
        if not candidates:
            try:
                candidates = _flatten_servers(st.get_servers([int(server_id)]))
            except Exception:  # noqa: BLE001
                candidates = []
        if not candidates:
            raise RuntimeError(f"Server speedtest id {server_id} tidak ditemukan")
        srv = st.get_best_server(candidates)
    else:
        # Pick from the modern nearby list when it is reachable. get_best_server
        # still measures real latency, so this only replaces the server set, not
        # the selection logic.
        try:
            candidates = _modern_server_list(10)
        except Exception as e:  # noqa: BLE001
            log.warning("speedtest: modern server list failed, using legacy list: %s", e)
            candidates = []
        srv = st.get_best_server(candidates) if candidates else st.get_best_server()

    host = srv.get("host", "")
    preview = _server_preview(srv)
    with _lock:
        _job.server = preview
        _job.live_download_mbps = 0.0
        _job.live_upload_mbps = 0.0
        _job.live_ping_ms = 0.0
        _job.live_jitter_ms = 0.0

    _set_phase("ping", 0.10)
    ping, jitter = _measure_ping(host) if host else (0.0, 0.0)
    with _lock:
        _job.live_ping_ms = ping
        _job.live_jitter_ms = jitter

    _set_phase("download", 0.16)
    stop = _start_monitor("download")
    try:
        down = st.download(threads=FALLBACK_DOWNLOAD_THREADS) / 1e6  # bits/s -> Mbps
    finally:
        stop.set()
    with _lock:
        _job.live_download_mbps = round(down, 2)

    _set_phase("upload", 0.66)
    stop = _start_monitor("upload")
    try:
        up = st.upload(threads=FALLBACK_UPLOAD_THREADS) / 1e6
    finally:
        stop.set()
    with _lock:
        _job.live_upload_mbps = round(up, 2)

    if time.time() - (_job.started_at or time.time()) > MAX_SECONDS:
        log.warning("speedtest exceeded budget; keeping partial result")

    res = SpeedtestResult(
        download_mbps=round(down, 2),
        upload_mbps=round(up, 2),
        ping_ms=ping,
        ping_jitter_ms=jitter,
        server_id=str(srv.get("id", "")),
        server_name=srv.get("name", ""),
        server_sponsor=srv.get("sponsor", ""),
        server_host=host,
        server_country=srv.get("country", ""),
        server_city=srv.get("city", "") or srv.get("name", ""),
        client_isp=client.get("isp", ""),
        client_ip=client.get("ip", ""),
        engine="speedtest-cli",
    )
    with _lock:
        global _last
        _last = res
        _job.result = res
        _job.error = ""
        _job.progress = 1.0
    _persist(res)


def _run_ookla(binary: str, server_id: int | None = None) -> None:
    """Run the official CLI and translate its JSONL stream into job state."""
    cmd = [
        binary,
        "--accept-license",
        "--accept-gdpr",
        "-f",
        "jsonl",
        "-p",
        "yes",
        "--progress-update-interval=500",
    ]
    if server_id is not None:
        cmd += ["--server-id", str(int(server_id))]

    _set_phase("server")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    killer = threading.Timer(MAX_SECONDS, proc.kill)
    killer.daemon = True
    killer.start()

    result: dict | None = None
    noise: list[str] = []
    client_ip = ""
    client_isp = ""
    preview: dict | None = None

    try:
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                noise.append(line)
                continue

            kind = event.get("type")
            if kind == "testStart":
                iface = event.get("interface") or {}
                client_ip = iface.get("externalIp", "") or client_ip
                client_isp = event.get("isp", "") or client_isp
                preview = _official_preview(event.get("server"))
                with _lock:
                    _job.client_ip = client_ip
                    _job.client_isp = client_isp
                    if preview:
                        _job.server = preview
                _set_phase("ping", 0.10)
            elif kind == "ping":
                ping = event.get("ping") or {}
                with _lock:
                    _job.live_ping_ms = float(ping.get("latency", 0) or 0)
                    _job.live_jitter_ms = float(ping.get("jitter", 0) or 0)
                _set_phase("ping", 0.10)
            elif kind == "download":
                download = event.get("download") or {}
                mbps = float(download.get("bandwidth", 0) or 0) * 8.0 / 1e6
                with _lock:
                    _job.live_download_mbps = mbps
                _set_phase("download", 0.16)
            elif kind == "upload":
                upload = event.get("upload") or {}
                mbps = float(upload.get("bandwidth", 0) or 0) * 8.0 / 1e6
                with _lock:
                    _job.live_upload_mbps = mbps
                _set_phase("upload", 0.66)
            elif kind == "result":
                result = event
    finally:
        killer.cancel()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    if result is None:
        tail = " | ".join(noise[-3:])
        raise RuntimeError(tail or "Ookla CLI tidak menghasilkan hasil")

    ping = result.get("ping") or {}
    download = result.get("download") or {}
    upload = result.get("upload") or {}
    server = result.get("server") or {}
    iface = result.get("interface") or {}
    if server:
        preview = _official_preview(server)
    preview = preview or {}

    res = SpeedtestResult(
        download_mbps=round(float(download.get("bandwidth", 0) or 0) * 8.0 / 1e6, 2),
        upload_mbps=round(float(upload.get("bandwidth", 0) or 0) * 8.0 / 1e6, 2),
        ping_ms=round(float(ping.get("latency", 0) or 0), 1),
        ping_jitter_ms=round(float(ping.get("jitter", 0) or 0), 1),
        server_id=str(server.get("id", "") or preview.get("id", "")),
        server_name=str(preview.get("name", "")),
        server_sponsor=str(preview.get("sponsor", "")),
        server_host=str(preview.get("host", "")),
        server_country=str(preview.get("country", "")),
        server_city=str(preview.get("city", "")),
        client_isp=str(result.get("isp") or client_isp),
        client_ip=str(iface.get("externalIp") or client_ip),
        engine="ookla-cli",
        packet_loss=float(result.get("packetLoss", 0) or 0),
    )

    with _lock:
        global _last
        _last = res
        _job.result = res
        _job.server = preview or _job.server
        _job.client_ip = res.client_ip or _job.client_ip
        _job.client_isp = res.client_isp or _job.client_isp
        _job.live_download_mbps = res.download_mbps
        _job.live_upload_mbps = res.upload_mbps
        _job.live_ping_ms = res.ping_ms
        _job.live_jitter_ms = res.ping_jitter_ms
        _job.error = ""
        _job.progress = 1.0
    _persist(res)


def _run(server_id: int | None = None) -> None:
    """Worker body. Never raises past the lock."""
    try:
        binary = _ookla_binary()
        if binary:
            try:
                _run_ookla(binary, server_id)
                return
            except Exception as e:  # noqa: BLE001
                log.warning("Ookla CLI failed, falling back to speedtest-cli: %s", e)
                _reset_live()

        _run_python(server_id)
    except Exception as e:  # noqa: BLE001
        log.warning("speedtest failed: %s", e)
        with _lock:
            _job.error = f"{type(e).__name__}: {e}"
    finally:
        with _lock:
            _job.running = False
            _job.started_at = None
            _job.phase_started_at = None
            _job.phase = ""
            if _job.result:
                _job.progress = 1.0


def start(server_id: int | None = None) -> dict:
    """Kick off a test. Returns immediately; the UI polls status()."""
    with _lock:
        if _job.running:
            return {"started": False, "reason": "Test sudah berjalan"}
        _job.running = True
        _job.started_at = time.time()
        _job.phase_started_at = time.time()
        _job.phase = "server"
        _job.progress = 0.02
        _job.live_download_mbps = 0.0
        _job.live_upload_mbps = 0.0
        _job.live_ping_ms = 0.0
        _job.live_jitter_ms = 0.0
        _job.error = ""
        _job.log_lines = []
        # A new run starts empty; the previous result stays in the history table.
        _job.server = None
        _job.result = None
    threading.Thread(
        target=_run, args=(server_id,), name="speedtest", daemon=True
    ).start()
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
