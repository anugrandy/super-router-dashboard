"""WAN status parsing and outage-transition logic.

The live values here were read from a F670L on 2026-10-04; the fixtures keep
the suite honest about field names without needing the router to be up.

Run: .venv/Scripts/python.exe backend/test_wan.py
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import wan_monitor, wan_status  # noqa: E402

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


def inst(**kv) -> str:
    body = "".join(f"<ParaName>{k}</ParaName><ParaValue>{v}</ParaValue>" for k, v in kv.items())
    return f"<Instance>{body}</Instance>"


# Verbatim shape the router returned: TR069 (management), INTERNET (PPPoE),
# IPTV (bridge). Note TR069 has a 10.x address but must never be picked.
PAYLOAD = (
    "<Table>"
    + inst(
        WANCName="TR069", ConnStatus="Connected", UpTime="153264", Enable="1",
        mode="route", IPAddress="10.16.16.137", TransType="IP", IsDefGW="0",
        wantype="dhcp/static", DNS1="10.0.0.164", DNS2="0.0.0.0",
        SubnetMask="255.255.255.0", GateWay="10.16.16.1", MTU="1500",
        VLANID="100", ConnError="ERROR_NONE", IpMode="IPv4",
    )
    + inst(
        WANCName="INTERNET", ConnStatus="Connected", ConnStatus6="Connected",
        UpTime="153257", UpTimeV6="153258", Enable="1", mode="route",
        IPAddress="10.27.5.55", TransType="PPPoE", wantype="pppoe", IsDefGW="1",
        IsNAT="1", SubnetMask="255.255.255.255", GateWay="10.27.0.1",
        Gateway6="fe80::2621:24ff:fe95:e23f",
        DNS1="118.98.115.69", DNS2="180.250.245.134", DNS3="0.0.0.0",
        Dns1v6="2001:4489:102:102::2", Dns2v6="::", Dns3v6="::",
        AuthType="PAP,CHAP,MS-CHAP", UserName="s3cr3t-user",
        VLANID="200", MTU="1492", ConnError="ERROR_NONE",
        Pd="2001:448a:1020:b7b::", IPv6AcquireMode="Auto", IpMode="Both",
    )
    + inst(
        WANCName="IPTV", Enable="1", mode="bridge", VLANID="111",
        wantype="bridge",
    )
    + "</Table>"
)


print("--- parsing the live payload ---")
w = wan_status._parse(PAYLOAD)
check("picks INTERNET, not TR069", w.connection_name, "INTERNET")
check("connection type", w.connection_type, "PPPoE")
check("ipv4 status", w.ipv4_status, "connected")
check("ipv4 address", w.ipv4_address, "10.27.5.55")
check("gateway", w.gateway, "10.27.0.1")
check("connected()", w.connected, True)
check("online seconds", w.online_seconds, 153257)
check("dns filtered, 0.0.0.0 dropped", w.dns, ["118.98.115.69", "180.250.245.134"])
check("ipv6 status", w.ipv6_status, "connected")
check("ipv6 address (prefix delegation)", w.ipv6_address, "2001:448a:1020:b7b::")
check("ipv6 dns filtered", w.ipv6_dns, ["2001:4489:102:102::2"])
check("no error means no disconnect reason", w.disconnect_reason, "")
check("is_nat", w.is_nat, True)
check("all three connections reported", len(w.connections), 3)

print("\n--- the PPPoE username must never escape the backend ---")
blob = repr(w.to_dict())
check("username absent from api payload", "s3cr3t-user" not in blob, True)
check("username field not exposed", "username" not in w.to_dict(), True)

print("\n--- a real outage ---")
DOWN = (
    "<Table>"
    + inst(
        WANCName="INTERNET", ConnStatus="Disconnected", ConnStatus6="Disconnected",
        UpTime="0", UpTimeV6="0", Enable="1", mode="route", IPAddress="0.0.0.0",
        TransType="PPPoE", wantype="pppoe", IsDefGW="1", IsNAT="1",
        ConnError="ERROR_PPPOE_NON_PAP_AUTH_PWD_CHK_FAILED",
        DNS1="0.0.0.0", DNS2="0.0.0.0", DNS3="0.0.0.0",
        Dns1v6="::", Dns2v6="::", Dns3v6="::", Gateway6="", Pd="",
    )
    + "</Table>"
)
d = wan_status._parse(DOWN)
check("down status", d.ipv4_status, "disconnected")
check("connected() is False", d.connected, False)
check("ISP reason surfaced", d.disconnect_reason, "ERROR_PPPOE_NON_PAP_AUTH_PWD_CHK_FAILED")
check("uptime reset to zero", d.online_seconds, 0)
check("no stale dns", d.dns, [])
check("ipv6 also down", d.ipv6_status, "disconnected")

print("\n--- duration formatting (Indonesian, with spaces) ---")
check("1 day", wan_status.format_duration(86400 + 14 * 3600 + 3 * 60), "1h 14j 3m")
check("hours only", wan_status.format_duration(3600 * 3 + 61), "3j 1m")
check("minutes only", wan_status.format_duration(119), "1m")
check("zero", wan_status.format_duration(0), "-")
check("negative", wan_status.format_duration(-5), "-")

print("\n--- only a routed, enabled connection counts as the uplink ---")
no_route = "<Table>" + inst(
    WANCName="TR069", ConnStatus="Connected", Enable="1", mode="route",
    IPAddress="10.16.16.137", TransType="IP",
) + "</Table>"
check("management-only uplink is not picked", wan_status._parse(no_route).error != "", True)

disabled = "<Table>" + inst(
    WANCName="INTERNET", ConnStatus="Connected", Enable="0", mode="route",
    IPAddress="10.27.5.55", TransType="PPPoE",
) + "</Table>"
check("disabled uplink is not picked", wan_status._parse(disabled).error != "", True)

print("\n--- a DOWN named WAN is still selected (that is the whole point) ---")
# ConnStatus disconnected, no lease: the connection must still be reported,
# otherwise an outage would be invisible.
check("down named wan is picked", d.connection_name, "INTERNET")
check("and reported as disconnected", d.ipv4_status, "disconnected")

print("\n--- a renamed WAN still resolves ---")
renamed = PAYLOAD.replace(
    "<ParaName>WANCName</ParaName><ParaValue>INTERNET</ParaValue>",
    "<ParaName>WANCName</ParaName><ParaValue>InteNet_Utama</ParaValue>",
)
r = wan_status._parse(renamed)
check("falls back to the routed default gateway", r.connection_name, "InteNet_Utama")
check("still parsed as connected", r.ipv4_status, "connected")

print("\n--- transition detection ---")


class FakeWan:
    def __init__(self, status):
        self.available = True
        self.ipv4_status = status
        self.ipv4_address = "10.27.5.55"
        self.connection_name = "INTERNET"
        self.disconnect_reason = "" if status == "connected" else "ERROR_TIMEOUT"
        self.online_seconds = 100

    def to_dict(self):
        d = {
            "ipv4_status": self.ipv4_status,
            "connected": self.ipv4_status == "connected",
        }
        return d


recorded: list[str] = []
broadcasts: list[dict] = []


def run_polls(statuses):
    recorded.clear()
    broadcasts.clear()
    with (
        patch.object(wan_monitor, "_record", side_effect=lambda k, w: recorded.append(k)),
        patch.object(wan_monitor.hub, "broadcast"),
    ):
        for s in statuses:
            with patch.object(wan_status, "get", return_value=FakeWan(s)):
                wan_monitor.poll_once()


wan_monitor.reset()
run_polls(["connected", "connected", "connected"])
check("steady link records one baseline", recorded, ["connected"])
check("steady link raises no toast", broadcasts, [])

wan_monitor.reset()
run_polls(["connected", "disconnected", "connected"])
check("outage and recovery both recorded", recorded, ["connected", "disconnected", "connected"])

wan_monitor.reset()
run_polls(["connected", "disconnected", "disconnected"])
check("repeating 'still down' is not a new event", recorded, ["connected", "disconnected"])

wan_monitor.reset()
run_polls(["connected", "disconnected", "connected", "disconnected"])
check(
    "a flapping link records every flip",
    recorded,
    ["connected", "disconnected", "connected", "disconnected"],
)

print("\n--- router unreachable is not reported as an outage ---")


class DeadWan:
    available = False
    ipv4_status = "unknown"
    disconnect_reason = ""
    online_seconds = 0

    def to_dict(self):
        return {"available": False, "ipv4_status": "unknown"}


with patch.object(wan_monitor, "_record", side_effect=lambda k, w: recorded.append(k)):
    wan_monitor.reset()
    recorded.clear()
    with patch.object(wan_status, "get", return_value=DeadWan()):
        wan_monitor.poll_once()
    check("unreachable router records nothing", recorded, [])

print(f"\nPASS={PASS} FAIL={FAIL}")
for f in FAILURES:
    print("  " + f)
sys.exit(1 if FAIL else 0)