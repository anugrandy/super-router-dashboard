from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Field, SQLModel, create_engine, Session, select

from .config import DB_PATH

engine = create_engine(
    f"sqlite:///{DB_PATH.as_posix()}",
    connect_args={"check_same_thread": False},
)


def utcnow() -> datetime:
    """Timezone-aware UTC. SQLModel's DateTime columns require tz-aware values."""
    return datetime.now(timezone.utc)


class Device(SQLModel, table=True):
    __tablename__ = "devices"

    id: int | None = Field(default=None, primary_key=True)
    mac: str = Field(index=True, unique=True)
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


class DeviceEvent(SQLModel, table=True):
    """Connection/disconnection history."""

    __tablename__ = "device_events"

    id: int | None = Field(default=None, primary_key=True)
    mac: str = Field(index=True)
    kind: str  # online | offline
    at: datetime = Field(default_factory=utcnow, index=True)
    ip: str = ""


class KickLog(SQLModel, table=True):
    __tablename__ = "kick_logs"

    id: int | None = Field(default=None, primary_key=True)
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
    at: datetime = Field(default_factory=utcnow, index=True)
    online: int = 0
    total: int = 0


# Columns added after the first release. SQLModel's create_all() will NOT add
# columns to an existing table, so an upgraded database kept failing every
# INSERT with "table kick_logs has no column named mode". Migrate explicitly.
MIGRATIONS: dict[str, dict[str, str]] = {
    "kick_logs": {
        "mode": "TEXT NOT NULL DEFAULT 'router'",
        "router_inst_id": "TEXT NOT NULL DEFAULT ''",
        "router_blocked": "BOOLEAN NOT NULL DEFAULT 0",
        "arp_active": "BOOLEAN NOT NULL DEFAULT 0",
        "wifi_interface": "TEXT NOT NULL DEFAULT ''",
        "router_error": "TEXT NOT NULL DEFAULT ''",
    },
    "devices": {
        "is_static": "BOOLEAN NOT NULL DEFAULT 0",
    },
}


def _migrate() -> list[str]:
    """ALTER TABLE ... ADD COLUMN for anything the schema gained since."""
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
