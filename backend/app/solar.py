from __future__ import annotations

import math
from datetime import datetime, timezone


def solar_elevation(date: datetime, latitude: float, longitude: float) -> float:
    date = date.astimezone(timezone.utc)
    julian_day = date.timestamp() / 86400.0 + 2440587.5
    century = (julian_day - 2451545.0) / 36525.0
    mean_longitude = (280.46646 + century * (36000.76983 + century * 0.0003032)) % 360
    mean_anomaly = 357.52911 + century * (35999.05029 - 0.0001537 * century)
    eccentricity = 0.016708634 - century * (0.000042037 + 0.0000001267 * century)
    rad = math.radians
    center = (
        math.sin(rad(mean_anomaly)) * (1.914602 - century * (0.004817 + 0.000014 * century))
        + math.sin(rad(2 * mean_anomaly)) * (0.019993 - 0.000101 * century)
        + math.sin(rad(3 * mean_anomaly)) * 0.000289
    )
    true_longitude = mean_longitude + center
    omega = 125.04 - 1934.136 * century
    apparent_longitude = true_longitude - 0.00569 - 0.00478 * math.sin(rad(omega))
    mean_obliquity = 23 + (
        26 + (21.448 - century * (46.815 + century * (0.00059 - century * 0.001813))) / 60
    ) / 60
    obliquity = mean_obliquity + 0.00256 * math.cos(rad(omega))
    declination = math.asin(math.sin(rad(obliquity)) * math.sin(rad(apparent_longitude)))
    y = math.tan(rad(obliquity / 2)) ** 2
    equation_of_time = 4 * math.degrees(
        y * math.sin(2 * rad(mean_longitude))
        - 2 * eccentricity * math.sin(rad(mean_anomaly))
        + 4 * eccentricity * y * math.sin(rad(mean_anomaly)) * math.cos(2 * rad(mean_longitude))
        - 0.5 * y * y * math.sin(4 * rad(mean_longitude))
        - 1.25 * eccentricity * eccentricity * math.sin(2 * rad(mean_anomaly))
    )
    minutes = date.hour * 60 + date.minute + date.second / 60
    true_solar_time = (minutes + equation_of_time + 4 * longitude) % 1440
    hour_angle = true_solar_time / 4 + 180 if true_solar_time / 4 < 0 else true_solar_time / 4 - 180
    cosine_zenith = (
        math.sin(rad(latitude)) * math.sin(declination)
        + math.cos(rad(latitude)) * math.cos(declination) * math.cos(rad(hour_angle))
    )
    return 90 - math.degrees(math.acos(max(-1, min(1, cosine_zenith))))

