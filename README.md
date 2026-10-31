# AN Telemetry — Network Dashboard & Device Manager

Dashboard jaringan rumah + device manager yang berjalan di laptop/server sendiri
(localhost atau LAN internal). Memantau perangkat di WiFi/LAN **milik Anda
sendiri**, menampilkan vendor/tipe perangkat, dan bisa memblokir perangkat lewat
Access Control router atau ARP spoofing.

```
[React + Vite + Tailwind]  <--REST/WebSocket-->  [FastAPI]  <--scapy/router API-->  [LAN Anda]
                                                                    |
                                                               [SQLite]
```

> Gunakan hanya pada jaringan yang Anda miliki atau yang Anda punya izin
> eksplisit untuk mengelolanya.

---

## Fitur

- **Device discovery** — ARP sweep subnet (default `192.168.1.0/24`), auto-detect
  interface/IP, reverse DNS, vendor OUI IEEE, klasifikasi tipe perangkat,
  first/last seen.
- **Realtime** — WebSocket `/ws/live` mendorong daftar device, transisi
  online/offline, status kick, dan event WAN ke UI.
- **Nickname & tipe manual** — nama dan tipe perangkat tersimpan permanen.
- **Kick/block** — Access Control router (disarankan, efektif untuk iOS) atau
  ARP spoof dua arah sebagai fallback. Ada auto-stop, whitelist, dan restore ARP.
- **Dashboard & riwayat** — statistik online/offline, tren scan, event
  connect/disconnect, log kick.
- **Auth** — session cookie, rate limiting, password bisa diganti dari Settings.
- **Produksi** — backend bisa menyajikan `frontend/dist` langsung (satu proses,
  tanpa Vite) dan dijalankan di bawah PM2.

---

## Requirements

| Kebutuhan | Versi / catatan |
|---|---|
| Python | **3.11 – 3.14** |
| Node.js | **20 atau lebih baru** |
| npm | 10+ (ikut Node.js) |
| OS | Windows 10/11, Linux, macOS |
| Hak akses | `root`/Administrator hanya untuk fitur kick (raw socket) |
| Npcap (Windows) | Wajib untuk ARP kick; centang **WinPcap API-compatible Mode** |
| libpcap (Linux/macOS) | Untuk fitur scapy tertentu; ARP scan tetap bisa memakai raw socket |

Dependency Python lengkap dan versinya ada di
[`backend/requirements.txt`](backend/requirements.txt). **Gunakan satu virtual
environment utama di root project: `.venv`.** Jangan mencampur dengan
`backend/.venv` atau `backend/venv`. Launcher mencetak interpreter yang dipakai
dan menolak start bila ada dependency yang tidak bisa di-import.

### Dependency sistem

**Linux (Debian/Ubuntu):**

```bash
sudo apt update
sudo apt install -y python3-venv libpcap-dev net-tools iproute2
# Opsional, agar kick tidak perlu sudo terus-menerus:
sudo setcap cap_net_raw+ep "$(readlink -f .venv/bin/python)"
```

`net-tools` menyediakan command `arp` yang dipakai sebagai fallback saat raw
socket tidak tersedia. `iproute2` menyediakan `ss`/`ip` untuk diagnostik.

