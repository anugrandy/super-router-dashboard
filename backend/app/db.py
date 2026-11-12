from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Field, SQLModel, create_engine, Session, select

from .config import DB_PATH, config_store

engine = create_engine(
    f"sqlite:///{DB_PATH.as_posix()}",
    connect_args={"check_same_thread": False},
)


def utcnow() -> datetime:
    """Timezone-aware UTC. SQLModel's DateTime columns require tz-aware values."""
    return datetime.now(timezone.utc)


class NetworkProfile(SQLModel, table=True):
    """One physical network this dashboard has ever seen.

    Identified by the gateway's MAC first (the most stable signal: a router
    keeps its address when the subnet or SSID changes). SSID is stored as extra
    context, and subnet + gateway IP are only the fallback identity when no
    gateway MAC can be resolved. Every device/history row points at one of
    these, so the same phone can be a separate row on two networks.
    """

    __tablename__ = "network_profiles"

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    # "gw:AA:BB:..." when the gateway MAC is known, else "net:<subnet>|<ip>".
    fingerprint: str = Field(index=True, unique=True)
    gateway_mac: str = Field(default="", index=True)
    ssid: str = ""
    subnet: str = ""
    gateway_ip: str = ""
    created_at: datetime = Field(default_factory=utcnow)
    last_seen_at: datetime = Field(default_factory=utcnow)
    # Exactly one profile is active at a time: the network the backend is
    # physically connected to right now. Historical profiles are read-only for
    # kick/scan purposes.
    is_active: bool = Field(default=False, index=True)


class Device(SQLModel, table=True):
    __tablename__ = "devices"

    id: int | None = Field(default=None, primary_key=True)
    # MAC is unique *within* a network profile, not globally: the same physical
    # device seen on two networks gets one row per profile.
    network_profile_id: int | None = Field(default=None, index=True)
    mac: str = Field(index=True)
    ip: str = ""
    hostname: str = ""
    vendor: str = ""
    device_type: str = "unknown"
    nickname: str = ""
    is_gateway: bool = False
    first_seen: datetime = Field(default_factory=utcnow)
    last_seen: datetime = Field(default_factory=utcnow)
    last_online: datetime | None = None
    online: bool = False
    is_static: bool = False
    # Set by the user from the device page. When non-empty it wins over the
    # automatic guess, so a misclassification can be corrected permanently.
    type_override: str = ""
    # simple-icons slug (e.g. "samsung") chosen by the user. Empty means the
    # brand is derived automatically from the OUI vendor and hostname.
    brand_override: str = ""
    # Router-reported: hostnames and instantaneous link rates. No cumulative
    # byte counter exists on this firmware, so usage totals are not stored.
    rx_rate_bps: int = 0
    tx_rate_bps: int = 0
    link_band: str = ""
    # From wlan_client_stat: the exact AP this device is associated with and
    # its SSID name. Used to target Access Control rules at the right AP.
    wifi_interface: str = ""
    ssid_name: str = ""
    # Cumulative counters - unlike rx/tx_rate_bps these are totals, not rates.
    rx_bytes: int = 0
    tx_bytes: int = 0
    # Consecutive scans in which the device was not seen. A single miss is not
    # enough to call it offline: one lost ARP reply from a Wi-Fi client in
    # power save used to make phones flap online/offline every other scan.
    missed_scans: int = 0
    # True for the host running this backend. ARP never sees its own sender, so
    # the scanner injects it explicitly; it is always online by definition.
    is_self: bool = False
    # Best-effort OS guess (Windows/Linux/Android/macOS/iOS/...) plus how much
    # evidence backs it. Kept separate from device_type because a phone vendor
    # can run Android or iOS and a PC can run Windows/Linux/macOS.
    os_guess: str = ""
    os_confidence: str = ""  # high | medium | low
    os_evidence: str = ""


class SpeedtestRun(SQLModel, table=True):
    """History of manually triggered speedtests.

    Rows are only written when a user presses the button - nothing samples this
    on a timer, because a speedtest saturates the link.
    """

    __tablename__ = "speedtest_runs"

    id: int | None = Field(default=None, primary_key=True)
    at: datetime = Field(default_factory=utcnow, index=True)
    download_mbps: float = 0.0
    upload_mbps: float = 0.0
    ping_ms: float = 0.0
    server_name: str = ""
    server_sponsor: str = ""
    client_isp: str = ""
    ok: bool = True
    error: str = ""


