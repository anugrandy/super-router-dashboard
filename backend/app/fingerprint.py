"""Device fingerprinting: derive a friendly name and a device type.

Two inputs are combined:

* the router's DHCP hostname (see :mod:`app.topo_client`), e.g.
  ``TECNO-SPARK-Go-1``, ``Galaxy-A12``, ``OPPO-A16``;
* the IEEE OUI vendor, when the MAC has a real (non-randomized) prefix.

Both are optional and either may be missing, so every step degrades instead of
failing. The result is a *guess*: the user can always override the type and the
display name from the device page.

Why the vendor is often blank: modern phones (iOS and Android 10+) present a
locally-administered MAC per SSID, so their OUI is randomized and matches no
IEEE registry entry at all. Those devices are identified by hostname instead.
"""

from __future__ import annotations

import re

# Device types, kept in sync with the frontend's TYPE_LABEL / icon map.
T_PHONE = "phone"
T_LAPTOP = "laptop"
T_DESKTOP = "desktop"
T_TV = "tv"
T_PRINTER = "printer"
T_IOT = "iot"
T_ROUTER = "router"
T_SERVER = "server"
T_OTHER = "other"

ALL_TYPES = (
    T_PHONE,
    T_LAPTOP,
    T_DESKTOP,
    T_TV,
    T_PRINTER,
    T_IOT,
    T_ROUTER,
    T_SERVER,
    T_OTHER,
)

# --------------------------------------------------------------------- vendors

# Networking / router / AP vendors, matched against the OUI vendor string.
_ROUTER_VENDORS = (
    "zte", "tp-link", "tplink", "tp link", "d-link", "dlink", "mikrotik",
    "ubiquiti", "ubnt", "netgear", "linksys", "asus", "cisco", "aruba",
    "huawei", "broadcom", "realtek semiconductor", "mediatek", "qualcomm",
    "espressif", "tuya", "shelly", "sonoff", "itead", "tenda", "dumoo",
    "xiongmai", "gigaset", "avm", "fritz", "netcore", "ruijie", "hsq",
)

# Vendors that ship PCs and USB NICs rather than phones.
# Hostname fragments that positively identify networking hardware. Used instead
# of "any hostname", so a phone whose vendor OUI was inherited from the access
# point (ZTE does this) is not mistaken for the access point.
_ROUTER_HOST_NAMES = (
    "f670", "f670l", "f680", "f689", "zxhn", "dasan", "gw", "gateway",
    "router", "access-point", "accesspoint", "ap-", "-ap", "modem", "onu",
    "ONT", "ONT", " CPE", "wifi-", "wireless-router", "openwrt", "dd-wrt",
    "mikrotik", "ubnt", "tplink", "tp-link", "dir-", "dlink",
)

_PC_VENDORS = (
    "intel corporate", "realtek", "gigabyte", "asrock", "msi", "micro-star",
    "dell", "lenovo", "hewlett", "packard", "apple", "lg electronics", "samsung",
    "acer", "asus", "sony", "fujitsu", "toshiba", "compaq", "gateway",
)

# Single-board / server / VM-ish vendors.
_SERVER_VENDORS = (
    "raspberry pi", "raspberrypi", "proxmox", "supermicro", "vmware",
    "oracle", "canonical", "qemu", "xensource", "parallels", "bochs",
)

# IoT / smart-home / embedded vendors.
_IOT_VENDORS = (
    "sonos", "philips lighting", "signify", "tuya", "shelly", "sonoff",
    "itead", "espressif", "amazon technologies", "google", "nest labs",
    "roborock", "ecovacs", "dyson", "bose", "jbl", "harman", "denon",
    "yamaha", "apple home", "tasmota", "iteo", "wyze", "eufy", "anker",
)

_PRINTER_VENDORS = ("hewlett packard", "hp inc", "brother", "canon", "epson",
                    "lexmark", "kyocera", "ricoh", "fuji film", "pantum")

_TV_VENDORS = ("lg electronics", "sony", "samsung", "tcl", "hisense", "vizio",
               "roku", "philips", "sharp", "toshiba", "xiaomi", "huawei")

# ------------------------------------------------------------- hostname brands

# Phone brand -> canonical maker. Matched case-insensitively as a substring of
# the hostname, so "Redmi-Note-11-Pro-5G" and "redmi note 11" both hit.
_PHONE_BRANDS = (
    # Apple handled separately (iPhone/iPad/Mac are distinctive)
    "iphone", "ipad", "ipod", "macbook", "imac", "mac ",
    # Android makers
    "samsung", "galaxy", "redmi", "xiaomi", "poco", "mi ",
    "oppo", "realme", "vivo", "tecno", "itel", "infinix", "nokia", "hmd",
    "oneplus", "asus zenfone", "zenfone", "motorola", "moto g", "moto e",
    "honor", "huawei nova", "huawei p", "meizu", "leeco", "smartisan",
    "sharp aquos", "aquos", "sony xperia", "xperia", "lg g", "lg k",
    "nubia", "tecno camon", "camon", "itel it", "infinix hot", "infinix note",
    "crosscall", "cat s", "rugged",
)

