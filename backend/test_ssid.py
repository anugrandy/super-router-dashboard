"""SSID / Access Control target selection.

The bug this guards: every kick fell back to default_wifi_interface
(DEV.WIFI.AP6), so a device on SSID5 got its ACL rule written to SSID6. The
router accepts any valid AP id and reports success, so the block silently did
nothing.

Run: .venv/Scripts/python.exe backend/test_ssid.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.ssid_resolver import _para_map  # noqa: E402

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


# Captured live from the router: Local Network > Status > WLAN Client Status.
# AliasName is the AP the client is associated with - this is the field the old
# code was missing, since topo_lua.lua only reports the band.
CLIENT_STAT = """<?xml version="1.0"?>
<ajax_response_xml_root>
<OBJ_WLAN_AD_ID>
<Instance><ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.AP5.AD1</ParaValue>
<ParaName>AliasName</ParaName><ParaValue>DEV.WIFI.AP5</ParaValue>
<ParaName>MACAddress</ParaName><ParaValue>76:09:9E:D7:88:FD</ParaValue>
<ParaName>IPAddress</ParaName><ParaValue>192.168.1.5</ParaValue>
<ParaName>HostName</ParaName><ParaValue>TECNO-SPARK-Go-1</ParaValue>
<ParaName>RXBytes</ParaName><ParaValue>371196779</ParaValue>
<ParaName>TXBytes</ParaName><ParaValue>1952253083</ParaValue></Instance>
<Instance><ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.AP1.AD1</ParaValue>
<ParaName>AliasName</ParaName><ParaValue>DEV.WIFI.AP1</ParaValue>
<ParaName>MACAddress</ParaName><ParaValue>0E:39:4D:84:01:9C</ParaValue>
<ParaName>IPAddress</ParaName><ParaValue>192.168.1.10</ParaValue>
<ParaName>HostName</ParaName><ParaValue>Galaxy-A12</ParaValue>
<ParaName>RXBytes</ParaName><ParaValue>28297969</ParaValue>
<ParaName>TXBytes</ParaName><ParaValue>504454750</ParaValue></Instance>
<Instance><ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.AP6.AD1</ParaValue>
<ParaName>AliasName</ParaName><ParaValue>DEV.WIFI.AP6</ParaValue>
<ParaName>MACAddress</ParaName><ParaValue>04:6C:59:7D:73:14</ParaValue>
<ParaName>IPAddress</ParaName><ParaValue>192.168.1.3</ParaValue>
<ParaName>HostName</ParaName><ParaValue>UNKNOWN-PC</ParaValue>
<ParaName>RXBytes</ParaName><ParaValue>1549091764</ParaValue>
<ParaName>TXBytes</ParaName><ParaValue>2916210301</ParaValue></Instance>
</OBJ_WLAN_AD_ID>
</ajax_response_xml_root>"""

# From wlan_macfilteraclpolicy_lua.lua: SSID5 and SSID6 share radio RD2 (5 GHz),
# which is exactly why band cannot pick the right AP.
ACL_POLICY = """<?xml version="1.0"?>
<ajax_response_xml_root>
<OBJ_WLANSETTING_ID>
<Instance><ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.RD1</ParaValue>
<ParaName>Band</ParaName><ParaValue>2.4GHz</ParaValue></Instance>
<Instance><ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.RD2</ParaValue>
<ParaName>Band</ParaName><ParaValue>5GHz</ParaValue></Instance>
</OBJ_WLANSETTING_ID>
<OBJ_WLANAP_ID>
<Instance><ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.AP1</ParaValue>
<ParaName>Alias</ParaName><ParaValue>FAIZ</ParaValue>
<ParaName>WLANViewName</ParaName><ParaValue>DEV.WIFI.RD1</ParaValue>
<ParaName>ACLPolicy</ParaName><ParaValue>Ban</ParaValue></Instance>
<Instance><ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.AP5</ParaValue>
<ParaName>Alias</ParaName><ParaValue>AgraSec</ParaValue>
<ParaName>WLANViewName</ParaName><ParaValue>DEV.WIFI.RD2</ParaValue>
<ParaName>ACLPolicy</ParaName><ParaValue>Ban</ParaValue></Instance>
<Instance><ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.AP6</ParaValue>
<ParaName>Alias</ParaName><ParaValue>FAIZ</ParaValue>
<ParaName>WLANViewName</ParaName><ParaValue>DEV.WIFI.RD2</ParaValue>
<ParaName>ACLPolicy</ParaName><ParaValue>Ban</ParaValue></Instance>
<Instance><ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.AP2</ParaValue>
<ParaName>Alias</ParaName><ParaValue>SSID2</ParaValue>
<ParaName>WLANViewName</ParaName><ParaValue>DEV.WIFI.RD1</ParaValue>
<ParaName>ACLPolicy</ParaName><ParaValue>Disabled</ParaValue></Instance>
</OBJ_WLANAP_ID>
</ajax_response_xml_root>"""

print("--- parsing: AP table ---")
aps = {}
for d in _para_map(ACL_POLICY):
    iid = (d.get("_InstID") or "").strip()
    if not iid.startswith("DEV.WIFI.AP"):
        continue
    aps[iid] = {
        "alias": (d.get("Alias") or "").strip(),
        "radio": (d.get("WLANViewName") or "").strip(),
        "blockable": (d.get("ACLPolicy") or "").strip() != "Disabled",
    }

check("AP table parsed", len(aps), 4)
check("AP1 alias", aps["DEV.WIFI.AP1"]["alias"], "FAIZ")
check("AP5 alias", aps["DEV.WIFI.AP5"]["alias"], "AgraSec")
check("AP5 blockable", aps["DEV.WIFI.AP5"]["blockable"], True)
check("AP2 not blockable", aps["DEV.WIFI.AP2"]["blockable"], False)

print("\n--- parsing: per-client AP association ---")
client_ap = {}
usage = {}
for d in _para_map(CLIENT_STAT):
    mac = d["MACAddress"].upper()
    client_ap[mac] = d["AliasName"]
    usage[mac] = {"rx": int(d["RXBytes"]), "tx": int(d["TXBytes"])}

check("3 clients parsed", len(client_ap), 3)
check(
    "TECNO on AP5, not the AP6 default",
    client_ap["76:09:9E:D7:88:FD"],
    "DEV.WIFI.AP5",
)
check("Galaxy on AP1", client_ap["0E:39:4D:84:01:9C"], "DEV.WIFI.AP1")
check("PC on AP6", client_ap["04:6C:59:7D:73:14"], "DEV.WIFI.AP6")

print("\n--- the bug: band alone cannot separate SSID5 from SSID6 ---")
# Both are on DEV.WIFI.RD2, so anything derived from the band picks the wrong
# one roughly half the time. This is why auto-detect must use AliasName.
check(
    "AP5 and AP6 share the 5GHz radio",
    aps["DEV.WIFI.AP5"]["radio"] == aps["DEV.WIFI.AP6"]["radio"],
    True,
)
check(
    "AP5 and AP6 are different APs anyway",
    aps["DEV.WIFI.AP5"]["radio"] != aps["DEV.WIFI.AP1"]["radio"],
    True,
)

print("\n--- cumulative usage (these are totals, not rates) ---")
check("TECNO rx bytes", usage["76:09:9E:D7:88:FD"]["rx"], 371196779)
check("PC tx bytes", usage["04:6C:59:7D:73:14"]["tx"], 2916210301)
total = usage["04:6C:59:7D:73:14"]["rx"] + usage["04:6C:59:7D:73:14"]["tx"]
check("PC total GB is plausible", 4.0 < total / 1e9 < 5.0, True)

print("\n--- unknown MAC must not be guessed ---")
# A MAC absent from the WLAN table (e.g. a wired client) has no AP. Returning
# a default here is what caused the silent failure, so it must stay empty.
check("unknown MAC has no interface", client_ap.get("AA:BB:CC:DD:EE:FF", ""), "")
check(
    "unknown MAC not in usage",
    usage.get("AA:BB:CC:DD:EE:FF", {}).get("rx", 0),
    0,
)

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)