class DeviceApSeen(SQLModel, table=True):
    """History of which APs a device has been associated with.

    A client that roams between bands keeps one MAC but shows up on different
    ``DEV.WIFI.APn`` interfaces. Access Control is per-AP, so blocking only the
    interface the device happens to be on right now leaves it able to reconnect
    on another. Every interface in this table is a candidate target.
    """

    __tablename__ = "device_ap_seen"

    id: int | None = Field(default=None, primary_key=True)
    network_profile_id: int | None = Field(default=None, index=True)
    mac: str = Field(index=True)
    interface: str = Field(index=True)
    ssid_name: str = ""
    first_seen: datetime = Field(default_factory=utcnow)
    last_seen: datetime = Field(default_factory=utcnow)
    times_seen: int = 1


class DeviceEvent(SQLModel, table=True):
    """Connection/disconnection history."""

    __tablename__ = "device_events"

    id: int | None = Field(default=None, primary_key=True)
    network_profile_id: int | None = Field(default=None, index=True)
    mac: str = Field(index=True)
    kind: str  # online | offline
    at: datetime = Field(default_factory=utcnow, index=True)
    ip: str = ""


class WanEvent(SQLModel, table=True):
    """Internet (WAN) connection/disconnection history.

    Separate from DeviceEvent because an outage affects the whole network and
    must not be mistaken for one device dropping off.
    """

    __tablename__ = "wan_events"

    id: int | None = Field(default=None, primary_key=True)
    kind: str  # connected | disconnected
    at: datetime = Field(default_factory=utcnow, index=True)
    ipv4_address: str = ""
    connection_name: str = ""
    reason: str = ""
    online_seconds: int = 0
    note: str = ""


class KickLog(SQLModel, table=True):
    __tablename__ = "kick_logs"

    id: int | None = Field(default=None, primary_key=True)
    network_profile_id: int | None = Field(default=None, index=True)
    mac: str = Field(index=True)
    ip: str = ""
    actor: str = ""
    started_at: datetime = Field(default_factory=utcnow, index=True)
    ended_at: datetime | None = None
    duration_seconds: int | None = None
    reason: str = ""
    active: bool = True
    # "router" (access-control block) or "arp" (spoof fallback).
    mode: str = "router"
    # Router-assigned rule id from the Apply response (e.g. "DEV.ACL2").
    # Required to delete the rule later; survives a backend restart.
    router_inst_id: str = ""
    # Every ACL instance created for one kick. A kick can span several APs, so a
    # single inst_id is not enough to clean up afterwards. Comma-separated to
    # keep the migration simple: e.g. "DEV.ACL1,DEV.ACL3".
    router_inst_ids: str = ""
    # Which half of the combined kick actually landed.
    router_blocked: bool = False
    arp_active: bool = False
    # SSID/interface the rule was written against, e.g. DEV.WIFI.AP6.
    wifi_interface: str = ""
    # Error text from the router half, surfaced in the UI.
    router_error: str = ""


class ScanSample(SQLModel, table=True):
    """Device-count time series for the dashboard chart."""

    __tablename__ = "scan_samples"

    id: int | None = Field(default=None, primary_key=True)
    network_profile_id: int | None = Field(default=None, index=True)
    at: datetime = Field(default_factory=utcnow, index=True)
    online: int = 0
    total: int = 0


# Columns added after the first release. SQLModel's create_all() will NOT add
# columns to an existing table, so an upgraded database kept failing every
# INSERT with "table kick_logs has no column named mode". Migrate explicitly.
MIGRATIONS: dict[str, dict[str, str]] = {
    "kick_logs": {
        "network_profile_id": "INTEGER",
        "mode": "TEXT NOT NULL DEFAULT 'router'",
        "router_inst_id": "TEXT NOT NULL DEFAULT ''",
        "router_inst_ids": "TEXT NOT NULL DEFAULT ''",
        "router_blocked": "BOOLEAN NOT NULL DEFAULT 0",
        "arp_active": "BOOLEAN NOT NULL DEFAULT 0",
        "wifi_interface": "TEXT NOT NULL DEFAULT ''",
        "router_error": "TEXT NOT NULL DEFAULT ''",
    },
    "devices": {
        "network_profile_id": "INTEGER",
        "is_static": "BOOLEAN NOT NULL DEFAULT 0",
        "type_override": "TEXT NOT NULL DEFAULT ''",
        "brand_override": "TEXT NOT NULL DEFAULT ''",
        "rx_rate_bps": "INTEGER NOT NULL DEFAULT 0",
        "tx_rate_bps": "INTEGER NOT NULL DEFAULT 0",
        "link_band": "TEXT NOT NULL DEFAULT ''",
        "wifi_interface": "TEXT NOT NULL DEFAULT ''",
        "ssid_name": "TEXT NOT NULL DEFAULT ''",
        "rx_bytes": "INTEGER NOT NULL DEFAULT 0",
        "tx_bytes": "INTEGER NOT NULL DEFAULT 0",
        "missed_scans": "INTEGER NOT NULL DEFAULT 0",
        "is_self": "BOOLEAN NOT NULL DEFAULT 0",
        "os_guess": "TEXT NOT NULL DEFAULT ''",
        "os_confidence": "TEXT NOT NULL DEFAULT ''",
        "os_evidence": "TEXT NOT NULL DEFAULT ''",
    },
    "device_events": {"network_profile_id": "INTEGER"},
    "device_ap_seen": {"network_profile_id": "INTEGER"},
    "scan_samples": {"network_profile_id": "INTEGER"},
}


