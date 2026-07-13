from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone

from skyfield.api import EarthSatellite, load, wgs84

from app.schemas import PredictionEngineName, PredictedPass, StationConfig, TLE, WatchTarget


class PredictionEngine(ABC):
    name: PredictionEngineName

    @abstractmethod
    def predict(
        self, target: WatchTarget, tle: TLE, station: StationConfig, start: datetime, end: datetime
    ) -> list[PredictedPass]: ...


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _sample_datetimes(start: datetime, end: datetime, count: int = 11) -> list[datetime]:
    duration = end - start
    return [start + duration * (index / (count - 1)) for index in range(count)]


class SkyfieldPredictionEngine(PredictionEngine):
    name = PredictionEngineName.SKYFIELD

    def __init__(self):
        self.timescale = load.timescale()

    def predict(
        self, target: WatchTarget, tle: TLE, station: StationConfig, start: datetime, end: datetime
    ) -> list[PredictedPass]:
        start, end = _aware(start), _aware(end)
        satellite = EarthSatellite(tle.tle1, tle.tle2, tle.tle0, self.timescale)
        observer = wgs84.latlon(station.latitude, station.longitude, elevation_m=station.altitude_m)
        horizon = max(0.0, target.min_elevation or 0.0)
        times, events = satellite.find_events(
            observer,
            self.timescale.from_datetime(start),
            self.timescale.from_datetime(end),
            altitude_degrees=horizon,
        )
        passes: list[PredictedPass] = []
        rise = None
        peak = None
        for time_value, event in zip(times, events):
            event_time = time_value.utc_datetime().astimezone(timezone.utc)
            if event == 0:
                rise, peak = event_time, None
            elif event == 1 and rise is not None:
                peak = event_time
            elif event == 2 and rise is not None and peak is not None:
                passes.append(
                    self._build_pass(target, satellite, observer, rise, peak, event_time)
                )
                rise, peak = None, None
        return passes

    def _altaz(self, satellite, observer, value: datetime) -> tuple[float, float]:
        difference = (satellite - observer).at(self.timescale.from_datetime(value))
        altitude, azimuth, _ = difference.altaz()
        return float(altitude.degrees), float(azimuth.degrees % 360)

    def _build_pass(self, target, satellite, observer, start, peak, end) -> PredictedPass:
        _, rise_azimuth = self._altaz(satellite, observer, start)
        peak_elevation, peak_azimuth = self._altaz(satellite, observer, peak)
        _, set_azimuth = self._altaz(satellite, observer, end)
        samples = [self._altaz(satellite, observer, item)[1] for item in _sample_datetimes(start, end)]
        return PredictedPass(
            target_id=target.id,
            sat_id=target.sat_id,
            satellite_name=target.satellite_name or target.name,
            transmitter_uuid=target.transmitter_uuid,
            start=start,
            peak=peak,
            end=end,
            rise_azimuth=rise_azimuth,
            peak_azimuth=peak_azimuth,
            set_azimuth=set_azimuth,
            peak_elevation=peak_elevation,
            azimuth_samples=samples,
            engine=self.name,
        )


class SatnogsPredictionEngine(PredictionEngine):
    name = PredictionEngineName.SATNOGS_PREDICT

    def predict(
        self, target: WatchTarget, tle: TLE, station: StationConfig, start: datetime, end: datetime
    ) -> list[PredictedPass]:
        from satnogs_predict import (
            MinCulminationConstraint,
            Observer,
            OverlapHandling,
            PlanningConfig,
            Satellite,
            TimeRange,
            find_observation_windows,
        )

        satellite = Satellite.from_tle(
            line0=tle.tle0, line1=tle.tle1, line2=tle.tle2, identifier=str(tle.norad_cat_id)
        )
        observer = Observer(
            lat_deg=station.latitude,
            lon_deg=station.longitude,
            elevation_meters=int(station.altitude_m),
            horizon_deg=max(0.0, target.min_elevation or 0.0),
            identifier=str(station.station_id),
        )
        constraints = []
        if target.min_peak_elevation is not None:
            constraints.append(MinCulminationConstraint(target.min_peak_elevation))
        windows, _ = find_observation_windows(
            satellite=satellite,
            observer=observer,
            time_range=TimeRange.from_datetimes(_aware(start), _aware(end)),
            planning_config=PlanningConfig(
                overlap_handling=OverlapHandling.DROP,
                split_long_windows=False,
            ),
            pre_plan_constraints=constraints,
            post_plan_constraints=constraints,
        )
        return [
            PredictedPass(
                target_id=target.id,
                sat_id=target.sat_id,
                satellite_name=target.satellite_name or target.name,
                transmitter_uuid=target.transmitter_uuid,
                start=window.start_sample.instant.to_datetime(),
                peak=window.max_altitude_sample.instant.to_datetime(),
                end=window.end_sample.instant.to_datetime(),
                rise_azimuth=window.start_sample.azimuth_deg,
                peak_azimuth=window.max_altitude_sample.azimuth_deg,
                set_azimuth=window.end_sample.azimuth_deg,
                peak_elevation=window.max_altitude_sample.altitude_deg,
                azimuth_samples=[
                    window.start_sample.azimuth_deg,
                    window.max_altitude_sample.azimuth_deg,
                    window.end_sample.azimuth_deg,
                ],
                engine=self.name,
            )
            for window in windows
        ]


def engine_for(name: PredictionEngineName) -> PredictionEngine:
    if name == PredictionEngineName.SKYFIELD:
        return SkyfieldPredictionEngine()
    return SatnogsPredictionEngine()


def compare_passes(primary: list[PredictedPass], secondary: list[PredictedPass]) -> list[dict]:
    remaining = secondary.copy()
    comparisons: list[dict] = []
    for item in primary:
        match = min(
            remaining,
            key=lambda candidate: abs((candidate.peak - item.peak).total_seconds()),
            default=None,
        )
        if match and abs((match.peak - item.peak).total_seconds()) <= 300:
            remaining.remove(match)
            comparisons.append(
                {
                    "target_id": str(item.target_id),
                    "primary_start": item.start,
                    "secondary_start": match.start,
                    "aos_delta_seconds": (match.start - item.start).total_seconds(),
                    "peak_delta_seconds": (match.peak - item.peak).total_seconds(),
                    "los_delta_seconds": (match.end - item.end).total_seconds(),
                    "peak_elevation_delta": match.peak_elevation - item.peak_elevation,
                    "matched": True,
                }
            )
        else:
            comparisons.append({"target_id": str(item.target_id), "matched": False, "missing": "secondary"})
    comparisons.extend(
        {"target_id": str(item.target_id), "matched": False, "missing": "primary"}
        for item in remaining
    )
    return comparisons
