# netdash — Network Dashboard & Device Manager

Dashboard jaringan rumah + device manager. Menjalur di laptop sendiri (localhost),
untuk memonitor dan mengelola perangkat di jaringan WiFi/LAN **milik Anda sendiri**.

```
[React + Vite + Tailwind]  <--REST/WebSocket-->  [FastAPI]  <--scapy raw socket-->  [LAN Anda]
                                                                   |
                                                              [SQLite]
```

---

## Fitur

- **Device discovery** — ARP sweep subnet (default `192.168.1.0/24`), auto-detect
  interface dan IP lokal. Reverse DNS, vendor dari OUI IEEE, klasifikasi tipe
  (HP/laptop/TV/IoT/router/server), first seen / last seen.
- **Live update** — WebSocket `/ws/live`, hasil scan dipush ke UI tiap interval.
- **Nickname** — beri nama sendiri per device, tersimpan permanen.
- **Kick (ARP spoof dua arah)** — putuskan trafik device target dengan poisoned
  ARP, dengan auto-stop dan **restore ARP asli** saat dihentikan.
- **Whitelist** — MAC yang tidak bisa di-kick (mis. gateway, laptop Anda).
- **Dashboard** — statistik online/offline, grafik tren, device terbaru, log kick.
- **Auth** — login session cookie, rate limiting.

---

## Requirements

| Kebutuhan | Kenapa |
|---|---|
| Python 3.11+ | backend |
| Node.js 20+ | frontend build |
| **Administrator / root** | ARP spoof butuh raw socket |
| **Npcap** (Windows) | scapy butuh WinPcap-compatible driver |

> **Windows perlu dua hal:** (1) jalankan terminal/IDE sebagai
> *Run as Administrator*, dan (2) pasang **Npcap** dari
> <https://npcap.com> (centang *Support raw 802.11 traffic* tidak wajib, tapi
> berguna untuk monitor WiFi). Tanpa Npcap, dashboard **tetap jalan** —
> scanner jatuh ke ARP cache OS — tapi **kick tidak akan efektif**.
>
> **Linux/macOS:** cukup `sudo`. Kalau punya `cap_net_raw`:
> `sudo setcap cap_net_raw+ep $(which python3)`.

---

## Cara run

### 1. Backend

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r backend/requirements.txt psutil
```

Jalankan sebagai admin (WAJIB untuk kick):

```bash
# Linux/macOS
sudo .venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8777

# Windows (Run as Administrator)
.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8777
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

Vite memproxy `/api` dan `/ws` ke backend port 8777, jadi session cookie
tetap same-origin.

### 3. Login

| | |
|---|---|
| URL | <http://localhost:5173> |
| Username | `admin` |
| Password | `netdash` |

Ganti password di **Settings**, atau set env sebelum pertama jalan:

```bash
export NETDASH_PASSWORD="password-kamu"
```

### Build produksi (satu server)

```bash
cd frontend && npm run build     # menghasilkan frontend/dist
cd .. && .venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8777
```

Backend otomatis menyajikan SPA hasil build di `http://127.0.0.1:8777`.

---

## Setting awal

Buka **Settings**:

1. **Subnet target** — pastikan sesuai router Anda (`192.168.1.0/24` untuk
   IndiHome). Backend menampilkan IP lokal yang terdeteksi.
2. **MAC gateway** — opsional, usually terisi otomatis dari ARP cache.
   Isi manual kalau tidak terdeteksi.
3. **Whitelist MAC** — masukkan MAC laptop/HP Anda sendiri supaya tidak
   bisa ter-kick tidak sengaja.
4. **Batas durasi kick** — auto-stop default 600 detik.

---

## Peringatan kick

Kick melakukan **ARP spoofing**, yang:

- Hanya boleh dipakai pada **jaringan milik Anda sendiri** (rumah/kantor
  sendiri, atau dengan izin eksplisit). Memakai di jaringan orang lain
  melanggar hukum di hampir semua negara — termasuk UU ITE di Indonesia.
