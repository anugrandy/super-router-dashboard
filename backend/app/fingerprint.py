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

# ---------------------------------------------------------------- OS guessing
#
# Passive OS detection is evidence-based, never certain. TTL separates broad
# families (Windows 128, Unix-like 64, network gear 255), while a hostname can
# name the platform. Confidence is reported separately so the UI can say
# "perkiraan" instead of pretending the guess is a fact.

OS_WINDOWS = "Windows"
OS_LINUX = "Linux"
OS_ANDROID = "Android"
OS_MACOS = "macOS"
OS_IOS = "iOS"
OS_TVOS = "tvOS"
OS_ANDROID_TV = "Android TV"
OS_TIZEN = "Tizen"
OS_WEBOS = "webOS"
OS_UNIX = "Linux/Unix"
OS_NETWORK = "Router/Network"
OS_UNKNOWN = ""

CONF_HIGH = "high"
CONF_MEDIUM = "medium"
CONF_LOW = "low"

_ANDROID_HOST_HINTS = (
    "android", "galaxy", "redmi", "xiaomi", "poco", "oppo", "realme", "vivo",
    "tecno", "itel", "infinix", "oneplus", "pixel", "sm-", "moto g", "moto e",
    "zenfone", "xperia", "hmd", "nokia",
)

_LINUX_HOST_HINTS = (
    "linux", "ubuntu", "debian", "fedora", "centos", "kali", "manjaro",
    "archlinux", "opensuse", "raspbian", "raspberry", "alpine", "rocky",
    "almalinux", "endeavouros", "pop-os", "popos", "mint",
)


def ttl_family(ttl: int | None) -> str:
    """Coarse OS family from an observed TTL (initial TTL minus hops)."""
    if ttl is None:
        return ""
    if ttl >= 250:
        return OS_NETWORK
    if 100 <= ttl <= 140:
        return OS_WINDOWS
    if 32 <= ttl <= 80:
        return OS_UNIX
    return ""


def _os_compatible(os_name: str, ttl_os: str) -> bool:
    if not os_name or not ttl_os:
        return False
    if os_name == OS_WINDOWS:
        return ttl_os == OS_WINDOWS
    if os_name == OS_NETWORK:
        return ttl_os == OS_NETWORK
    return ttl_os == OS_UNIX


def _vendor_os(vendor: str, device_type: str) -> tuple[str, str]:
    """OS implied by the OUI vendor alone, with a deliberately weak label."""
    ven = (vendor or "").lower()
    if not ven:
        return "", ""
    if ven.startswith("apple"):
        if device_type == T_PHONE:
            return OS_IOS, "vendor Apple + tipe HP"
        if device_type == T_TV:
            return OS_TVOS, "vendor Apple + tipe TV"
        if device_type in (T_LAPTOP, T_DESKTOP):
            return OS_MACOS, "vendor Apple + tipe komputer"
        return "", ""
    if "microsoft" in ven:
        return OS_WINDOWS, "vendor Microsoft"
    if "raspberry pi" in ven or "raspberrypi" in ven:
        return OS_LINUX, "vendor Raspberry Pi"
    if device_type == T_TV:
        if "samsung" in ven:
            return OS_TIZEN, "vendor Samsung + tipe TV"
        if ven.startswith("lg") or "lg electronics" in ven:
            return OS_WEBOS, "vendor LG + tipe TV"
        if any(v in ven for v in ("sony", "tcl", "hisense", "philips", "sharp")):
            return OS_ANDROID_TV, "vendor TV (sering Android TV)"
    return "", ""