**Windows:** install [Npcap](https://npcap.com) dengan opsi **WinPcap API-compatible
Mode**, lalu jalankan terminal sebagai **Administrator** untuk fitur kick.

**macOS:** `xcode-select --install` (atau `brew install libpcap`), lalu jalankan
dengan `sudo` bila ingin fitur kick.

---

## Instalasi

### 1. Clone dan siapkan Python

```bash
git clone <url-repo> super-router-dashboard
cd super-router-dashboard

python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt
```

Windows PowerShell:

```powershell
py -3 -m venv .venv
.venv\Scripts\Activate.ps1
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

### 2. Install frontend dan dependency launcher

```bash
cd frontend
npm install
cd ..

# dependency untuk command `anrouter` (prompts + open)
npm install
```

### 3. Siapkan environment

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Isi kredensial router di `backend/.env`. File `.env` tidak boleh di-commit.
Detail variabel ada di [Environment variables](#environment-variables).

### 4. Install command global `anrouter`

```bash
npm link
```

Kalau `npm link` gagal karena prefix npm (`/usr/local`) butuh sudo, pakai
instalasi ke direktori user yang biasanya sudah ada di PATH:

```bash
npm install -g . --prefix "$HOME/.local"
```

Pastikan `~/.local/bin` ada di `PATH` (`export PATH="$HOME/.local/bin:$PATH"`).
Di Windows, `npm link` membuat shim `anrouter.cmd` otomatis.

Cek:

```bash
anrouter --version
anrouter --doctor
```

---

## Cara menjalankan

### Cara utama: `anrouter` (cross-platform)

`anrouter` adalah satu-satunya command yang direkomendasikan untuk development
harian. Launcher ini Node.js murni, jadi perilakunya sama di Windows, Linux, dan
macOS.

```bash
anrouter
```

Yang dilakukan launcher:

1. Memilih Python dari `.venv` root (fallback ke `backend/.venv`/`python3` hanya
   bila perlu), lalu memastikan semua dependency bisa di-import.
2. Menyalakan backend FastAPI di `127.0.0.1:8777` bila belum berjalan.
3. Menyalakan Vite dev server di `http://localhost:5173` bila belum berjalan.
4. Menunggu kedua layanan benar-benar siap.
5. Menampilkan menu **AN Telemetry**:
   - **Web UI (Open in Browser)** — membuka `http://localhost:5173/dashboard`.
   - **Exit** — mematikan hanya layanan yang dimulai oleh sesi `anrouter` ini.
6. Menulis log ke `backend/server.log` dan `frontend/dev.log`.

Perintah tambahan:

```bash
anrouter --doctor          # cek Python/venv, dependency, dan port
anrouter --port 8787       # backend di port lain
anrouter --host 127.0.0.1
anrouter --help
```

`anrouter` memakai browser default lewat package `open` (bukan `start`/`xdg-open`
manual). Kalau environment tidak punya browser (server/SSH), launcher tetap
menampilkan URL untuk dibuka manual.

### Alternatif/fallback: `run.sh` dan `run.ps1`

File ini dipertahankan untuk environment yang tidak bisa memakai Node.js
launcher. Keduanya **bukan** cara utama dan tidak menampilkan menu/browser.

Linux/macOS:

```bash
./run.sh              # backend saja, port 8777
./run.sh 8787         # port lain
cd frontend && NETDASH_BACKEND=8777 npm run dev
```

Windows PowerShell:

```powershell
.\run.ps1
.\run.ps1 -Port 8787
cd frontend; $env:NETDASH_BACKEND="8777"; npm run dev
```

### Manual (tanpa launcher)

```bash
# terminal 1 — backend
.venv/bin/python -m uvicorn app.main:app --app-dir backend \
  --host 127.0.0.1 --port 8777

# terminal 2 — frontend
cd frontend
NETDASH_BACKEND=8777 npm run dev
```

Windows:

```powershell
.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8777
cd frontend; $env:NETDASH_BACKEND="8777"; npm run dev
```

Buka <http://localhost:5173>. Login default: **admin / netdash** (ganti lewat
Settings atau `NETDASH_PASSWORD`).

---

## Deployment ke server / PM2

`run-pm2.js` adalah entrypoint **khusus produksi/server**. Script ini tidak
membaca stdin, tidak butuh TTY, dan tidak menampilkan menu. PM2 bisa
me-restart-nya otomatis. Untuk development harian tetap pakai `anrouter`.

### Build lalu jalankan

```bash
cd frontend && npm run build && cd ..

pm2 start run-pm2.js --name "Dashboard-Router" -- --prod
pm2 save
pm2 startup          # ikuti instruksi yang dicetak PM2
```

