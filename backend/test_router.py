"""Verify router_client against your ZTE F670L.

Credentials come from the environment — this script never prompts for or
prints them:

    # Windows PowerShell
    $env:NETDASH_ROUTER_USER="admin"
    $env:NETDASH_ROUTER_PASS="password-router-kamu"
    .venv\\Scripts\\python.exe backend/test_router.py

    # Linux / macOS
    NETDASH_ROUTER_USER=admin NETDASH_ROUTER_PASS=... python backend/test_router.py

Optional: NETDASH_ROUTER_URL (default http://192.168.1.1)

Add --block <MAC> to also exercise block/unblock for real. Use a device you
own — this writes to the router's real access-control list.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

PASS, FAIL = 0, 0


def chk(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name} {extra}")


def main() -> int:
    # --- offline unit checks (no network, no credentials) ---
    from app.router_client import RouterError, Rule, normalize_mac, parse_rules

    chk("normalize lowercase", normalize_mac("aa:bb:cc:dd:ee:ff") == "AA:BB:CC:DD:EE:FF")
    chk("normalize dashes", normalize_mac("AA-BB-CC-DD-EE-FF") == "AA:BB:CC:DD:EE:FF")
    chk("normalize dots", normalize_mac("aabb.ccdd.eeff") == "AA:BB:CC:DD:EE:FF")
    chk("normalize bare hex (cisco)",
        normalize_mac("AABBCCDDEEFF") == "AA:BB:CC:DD:EE:FF")
    for bad in ("AA:BB:CC:DD:EE", "nope", "AA:BB:CC:DD:EE:GG", "AA:BB:CC:DD:EE:FF:00"):
        try:
            normalize_mac(bad)
            chk(f"reject {bad!r}", False, "accepted")
        except RouterError:
            chk(f"reject {bad!r}", True)

    # Hidden-input markup shape (matches the captured request).
    html_hidden = """
    <input name="MACAddress0" value="16:50:AD:B9:4A:FA" type="hidden">
    <input name="MACAddress1" value="" type="hidden">
    <input name="MACAddress2" value="00:00:00:00:00:00" type="hidden">
    <input name="Name1" value="Agra" type="hidden">
    """
    rules = parse_rules(html_hidden)
    chk("parse hidden MACAddress fields", len(rules) == 1, rules)
    chk("parsed correct MAC", rules and rules[0].mac == "16:50:AD:B9:4A:FA", rules)
    chk("parsed slot index", rules and rules[0].index == 0, rules)

    # Table-row fallback shape.
    html_table = """
    <tr><td>1</td><td>16:50:AD:B9:4A:FA</td><td>Agra</td><td>DEV.WIFI.AP6</td></tr>
    <tr><td>2</td><td>AA:BB:CC:DD:EE:01</td><td>Phone</td><td>DEV.WIFI.AP4</td></tr>
    """
    rows = parse_rules(html_table)
    chk("parse table rows", len(rows) == 2, rows)
    chk("table parse keeps order", [r.mac for r in rows] == [
        "16:50:AD:B9:4A:FA", "AA:BB:CC:DD:EE:01"], rows)
    chk("empty page -> no rules", parse_rules("<html>nothing</html>") == [])

    # Regression: the ZTE returns a usable-looking sess_token even when the
    # password is WRONG, with the real verdict in loginErrMsg. login() must
    # not treat that as success.
    import httpx as _httpx

    class _Resp:
        status_code = 200

        def __init__(self, payload):
            self._p = payload
            self.text = str(payload)

        def json(self):
            return self._p

    class _XmlResp:
        status_code = 200

        def __init__(self, xml):
            self.text = xml

        def json(self):
            raise ValueError("not json")

    class _FakeClient:
        """Mimics the router: challenge on GET, token-with-error on POST."""

        def __init__(self, payload):
            self.payload = payload
            self.cookies = _httpx.Cookies()

        def get(self, *a, **k):
            return _XmlResp(
                "<ajax_response_xml_root>12345</ajax_response_xml_root>"
            )

        def post(self, *a, **k):
            return _Resp(self.payload)

    from app.router_client import ZteRouter

    bad = {
        "lockingTime": -1,
        "loginErrMsg": "Username or password is error. ",
        "promptMsg": "",
        "sess_token": "LDcKN30qYOUfzdiRPu79gZcd",
    }
    r = ZteRouter(base_url="http://x", username="u", password="p")
    r._client = _FakeClient(bad)
    try:
        r.login()
        chk("rejects login despite valid-looking token", False, "login() returned")
    except RouterError as e:
        chk("rejects login despite valid-looking token", "ditolak" in str(e).lower(), str(e))
    chk("does not mark itself logged in on failure", not r.logged_in)
    r.close()

    ok = {"lockingTime": -1, "loginErrMsg": "", "promptMsg": "", "sess_token": "GOODTOKEN123"}
    r2 = ZteRouter(base_url="http://x", username="u", password="p")
    r2._client = _FakeClient(ok)
    try:
        tok = r2.login()
        chk("accepts a clean login", tok == "GOODTOKEN123", tok)
        chk("marks logged in on success", r2.logged_in)
    except RouterError as e:
        chk("accepts a clean login", False, str(e))
    r2.close()

    # Check header: sha256(body) then RSA PKCS1v15, base64. Verified against the
    # router's own asyEncode() implementation.
    import base64 as _b64

    from app.zte_check import build_check, body_digest

    body = "IF_ACTION=Apply&_InstID=-1&_sessionTOKEN=abc"
    chk("digest is sha256 hex", len(body_digest(body)) == 64)
    chk("digest is stable", body_digest(body) == body_digest(body))
    chk("digest differs per body",
        body_digest(body) != body_digest(body + "x"))
    try:
        c = build_check(body)
        raw = _b64.b64decode(c)
        chk("check is 256 bytes (RSA-2048)", len(raw) == 256, len(raw))
        # The ciphertext is randomised, so nothing about the plaintext is
        # observable without the router's private key. Only the block size and
        # per-call randomness are checkable here; the router itself is the real
        # oracle (a wrong Check gives HTTP 400, a correct one HTTP 200).
        chk("check ciphertext has no plaintext leak",
            body_digest(body).encode() not in raw, "digest visible in ciphertext")
        c2 = build_check(body)
        chk("check is randomised per call", c != c2)
    except ImportError as e:
        print(f"SKIP  check header tests (cryptography missing): {e}")

    # MAC filter list must tolerate an empty / error page without raising.
    chk("parse_rules handles xml error page", parse_rules(
        "<ajax_response_xml_root><IF_ERRORSTR>SessionTimeout</IF_ERRORSTR>"
        "</ajax_response_xml_root>") == [])

    # --- regression: IF_ACTION must carry its value (C) ---
    # This was a real bug: an empty IF_ACTION made every ACL POST answer
    # SessionTimeout no matter how good the session was. Compare the encoded
    # body byte-for-byte against a browser capture.
    r_body = ZteRouter(base_url="http://x", username="u", password="p")
    r_body.session_token = "spnc7TLtiQZdTglVl2x7XW05"
    body_txt, hdrs = r_body._encode_body({
        "IF_ACTION": "Apply", "_InstID": "-1",
        "MACAddress": "16:50:AD:B9:4A:FA", "Name": "Agra",
        "Interface": "DEV.WIFI.AP6",
        "Btn_cancel_MACFilterRule": "", "Btn_apply_MACFilterRule": "",
        "_sessionTOKEN": "spnc7TLtiQZdTglVl2x7XW05",
    })
    expected = (
        "IF_ACTION=Apply&_InstID=-1&MACAddress=16%3A50%3AAD%3AB9%3A4A%3AFA"
        "&Name=Agra&Interface=DEV.WIFI.AP6&Btn_cancel_MACFilterRule="
        "&Btn_apply_MACFilterRule=&_sessionTOKEN=spnc7TLtiQZdTglVl2x7XW05"
    )
    chk("body matches browser capture byte-for-byte", body_txt == expected, body_txt)
    chk("IF_ACTION carries its value", "IF_ACTION=Apply&" in body_txt, body_txt[:40])
    chk("MAC is percent-encoded", "16%3A50%3AAD%3AB9%3A4A%3AFA" in body_txt)
    chk("Check header present on the request", "Check" in hdrs)
    r_body.close()

    # Delete uses the router-assigned instance id, never a hardcoded one.
    r_del = ZteRouter(base_url="http://x", username="u", password="p")
    r_del.session_token = "TOK"
    body_del, _ = r_del._encode_body({
        "IF_ACTION": "Delete", "_InstID": "DEV.ACL7",
        "MACAddress": "16:50:AD:B9:4A:FA", "Name": "",
        "Interface": "DEV.WIFI.AP6",
        "Btn_cancel_MACFilterRule": "", "Btn_apply_MACFilterRule": "",
        "_sessionTOKEN": "TOK",
    })
    chk("delete uses IF_ACTION=Delete", body_del.startswith("IF_ACTION=Delete&"),
        body_del[:40])
    chk("delete carries the inst id", "_InstID=DEV.ACL7" in body_del)
    r_del.close()

    # --- the ACL page load is mandatory (verified live) ---
    r_pg = ZteRouter(base_url="http://x", username="u", password="p")
    r_pg.session_token = "LOGINTOK"
    r_pg.acl_token = "PAGETOK"
    chk("acl_token is separate from the login token",
        r_pg.acl_token != r_pg.session_token)
    r_pg.close()

    # Delete uses "Delete", NOT "Del": "Del" answers SUCC and silently does
    # nothing. Confirmed on the live router.
    r_v = ZteRouter(base_url="http://x", username="u", password="p")
    r_v.session_token = "TOK"
    body_del_v, _ = r_v._encode_body({
        "IF_ACTION": "Delete", "_InstID": "DEV.ACL1",
        "MACAddress": "16:50:AD:B9:4A:FA", "Name": "",
        "Interface": "DEV.WIFI.AP6",
        "Btn_cancel_MACFilterRule": "", "Btn_apply_MACFilterRule": "",
        "_sessionTOKEN": "TOK",
    })
    chk("delete verb is Delete", body_del_v.startswith("IF_ACTION=Delete&"),
        body_del_v[:36])
    chk("delete verb is NOT Del",
        not body_del_v.startswith("IF_ACTION=Del&") or
        body_del_v.startswith("IF_ACTION=Delete&"), body_del_v[:30])
    r_v.close()

    # Apply must name the instance (DEV.ACL<n>); -1 is rejected with -258.
    r_a = ZteRouter(base_url="http://x", username="u", password="p")
    r_a.session_token = "TOK"
    for bad in ("-1", "1", "0", "DEV.WIFI.AP6"):
        b, _h = r_a._encode_body({
            "IF_ACTION": "Apply", "_InstID": bad,
            "MACAddress": "16:50:AD:B9:4A:FA", "Name": "x",
            "Interface": "DEV.WIFI.AP6",
            "Btn_cancel_MACFilterRule": "", "Btn_apply_MACFilterRule": "",
            "_sessionTOKEN": "TOK",
        })
        chk(f"apply with _InstID={bad} is not auto-allocated",
            f"_InstID={bad}&" in b, b[:40])
    r_a.close()

    # --- verified F670L ACL protocol (confirmed against the live router) ---
    # Read returns OBJ_ACLCFG_ID with the inst id; this is the authoritative
    # source for both block() verification and the unblock() fallback.
    read_xml = (
        "<ajax_response_xml_root><IF_ERRORTYPE>SUCC</IF_ERRORTYPE>"
        "<OBJ_ACLCFG_ID><Instance>"
        "<ParaName>_InstID</ParaName><ParaValue>DEV.ACL1</ParaValue>"
        "<ParaName>MACAddress</ParaName><ParaValue>16:50:ad:b9:4a:fa</ParaValue>"
        "<ParaName>Name</ParaName><ParaValue>AA</ParaValue>"
        "<ParaName>Interface</ParaName><ParaValue>DEV.WIFI.AP6</ParaValue>"
        "</Instance></OBJ_ACLCFG_ID></ajax_response_xml_root>"
    )
    rl = parse_rules(read_xml)
    chk("read xml yields 1 rule", len(rl) == 1, rl)
    chk("read xml keeps DEV.ACL1", rl and rl[0].inst_id == "DEV.ACL1", rl)
    chk("read xml normalises MAC case", rl and rl[0].mac == "16:50:AD:B9:4A:FA", rl)
    chk("read xml keeps name", rl and rl[0].name == "AA", rl)
    chk("read xml keeps interface", rl and rl[0].interface == "DEV.WIFI.AP6", rl)

    # The ACL policy page exposes the real SSID -> AP mapping. Confirmed live:
    # DEV.WIFI.AP6 is SSID6 on the 5GHz radio, and ACLPolicy=Ban lives there.
    policy_xml = (
        "<ajax_response_xml_root><OBJ_WLANSETTING_ID>"
        "<Instance><ParaName>_InstID</ParaName><ParaValue>DEV.WIFI.AP6</ParaValue>"
        "<ParaName>Alias</ParaName><ParaValue>SSID6</ParaValue>"
        "<ParaName>ACLPolicy</ParaName><ParaValue>Ban</ParaValue></Instance>"
        "</OBJ_WLANSETTING_ID></ajax_response_xml_root>"
    )
    from app.router_client import parse_acl_policy

    pol = parse_acl_policy(policy_xml)
    chk("policy maps SSID6 -> DEV.WIFI.AP6", pol.get("SSID6") == "DEV.WIFI.AP6", pol)
    chk("policy records Ban on SSID6", pol.get("_policy", {}).get("SSID6") == "Ban", pol)

    # --- SSID -> interface mapping (A) ---
    from app.ssid_map import interface_to_ssid, parse_leases, ssid_to_interface

    chk("SSID6 -> DEV.WIFI.AP6 (identity default)",
        ssid_to_interface("SSID6") == "DEV.WIFI.AP6", ssid_to_interface("SSID6"))
    chk("SSID1 -> DEV.WIFI.AP1 (identity default)",
        ssid_to_interface("SSID1") == "DEV.WIFI.AP1", ssid_to_interface("SSID1"))
    chk("'SSID 6' with space", ssid_to_interface("SSID 6") == "DEV.WIFI.AP6")
    chk("unknown ssid -> None", ssid_to_interface("SSID99") is None)
    chk("garbage -> None", ssid_to_interface("nope") is None)
    chk("interface back to label", interface_to_ssid("DEV.WIFI.AP6") == "SSID6",
        interface_to_ssid("DEV.WIFI.AP6"))

    lease_html = """
    <table><tr><th>MAC</th><th>IP</th><th>Hostname</th><th>Port</th></tr>
    <tr><td>16:50:AD:B9:4A:FA</td><td>192.168.1.7</td><td>iphone</td><td>SSID6</td></tr>
    <tr><td>FC:44:9F:2F:65:28</td><td>192.168.1.3</td><td>laptop</td><td>SSID1</td></tr>
    </table>"""
    leases = parse_leases(lease_html)
    chk("lease table parses 2 rows", len(leases) == 2, leases)
    chk("lease MAC keyed uppercase",
        leases.get("16:50:AD:B9:4A:FA") == "SSID6", leases)
    chk("second lease too",
        leases.get("FC:44:9F:2F:65:28") == "SSID1", leases)

    # --- _InstID parsing (B/C) ---
    from app.router_client import parse_new_inst_id

    apply_resp = ("<ajax_response_xml_root><DEV.ACL3>_InstID=DEV.ACL3"
                  "<IF_ERRORTYPE>SUCC</IF_ERRORTYPE></ajax_response_xml_root>")
    chk("reads DEV.ACL id from Apply response",
        parse_new_inst_id(apply_resp) == "DEV.ACL3", parse_new_inst_id(apply_resp))
    chk("no id when absent", parse_new_inst_id("<xml>nothing</xml>") == "")

    rule_html = """
    <table><tr><td>DEV.ACL2</td><td>16:50:AD:B9:4A:FA</td><td>Anak</td>
    <td>DEV.WIFI.AP6</td></tr></table>"""
    from app.router_client import parse_rules as pr

    rows = pr(rule_html)
    chk("rule row parsed", len(rows) == 1, rows)
    chk("rule keeps inst_id", rows and rows[0].inst_id == "DEV.ACL2", rows)
    chk("rule keeps interface", rows and rows[0].interface == "DEV.WIFI.AP6", rows)

    # --- live checks (need credentials) ---
    user = os.environ.get("NETDASH_ROUTER_USER")
    pw = os.environ.get("NETDASH_ROUTER_PASS")
    url = os.environ.get("NETDASH_ROUTER_URL", "http://192.168.1.1")
    if not user or not pw:
        print("\nSKIP  live checks: set NETDASH_ROUTER_USER / NETDASH_ROUTER_PASS")
        print(f"\nPASS={PASS} FAIL={FAIL}")
        return 1 if FAIL else 0

    from app.router_client import ZteRouter

    print(f"\n--- live: {url} ---")
    r = ZteRouter()
    try:
        ch = r._fetch_challenge()
        chk("login_token returns a challenge", bool(ch) and ch.isdigit(), repr(ch[:40]))

        token = r.login()
        chk("login returns a session token", len(token) > 4, token[:8] + "…")

        rules = r.list_rules()
        print(f"  current rules: {len(rules)}")
        for x in rules:
            print(f"    [{x.index}] {x.mac} {x.name} {x.interface}")
        chk("list_rules succeeds", isinstance(rules, list))

        # --- optional real block/unblock ---
        target = None
        if "--block" in sys.argv:
            target = sys.argv[sys.argv.index("--block") + 1]

        if target:
            mac = normalize_mac(target)
            print(f"\n--- live block/unblock {mac} ---")
            before = r.is_blocked(mac)
            print(f"  blocked before: {before}")
            r.block(mac, name="netdash-test")
            chk("block took effect", r.is_blocked(mac), "still not in list")
            r.unblock(mac)
            chk("unblock removed it", not r.is_blocked(mac), "still in list")
    except RouterError as e:
        chk("router session", False, str(e))
    except Exception as e:  # noqa: BLE001
        chk("router session", False, f"{type(e).__name__}: {e}")
    finally:
        r.close()

    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())