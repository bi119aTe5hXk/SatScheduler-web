from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from app.config import ENV
from app.db import Database
from app.schemas import SchedulerSettings, StationConfig, WatchTargetInput
from app.targets import TargetRepository


def _first(raw: dict[str, Any], *keys: str, default=None):
    for key in keys:
        if key in raw:
            return raw[key]
    return default


def _station_min_horizon(raw: dict[str, Any]) -> float | None:
    snapshots = _first(raw, "stationSnapshots", "station_snapshots", default={})
    if not isinstance(snapshots, dict) or not snapshots:
        return None

    preferred_ids: list[Any] = []
    if ENV.station_id is not None:
        preferred_ids.append(ENV.station_id)
    station_ids = _first(raw, "stationIDs", "stationIds", "station_ids", default=[])
    if isinstance(station_ids, list):
        preferred_ids.extend(station_ids)

    for station_id in preferred_ids:
        snapshot = snapshots.get(str(station_id), snapshots.get(station_id))
        if isinstance(snapshot, dict):
            value = _first(snapshot, "minHorizon", "min_horizon")
            if value is not None:
                return float(value)

    for snapshot in snapshots.values():
        if isinstance(snapshot, dict):
            value = _first(snapshot, "minHorizon", "min_horizon")
            if value is not None:
                return float(value)
    return None


def normalize_target(raw: dict[str, Any]) -> tuple[WatchTargetInput, UUID | None]:
    if not isinstance(raw, dict):
        raise ValueError("each imported target must be a JSON object")
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
        min_elevation=_first(
            raw, "min_elevation", "minElevation", default=_station_min_horizon(raw)
        ),
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


def _ios_target(item: Any, station: StationConfig | None) -> dict[str, Any]:
    station_ids = [station.station_id] if station else []
    station_names: dict[str, str] = {}
    station_snapshots: dict[str, dict[str, Any]] = {}
    if station:
        station_key = str(station.station_id)
        station_name = station.station_name or f"Station {station.station_id}"
        station_names[station_key] = station_name
        station_snapshots[station_key] = {
            "altitude": station.altitude_m,
            "id": station.station_id,
            "latitude": station.latitude,
            "longitude": station.longitude,
            "minHorizon": item.min_elevation,
            "name": station_name,
        }

    result: dict[str, Any] = {
        "enabled": item.enabled,
        "id": str(item.id).upper(),
        "name": item.name,
        "satelliteID": item.sat_id,
        "stationIDs": station_ids,
        "stationNames": station_names,
        "stationSnapshots": station_snapshots,
    }
    optional = {
        "satelliteName": item.satellite_name,
        "transmitterID": item.transmitter_uuid,
        "transmitterDescription": item.transmitter_description,
        "centerFrequency": item.center_frequency,
        "minElevation": item.min_elevation,
        "minPeakElevation": item.min_peak_elevation,
        "maxPeakElevation": item.max_peak_elevation,
        "minAzimuth": item.min_azimuth,
        "maxAzimuth": item.max_azimuth,
    }
    result.update({key: value for key, value in optional.items() if value is not None})
    if item.requires_station_daylight:
        result["requireStationDaylight"] = True
    return result


def export_configuration(
    targets: TargetRepository, station: StationConfig | None = None
) -> dict[str, Any]:
    exported_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    return {
        "exportedAt": exported_at.replace("+00:00", "Z"),
        "schemaVersion": 1,
        "targets": [_ios_target(item, station) for item in targets.list()],
    }


def _save_imported_station(database: Database, raw_targets: list[Any]) -> None:
    for raw in raw_targets:
        if not isinstance(raw, dict):
            continue
        station_ids = _first(raw, "stationIDs", "stationIds", "station_ids", default=[])
        snapshots = _first(raw, "stationSnapshots", "station_snapshots", default={})
        names = _first(raw, "stationNames", "station_names", default={})
        if not isinstance(station_ids, list) or not isinstance(snapshots, dict):
            continue
        station_id = ENV.station_id
        if station_id is None and station_ids:
            station_id = station_ids[0]
        if station_id is None:
            continue
        snapshot = snapshots.get(str(station_id), snapshots.get(station_id))
        if not isinstance(snapshot, dict):
            continue

        saved: dict[str, Any] = database.get_setting("station_config", {})
        station_name = None
        if isinstance(names, dict):
            station_name = names.get(str(station_id), names.get(station_id))
        saved.update(
            {
                "station_id": int(station_id),
                "latitude": _first(snapshot, "latitude", "lat"),
                "longitude": _first(snapshot, "longitude", "lng"),
                "altitude_m": _first(snapshot, "altitude", "altitude_m"),
                "station_name": station_name or snapshot.get("name"),
            }
        )
        database.set_setting("station_config", saved)
        return


def _configured_station_id(database: Database) -> int:
    if ENV.station_id is not None:
        return int(ENV.station_id)
    saved: dict[str, Any] = database.get_setting("station_config", {})
    station_id = saved.get("station_id")
    if station_id is None:
        raise ValueError("the station ID must be configured before importing a watch list")
    return int(station_id)


def _target_has_station(raw: Any, station_id: int) -> bool:
    if not isinstance(raw, dict):
        return False
    station_ids = _first(raw, "stationIDs", "stationIds", "station_ids", default=[])
    if not isinstance(station_ids, list):
        return False
    for value in station_ids:
        try:
            if int(value) == station_id:
                return True
        except (TypeError, ValueError):
            continue
    return False


def import_configuration(
    database: Database, targets: TargetRepository, payload: Any, replace: bool
) -> dict[str, int]:
    if isinstance(payload, list):
        raw_targets = payload
        settings = None
    elif isinstance(payload, dict):
        # `targets` is the canonical iOS/Android field. The others remain accepted so
        # exports made by early SatScheduler Web builds can still be restored.
        for key in ("targets", "watch_targets", "watchTargets", "androidWatchTargets"):
            if key in payload:
                raw_targets = payload[key]
                break
        else:
            raise ValueError("the import file does not contain a targets array")
        settings = payload.get("settings")
    else:
        raise ValueError("the import file must contain a JSON object or array")
    if not isinstance(raw_targets, list):
        raise ValueError("the import file's targets field must be an array")

    station_id = _configured_station_id(database)
    matching_targets = [raw for raw in raw_targets if _target_has_station(raw, station_id)]
    skipped = len(raw_targets) - len(matching_targets)
    normalized = [normalize_target(raw) for raw in matching_targets]
    _save_imported_station(database, matching_targets)
    # A file containing only targets for another station must not erase the current list.
    if replace and (normalized or not raw_targets):
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
    if settings and (normalized or not raw_targets):
        database.set_setting(
            "scheduler_settings",
            SchedulerSettings.model_validate(settings).model_dump(mode="json"),
        )
    return {"imported": imported, "skipped_station_mismatch": skipped}
