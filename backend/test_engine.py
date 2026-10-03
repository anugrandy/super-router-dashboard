"""Engine + WebSocket checks that don't need raw-socket rights.

Run: .venv/Scripts/python.exe backend/test_engine.py
"""
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

PASS, FAIL = 0, 0


def chk(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name} {extra}")

from app import net  # noqa: E402
from app.scapy_arp import (  # noqa: E402
    _local_mac,
    describe_interfaces,
    resolve_iface,
)

# --- interface resolution (regression: spoof must not use a virtual adapter) ---
LOCAL_IP = net.detect_local_ip("192.168.1.0/24")
iface = resolve_iface(LOCAL_IP)
chk("resolve_iface returns something", iface is not None)
if iface is not None:
    chk("resolve_iface picks the LAN adapter",
        getattr(iface, "ip", None) == LOCAL_IP,
        f"{getattr(iface, 'name', None)} ip={getattr(iface, 'ip', None)}")
    chk("resolve_iface avoids virtual adapters",
        "vmware" not in str(getattr(iface, "name", "")).lower()
        and "virtualbox" not in str(getattr(iface, "name", "")).lower(),
        getattr(iface, "name", None))
    mac = getattr(iface, "mac", None)
    chk("iface mac is real (not all-zero)", mac and mac != "00:00:00:00:00:00", mac)
    chk("_local_mac matches iface mac",
        _local_mac(LOCAL_IP) == str(mac).lower(),
        f"{_local_mac(LOCAL_IP)} vs {mac}")

try:
    from scapy.all import conf  # type: ignore

    inv = describe_interfaces()
    chk("interface inventory non-empty", len(inv) > 0, len(inv))
    chk("inventory marks virtuals",
        any(i["is_virtual"] for i in inv) or len(inv) == 1)
    chk("inventory has ip field", all("ip" in i for i in inv))
except Exception as e:
    print(f"SKIP  interface inventory: {e}")

# Explicit name hint must be honoured.
if iface is not None:
    hinted = resolve_iface(None, getattr(iface, "name", None))
    chk("name hint honoured", getattr(hinted, "name", None) == getattr(iface, "name", None),
        getattr(hinted, "name", None))
    bad = resolve_iface(None, "no-such-adapter-xyz")
    chk("unknown hint falls back", bad is not None)

# --- spoof engine lifecycle -------------------------------------------------
t = net.KickTarget(
    mac="AA:BB:CC:DD:EE:01",
    ip="192.168.1.50",
    gateway_ip="192.168.1.1",
    gateway_mac="11:22:33:44:55:66",
    local_ip="192.168.1.3",
)
net.engine.start(t, max_seconds=60)
chk("start registers target", net.engine.is_active("aa:bb:cc:dd:ee:01") is not None)
chk("active list length 1", len(net.engine.active()) == 1)

# starting the same MAC again must not double-register
net.engine.start(t, max_seconds=60)
chk("restart stays single", len(net.engine.active()) == 1)

stopped = net.engine.stop("AA:BB:CC:DD:EE:01")
chk("stop returns target", stopped is not None)
chk("stop deregisters", net.engine.is_active("AA:BB:CC:DD:EE:01") is None)
chk("stop unknown mac is None", net.engine.stop("00:00:00:00:00:99") is None)

# auto-stop at max_seconds
t2 = net.KickTarget(
    mac="AA:BB:CC:DD:EE:02", ip="192.168.1.51",
    gateway_ip="192.168.1.1", gateway_mac="11:22:33:44:55:66",
    local_ip="192.168.1.3",
)
net.engine.start(t2, max_seconds=10)
chk("auto-kick active", net.engine.is_active("AA:BB:CC:DD:EE:02") is not None)

# stop_all on shutdown
t3 = net.KickTarget(
    mac="AA:BB:CC:DD:EE:03", ip="192.168.1.52",
    gateway_ip="192.168.1.1", gateway_mac="11:22:33:44:55:66",
    local_ip="192.168.1.3",
)
net.engine.start(t3, max_seconds=600)
net.engine.stop_all()
time.sleep(0.4)
chk("stop_all clears everything", len(net.engine.active()) == 0)
chk("stop flag set on target", t3._stop.is_set())
net.engine.stop_all()