- Memutus trafik device tersebut. Device yang sedang di-kick akan **tidak
  bisa akses internet sampai kick dihentikan**.
- Selalu ada **auto-stop** + tombol **Stop Kick** + whitelist, supaya tidak
  ada device yang lupa terputus terus-terusan.

Backend menolak kick pada: MAC yang tidak ada di hasil scan, gateway, MAC yang
di-whitelist, dan device yang sudah sedang di-kick.

---

## Router access control (ZTE F670L / IndiHome)

Far more reliable than ARP spoofing for modern devices: iOS actively
defends against ARP poisoning (it sends its own ARP corrections within seconds)
but honours a router-side block. `backend/app/router_client.py` speaks the
F670L's own Access Control API (`wlan_macfilterrule_lua.lua`).

### Setup

Credentials are read from the environment, never from a config file:

```bash
# Windows PowerShell
$env:NETDASH_ROUTER_USER = "admin"
$env:NETDASH_ROUTER_PASS = "password-router-kamu"
$env:NETDASH_ROUTER_URL  = "http://192.168.1.1"   # optional

# Linux / macOS
export NETDASH_ROUTER_USER=admin
export NETDASH_ROUTER_PASS=...
```

### Usage

```python
from app.router_client import ZteRouter

with ZteRouter() as r:
    r.login()                       # challenge -> SHA256 -> sess_token
    r.block("16:50:AD:B9:4A:FA", name="Anak")   # add to blacklist
    print(r.list_rules())           # current entries
    r.unblock("16:50:AD:B9:4A:FA")              # free the slot
```

`block()` picks a free slot automatically (the router table is positional,
10 slots), and `unblock()` is idempotent — deleting a MAC that isn't listed
is a no-op rather than an error.

### Verify

```bash
.venv/Scripts/python.exe backend/test_router.py              # 18 offline tests
.venv/Scripts/python.exe backend/test_router.py --block AA:BB:CC:DD:EE:FF   # + live block/unblock
```

### Debugging `SessionTimeout`

`SessionTimeout` from `wlan_macfilterrule_lua.lua` is almost always a
malformed body, not a bad session. To tell them apart, POST the same
`IF_ACTION=Read` to a tag that always answers:

```bash
curl -s -X POST "http://192.168.1.1/?_type=menuData&_tag=wlan_homepage_lua.lua" \
  -H "Cookie: SID=..." -H "Check=..." -H "X-Requested-With: XMLHttpRequest" \
  --data-raw "IF_ACTION=Read&_sessionTOKEN=<token>"
# SUCC            -> session + Check are fine; the ACL body is malformed
# SessionTimeout  -> the session really is dead; log in again
```

`IF_ACTION` must be first in the body and must carry its value. Sending an
empty `IF_ACTION=` produces `SessionTimeout` even with a perfect session —
that was a real bug here, caught by diffing against a browser capture.

### Access Control API (verified against a live F670L)

**Load the page first.** Before any ACL call you must fetch
`/?_type=menuView&_tag=wlanAdvanced&Menu3Location=0` (20 KB, *not* the 188 KB
generic shell) and use the `_sessionTmpToken` it embeds for the following
requests. Without that page load the endpoint answers `SessionTimeout`; with
the login token instead of the page token it answers "This page has expired".
`router_client.load_acl_page()` does this and caches the result in
`router_client.acl_token`.

| Action | `IF_ACTION` | `_InstID` | Answer |
|---|---|---|---|
| List rules | `Read` | *(omitted)* | `SUCC` + `OBJ_ACLCFG_ID` |
| Add rule | `Apply` | **`DEV.ACL<n>`** | `SUCC` + `<_InstID>DEV.ACL<n></_InstID>` |
| Delete rule | **`Delete`** | `DEV.ACL<n>` | `SUCC` + rule gone |

Four traps, each verified by getting it wrong first:

- `_InstID=-1` on Apply → `FAIL [-258]`. Name the instance explicitly
  (`DEV.ACL1`..`DEV.ACL10`); `block()` picks the next free one.
