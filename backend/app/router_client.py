"""ZTE F670L (IndiHome) router client: login, block MAC, unblock MAC.

Replaces ARP spoofing with the router's own Access Control / MAC filter
(wlan_macfilterrule_lua.lua), which is far more reliable — modern iOS actively
defends against ARP poisoning, but it honours a router-side block.

Login flow, reverse-engineered from the router's own login page:
  1. GET  /?_type=loginData&_tag=login_token   -> <ajax_response_xml_root>N</...>
     N is a per-session challenge value.
  2. password_hash = SHA256(password + N)       (plain SHA256, hex, lowercase)
  3. POST /?_type=loginData&_tag=login_entry
     with action=login, Username, Password=hash, _sessionTOKEN
  4. Response JSON carries sess_token; that becomes _sessionTOKEN for
     every subsequent POST (read from the DOM by the router's own JS as
     $("#_sessionTOKEN").val()).

The `Check:` header in a browser-captured request is NOT required — it is
injected by a browser extension (uBlock Origin et al.), not by the router's
JS or by ZTE's firmware. Verified by grepping every served JS file: no
setRequestHeader("Check", ...). This client omits it.

Credentials come from the environment so they never touch a config file:
    NETDASH_ROUTER_URL   (default http://192.168.1.1)
    NETDASH_ROUTER_USER
    NETDASH_ROUTER_PASS
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from .zte_check import build_check

log = logging.getLogger("netdash.router")

DEFAULT_URL = "http://192.168.1.1"
LOGIN_TOKEN_URL = "/?_type=loginData&_tag=login_token"
LOGIN_ENTRY_URL = "/?_type=loginData&_tag=login_entry"
# Verified against the live F670L:
#   - the rule *page* is fetched with menuView (GET) and returns 200
#   - menuData (POST) on the same _tag returns HTTP 400
# Write actions (Apply / Del) go to the menuData endpoint the web UI posts to,
# which is what the browser DevTools capture shows.
MACFILTER_VIEW_URL = "/?_type=menuView&_tag=wlan_macfilterrule_lua.lua"
MACFILTER_DATA_URL = "/?_type=menuData&_tag=wlan_macfilterrule_lua.lua"
MACFILTER_URL = MACFILTER_DATA_URL
ACL_POLICY_URL = "/?_type=menuData&_tag=wlan_macfilteraclpolicy_lua.lua"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) "
    "Gecko/20100101 Firefox/157.0"
)

# Only needed because settings.oui_file-style JSON config is not used here.
_VALID_MAC = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")


class RouterError(RuntimeError):
    """Any failure talking to or authenticating against the router."""


def normalize_mac(mac: str) -> str:
    """Accept colon, dash, dot and bare-hex forms; return AA:BB:CC:DD:EE:FF."""
    cleaned = re.sub(r"[^0-9A-Fa-f]", "", mac.strip())
    # 12 hex chars = 6 octets; reject anything else before re-grouping.
    if len(cleaned) != 12:
        raise RouterError(f"MAC tidak valid: {mac!r}")
    grouped = ":".join(cleaned[i:i + 2] for i in range(0, 12, 2)).upper()
    if not _VALID_MAC.match(grouped):
        raise RouterError(f"MAC tidak valid: {mac!r}")
    return grouped


def router_credentials() -> tuple[str, str, str]:
    """(url, username, password).

    Reads backend/.env itself rather than relying on an import of .config, so
    scripts that import only router_client still pick up the credentials.
    """
    from .config import BASE_DIR

    try:
        from dotenv import load_dotenv

        load_dotenv(BASE_DIR / ".env", override=False)
    except Exception:  # dotenv missing or unreadable file: env may still be set
        pass

    url = os.environ.get("NETDASH_ROUTER_URL", DEFAULT_URL).rstrip("/")
    user = os.environ.get("NETDASH_ROUTER_USER", "")
    pw = os.environ.get("NETDASH_ROUTER_PASS", "")
    if not user or not pw:
        raise RouterError(
            "Kredensial router belum diset. Isi backend/.env (lihat "
            "backend/.env.example) atau export NETDASH_ROUTER_USER dan "
            "NETDASH_ROUTER_PASS."
        )
    return url, user, pw


@dataclass
class Rule:
    index: int
    mac: str
    name: str
    interface: str
    # Router-assigned instance id (e.g. "DEV.ACL1"). Required for Delete:
    # the router identifies a rule by this, not by MAC.
    inst_id: str = ""

    @property
    def blocked(self) -> bool:
        return self.mac not in ("", "--", "00:00:00:00:00:00")


class ZteRouter:
    """Thin client for one ZTE F670L session.

    Reusable: call login() once, then block()/unblock()/list_rules() as needed.
    Not thread-safe; the spoof engine calls it from a single worker.
    """

    def __init__(
        self,
        base_url: str | None = None,
        username: str | None = None,
        password: str | None = None,
        timeout: float = 12.0,
    ) -> None:
        if base_url is None or username is None or password is None:
            env_url, env_user, env_pw = router_credentials()
            base_url = base_url or env_url
            username = username or env_user
            password = password or env_pw
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.timeout = timeout

        self._client: httpx.Client | None = None
        self.session_token: str = ""
        # Token issued by the Access Control page; Apply requires this one.
        self.acl_token: str = ""
        self.logged_in: bool = False

    # -- plumbing ---------------------------------------------------------
    def _headers(self, extra: dict | None = None) -> dict:
        h = {
            "User-Agent": UA,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": self.base_url,
            "Referer": f"{self.base_url}/",
        }
        if extra:
            h.update(extra)
        return h

    def close(self) -> None:
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None
        self.logged_in = False

    def __enter__(self) -> "ZteRouter":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                base_url=self.base_url,
                timeout=self.timeout,
                follow_redirects=True,
                headers=self._headers(),
            )
        return self._client

    # -- login ------------------------------------------------------------
    def _fetch_challenge(self) -> str:
        """GET login_token -> the challenge string inside the XML root."""
        r = self.client.get(LOGIN_TOKEN_URL, headers=self._headers())
        if r.status_code != 200:
            raise RouterError(f"Router tidak merespons ({r.status_code}) di {self.base_url}")
        m = re.search(
            r"<ajax_response_xml_root>(.*?)</ajax_response_xml_root>",
            r.text.strip(),
            re.S,
        )
        if not m:
            raise RouterError("Format token login tidak dikenali (kemungkinan bukan ZTE F670L)")
        challenge = m.group(1).strip()
        if not challenge:
            raise RouterError("Router mengembalikan challenge kosong")
        return challenge

    def login(self) -> str:
        """Authenticate and store the session token. Returns the token."""
        challenge = self._fetch_challenge()
        # ZTE hashes SHA256(password + challenge) — plain hex, lowercase.
        digest = hashlib.sha256((self.password + challenge).encode()).hexdigest()

        body = {
            "action": "login",
            "Username": self.username,
            "Password": digest,
            # The pre-login page ships a hidden _sessionTOKEN; the router
            # tolerates an empty one on this endpoint.
            "_sessionTOKEN": self.session_token,
        }
        r = self.client.post(
            LOGIN_ENTRY_URL,
            data=body,
            headers=self._headers({"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"}),
        )
        if r.status_code != 200:
            raise RouterError(f"Login ditolak / error HTTP {r.status_code}")

        try:
            data: Any = r.json()
        except Exception:
            text = r.text.strip()
            raise RouterError(f"Respons login tidak valid JSON: {text[:200]}")

        token = (data.get("sess_token") or "").strip()
        # ZTE returns a sess_token even when the credentials are WRONG — the
        # real verdict is in loginErrMsg/promptMsg. Trusting the token alone
        # would produce a "successful" login that silently 400s on every
        # subsequent call, so check the error fields first.
        err = (data.get("loginErrMsg") or "").strip()
        prompt = (data.get("promptMsg") or "").strip()
        if err or prompt:
            lock = data.get("lockingTime")
            extra = f" (lockingTime={lock})" if lock and lock > 0 else ""
            raise RouterError(f"Login ditolak router: {err or prompt}{extra}")
        if not token:
            raise RouterError(f"Login ditolak / respons tanpa token: {data}")

        self.session_token = token
        self.logged_in = True

        # The router returns login_need_refresh:true and its own JS does
        # `top.location.href = top.location.href` in that case. Skipping the
        # reload leaves the session registered but every data endpoint answers
        # <IF_ERRORSTR>SessionTimeout</IF_ERRORSTR>, so we must do the same.
        if data.get("login_need_refresh"):
            try:
                self.client.get("/", headers=self._headers())
            except Exception as e:
                log.warning("post-login refresh failed: %s", e)

        log.info("berhasil login ke %s (token %s…)", self.base_url, token[:6])
        return token

    def page_get(self, page_url: str, data_url: str) -> str:
        """Load a menu page, then GET its data endpoint with the page's token.

        Used for the WAN status page, whose data URL carries its own query
        parameters and is read with GET rather than POST+IF_ACTION.
        """
        page = self.client.get(page_url, headers=self._headers())
        if page.status_code != 200:
            raise RuntimeError(f"router page {page.status_code}")
        body = page.text
        if "login_need_refresh" in body or "SessionTimeout" in body:
            self.login()
            body = self.client.get(page_url, headers=self._headers()).text
        return self.client.get(data_url, headers=self._headers()).text

    def ensure_login(self) -> None:
        if not self.logged_in or not self.session_token:
            self.login()

    # -- access control ---------------------------------------------------
    ACL_PAGE_URL = "/?_type=menuView&_tag=wlanAdvanced&Menu3Location=0"

    def load_acl_page(self) -> str:
        """Load the real Access Control page and return its session token.

        Not optional. On the F670L the wlan_macfilterrule endpoint answers
        SessionTimeout unless the session has first fetched the WLAN Advanced
        page, and that page also issues the _sessionTOKEN that Apply requires
        (posting with the login token gives "This page has expired").
        """
        import codecs
        import re as _re

        resp = self.client.get(self.ACL_PAGE_URL, headers=self._headers())
        if resp.status_code != 200 or len(resp.text) < 5000:
            raise RouterError(
                f"Halaman Access Control router tidak termuat "
                f"(HTTP {resp.status_code}, {len(resp.text)} byte)"
            )
        toks = [
            codecs.decode(t, "unicode_escape")
            for t in _re.findall(
                r'_sessionTmpToken\s*=\s*["\']([^"\']*)["\']', resp.text
            )
        ]
        toks = [t for t in toks if t]
        if toks:
            self.acl_token = toks[-1]
        # Prime the rule endpoint too, the way the page's own JS does.
        self.client.get(MACFILTER_DATA_URL, headers=self._headers())
        return self.acl_token or self.session_token

    def _encode_body(self, fields: dict) -> tuple[str, dict]:
        """Serialize fields the way the router's own JS builds the body.

        IF_ACTION must lead the body (the router's InitialPostData puts it
        first) and must carry the caller's value — an empty IF_ACTION makes the
        router answer SessionTimeout regardless of how good the session is.
        The Check header is computed over this exact string.
        """
        ordered = [("IF_ACTION", str(fields.get("IF_ACTION", "") or ""))]
        for k, v in fields.items():
            if k != "IF_ACTION":
                ordered.append((k, "" if v is None else str(v)))
        body = "&".join(f"{k}={quote(str(v), safe='')}" for k, v in ordered)
        headers = self._headers(
            {"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"}
        )
        try:
            headers["Check"] = build_check(body)
        except Exception as e:  # cryptography missing, etc.
            log.warning("could not build Check header: %s", e)
        return body, headers

    def _post_macfilter(self, fields: dict, tag: str = MACFILTER_URL) -> httpx.Response:
        """POST to the MAC filter page.

        A blocked MAC shows up in list_rules() rather than in the response, so
        success is verified there — not by status code. A 400/404 means either a
        bad Check header or an expired session token, so we rebuild once and
        retry with a fresh login.
        """
        if not fields.get("_sessionTOKEN"):
            fields["_sessionTOKEN"] = self.session_token

        body, headers = self._encode_body(fields)
        r = self.client.post(tag, content=body, headers=headers)

        if r.status_code in (400, 401, 403, 404) and self.logged_in:
            log.info("HTTP %s, login ulang lalu coba lagi", r.status_code)
            self.session_token = ""
            self.logged_in = False
            self.ensure_login()
            fields["_sessionTOKEN"] = self.session_token
            body, headers = self._encode_body(fields)
            r = self.client.post(tag, content=body, headers=headers)
        if r.status_code != 200:
            raise RouterError(
                f"Permintaan access control ditolak (HTTP {r.status_code}). "
                "Coba muat ulang halaman Settings."
            )
        err = re.search(r"<IF_ERRORSTR>(.*?)</IF_ERRORSTR>", r.text)
        if err and err.group(1) not in ("", "SUCC", "NoError"):
            msg = html_unescape(err.group(1))
            eid = re.search(r"<IF_ERRORID>(-?\d+)</IF_ERRORID>", r.text)
            code = eid.group(1) if eid else "?"
            hint = ""
            if msg == "FAIL" and code == "-258":
                # Measured on this firmware: -1 succeeds for the first row and
                # then fails, and a named-but-unused slot fails with -8. The
                # router's own Add form posts _InstID=-1, so the rejection is
                # about the table state, not the value.
                hint = " (router menolak penambahan rule kedua; tabel ACL mungkin penuh)"
            elif "SessionTimeout" in msg:
                hint = " (sesi login habis — coba lagi)"
            raise RouterError(f"Router menolak: {msg} [{code}]{hint}")
        return r

    def block(
        self,
        mac: str,
        name: str = "netdash",
        interface: str = "DEV.WIFI.AP6",
        inst_id: int | str | None = -1,
    ) -> str:
        """Add a MAC to the router's access-control blacklist.

        Returns the router-assigned instance id (e.g. "DEV.ACL3"). This MUST be
        persisted: Delete needs it, because the router addresses a rule by
        instance id and will not match on MAC alone.

        The table is positional on apply (IF_InstID=-1 means "new row"), so we
        send -1 and read the real id back from the response.
        """
        mac = normalize_mac(mac)
        self.ensure_login()

        # The ACL table is positional. -1 means "append a row" and the router
        # assigns the next DEV.ACL<n>; passing a named but unused slot is
        # rejected with -8. So -1 is the correct value here, and the real id
        # comes back in the response (or from the verification read below).
        if inst_id is None:
            inst_id = -1
        target_id = inst_id
        tok = self.load_acl_page()
        resp = self._post_macfilter(
            {
                "IF_ACTION": "Apply",
                "_InstID": target_id,
                "MACAddress": mac,
                "Name": (name or "netdash")[:15],
                "Interface": interface,
                "Btn_cancel_MACFilterRule": "",
                "Btn_apply_MACFilterRule": "",
                "_sessionTOKEN": tok,
            }
        )
        new_id = parse_new_inst_id(resp.text) or target_id
        # The router can answer SUCC without having written anything, so the
        # only trustworthy confirmation is that the rule shows up in the list.
        # It must be on the interface we asked for: a multi-interface kick puts
        # several rules on the same MAC, so matching on MAC alone would accept a
        # rule that landed on the wrong AP.
        landed = [r for r in self.list_rules() if r.mac == mac]
        if not landed:
            raise RouterError(
                f"Router melaporkan SUCC tapi rule untuk {mac} tidak muncul "
                "di daftar Access Control."
            )
        if not any(r.interface == interface for r in landed):
            got = landed[-1].interface or "?"
            try:
                self.unblock(mac, new_id)
            except Exception:  # noqa: BLE001
                pass
            raise RouterError(
                f"Rule untuk {mac} masuk ke {got}, bukan {interface}. "
                "Blokir tidak akan berlaku di SSID yang benar."
            )
        log.info("block: %s on %s -> %s", mac, interface, new_id)
        return new_id

    def _next_free_acl_id(self) -> str:
        """Next unused DEV.ACL<n>. Used for capacity reporting only.

        Apply itself always sends -1 (the table is positional and the router
        assigns the id); naming an unused slot is rejected with -8. ACL1..ACL10
        mirror the web UI's 10 slots.
        """
        used = {r.inst_id for r in self._rows() if r.inst_id}
        for n in range(1, 11):
            cand = f"DEV.ACL{n}"
            if cand not in used:
                return cand
        raise RouterError("Semua 10 slot Access Control router sudah penuh")

    def page_post(self, page_url: str, data_tag: str) -> str | None:
        """Load a menuView page for its token, then POST a menuData tag.

        Read-only helper for endpoints like router health, where the data tag
        answers SessionTimeout until the owning page has been fetched.
        Returns the raw body, or None.
        """
        self.ensure_login()
        try:
            page = self.client.get(page_url, headers=self._headers())
        except Exception as e:  # noqa: BLE001
            log.debug("page_post: %s failed: %s", page_url, e)
            return None
        token = ""
        if getattr(page, "status_code", 0) == 200:
            import codecs
            import re as _re

            toks = [
                codecs.decode(t, "unicode_escape")
                for t in _re.findall(
                    r'_sessionTmpToken\s*=\s*["\']([^"\']*)["\']', page.text
                )
            ]
            toks = [t for t in toks if t]
            if toks:
                token = toks[-1]
                self.acl_token = token
        try:
            body, headers = self._encode_body(
                {"IF_ACTION": "Read", "_sessionTOKEN": token or self.session_token}
            )
            resp = self.client.post(
                f"/?_type=menuData&_tag={data_tag}", content=body, headers=headers
            )
        except Exception as e:  # noqa: BLE001
            log.debug("page_post: POST %s failed: %s", data_tag, e)
            return None
        if resp.status_code != 200 or "SessionTimeout" in resp.text:
            return None
        return resp.text

    def rules_for(self, mac: str) -> list[Rule]:
        """Every ACL rule currently holding this MAC, one per AP."""
        m = normalize_mac(mac)
        return [r for r in self._rows() if r.mac == m]

    def interfaces_for(self, mac: str) -> list[str]:
        """Distinct AP interfaces this MAC already has a rule on."""
        out: list[str] = []
        for r in self.rules_for(mac):
            if r.interface and r.interface not in out:
                out.append(r.interface)
        return out

    def free_slots(self) -> int:
        """Remaining ACL entries (the F670L has 10)."""
        used = {r.inst_id for r in self._rows() if r.inst_id}
        return sum(1 for n in range(1, 11) if f"DEV.ACL{n}" not in used)

    def block_multi(
        self,
        mac: str,
        interfaces: list[str],
        name: str = "netdash",
    ) -> tuple[list[str], list[str], list[str]]:
        """Create one ACL rule per interface.

        Returns ``(inst_ids, errors, covered_interfaces)``.

        A client that roams between bands keeps one MAC but appears on different
        APs, and Access Control is per-AP: a rule on AP5 does not stop the device
        joining AP1. Blocking every interface it has been seen on closes that gap.

        Partial success is normal and is reported rather than hidden - each
        interface is attempted independently so one full table does not abort
        the rest.
        """
        mac = normalize_mac(mac)
        self.ensure_login()

        wanted = [i for i in dict.fromkeys(interfaces) if i]
        created: list[str] = []
        errors: list[str] = []
        covered: list[str] = []
        existing = set(self.interfaces_for(mac))

        for iface in wanted:
            if iface in existing:
                # Already covered by a live rule; reuse it rather than burning
                # one of the router's 10 ACL slots on a duplicate.
                inst = next(
                    (r.inst_id for r in self.rules_for(mac) if r.interface == iface),
                    "",
                )
                if inst:
                    created.append(inst)
                    covered.append(iface)
                continue
            try:
                created.append(self.block(mac, name=name, interface=iface))
                covered.append(iface)
            except RouterError as e:
                errors.append(f"{iface}: {e}")
            except Exception as e:  # noqa: BLE001
                errors.append(f"{iface}: {type(e).__name__}: {e}")

        return created, errors, covered

    def unblock_all(self, mac: str) -> tuple[list[str], list[str]]:
        """Delete every ACL rule for this MAC. Returns (removed_ids, errors).

        A multi-AP kick leaves several rules on one MAC; stopping the kick has to
        clear all of them, otherwise the device stays blocked on the APs whose
        instance id was lost (for example after a backend restart).
        """
        mac = normalize_mac(mac)
        self.ensure_login()

        removed: list[str] = []
        errors: list[str] = []
        # Re-read between deletes: the table shifts as rows disappear.
        for rule in self.rules_for(mac):
            try:
                self.unblock(mac, rule.inst_id)
                removed.append(rule.inst_id)
            except RouterError as e:
                errors.append(f"{rule.inst_id or rule.interface}: {e}")
            except Exception as e:  # noqa: BLE001
                errors.append(f"{rule.inst_id or rule.interface}: {type(e).__name__}: {e}")
        return removed, errors

    def unblock(self, mac: str, inst_id: str | None = None) -> None:
        """Remove a rule from the blacklist.

        `inst_id` must be the value returned by block() (e.g. "DEV.ACL2").
        When it is missing we re-read the table and find the rule by MAC — that
        fallback exists for after a backend restart, not as the normal path.
        """
        mac = normalize_mac(mac)
        self.ensure_login()

        resolved = (inst_id or "").strip()
        if not resolved:
            resolved = self._find_inst_id_by_mac(mac)
        if not resolved:
            log.info("unblock: %s tidak ada di blacklist router", mac)
            return

        # Take the interface from the specific rule being deleted; a MAC can
        # hold several rules and they are not necessarily on the same AP.
        iface = ""
        for r in self._rows():
            if r.inst_id == resolved:
                iface = r.interface
                break
        iface = iface or self._interface_for_inst(mac) or "DEV.WIFI.AP6"
        tok = self.load_acl_page()
        self._post_macfilter(
            {
                "IF_ACTION": "Delete",
                "_InstID": resolved,
                "MACAddress": mac,
                "Name": "",
                "Interface": iface,
                "Btn_cancel_MACFilterRule": "",
                "Btn_apply_MACFilterRule": "",
                "_sessionTOKEN": tok,
            }
        )
        # The router answers SUCC even when it ignored the delete, so verify
        # that this specific instance is gone. Other rules for the same MAC on
        # other APs are legitimate (a multi-AP kick) and must not fail here.
        if any(r.inst_id == resolved for r in self.list_rules()):
            raise RouterError(
                f"Router melaporkan SUCC tapi rule {resolved} masih ada. "
                "Hapus manual di 192.168.1.1 -> WLAN Advanced -> Access Control Rule."
            )
        log.info("unblock: %s (rule %s dihapus)", mac, resolved)

    def list_rules(self) -> list[Rule]:
        """Current blacklist, straight from OBJ_ACLCFG_ID.

        Loads the ACL page first: without it the router answers
        SessionTimeout, and it also refreshes the token the write calls need.
        """
        self.ensure_login()
        tok = self.load_acl_page()
        r = self._post_macfilter({"IF_ACTION": "Read", "_sessionTOKEN": tok})
        return parse_rules(r.text)

    def is_blocked(self, mac: str) -> bool:
        mac = normalize_mac(mac)
        return any(rule.mac == mac for rule in self.list_rules())

    # -- slot helpers -----------------------------------------------------
    def _rows(self) -> list[Rule]:
        try:
            return self.list_rules()
        except RouterError:
            return []

    def _find_inst_id_by_mac(self, mac: str) -> str:
        """Fallback lookup: which rule instance currently holds this MAC?"""
        for r in self._rows():
            if r.mac == normalize_mac(mac):
                return r.inst_id
        return ""

    def rule_interface_for(self, mac: str) -> str:
        """The AP interface an existing ACL rule for this MAC targets.

        Used as read-back verification after block(): the router accepts any
        valid AP id, so a rule written to the wrong SSID still returns success.
        Returns '' when no rule exists for the MAC.
        """
        m = normalize_mac(mac)
        for r in self._rows():
            if r.mac == m:
                return r.interface
        return ""

    def _interface_for_inst(self, mac: str) -> str:
        for r in self._rows():
            if r.mac == normalize_mac(mac):
                return r.interface or "DEV.WIFI.AP6"
        return "DEV.WIFI.AP6"


# ------------------------------------------------------------------ parsing


def parse_acl_policy(xml: str) -> dict:
    """SSID alias -> interface, plus the per-SSID ACL mode.

    From wlan_macfilteraclpolicy_lua.lua. This is the authoritative SSID<->AP
    mapping — confirmed live on the F670L: SSID6 is DEV.WIFI.AP6 on the 5GHz
    radio, and it was the only SSID with ACLPolicy=Ban.
    """
    out: dict[str, object] = {}
    policy: dict[str, str] = {}
    for inst in re.findall(r"<Instance>(.*?)</Instance>", xml, re.S | re.I):
        params = dict(
            re.findall(
                r"<ParaName>([^<]+)</ParaName>\s*<ParaValue>([^<]*)</ParaValue>",
                inst, re.I,
            )
        )
        alias = params.get("Alias")
        if alias:
            out[alias] = params.get("_InstID", "")
        if alias and "ACLPolicy" in params:
            policy[alias] = params["ACLPolicy"]
    out["_policy"] = policy
    return out


def fetch_acl_policy(router) -> dict:
    """Read the ACL policy page: SSID mapping + which SSIDs allow blocking."""
    router.ensure_login()
    resp = r._post_macfilter(
        {"IF_ACTION": "Read", "_sessionTOKEN": r.session_token}, tag=ACL_POLICY_URL
    )
    return parse_acl_policy(resp.text)


def html_unescape(text: str) -> str:
    """The router escapes spaces as &#32; in its error strings."""
    import html as _html

    return _html.unescape(text or "").strip()


