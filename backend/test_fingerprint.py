"""Device fingerprinting checks: hostname/vendor -> type, and naming.

Run: .venv/Scripts/python.exe backend/test_fingerprint.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.fingerprint import (  # noqa: E402
    T_DESKTOP,
    T_IOT,
    T_LAPTOP,
    T_OTHER,
    T_PHONE,
    T_PRINTER,
    T_ROUTER,
    T_SERVER,
    T_TV,
    fingerprint,
    friendly_name,
    guess_type,
    is_confident,
    is_randomized_mac,
)

PASS = FAIL = 0
FAILURES: list[str] = []


def check(name: str, got: object, want: object) -> None:
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        FAILURES.append(f"{name}: got {got!r}, want {want!r}")
        print(f"FAIL  {name}: got {got!r}, want {want!r}")


def check_type(name, host="", vendor="", wifi=None, gateway=False, want=""):
    check(name, guess_type(host, vendor, wifi, gateway), want)


print("--- hostname brands (live hostnames from this router) ---")
# These are the actual HostName values the ZTE F670L reported.
check_type("TECNO-SPARK-Go-1", "TECNO-SPARK-Go-1", "zte corporation", True, want=T_PHONE)
check_type("Galaxy-A12", "Galaxy-A12", "", True, want=T_PHONE)
check_type("OPPO-A16", "OPPO-A16", "", True, want=T_PHONE)
check_type("A52-milik-Nur", "A52-milik-Nur", "", True, want=T_PHONE)
check_type("itel-A70", "itel-A70", "", True, want=T_PHONE)
check_type("vivo-V27", "vivo-V27", "", True, want=T_PHONE)
check_type("Redmi-Note-11-Pro-5G", "Redmi-Note-11-Pro-5G", "", True, want=T_PHONE)
check_type("realme-11", "realme-11", "", True, want=T_PHONE)
check_type("SM-A125F", "SM-A125F", "", True, want=T_PHONE)

print("\n--- hostname wins over a misleading vendor ---")
# The AP is ZTE; phones behind it can inherit that OUI. A vendor-only match
# would call a TECNO a router, which was a real bug.
check_type("TECNO beats zte vendor", "TECNO-SPARK-Go-1", "zte corporation", True, want=T_PHONE)
# A ZTE OUI alone is NOT enough: the AP stamps its own OUI on every client
# behind it. Wireless + no hostname + ZTE vendor must not be called a router.
check_type("zte vendor alone is NOT router", "", "zte corporation", True, want=T_OTHER)
# ...but a wired ZTE device really is infrastructure.
check_type("wired zte is router", "", "zte corporation", False, want=T_ROUTER)
# ...and a ZTE device that names itself is treated as hardware.
check_type("named zte is router", "F670L", "zte corporation", True, want=T_ROUTER)
check_type("gateway always router", "Galaxy-A12", "Apple, Inc.", True, True, T_ROUTER)

print("\n--- regression: client behind an AP with the AP's OUI ---")
# The exact device from the bug report: 192.168.1.7, no hostname, ZTE vendor.
check_type("no-hostname ZTE client", "", "zte corporation", True, want=T_OTHER)
check(
    "no-hostname ZTE client is not confident",
    is_confident("FC:44:9F:2F:65:28", hostname="", vendor="zte corporation", is_wireless=True),
    False,
)

print("\n--- apple ---")
check_type("iPhone", "iPhone-14", "", True, want=T_PHONE)
check_type("iPad", "iPad-mini", "", True, want=T_PHONE)
check_type("MacBook", "MacBook-Pro", "Apple, Inc.", True, want=T_LAPTOP)
check_type("bare apple oui", "", "Apple, Inc.", True, want=T_LAPTOP)

print("\n--- linux / server ---")
check_type("raspberry pi vendor", "raspberrypi", "Raspberry Pi Foundation", False, want=T_SERVER)
check_type("ubuntu hostname", "ubuntu-server", "", False, want=T_SERVER)
check_type("debian hostname", "debian", "", False, want=T_SERVER)
check_type("nas hostname", "my-nas", "", False, want=T_SERVER)

print("\n--- pc / desktop ---")
check_type("UNKNOWN-PC + intel", "UNKNOWN-PC", "Intel Corporate", True, want=T_LAPTOP)
check_type("desktop hostname", "desktop-01", "", False, want=T_DESKTOP)
check_type("laptop hostname", "laptop-01", "", False, want=T_LAPTOP)
check_type("wired intel nic", "", "Intel Corporate", False, want=T_DESKTOP)

print("\n--- tv / printer / iot ---")
check_type("tv hostname", "living-room-tv", "LG Electronics", True, want=T_TV)
check_type("printer vendor", "hp-printer", "Hewlett Packard", False, want=T_PRINTER)
check_type("camera hostname", "cam-front", "", True, want=T_IOT)

print("\n--- wired fallback ---")
# A wired client with no other evidence is most often a PC/server. The user can
# correct it via the type override; guessing "phone" here would be wrong.
check_type("wired no evidence", "", "", False, want=T_SERVER)
check_type("wireless no evidence", "", "", True, want=T_OTHER)

print("\n--- randomized MACs ---")
check("private mac detected", is_randomized_mac("16:50:AD:B9:4A:FA"), True)
check("real oui not private", is_randomized_mac("C8:4C:78:15:0B:B4"), False)
check("hyphen form works", is_randomized_mac("c2-4a-22-70-1c-c8"), True)
check("garbage mac is not private", is_randomized_mac("nonsense"), False)

print("\n--- friendly_name ---")
check(
    "hostname wins",
    friendly_name("TECNO-SPARK-Go-1", "zte corporation", "192.168.1.5", "76:09:9E:D7:88:FD", T_PHONE),
    "TECNO-SPARK-Go-1",
)
# The router echoes the MAC back as HostName when DHCP has no name; using that
# as a title would be useless.
check(
    "mac echo is not a name",
    friendly_name("16:50:AD:B9:4A:FA", "", "192.168.1.4", "16:50:AD:B9:4A:FA", T_PHONE),
    "Device 192.168.1.4",
)
check(
    "vendor fallback",
    friendly_name("", "Intel Corporate", "192.168.1.3", "04:6C:59:7D:73:14", T_LAPTOP),
    "Intel Corporate",
)
# The legal suffix is stripped for a cleaner label.
check(
    "gateway naming strips suffix",
    friendly_name("", "ZTE Corporation", "192.168.1.1", "C8:4C:78:15:0B:B4", T_ROUTER),
    "ZTE",
)
check(
    "ip fallback",
    friendly_name("", "", "192.168.1.9", "AA:BB:CC:DD:EE:FF", T_OTHER),
    "Device 192.168.1.9",
)

print("\n--- apple: broader hostname shapes ---")
# macOS announces "<Model>-<Name>.local"; Apple TV / AirPort also appear.
check_type("mac local name", "MacBook-Pro-Jadi.local", "", True, want=T_LAPTOP)
check_type("mac mini", "mac-mini-1", "", True, want=T_LAPTOP)
check_type("apple tv", "AppleTV", "", True, want=T_TV)
check_type("apple tv spaced", "apple-tv-living", "", True, want=T_TV)
check_type("iphone still phone", "iPhone-15-Pro", "", True, want=T_PHONE)

print("\n--- confidence: guess vs evidence ---")
check(
    "hostname means confident",
    is_confident("16:50:AD:B9:4A:FA", hostname="Galaxy-A12", vendor=""),
    True,
)
check(
    "random mac, no hostname = NOT confident",
    is_confident("16:50:AD:B9:4A:FA", hostname="", vendor="", is_wireless=True),
    False,
)
check(
    "gateway always confident",
    is_confident("C8:4C:78:15:0B:B4", hostname="", vendor="", gateway=True),
    True,
)
check(
    "vendor alone is confident",
    is_confident("04:6C:59:7D:73:14", hostname="", vendor="Intel Corporate"),
    True,
)

print("\n--- fingerprint() returns a pair ---")
name, dtype = fingerprint(
    "76:09:9E:D7:88:FD",
    hostname="TECNO-SPARK-Go-1",
    vendor="zte corporation",
    ip="192.168.1.5",
    is_wireless=True,
)
check("pair name", name, "TECNO-SPARK-Go-1")
check("pair type", dtype, T_PHONE)

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)