- **`IF_ACTION=Del` returns `SUCC` and deletes nothing.** The verb is `Delete`.
  Because the router lies about success, `block()` and `unblock()` both re-read
  the rule list afterwards and raise if the change is not really there.
- Sending `_sessionTOKEN` as a **query parameter on a GET** makes the router
  serve the 188 KB shell instead of data. Reads are cookie-only; writes carry
  the token in the form body.
- The `Check` header must hash the **percent-encoded** body
  (`MACAddress=16%3A50%3A...`). Hashing the raw string gets HTTP 400.

`wlan_macfilteraclpolicy_lua.lua` returns the authoritative SSID↔AP map and
each SSID's `ACLPolicy`. On the tested F670L `SSID6` is `DEV.WIFI.AP6` on the
5 GHz radio, and rules only apply where `ACLPolicy` is `Ban`, not `Disabled`.

### How the login works

Reverse-engineered from the router's own login page, not guessed:

1. `GET /?_type=loginData&_tag=login_token` → `<ajax_response_xml_root>46351051</...>`
   is a per-session challenge.
2. `Password = SHA256(password + challenge)` — plain SHA256, lowercase hex.
3. `POST /?_type=loginData&_tag=login_entry` with `action=login`,
   `Username`, `Password`, `_sessionTOKEN`.
4. The response carries `sess_token`; that is the `_sessionTOKEN` for every
   later POST (the router's JS reads it from the DOM as
   `$("#_sessionTOKEN").val()`).

**The `Check:` header in your captured request is not required.** It is
injected by a browser extension (uBlock Origin and friends), not by the
router's JavaScript or by ZTE's firmware — verified by grepping every JS
file the router serves (`common_lib.js`, `crypto-js.min.js`, `jquery.min.js`,
`jsencrypt.min.js`): none of them call `setRequestHeader("Check", ...)`.
This client omits it and the requests work without it.

⚠️ **Careful with a failed login:** the F670L returns a valid-looking
`sess_token` *even when the password is wrong*, putting the real verdict in
`loginErrMsg`. Repeated failures trigger a lockout (`lockingTime`, observed
at 60s). `router_client` checks `loginErrMsg`/`promptMsg` and raises rather
than trusting the token — verified against the live router with a deliberate
wrong password.

---

## Troubleshooting: kick tidak berfungsi

Kalau device yang di-kick **tidak kehilangan koneksi**, cek berurutan ini.
Halaman **Settings → Diagnostik kick** menampilkan status yang sama langsung
di UI, jadi tidak perlu menebak.

### 1. Backend harus jalan sebagai Administrator

ARP spoof butuh raw socket. Tanpa elevasi, frame tidak pernah sampai
ke LAN — tapi tidak ada error yang muncul, jadi mudah terlewat.

```powershell
# klik kanan PowerShell/CMD -> Run as administrator
.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8777
```

Di Settings, panel diagnostik akan menampilkan peringatan kuning kalau
backend tidak elevated.

### 2. Adapter yang dipakai harus adapter LAN

**Ini penyebab paling sering**, terutama di laptop yang juga jalan VMware /
VirtualBox / Hyper-V.

scapy punya `conf.iface` global yang menunjuk adapter **pertama yang ia
temukan** — pada banyak mesin itu adapter virtual (mis. *VMware Network
Adapter VMnet1*), bukan Wi-Fi. Semua frame lalu terkirim ke adapter virtual,
tidak sampai ke jaringan, dan scapy mencetak:

```
WARNING: MAC address to reach destination not found. Using broadcast.
```

netdash tidak memakai `conf.iface`. Semua pengiriman ARP dipin ke adapter
yang memegang IP lokal kamu (resolved via `resolve_iface()` di
`backend/app/scapy_arp.py`), dan dikirim dengan `sendp()` — bukan `send()`,
karena `send()` menolak `iface=` untuk paket link-layer lalu kembali ke
routing default.

Untuk memastikan adapter yang benar:

```bash
curl -s -b cookies.txt http://127.0.0.1:8777/api/interfaces
```

