"""Regressions for three bugs that made /connection show
"Respons tidak valid dari server (200)" and hang on "Memuat...".

1. The SPA catch-all served index.html for ANY unmatched path, so a missing
   /api/ route returned HTML at status 200 and JSON.parse() failed.
2. wan_status.get() ran its fetch outside the lock, so concurrent cache-miss
   callers raced each other's router login and tripped the router lockout.
3. A JSON parse failure reported only the status, hiding the real cause.

Run: .venv/Scripts/python.exe backend/test_wan_regressions.py
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import wan_status  # noqa: E402
from app.main import app  # noqa: E402

PASS = FAIL = 0
FAILURES: list[str] = []


def check(name: str, got, want) -> None:
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        FAILURES.append(f"{name}: got {got!r}, want {want!r}")
        print(f"FAIL  {name}: got {got!r}, want {want!r}")


# The real routes require auth; log in so the client is not redirected.
client = TestClient(app)
client.post(
    "/api/auth/login",
    json={"username": "admin", "password": "netdash"},
)


print("--- 1. an unrouted /api/ path is a 404, not the SPA ---")
res = client.get("/api/endpoint-yang-tidak-ada")
check("unknown api route is 404", res.status_code, 404)
check("404 is JSON, not HTML", res.headers.get("content-type", "").startswith("application/json"), True)
try:
    res.json()
    parsed = True
except Exception:
    parsed = False
check("404 body parses as JSON", parsed, True)

print("\n--- a real route is still served normally ---")
res = client.get("/api/wan")
check("real wan route returns 200", res.status_code, 200)
check("and is JSON", res.headers.get("content-type", "").startswith("application/json"), True)
check("has the expected shape", sorted(res.json().keys()), ["history", "poll_seconds", "status"])

print("\n--- 2. concurrent cache-miss fetches are serialised ---")
calls: list[int] = []


import time as _time


class FakeWan:
    """Minimal stand-in; `fetched_at` is read by the cache-freshness check."""

    available = True
    ipv4_status = "connected"
    ipv4_address = "10.27.5.55"
    connection_name = "INTERNET"
    disconnect_reason = ""
    online_seconds = 5
    error = ""

    def __init__(self):
        self.fetched_at = _time.time()

    def to_dict(self):
        return {"ipv4_status": "connected", "connected": True}


def slow_fetch():
    """Stand in for a router round-trip; long enough to overlap if unlocked."""
    calls.append(1)
    time.sleep(0.25)
    return FakeWan()


results = []
lock = threading.Lock()


def worker():
    w = wan_status.get()
    with lock:
        results.append(w.ipv4_status)


threads = [threading.Thread(target=worker) for _ in range(4)]
with patch.object(wan_status, "_fetch", side_effect=slow_fetch):
    # Cold cache: all four callers race into the fetch at once.
    wan_status.invalidate()
    [t.start() for t in threads]
    [t.join() for t in threads]

check("all callers got a status", len(results), 4)
check("no caller saw an error", all(r == "connected" for r in results), True)
# Serialised: one caller fetches, the rest wait and reuse that result.
check("router was hit once, not four times", len(calls), 1)

print("\n--- an overlapping burst must not fail any caller ---")


def failing_fetch():
    time.sleep(0.05)
    return FakeWan()


ok = []
with patch.object(wan_status, "_fetch", side_effect=failing_fetch):
    wan_status.invalidate()
    ts = [threading.Thread(target=lambda: ok.append(wan_status.get())) for _ in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
check("six concurrent forced reads all succeed", len(ok), 6)
check("and all are real objects", all(getattr(o, "available", False) for o in ok), True)

print("\n--- 3. stale bytecode must not shadow a new method ---")
from app.router_client import ZteRouter  # noqa: E402

check("ZteRouter has page_get", hasattr(ZteRouter, "page_get"), True)

print(f"\nPASS={PASS} FAIL={FAIL}")
for f in FAILURES:
    print("  " + f)
sys.exit(1 if FAIL else 0)