# Bare model numbers that identify a phone but carry no brand name, e.g.
# "A52-milik-Nur" is an Oppo A52 and "SM-A125F" is a Samsung. Kept as
# whole-token regexes so they don't fire on arbitrary words.
_PHONE_MODEL_PATTERNS = (
    r"\bsm-[a-z]\d{2,4}\w*\b",          # Samsung SM-A125F, SM-G991B
    r"\bnx[a-z]?\d{3,4}\w*\b",          # Samsung Galaxy Nexus
    r"\b(a\d{2}|c\d{2}|sp\d{2,3})\b",   # Oppo A/C/series, realme sp
    r"\b(rp\d{2}|rmx\d{4})\b",          # realme / Oppo Reno model codes
    r"\b(m2|m3|m5|note\s?\d{1,2}|p\d{2}|f\d{2})\b",
    r"\b(k\d{2}|i\d{3})\b",             # LG K-series, iPhone numeric
)

# Desktop / laptop indicators in a hostname.
_PC_HOST_HINTS = (
    "desktop", "laptop", "notebook", "pc", "workstation", "thinkpad",
    "ideapad", "thinkcentre", "pavilion", "optiplex", "elitebook", "latitude",
    "precision", "xps", "surface", "macbook", "imac", "powerbook",
    "aspire", "predator", "pulse", "zenbook", "vivobook", "rog ",
    "macmini", "imac", "pro", "work",
)

# Linux / server indicators in a hostname.
_SERVER_HOST_HINTS = (
    "linux", "ubuntu", "debian", "fedora", "centos", "raspbian", "kali",
    "alpine", "arch", "manjaro", "server", "nas", "synology", "truenas",
    "proxmox", "vmware", "esxi", "docker", "container", "node", "raspberry",
    "pi-", "pi0", "pi3", "pi4", "rpi", "orange-pi", "bananapi",
)

_IOT_HOST_HINTS = (
    "tv", "chromecast", "firestick", "roku", "sonos", "speaker", "echo",
    "alexa", "google-home", "nest", "camera", "cam", "ipcam", "baby",
    "printer", "scanner", "watch", "band", "console", "playstation", "xbox",
    "nintendo", "switch", "roblox", "steam-deck", "printer", "plug", "bulb",
    "light", "sensor", "hub", "thermostat", "doorbell", "lock",
)


def normalize_mac(mac: str) -> str:
    """Uppercase colon form, or '' when the input is not a usable MAC."""
    raw = re.sub(r"[^0-9a-fA-F]", "", str(mac or ""))
    if len(raw) != 12:
        return ""
    return ":".join(raw[i : i + 2] for i in range(0, 12, 2)).upper()


def is_randomized_mac(mac: str) -> bool:
    """True when the U/L bit is set, i.e. the phone chose a private MAC.

    Such a MAC has no IEEE OUI, so a blank vendor is correct and expected
    rather than a lookup failure.
    """
    norm = normalize_mac(mac)
    if not norm:
        return False
    return bool(int(norm[:2], 16) & 0x02)


def _has(haystack: str, needles: tuple[str, ...]) -> str:
    """First needle present in haystack, else ''."""
    for n in needles:
        if n in haystack:
            return n
    return ""