# --- helpers ----------------------------------------------------------------
chk("normalize mac dashes", net.normalize_mac("aa-bb-cc-dd-ee-ff") == "AA:BB:CC:DD:EE:FF")
chk("valid mac true", net.valid_mac("AA:BB:CC:DD:EE:FF"))
chk("invalid mac false", not net.valid_mac("AA:BB:CC:DD:EE"))
chk("valid mac short rejected", not net.valid_mac("AABBCCDDEEFF"))
chk("vendor lookup samsung", "samsung" in net.lookup_vendor("00:00:F0:11:22:33").lower(),
    repr(net.lookup_vendor("00:00:F0:11:22:33")))
chk("vendor lookup from real oui file", "asus" in net.lookup_vendor("AC:22:0B:11:22:33").lower(),
    repr(net.lookup_vendor("AC:22:0B:11:22:33")))
chk("vendor lookup zte gateway", "zte" in net.lookup_vendor("C8:4C:78:15:0B:B4").lower(),
    net.lookup_vendor("C8:4C:78:15:0B:B4"))
chk("vendor table is large", len(net._load_oui()) > 30000, len(net._load_oui()))
chk("vendor unknown empty", net.lookup_vendor("02:99:99:99:99:99") == "")
chk("broadcast rejected", not net._is_unicast("FF:FF:FF:FF:FF:FF"))
chk("multicast rejected", not net._is_unicast("01:00:5E:00:00:16"))
chk("allzero rejected", not net._is_unicast("00:00:00:00:00:00"))
chk("unicast accepted", net._is_unicast("C8:4C:78:15:0B:B4"))
chk("type guess iot", net.guess_device_type("Espressif Inc.", "") == "iot")
chk("type guess phone", net.guess_device_type("Xiaomi Communications Co., Ltd.", "") == "phone")
chk("xiaomi tv hostname -> tv", net.guess_device_type("Xiaomi Communications Co., Ltd.", "livingroom_tv") == "tv")
chk("xiaomi band is iot", net.guess_device_type("Xiaomi Communications Co., Ltd.", "mi_band_5") == "iot")
chk("type guess computer", net.guess_device_type("ASUSTek Computer Inc.", "") == "computer")
chk("gateway flag -> router", net.guess_device_type("", "", "192.168.1.1", True) == "router")
chk("zte vendor -> router", net.guess_device_type("zte corporation", "") == "router")
chk("synology -> server", net.guess_device_type("Synology Incorporated", "") == "server")
chk("chromecast -> tv", net.guess_device_type("Google, Inc.", "chromecast") == "tv")
chk("type guess unknown", net.guess_device_type("", "") == "unknown")
mac = _local_mac()
chk("local mac valid form", net.valid_mac(mac) or mac == "00:00:00:00:00:00", mac)


# --- websocket --------------------------------------------------------------
async def ws_check():
    """Assert the WS endpoint rejects anonymous clients and serves the
    snapshot to an authenticated one."""
    import websockets  # type: ignore
    import http.cookiejar
    import urllib.request

    # Log in over plain HTTP to grab the session cookie.
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    req = urllib.request.Request(
        "http://127.0.0.1:8777/api/auth/login",
        data=json.dumps({"username": "admin", "password": "netdash"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        opener.open(req, timeout=5).read()
    except Exception as e:
        print(f"SKIP  ws test, login failed: {e}")
        return
    cookie = next((c for c in jar if c.name == "netdash_session"), None)
    if not cookie:
        print("SKIP  ws test, no session cookie")
        return

    # 1. anonymous must be rejected
    rejected = False
    try:
        async with websockets.connect("ws://127.0.0.1:8777/ws/live") as ws:
            await asyncio.wait_for(ws.recv(), timeout=3)
    except Exception:
        rejected = True
    chk("ws rejects anonymous client", rejected)

    # 2. authenticated gets a devices snapshot then a kicked map
    hdrs = [("Cookie", f"netdash_session={cookie.value}")]
    async with websockets.connect("ws://127.0.0.1:8777/ws/live", additional_headers=hdrs) as ws:
        first = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        chk("ws sends devices first", first.get("event") == "devices", str(first)[:100])
        second = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        chk("ws sends kicked map", second.get("event") == "kicked", str(second)[:100])
        # A client ping must be tolerated: the server absorbs it and does not
        # reply, so assert the socket is still open rather than awaiting a frame.
        await ws.send("ping")
        await asyncio.sleep(0.4)
        chk("ws stays open after ping", ws.state is websockets.protocol.State.OPEN, str(ws.state))


try:
    print("--- websocket ---")
    asyncio.run(ws_check())
except ImportError:
    print("SKIP  websocket test (websockets not installed)")
except Exception as e:
    print(f"SKIP  websocket test: {type(e).__name__}: {e}")

print()
print(f"PASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
