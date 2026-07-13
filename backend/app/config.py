from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def _optional_float(name: str) -> float | None:
    value = os.getenv(name, "").strip()
    return float(value) if value else None


def _optional_int(name: str) -> int | None:
    value = os.getenv(name, "").strip()
    return int(value) if value else None


@dataclass(frozen=True, slots=True)
class EnvironmentSettings:
    api_token: str
    station_id: int | None
    latitude: float | None
    longitude: float | None
    altitude_m: float | None
    station_timezone: str
    database_path: Path
    log_level: str

    @classmethod
    def load(cls) -> "EnvironmentSettings":
        timezone_name = os.getenv("STATION_TIMEZONE", "UTC").strip() or "UTC"
        try:
            ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError:
            timezone_name = "UTC"
        return cls(
            api_token=os.getenv("SATNOGS_API_TOKEN", "").strip(),
            station_id=_optional_int("SATNOGS_STATION_ID"),
            latitude=_optional_float("STATION_LATITUDE"),
            longitude=_optional_float("STATION_LONGITUDE"),
            altitude_m=_optional_float("STATION_ALTITUDE_M"),
            station_timezone=timezone_name,
            database_path=Path(os.getenv("DATABASE_PATH", "./data/satscheduler.db")),
            log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
        )


ENV = EnvironmentSettings.load()