def guess_type(
    hostname: str = "",
    vendor: str = "",
    is_wireless: bool | None = None,
    gateway: bool = False,
) -> str:
    """Classify a device. Order matters: the most specific rule wins.

    ``is_wireless`` comes from the router (AccessType). When it is None the
    classification falls back to hostname/vendor evidence only.
    """
    host = (hostname or "").strip().lower()
    ven = (vendor or "").strip().lower()

    # 1. The gateway is, by definition, the router.
    if gateway:
        return T_ROUTER

    # 2. Apple names are unambiguous, and must be checked before the vendor
    #    rule below: a phone behind a ZTE/AP chipset reports the AP vendor.
    if host:
        if _has(host, ("iphone", "ipad", "ipod")):
            return T_PHONE
        # Checked before the Mac list: "appletv" is a substring of "apple tv"
        # patterns and would otherwise be classified as a computer.
        if _has(host, ("apple tv", "appletv", "apple-tv", "firetv", "chromecast")):
            return T_TV
        if _has(host, ("macbook", "imac", "mac mini", "macmini", "powerbook",
                       "airport", "time capsule")):
            return T_LAPTOP
        # macOS announces "<Model>-<Name>.local" (e.g. "MacBook-Pro.local").
        # Android never uses this shape, so it is a safe signal.
        if re.search(r"\bmac\w*-", host) or host.endswith(".local") and "mac" in host:
            return T_LAPTOP
    if ven.startswith("apple"):
        # Apple OUI alone is ambiguous (Mac, iPhone, iPad, Apple TV all share
        # it), so treat it as a generic computer unless the hostname said more.
        return T_LAPTOP

    # 2b. Vendor says networking hardware. This only holds with corroborating
    #     evidence, because AP vendors such as ZTE stamp the SAME OUI on the
    #     access point and on every client behind it. A vendor match alone was
    #     labelling clients (FC:44:9F:2F:65:28, a phone with no hostname) as
    #     routers. Trust it when the device also looks like infrastructure:
    #       - a wired link (AccessType LAN from the router), or
    #       - the gateway flag, or
    #       - a hostname that names the hardware.
    if ven and _has(ven, _ROUTER_VENDORS):
        if is_wireless is False:
            return T_ROUTER
        # Only an explicit hardware name counts, never merely "has a hostname":
        # "TECNO-SPARK-Go-1" has a hostname too, and must stay a phone.
        if host and _has(host, _ROUTER_HOST_NAMES):
            return T_ROUTER

    # 3. Server / Linux.
    if host and _has(host, _SERVER_HOST_HINTS):
        return T_SERVER
    if ven and _has(ven, _SERVER_VENDORS):
        return T_SERVER

    # 4. Printer.
    if ven and _has(ven, _PRINTER_VENDORS):
        return T_PRINTER
    if host and _has(host, ("printer", "scanner")):
        return T_PRINTER

    # 5. TV / console (vendor-based; Apple TV was handled above).
    if ven and _has(ven, _TV_VENDORS):
        return T_TV

    # 6. Phone brands (hostname carries the brand on Android; Apple is done).
    if host:
        if _has(host, _PHONE_BRANDS):
            return T_PHONE
        if any(re.search(p, host) for p in _PHONE_MODEL_PATTERNS):
            return T_PHONE

    # 7. Generic PC/Laptop indicators.
    if host and _has(host, _PC_HOST_HINTS):
        return T_LAPTOP

    # 8. IoT-ish hostnames.
    if host and _has(host, _IOT_HOST_HINTS):
        return T_IOT
    if ven and _has(ven, _IOT_VENDORS):
        return T_IOT

    # 9. A wired NIC from a PC-chip vendor is most likely a desktop, but only
    #     when the router actually told us it is on the LAN (not Wi-Fi).
    if ven and _has(ven, _PC_VENDORS) and is_wireless is False:
        return T_DESKTOP

    # 10. Wired, no other evidence: a wired client is far more often a
    #     PC/server than a phone (phones join over Wi-Fi). Offer "server" as
    #     the honest default and let the user correct it.
    if is_wireless is False:
        return T_SERVER

    # 11. Known phone vendors by OUI, for phones that sent no hostname.
    if ven and _has(ven, ("samsung", "xiaomi", "oppo", "vivo", "realme",
                          "tecno", "itel", "infinix", "huawei", "honor")):
        return T_PHONE

    return T_OTHER


def friendly_name(
    hostname: str = "",
    vendor: str = "",
    ip: str = "",
    mac: str = "",
    device_type: str = "",
) -> str:
    """A human label for a device, best-effort.

    Preference order: a real DHCP hostname, then a brand-typed label built from
    the OUI vendor, then something short and unambiguous that includes the IP.
    """
    host = (hostname or "").strip()

    # The router echoes the MAC back as HostName when DHCP has no name.
    if host and normalize_mac(host) == normalize_mac(mac):
        host = ""

    if host:
        return host

    ven = (vendor or "").strip()
    if ven:
        ven = re.sub(r"\s+(corporation|corp\.?|ltd\.?|inc\.?|co\.?)$", "", ven,
                     flags=re.I).strip()
        # A vendor is a better label than a bare IP for anything identifiable.
        # Only "other" falls through to the IP.
        if ven and device_type != T_OTHER:
            return ven

    if ip:
        if device_type == T_ROUTER:
            return f"Gateway {ip}"
        return f"Device {ip}"

    return normalize_mac(mac) or "Unknown device"


def is_confident(
    mac: str,
    hostname: str = "",
    vendor: str = "",
    is_wireless: bool | None = None,
    gateway: bool = False,
) -> bool:
    """True when the type is based on real evidence, not a fallback.

    A device with no hostname, no resolvable vendor (i.e. a randomized MAC) and
    no link-type signal cannot be classified at all. Reporting that as
    "unknown" is honest; letting it show up as a confident-looking "Lainnya"
    with a device icon implies we know something we do not.
    """
    if gateway:
        return True
    if (hostname or "").strip():
        return True
    # An AP vendor alone is NOT evidence: ZTE stamps the same OUI on the access
    # point and on every client behind it, so it identifies the chipset, not
    # the device.
    if (vendor or "").strip() and not _has(vendor.lower(), _ROUTER_VENDORS):
        return True
    # is_wireless is deliberately NOT evidence. Knowing a device joined on
    # 5 GHz says nothing about what it is, which is precisely the case this
    # flag exists to catch.
    return False


def fingerprint(
    mac: str,
    hostname: str = "",
    vendor: str = "",
    ip: str = "",
    is_wireless: bool | None = None,
    gateway: bool = False,
) -> tuple[str, str]:
    """Return ``(friendly_name, device_type)`` for one device."""
    dtype = guess_type(
        hostname=hostname, vendor=vendor, is_wireless=is_wireless, gateway=gateway
    )
    name = friendly_name(
        hostname=hostname, vendor=vendor, ip=ip, mac=mac, device_type=dtype
    )
    return name, dtype