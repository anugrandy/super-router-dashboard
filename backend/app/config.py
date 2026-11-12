"""Runtime configuration, persisted to a JSON file so the UI can change it."""
from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent.parent

# Load backend/.env before anything reads os.environ for router credentials.
# Must run at import time so every entrypoint (uvicorn, tests, scripts) picks
# it up without needing manual `set` in each new terminal.
load_dotenv(BASE_DIR / ".env", override=False)

DATA_DIR = Path(os.environ.get("NETDASH_DATA", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_PATH = DATA_DIR / "config.json"
DB_PATH = DATA_DIR / "netdash.db"


class Settings(BaseModel):
    subnet: str = "192.168.1.0/24"
    interface: str | None = None
    scan_interval: float = Field(default=15.0, ge=5.0, le=3600.0)
    gateway_mac: str | None = None
    whitelist_macs: list[str] = Field(default_factory=list)
    kick_max_seconds: int = Field(default=600, ge=10, le=86400)
    oui_file: str | None = None
    # "router" = block MAC via the router's Access Control (reliable, works on
    # iOS/Android). "arp" = legacy ARP spoofing fallback. See net.KickEngine.
    kick_mode: str = "router"
    # Default SSID interface for router access-control rules, e.g. DEV.WIFI.AP6.
    default_wifi_interface: str = "DEV.WIFI.AP6"
    # Per-device override: {MAC_UPPER: DEV.WIFI.APn}
    wifi_interface_map: dict[str, str] = Field(default_factory=dict)
    username: str = "admin"
    # Optional friendly name shown in the sidebar. Empty means "use username".
    display_name: str = ""
    # Override with env NETDASH_PASSWORD; otherwise a generated one is stored.
    password_hash: str = ""
    session_secret: str = ""


def _hash(password: str) -> str:
    import hashlib

    return hashlib.sha256(("netdash:" + password).encode()).hexdigest()


def default_config() -> Settings:
    pw = os.environ.get("NETDASH_PASSWORD") or "netdash"
    return Settings(password_hash=_hash(pw), session_secret=os.urandom(16).hex())


class ConfigStore:
    def __init__(self) -> None:
        self._settings = self._load()

    def _load(self) -> Settings:
        if CONFIG_PATH.exists():
            try:
                return Settings(**json.loads(CONFIG_PATH.read_text()))
            except Exception:
                pass
        s = default_config()
        self._save(s)
        return s

    def _save(self, s: Settings) -> None:
        CONFIG_PATH.write_text(json.dumps(s.model_dump(), indent=2))

    @property
    def settings(self) -> Settings:
        return self._settings

    def update(self, **changes) -> Settings:
        """Apply non-secret changes; password/session fields are never settable here."""
        data = self._settings.model_dump()
        for key, value in changes.items():
            if key in ("password_hash", "session_secret", "password"):
                continue
            # An explicit None clears the field. Callers that mean "leave it
            # alone" omit the key instead of sending null.
            data[key] = value
        self._settings = Settings(**data)
        self._save(self._settings)
        return self._settings

    def set_password(self, password: str) -> None:
        self._settings.password_hash = _hash(password)
        self._save(self._settings)

    def check_password(self, password: str) -> bool:
        import hmac

        return hmac.compare_digest(self._settings.password_hash, _hash(password))


config_store = ConfigStore()
settings = config_store.settings