Field `chosen.name` harus adapter LAN kamu (mis. `Wi-Fi`), bukan adapter
virtual. Kalau salah, paksa lewat Settings → *Interface untuk scan & kick*.

### 3. Npcap terpasang & benar

Butuh **Npcap** (<https://npcap.com>) dengan opsi **WinPcap API-compatible
Mode** **centang**. Cek:

```powershell
sc query npcap                                   # harus RUNNING
Test-Path C:\Windows\System32\wpcap.dll          # harus True
```

Kalau `wpcap.dll` tidak ada, install ulang Npcap dengan WinPcap API-compatible
Mode aktif, lalu **install ulang netdash** (`pip install -r
backend/requirements.txt`) agar scapy memuat DLL yang benar.

### 4. Kalau semua sudah benar tapi target tetap online

Kalau semua di atas sudah benar tapi target tetap online:

- **iPhone/iPad sangat resisten terhadap ARP spoofing.** iOS memonitor ARP
  dan bisa mengirim koreksi ARP (gratuitous ARP) sendiri, membatalkan spoofing
  dalam hitungan detik. Untuk iOS, cara yang lebih andal adalah membatasi
  perangkat di router (mis. parental control / device block di IndiHome).
- **Client di VLAN atau band berbeda** (mis. 5 GHz vs 2.4 GHz dengan
  WLAN isolation) tidak bisa di-ARP dari laptopmu.
- Target harus **pernah terlihat di scan** — MAC yang tidak ada di ARP cache
  akan ditolak backend.

### Uji cepat

```bash
.venv\Scripts/python.exe backend/test_kick_drill.py 192.168.1.7 10
```

Drill mencetak status admin, adapter yang dipakai, dan menolak jalan kalau
adapter-nya virtual.

---

## Tests

Backend harus sudah berjalan di `127.0.0.1:8777`.

```bash
# API + auth + kick safety (19 tests)
bash backend/test_api.sh

# Engine, OUI, device typing, WebSocket (37 tests)
.venv/bin/python backend/test_engine.py

# Drill kick nyata terhadap satu device — restore ARP, auto-stop
.venv/bin/python backend/test_kick_drill.py 192.168.1.7 10
```

> ⚠️ `test_api.sh` sengaja mengunci rate limiter di akhir, jadi **restart server**
> sebelum menjalankannya lagi.
>
> ⚠️ `test_kick_drill.py` mengirim ARP spoof sungguhan. Tanpa hak admin, spoof
> tidak akan memblokir trafik — drill tetap menguji start/stop/logging, dan
> akan bilang apa adanya.

---

## Vendor lookup

Database OUI IEEE lengkap (~40.000 entri) sudah bundled di
`backend/app/oui_data.py`, jadi identifikasi vendor jalan **offline**.

Untuk regenerate dari registry resmi:

```bash
curl -sL -o oui.csv https://standards-oui.ieee.org/oui/oui.csv
python tools/build_oui_table.py oui.csv backend/app/oui_data.py
```

Atau pakai `oui.csv` sendiri lewat field **Oui file** di Settings.

---

## Struktur

```
backend/
  app/
    main.py        # FastAPI, semua endpoint, static SPA
    net.py         # ARP scan, OUI lookup, spoof engine
    scapy_arp.py   # konstruksi paket ARP (spoof + restore)
    scanner.py     # background scan loop, WebSocket hub
    db.py          # model SQLModel (Device, DeviceEvent, KickLog, ScanSample)
    auth.py        # session cookie + rate limiter
    config.py      # settings tersimpan di data/config.json
    oui_data.py    # database OUI IEEE (generated)
  test_api.sh          # smoke test API
  test_engine.py       # unit test engine + WebSocket
  test_kick_drill.py   # drill kick nyata
frontend/
  src/
    api.ts          # typed API client
    live.tsx        # WebSocket + auth context
    components/     # Layout, DeviceTable
    pages/          # Login, Dashboard, Devices, DeviceDetail, Settings
tools/
  build_oui_table.py   # generator tabel OUI
```

Data runtime (SQLite + config) ada di `backend/data/`. Hapus folder itu untuk
reset ke kondisi awal.