def _default_gateway_ip(subnet: str) -> str:
    try:
        import ipaddress

        return str(ipaddress.ip_network(subnet, strict=False).network_address + 1)
    except ValueError:
        return "192.168.1.1"


def _legacy_profile(cur) -> tuple[str, str, str]:
    """Return (fingerprint, gateway_mac, subnet) for a pre-profile database.

    Gateway MAC is the strongest identity; when no row is flagged as the
    gateway yet, fall back to the configured subnet + first usable host. That
    is exactly the same fallback `app.profiles` uses, so the first real scan
    after upgrading resolves to this profile instead of creating a duplicate.
    """
    row = cur.execute(
        "SELECT mac FROM devices WHERE is_gateway = 1 "
        "AND mac IS NOT NULL AND mac != '' LIMIT 1"
    ).fetchone()
    gateway_mac = (row[0] or "") if row else ""
    subnet = config_store.settings.subnet
    if gateway_mac:
        return f"gw:{gateway_mac.upper()}", gateway_mac.upper(), subnet
    return f"net:{subnet}|{_default_gateway_ip(subnet)}", "", subnet


def _migrate() -> list[str]:
    """ALTER TABLE ... ADD COLUMN for anything the schema gained since.

    Also performs the one-time Network Profiles upgrade: if the database has
    rows from before profiles existed, they all move into a single default
    profile named "Rumah" and the old global unique index on `devices.mac`
    becomes a composite unique index on (profile, mac).
    """
    import sqlite3

    applied: list[str] = []
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.cursor()
        existing_tables = {
            r[0] for r in cur.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        for table, cols in MIGRATIONS.items():
            if table not in existing_tables:
                continue
            have = {r[1] for r in cur.execute(f"PRAGMA table_info({table})")}
            for col, ddl in cols.items():
                if col not in have:
                    cur.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
                    applied.append(f"{table}.{col}")

        # Every table that carries a profile id. Used for the legacy backfill.
        scoped = [
            "devices",
            "device_events",
            "kick_logs",
            "scan_samples",
            "device_ap_seen",
        ]
        scoped = [t for t in scoped if t in existing_tables]

        profile_id = None
        if "network_profiles" in existing_tables:
            profile_id = cur.execute(
                "SELECT id FROM network_profiles ORDER BY id LIMIT 1"
            ).fetchone()
            profile_id = profile_id[0] if profile_id else None

        has_data = False
        for table in scoped:
            if cur.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone():
                has_data = True
                break

        if profile_id is None and has_data:
            fingerprint, gateway_mac, subnet = _legacy_profile(cur)
            gateway_ip = _default_gateway_ip(subnet)
            now = datetime.now(timezone.utc).isoformat()
            cur.execute(
                "INSERT INTO network_profiles "
                "(name, fingerprint, gateway_mac, ssid, subnet, gateway_ip, "
                " created_at, last_seen_at, is_active) "
                "VALUES (?, ?, ?, '', ?, ?, ?, ?, 1)",
                ("Rumah", fingerprint, gateway_mac, subnet, gateway_ip, now, now),
            )
            profile_id = cur.lastrowid
            applied.append("network_profiles.default")

        if profile_id is not None:
            for table in scoped:
                cur.execute(
                    f"UPDATE {table} SET network_profile_id = ? "
                    "WHERE network_profile_id IS NULL",
                    (profile_id,),
                )

        # The old `mac` index was globally unique, which would prevent the same
        # MAC from existing once per profile. Replace it with a non-unique
        # lookup index and a unique (profile, mac) index.
        if "devices" in existing_tables:
            for row in cur.execute("PRAGMA index_list(devices)").fetchall():
                name, unique = row[1], row[2]
                if name == "ix_devices_mac" and unique:
                    cur.execute("DROP INDEX ix_devices_mac")
                    cur.execute("CREATE INDEX ix_devices_mac ON devices(mac)")
                    applied.append("devices.mac index non-unique")
            cur.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_devices_profile_mac "
                "ON devices(network_profile_id, mac)"
            )
        conn.commit()
    finally:
        conn.close()
    return applied


def init_db() -> None:
    SQLModel.metadata.create_all(engine)
    added = _migrate()
    if added:
        import logging

        logging.getLogger("netdash.db").info(
            "migrated database, added columns: %s", ", ".join(added)
        )


def get_session() -> Session:
    return Session(engine)