Mode production hanya menjalankan **satu** proses backend; FastAPI menyajikan
`frontend/dist` langsung di `http://127.0.0.1:8777` tanpa Vite. Ini menghemat
RAM/CPU dibanding menjalankan Vite di server.

Alternatif: build otomatis saat PM2 start:

```bash
pm2 start run-pm2.js --name "Dashboard-Router" -- --build
```

Mode development di PM2 (backend + Vite, untuk server internal):

```bash
pm2 start run-pm2.js --name "Dashboard-Router"
```

Perintah harian:

```bash
pm2 logs Dashboard-Router
pm2 restart Dashboard-Router --update-env
pm2 stop Dashboard-Router
pm2 delete Dashboard-Router
```

### Virtual environment yang benar

PM2 **tidak** otomatis memakai `.venv` root. `run-pm2.js` memilih interpreter
dengan urutan:

1. `NETDASH_PYTHON` (kalau di-set),
2. `.venv/bin/python` (Linux/macOS) atau `.venv\Scripts\python.exe` (Windows),
3. `backend/.venv` (legacy),
4. `python3`/`python` dari `PATH`.

Interpreter pertama yang bisa meng-import **semua** dependency runtime dipakai,
dan pilihannya dicetak di log PM2:

```
[run-pm2] python: /path/to/super-router-dashboard/.venv/bin/python (project .venv)
```

Kalau ingin memaksa path tertentu:

```bash
NETDASH_PYTHON=/path/to/python pm2 start run-pm2.js --name "Dashboard-Router" -- --prod
# atau setelah terdaftar:
pm2 restart Dashboard-Router --update-env
```

### Port dan proses dobel

Default backend adalah **8777**. Sebelum start, `run-pm2.js` memeriksa port dan
berhenti dengan pesan jelas kalau port sudah dipakai. Ini mencegah kasus lama:
backend baru gagal bind, tetapi UI diam-diam bicara ke proses lama.

```bash
pm2 list
pm2 delete <nama-app-lama>
ss -ltnp | grep 8777
```

---

## Environment variables

### `backend/.env`

| Variabel | Wajib | Keterangan |
|---|---|---|
| `NETDASH_ROUTER_USER` | untuk Access Control | username login router ZTE |
| `NETDASH_ROUTER_PASS` | untuk Access Control | password router |
| `NETDASH_ROUTER_URL` | tidak | default `http://192.168.1.1` |
| `NETDASH_PASSWORD` | tidak | password login dashboard; default `netdash` |
| `NETDASH_PORT` | tidak | port backend; default `8777` |
| `NETDASH_HOST` | tidak | host bind backend; default `127.0.0.1` |
| `NETDASH_DATA` | tidak | direktori SQLite/config; default `backend/data` |

Contoh lengkap: [`backend/.env.example`](backend/.env.example).

### `frontend/.env`

| Variabel | Keterangan |
|---|---|
| `NETDASH_BACKEND` | port backend yang diproxy Vite (`/api` dan `/ws`); default `8777` |

Contoh: [`frontend/.env.example`](frontend/.env.example).

### Environment shell tambahan

| Variabel | Keterangan |
|---|---|
| `NETDASH_PYTHON` | paksa interpreter Python untuk `anrouter`/`run-pm2.js` |
| `NETDASH_MODE` | `production` untuk `run-pm2.js` tanpa argumen `--prod` |
| `NO_COLOR` | matikan warna di menu `anrouter` |

---

## Troubleshooting

### `No module named 'cryptography'`

**Root cause:** `cryptography` dipakai langsung oleh
`backend/app/zte_check.py` untuk menandatangani header `Check` router ZTE, tetapi
dulu tidak tercantum di `requirements.txt`. Akibatnya `pip install -r
backend/requirements.txt` tidak memasangnya. Masalah makin membingungkan karena
project bisa punya beberapa venv: package mungkin sudah dipasang manual ke
`backend/.venv`, sementara PM2/launcher memakai `.venv` root yang belum punya
`cryptography`.