def parse_new_inst_id(html: str) -> str:
    """Pull the newly created rule's instance id out of an Apply response.

    The router echoes the instance it allocated (DEV.ACL<n>) in the returned
    XML/HTML. Look for that first, then for any generic _InstID value.
    """
    m = re.search(r"(DEV\.ACL\d+)", html, re.I)
    if m:
        return m.group(1)
    m = re.search(r'_InstID[^A-Za-z0-9]{0,4}["\']?(DEV\.ACL\d+)', html, re.I)
    if m:
        return m.group(1)
    return ""


def parse_rules(html: str) -> list[Rule]:
    """Extract blacklist rules from the ACL Read response or the web page.

    The Read endpoint returns XML like:

        <OBJ_ACLCFG_ID><Instance>
          <ParaName>_InstID</ParaName><ParaValue>DEV.ACL1</ParaValue>
          <ParaName>MACAddress</ParaName><ParaValue>16:50:ad:b9:4a:fa</ParaValue>
          <ParaName>Name</ParaName><ParaValue>AA</ParaValue>
          <ParaName>Interface</ParaName><ParaValue>DEV.WIFI.AP6</ParaValue>
        </Instance></OBJ_ACLCFG_ID>

    That is the authoritative source (inst id included). HTML table rows and
    hidden MACAddress fields are kept as fallbacks for other firmware builds.
    """
    rules: list[Rule] = []

    for inst_xml in re.findall(r"<Instance>(.*?)</Instance>", html, re.S | re.I):
        params = dict(
            re.findall(
                r"<ParaName>([^<]+)</ParaName>\s*<ParaValue>([^<]*)</ParaValue>",
                inst_xml, re.I,
            )
        )
        mac = (params.get("MACAddress") or "").strip().upper()
        if not mac or mac == "00:00:00:00:00:00":
            continue
        rules.append(
            Rule(
                index=len(rules),
                mac=mac,
                name=params.get("Name", ""),
                interface=params.get("Interface", ""),
                inst_id=params.get("_InstID", ""),
            )
        )
    if rules:
        return rules

    # Row style carries everything we need: inst id, MAC, name, interface.
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S | re.I):
        macs = re.findall(r"([0-9A-F]{2}(?::[0-9A-F]{2}){5})", row, re.I)
        if not macs:
            continue
        mac = macs[0].upper()
        if mac == "00:00:00:00:00:00":
            continue
        inst = ""
        im = re.search(r"(DEV\.ACL\d+)", row, re.I)
        if im:
            inst = im.group(1)
        ifm = re.search(r"(DEV\.WIFI\.AP\d+)", row, re.I)
        rules.append(
            Rule(
                index=len(rules),
                mac=mac,
                name="",
                interface=ifm.group(1) if ifm else "",
                inst_id=inst,
            )
        )
    if rules:
        return rules

    # Hidden-field style: name="MACAddress0" value="AA:BB:..."
    for idx, mac in re.findall(
        r'name="MACAddress(\d+)"[^>]*value="([^"]*)"', html, re.I
    ):
        mac = mac.strip().upper()
        if not mac or mac in ("--", "00:00:00:00:00:00"):
            continue
        rules.append(Rule(index=int(idx), mac=mac, name="", interface=""))
    if rules:
        return rules

    # Fallback: table rows with a MAC-looking cell.
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S | re.I):
        found = re.search(r"([0-9A-F]{2}(?::[0-9A-F]{2}){5})", row, re.I)
        if found:
            rules.append(Rule(index=len(rules), mac=found.group(1).upper(), name="", interface=""))
    return rules