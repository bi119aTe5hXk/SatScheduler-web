from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from skyfield.api import EarthSatellite, load, wgs84


timescale = load.timescale()


def _aware(value: str | None, fallback: datetime) -> datetime:
    if not value:
        return fallback
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return fallback
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _subpoint(satellite: EarthSatellite, value: datetime) -> dict[str, Any]:
    point = wgs84.subpoint(satellite.at(timescale.from_datetime(value)))
    return {
        "time": value.isoformat(),
        "latitude": float(point.latitude.degrees),
        "longitude": float(point.longitude.degrees),
    }


def observation_ground_track(observation: dict[str, Any]) -> dict[str, Any]:
    tle1, tle2 = observation.get("tle1"), observation.get("tle2")
    if not tle1 or not tle2:
        raise ValueError("Observation does not include TLE data")

    now = datetime.now(timezone.utc)
    start = _aware(observation.get("start"), now)
    end = _aware(observation.get("end"), start + timedelta(minutes=15))
    window_start = min(start, now) - timedelta(minutes=50)
    window_end = max(end, now) + timedelta(minutes=50)
    if window_end - window_start > timedelta(hours=3):
        window_start, window_end = now - timedelta(minutes=50), now + timedelta(minutes=50)

    satellite = EarthSatellite(tle1, tle2, observation.get("tle0") or "", timescale)
    samples = 121
    step = (window_end - window_start) / (samples - 1)
    points = [_subpoint(satellite, window_start + step * index) for index in range(samples)]

    station_lat = observation.get("station_lat")
    station_lng = observation.get("station_lng")
    station = (
        {"latitude": float(station_lat), "longitude": float(station_lng)}
        if station_lat is not None and station_lng is not None
        else None
    )
    return {
        "observation_id": observation.get("id"),
        "satellite_name": observation.get("satellite_name") or observation.get("tle0"),
        "current": _subpoint(satellite, now),
        "points": points,
        "station": station,
    }