Sekarang `cryptography` sudah menjadi dependency eksplisit, dan kedua launcher
memeriksa import sebelum start. Perbaiki environment dengan:

```bash
# Linux/macOS
.venv/bin/python -m pip install -r backend/requirements.txt
anrouter --doctor

# Windows
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
anrouter --doctor
```

Kalau memakai PM2:

```bash
pm2 restart Dashboard-Router --update-env
pm2 logs Dashboard-Router --lines 50
```

Pastikan log menampilkan `python: .../.venv/bin/python` dan tidak ada lagi
warning `could not build Check header`. Tanpa `cryptography`, router login dan
Access Control tidak bisa bekerja walaupun dashboard tetap tampil.

### Device list realtime tidak update

Gejala: halaman device tampil, tetapi status online/offline tidak berubah sampai
refresh. WebSocket memakai cookie session dan endpoint `/ws/live`.

Yang sudah diperbaiki:

- `LiveProvider` dulu langsung membuka WebSocket sebelum login selesai. Backend
  menolak dengan kode `1008`, dan client tidak pernah mencoba lagi setelah login.
  Sekarang koneksi menunggu user terautentikasi dan otomatis reconnect saat
  login/logout.
- Session yang kedaluwarsa tidak lagi mematikan realtime permanen; client
  mencoba ulang secara berkala.
- `anrouter`/PM2 memakai interpreter yang benar, sehingga backend tidak restart
  atau gagal karena dependency hilang.

Kalau masih bermasalah:

1. Pastikan membuka UI dan backend di origin yang benar. Development:
   <http://localhost:5173> (Vite memproxy `/ws` ke 8777). Production:
   <http://127.0.0.1:8777> (backend menyajikan `dist`).
2. Jangan membuka `127.0.0.1:5173` kalau Vite bind ke `localhost`/IPv6; gunakan
   URL yang dicetak Vite.
3. Cek log: `backend/server.log`, `frontend/dev.log`, atau
   `pm2 logs Dashboard-Router`.
4. Pastikan tidak ada dua backend di port berbeda. `anrouter --doctor` dan
   `ss -ltnp | grep 8777` membantu.
5. Setelah rebuild frontend, hard-refresh browser agar bundle lama tidak
   tertahan cache.

### `EADDRINUSE` / port 8777 sudah dipakai

```bash
pm2 list
pm2 delete <nama-app-lama>
ss -ltnp | grep 8777
anrouter --doctor
```

Jangan menjalankan `anrouter`, `run.sh`, dan PM2 secara bersamaan pada port yang
sama. `anrouter` sengaja mendeteksi backend yang sudah berjalan sebagai
`external` dan tidak akan mematikannya saat Exit.

### PM2 terus restart

Lihat `pm2 logs Dashboard-Router`. Penyebab umum:

- `.venv` belum berisi dependency → jalankan `pip install -r
  backend/requirements.txt`.
- Port 8777 dipakai proses lain → hapus app PM2 lama atau pakai `--port`.
- `frontend/dist/index.html` tidak ada di mode `--prod` → jalankan
  `npm run build` atau pakai `--build`.
- Interpreter yang dipilih bukan venv yang benar → set `NETDASH_PYTHON` lalu
  `pm2 restart ... --update-env`.

### Kick tidak berfungsi

