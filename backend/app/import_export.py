from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from app.config import ENV
from app.db import Database
from app.schemas import SchedulerSettings, WatchTargetInput
from app.targets import TargetRepository


def _first(raw: dict[str, Any], *keys: str, default=None):
    for key in keys:
        if key in raw:
            return raw[key]
    return default


def normalize_target(raw: dict[str, Any]) -> tuple[WatchTargetInput, UUID | None]:
    target = WatchTargetInput(
        name=_first(raw, "name", default=_first(raw, "satelliteName", "satellite_name", default="Satellite")),
        sat_id=_first(raw, "sat_id", "satelliteID", "satelliteId", "satellite_id"),
        norad_cat_id=_first(raw, "norad_cat_id", "noradCatID", "noradCatId"),
        satellite_name=_first(raw, "satellite_name", "satelliteName"),
        transmitter_uuid=_first(
            raw, "transmitter_uuid", "transmitterID", "transmitterId", "transmitter_id"
        ),
        transmitter_description=_first(raw, "transmitter_description", "transmitterDescription"),
        center_frequency=_first(raw, "center_frequency", "centerFrequency"),
        priority=float(_first(raw, "priority", default=1.0)),
        enabled=bool(_first(raw, "enabled", default=True)),
        requires_station_daylight=bool(
            _first(raw, "requires_station_daylight", "requireStationDaylight", default=False)
        ),
        daylight_solar_elevation=float(_first(raw, "daylight_solar_elevation", default=-6)),
        min_elevation=_first(raw, "min_elevation", "minElevation"),
        min_peak_elevation=_first(raw, "min_peak_elevation", "minPeakElevation"),
        max_peak_elevation=_first(raw, "max_peak_elevation", "maxPeakElevation"),
        min_azimuth=_first(raw, "min_azimuth", "minAzimuth"),
        max_azimuth=_first(raw, "max_azimuth", "maxAzimuth"),
        transmitter_success_rate=_first(raw, "transmitter_success_rate"),
        transmitter_good_count=_first(raw, "transmitter_good_count"),
        transmitter_max_good_count=_first(raw, "transmitter_max_good_count"),
    )
    raw_id = _first(raw, "id")
    try:
        target_id = UUID(str(raw_id)) if raw_id else None
    except ValueError:
        target_id = None
    return target, target_id


def export_configuration(database: Database, targets: TargetRepository) -> dict[str, Any]:
    values = targets.list()
    station_ids = [ENV.station_id] if ENV.station_id is not None else []
    ios_targets = [
        {
            "id": str(item.id),
            "name": item.name,
            "satelliteID": item.sat_id,
            "satelliteName": item.satellite_name,
            "transmitterID": item.transmitter_uuid,
            "transmitterDescription": item.transmitter_description,
            "centerFrequency": item.center_frequency,
            "requireStationDaylight": item.requires_station_daylight,
            "stationIDs": station_ids,
            "minElevation": item.min_elevation,
            "enabled": item.enabled,
            "minPeakElevation": item.min_peak_elevation,
            "maxPeakElevation": item.max_peak_elevation,
            "minAzimuth": item.min_azimuth,
            "maxAzimuth": item.max_azimuth,
            "priority": item.priority,
        }
        for item in values
    ]
    android_targets = [
        {
            "id": str(item.id),
            "name": item.name,
            "satelliteId": item.sat_id,
            "satelliteName": item.satellite_name,
            "transmitterId": item.transmitter_uuid,
            "transmitterDescription": item.transmitter_description,
            "centerFrequency": item.center_frequency,
            "stationIds": station_ids,
            "enabled": item.enabled,
            "requireStationDaylight": item.requires_station_daylight,
            "minElevation": item.min_elevation,
            "minPeakElevation": item.min_peak_elevation,
            "maxPeakElevation": item.max_peak_elevation,
            "minAzimuth": item.min_azimuth,
            "maxAzimuth": item.max_azimuth,
        }
        for item in values
    ]
    return {
        "format": "satscheduler.shared",
        "schema_version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "settings": get_exportable_settings(database),
        "watch_targets": [item.model_dump(mode="json") for item in values],
        "watchTargets": ios_targets,
        "androidWatchTargets": android_targets,
        "targets": android_targets,
    }


def export_mobile_targets(targets: TargetRepository, platform: str) -> Any:
    shared = export_configuration(targets.database, targets)
    if platform == "ios":
        return shared["watchTargets"]
    if platform == "android":
        return {
            "schemaVersion": 1,
            "exportedAt": shared["exported_at"],
            "targets": shared["androidWatchTargets"],
        }
    return shared


def get_exportable_settings(database: Database) -> dict[str, Any]:
    return SchedulerSettings.model_validate(
        database.get_setting("scheduler_settings", {})
    ).model_dump(mode="json")


def import_configuration(
    database: Database, targets: TargetRepository, payload: Any, replace: bool
) -> dict[str, int]:
    if isinstance(payload, list):
        raw_targets = payload
        settings = None
    else:
        raw_targets = (
            payload.get("watch_targets")
            or payload.get("watchTargets")
            or payload.get("androidWatchTargets")
            or payload.get("targets")
            or []
        )
        settings = payload.get("settings")
    normalized = [normalize_target(raw) for raw in raw_targets]
    if replace:
        with database.connection() as connection:
            connection.execute("DELETE FROM watch_targets")
    imported = 0
    for value, target_id in normalized:
        existing = targets.get(target_id) if target_id else None
        if existing:
            targets.update(existing.id, value)
        else:
            targets.create(value, target_id=target_id)
        imported += 1
    if settings:
        database.set_setting(
            "scheduler_settings",
            SchedulerSettings.model_validate(settings).model_dump(mode="json"),
        )
    return {"imported": imported}