def guess_os(
    hostname: str = "",
    vendor: str = "",
    ttl: int | None = None,
    device_type: str = "",
) -> tuple[str, str, str]:
    """Return ``(os, confidence, evidence)`` for one device.

    Confidence is one of ``high``/``medium``/``low`` or empty when there is no
    usable signal. A bare TTL is only ever ``low``: 64 says "Unix-like", not
    which of Linux/Android/macOS/iOS it is.
    """
    host = (hostname or "").strip().lower()
    host_os = ""
    host_conf = ""
    host_ev = ""

    # Strong Apple hostnames.
    if _has(host, ("iphone", "ipod")):
        host_os, host_conf, host_ev = OS_IOS, CONF_HIGH, "hostname iPhone/iPod"
    elif "ipad" in host:
        host_os, host_conf, host_ev = OS_IOS, CONF_HIGH, "hostname iPad"
    elif _has(host, ("apple tv", "appletv", "apple-tv")):
        host_os, host_conf, host_ev = OS_TVOS, CONF_HIGH, "hostname Apple TV"
    elif _has(host, ("macbook", "imac", "mac mini", "macmini", "powerbook")):
        host_os, host_conf, host_ev = OS_MACOS, CONF_HIGH, "hostname Mac"

    # Windows default names: DESKTOP-XXXXXXX, LAPTOP-XXXXXXX, WIN-XXXXXXXX.
    if not host_os and re.search(r"(^|[-_.])(desktop|laptop|win)-[a-z0-9]{4,}", host):
        host_os, host_conf, host_ev = OS_WINDOWS, CONF_HIGH, "hostname pola Windows"

    # TV platforms.
    if not host_os:
        if _has(host, ("androidtv", "android-tv", "googletv", "google-tv",
                       "chromecast", "bravia")):
            host_os, host_conf, host_ev = OS_ANDROID_TV, CONF_HIGH, "hostname Android TV"
        elif "webos" in host:
            host_os, host_conf, host_ev = OS_WEBOS, CONF_HIGH, "hostname webOS"
        elif "tizen" in host:
            host_os, host_conf, host_ev = OS_TIZEN, CONF_HIGH, "hostname Tizen"

    # Linux distro / server names.
    if not host_os and _has(host, _LINUX_HOST_HINTS):
        host_os, host_conf, host_ev = OS_LINUX, CONF_HIGH, "hostname distro Linux"

    # Android makers. Checked after Apple/TV so "Samsung TV" is not a phone.
    if not host_os and host and _has(host, _ANDROID_HOST_HINTS):
        host_os, host_conf, host_ev = OS_ANDROID, CONF_MEDIUM, "hostname brand Android"
    if not host_os and re.search(r"\bsm-[a-z]\d{2,4}\w*\b", host):
        host_os, host_conf, host_ev = OS_ANDROID, CONF_MEDIUM, "hostname model Samsung"

    # macOS shows up as "<Name>-MacBook.local" or a hostname containing "mac".
    if not host_os and re.search(r"\bmac\w*-", host):
        host_os, host_conf, host_ev = OS_MACOS, CONF_MEDIUM, "hostname pola macOS"

    ttl_os = ttl_family(ttl)
    vendor_os, vendor_ev = _vendor_os(vendor, device_type)

    if host_os:
        if ttl_os and _os_compatible(host_os, ttl_os):
            return host_os, CONF_HIGH, f"{host_ev}; TTL {ttl} konsisten"
        if ttl_os:
            return host_os, CONF_MEDIUM, f"{host_ev}; TTL {ttl} tidak cocok"
        return host_os, host_conf, host_ev

    if vendor_os:
        if ttl_os and _os_compatible(vendor_os, ttl_os):
            return vendor_os, CONF_MEDIUM, f"{vendor_ev}; TTL {ttl} konsisten"
        return vendor_os, CONF_LOW, vendor_ev

    # A gateway is network equipment by definition; its firmware may be Linux
    # based, but reporting "Linux" from TTL 64 alone would be a false claim.
    if device_type == T_ROUTER:
        return OS_NETWORK, CONF_LOW, "tipe router/gateway"

    if ttl_os:
        return ttl_os, CONF_LOW, f"TTL {ttl} saja"

    return OS_UNKNOWN, "", ""


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

# Unambiguous TV/streaming hostnames. A bare "tv" is matched as a word so
# "steve-pc" or "network" does not become a television.
_TV_HOST_RE = re.compile(
    r"(^|[-_.])(tv|smarttv|androidtv|googletv|appletv|firetv|roku)([-_.]|$)"
    r"|bravia|webos|tizen|chromecast|fire ?stick|shield tv|living ?room"
)

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
        # Smart TV / streaming boxes. Checked before phone brands because
        # "Samsung-TV" and "Xiaomi-TV" contain a phone maker's name.
        if _TV_HOST_RE.search(host):
            return T_TV
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

    # 5. TV / streaming: only vendors that are unambiguous television brands.
    #     Samsung/LG/Sony/Xiaomi/Huawei/Toshiba also make phones and PCs, so
    #     their OUI alone must not label a device as a TV; their hostnames are
    #     handled by the TV hints above.
    if ven and _has(ven, ("tcl", "hisense", "vizio", "roku", "philips")):
        return T_TV

    # 6. Phone brands (hostname carries the brand on Android; Apple is done).
    if host:
        if _has(host, _PHONE_BRANDS):
            return T_PHONE
        if any(re.search(p, host) for p in _PHONE_MODEL_PATTERNS):
            return T_PHONE

    # 7. Generic PC/Laptop indicators. Windows default names are explicit:
    #    DESKTOP-XXXX is a desktop, LAPTOP-XXXX is a laptop.
    if host:
        if re.search(r"(^|[-_.])desktop-", host):
            return T_DESKTOP
        if re.search(r"(^|[-_.])laptop-", host):
            return T_LAPTOP
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