Lihat bagian [Troubleshooting: kick tidak berfungsi](#troubleshooting-kick-tidak-berfungsi)
di bawah. Ringkasnya: butuh Administrator/root atau `cap_net_raw`, adapter LAN
yang benar, dan Npcap/libpcap.

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

## Menentukan SSID device (untuk Access Control)

Access Control di F670L bersifat **per-AP**, jadi rule harus diarahkan ke AP
yang benar. Kalau salah, router tetap menerima rule dan melaporkan sukses —
blokir jadi tidak berlaku tanpa error. Ini bug yang pernah ada: semua device
dikirim ke `default_wifi_interface` (AP6).

Sumber data, dari yang sudah diverifikasi langsung:

| Endpoint | Isi | Bisa tentukan SSID? |
|---|---|---|
| `topo_lua.lua` (Topology) | `AccessType` = 0 LAN / 1 2.4GHz / 2 5GHz | **Tidak** |
| DHCP (`landhcp*`) | hostname, IP, MAC, port | **Tidak** |
| `wlan_client_stat_lua.lua` | `AliasName` = AP per client, `ESSID`, `RXBytes`/`TXBytes` | **Ya** |

`topo_lua.lua` hanya memberi **band**, dan itu tidak cukup: pada router ini
**SSID5 dan SSID6 sama-sama 5 GHz** (keduanya `DEV.WIFI.RD2`), jadi tebakan
berdasarkan band salah ~50% waktu.

Sumber yang benar adalah **Local Network → Status → WLAN Client Status**
(`wlan_client_stat_lua.lua`), yang punya `AliasName` per client:

```
76:09:9E:D7:88:FD  TECNO-SPARK-Go-1  DEV.WIFI.AP5  AgraSec
C2:4A:22:70:1C:C8  OPPO-A16          DEV.WIFI.AP5  AgraSec
26:E3:D2:DE:86:84  A52-milik-Nur     DEV.WIFI.AP5  AgraSec
04:6C:59:7D:73:14  UNKNOWN-PC        DEV.WIFI.AP6  FAIZ
0E:39:4D:84:01:9C  Galaxy-A12        DEV.WIFI.AP1  FAIZ
```

Nama SSID asli (`FAIZ`, `AgraSec`) diambil dari
`wlan_macfilteraclpolicy_lua.lua`, yang juga memberi daftar AP dengan
`ACLPolicy` bukan `Disabled` - itu daftar AP yang bisa dipakai untuk block.

Perilaku `app/ssid_resolver.py`:

- `interface_for(mac)` mengembalikan AP yang sesuai, atau `''` kalau device
  tidak terdaftar sebagai client WLAN (mis. kabel).
- Tidak ada tebakan diam-diam. Kalau tidak ditemukan, kick **gagal dengan
  pesan jelas**, bukan menulis rule ke AP default.
- Setelah `block()`, rule dibaca balik dari router. Kalau interface yang
  tersimpan berbeda dari yang dimaksud, rule dibatalkan dan kick dilaporkan
  gagal — supaya "berhasil" tidak pernah berarti blokir tidak berlaku.
- Override manual per-MAC tersedia di Device Detail (dropdown "AP untuk blokir").

## Data pemakaian per device — tersedia

Ternyata router **ada** penghitung byte kumulatif per klien, di field tersembunyi
`RXBytes`/`TXBytes` pada halaman WLAN Client Status. Ini melengkapi kesimpulan
sebelumnya yang menyatakan tidak tersedia — DHCP dan Topology memang tidak
punya, tapi tabel ini punya.

Nilainya kumulatif sejak router boot (reset saat reboot), bukan data historis
per hari. Device Detail menampilkan total GB + SSID-nya.

## Performa

Pengukuran di jaringan test (10 perangkat):

| Metrik | Nilai |
|---|---|
| `/api/devices` | 28 ms |
| `/api/settings` | 41 ms |
| `/api/dashboard` | 55 ms |
| `/api/devices` saat scan jalan | maks 361 ms (tidak blocking) |
| Scan interval | 15 s (background, bukan blocking request) |

Tiga penyebab lag yang ditemukan, semuanya di frontend:

1. **Timer 1 Hz di shared context.** `tick` ada di `LiveState`, jadi setiap
   detik seluruh komponen `useLive()` render ulang — termasuk semua baris tabel
   device — walau tidak ada device yang sedang di-kick. Diukur **11 mutasi DOM
   per detik** pada halaman yang idle. Tick sekarang/context terpisah
   (`ClockCtx`) dan **berhenti total** saat tidak ada kick aktif, jadi hanya
   badge countdown yang render per detik.

2. **Identitas array devices berubah tiap tick.** `Date.now()` dipanggil di
   dalam `useMemo`, membuat array baru tiap detik. Sekarang `kicked`
   menyimpan epoch (stabil) dan `elapsedOf()` menghitung elapsed di badge.

3. **Paint mahal saat scroll.** `body::before` memakai `position: fixed` full
   viewport (repaint tiap frame scroll) dan tiap `.card` punya box-shadow
   dua-lapis. Sekarang `position: absolute` dan shadow satu lapis.

Baris tabel juga dibungkus `memo()` dengan key `mac` yang stabil, jadi scan
yang mengubah satu device tidak me-render ulang seluruh tabel.

Backend sudah baik dan tidak diubah: query ter-index, semua query history
pakai `LIMIT`, dan scan berjalan di background (`asyncio.to_thread`) tanpa
menge-block request API.

## Typography

Font: **Plus Jakarta Sans** (Google Fonts, `display=swap`) dengan fallback
sistem. Base font 15px, heading 700–800, angka statistik 2.75rem/800 dengan
`tabular-nums` supaya tidak bergeser saat digit berubah.

## Device fingerprinting

Hostname diambil dari halaman **Topology** router (panel "Access Devices
Information"), endpoint `/?_type=menuData&_tag=topo_lua.lua`. Ini satu-satunya
sumber nama DHCP di firmware ini; `accessdev_homepage_lua.lua` ternyata berisi
status WAN, bukan daftar lease.

Tipe device ditebak dari kombinasi hostname + vendor OUI (`app/fingerprint.py`):

| Urutan | Dasar | Hasil |
|---|---|---|
| 1 | Gateway | Router |
| 2 | `iPhone` / `iPad` / `MacBook` di hostname | Phone / Laptop |
| 2b | Vendor jaringan (ZTE, TP-Link, ...) **dan** hostname kosong | Router |
| 3 | `linux`, `ubuntu`, `raspberrypi`, atau vendor Raspberry Pi | Server |
| 4–5 | Vendor printer / TV | Printer / TV |
| 6 | Merek HP (Samsung, Xiaomi, OPPO, Tecno, Itel, ...) atau kode model | Phone |
| 7–8 | `desktop`, `laptop`, `cam`, `printer`, `tv` | Laptop / IoT |
| 9–10 | Vendor NIC + kabel, atau wired tanpa bukti lain | PC / Server |

**Kenapa vendor sering kosong:** iOS dan Android 10+ memakai *private MAC* per
SSID. Bit U/L di byte pertama MAC tersebut menyala, jadi prefix-nya acak dan
tidak ada di registry IEEE sama sekali. Ini perilaku yang benar, bukan lookup
yang gagal — field `randomized_mac` menandainya di API.

Hostname menang atas vendor: di jaringan ini AP-nya ZTE, dan beberapa ponsel
mewarisi prefix yang sama, sehingga pencocokan vendor-saja akan salah menandai
ponsel sebagai router.

Override manual tersimpan di `Device.type_override` dan menang atas tebakan.
Kirim `PATCH /api/devices/{mac}` dengan `{"type_override": "server"}`, atau `""`
untuk kembali ke deteksi otomatis.

## Device Apple dengan MAC acak — tidak bisa dideteksi otomatis

Diverifikasi langsung di jaringan ini untuk device `16:50:AD:B9:4A:FA`:

| Sumber | Hasil |
|---|---|
| OUI `16:50:AD` | tidak ada di registry IEEE |
| Bit U/L byte pertama | **menyala** → MAC private/random |
| Hostname dari router (`topo_lua.lua`) | kosong |
| Hostname dari `Action=Offline` | router juga tidak punya nama |
| Reverse DNS (`gethostbyaddr`) | `herror` |
| mDNS (224.0.0.251:5353) | tidak ada respons |
| Field vendor/OUI di payload topo | **tidak ada sama sekali** |

Jadi untuk device seperti ini **tidak ada sumber data yang bisa memastikan itu
Apple**. Nama "Apple device"-nya ada di DHCP request, tapi router ZTE F670L
tidak menyimpannya, dan iOS tidak memCAST nama modelnya lewat mDNS ke LAN
(iOS pada umumnya tidak mengirim respons mDNS ke LAN).

Kalau iOS kamu menyala "Private Wi-Fi Address" dengan mode **Rotating**,
nama DHCP juga ikut berubah tiap beberapa hari. Mode **Off** akan mengembalikan
nama device aslinya (mis. `iPhone-Ade`) dan netdash langsung bisa
mengenali-nya lewat hostname.

Yang dilakukan aplikasi:

- Ditambah `type_confident: false` di API. Device tanpa hostname + MAC acak
  ditandai label muted **"perlu dicek"** di kolom Tipe, bukan ditampilkan seolah
  diklasifikasi dengan yakin.
- Panel Device Detail menampilkan penjelasan kenapa tidak bisa dipastikan, dan
 dropdown tipe tersedia untuk memilih manual. Pilihan manual tersimpan dan
  menang atas tebakan.
- Deteksi Apple via hostname diperluas: `iPhone/iPad/iPod`, `MacBook*`,
  `iMac`, `mac-mini-*`, pola `<Model>-<Name>.local`, serta `Apple TV` → tipe
  TV. Ini menutup kasus di mana hostname ada tapi formatnya bukan kata
  "iPhone"/"iPad" polos.

Kalau device Apple kamu muncul sebagai "perlu dicek", isi manual sekali di
Device Detail — itu satu-satunya cara di firmware ini.

## Bandwidth per device — tidak tersedia

Router ZTE F670L **tidak** punya penghitung byte kumulatif per klien. Panel
adminnya hanya mengekspos laju sesaat per perangkat:

```
RxRateBps   TxRateBps      # bits/detik, sesaat
```

Selector "Real-time upstream / Real-time downstream" yang terlihat di Topology
adalah laju link, bukan akumulasi. Karena laptop ini bukan gateway, netdash
juga tidak bisa menghitung trafik device lain dari jaringan.

Yang ditampilkan di Device Detail karena itu: **laju saat ini** (RX/TX), plus
disclaimer eksplisit. Tidak ada angka GB yang dikarang.

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

Aplikasi ini tidak memakai `conf.iface`. Semua pengiriman ARP dipin ke adapter
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
Mode aktif, lalu **install ulang aplikasi** (`pip install -r
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
bin/
  anrouter.js        # command global cross-platform (menu, browser, cleanup)
lib/
  runtime.js         # deteksi Python/venv, npm, port, kill process tree
run-pm2.js           # entrypoint PM2/server (non-interaktif, --prod)
run.sh               # fallback Linux/macOS: backend saja
run.ps1              # fallback Windows: backend saja
package.json         # bin: anrouter, dependency prompts/open
backend/
  requirements.txt   # dependency Python lengkap + versi
  .env.example       # contoh kredensial router
  app/
    main.py          # FastAPI, semua endpoint, static SPA
    net.py           # ARP scan, OUI lookup, spoof engine
    scapy_arp.py     # konstruksi paket ARP (spoof + restore)
    scanner.py       # background scan loop, WebSocket hub
    db.py            # model SQLModel (Device, DeviceEvent, KickLog, ScanSample)
    auth.py          # session cookie + rate limiter
    config.py        # settings tersimpan di data/config.json
    oui_data.py      # database OUI IEEE (generated)
  test_api.sh          # smoke test API
  test_engine.py       # unit test engine + WebSocket
  test_kick_drill.py   # drill kick nyata
frontend/
  .env.example       # NETDASH_BACKEND untuk proxy Vite
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
