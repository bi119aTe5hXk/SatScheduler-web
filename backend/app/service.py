from __future__ import annotations

from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.config import ENV
from app.db import Database
from app.schemas import SchedulerSettings, StationConfig
from app.satnogs import SatNOGSClient


SETTINGS_KEY = "scheduler_settings"


def get_scheduler_settings(database: Database) -> SchedulerSettings:
    raw = database.get_setting(SETTINGS_KEY, {})
    return SchedulerSettings.model_validate(raw)


def save_scheduler_settings(database: Database, value: SchedulerSettings) -> None:
    database.set_setting(SETTINGS_KEY, value.model_dump(mode="json"))


async def resolve_station(database: Database, client: SatNOGSClient) -> StationConfig:
    saved: dict[str, Any] = database.get_setting("station_config", {})
    station_id = ENV.station_id or saved.get("station_id")
    if not station_id:
        raise ValueError("SATNOGS_STATION_ID is not configured")

    remote: dict[str, Any] = {}
    if ENV.latitude is None or ENV.longitude is None or ENV.altitude_m is None:
        remote, _ = await client.station(int(station_id))

    latitude = ENV.latitude if ENV.latitude is not None else saved.get("latitude", remote.get("lat"))
    longitude = ENV.longitude if ENV.longitude is not None else saved.get("longitude", remote.get("lng"))
    altitude = ENV.altitude_m if ENV.altitude_m is not None else saved.get("altitude_m", remote.get("altitude"))
    timezone_name = ENV.station_timezone or saved.get("timezone", "UTC")
    try:
        ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        timezone_name = "UTC"
    if latitude is None or longitude is None or altitude is None:
        raise ValueError("station latitude, longitude and altitude are required")
    return StationConfig(
        station_id=int(station_id),
        latitude=float(latitude),
        longitude=float(longitude),
        altitude_m=float(altitude),
        timezone=timezone_name,
        station_name=remote.get("name") or saved.get("station_name"),
    )

