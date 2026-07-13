from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from app.prediction import compare_passes, engine_for
from app.schemas import (
    PlanResult,
    PredictionEngineName,
    PredictedPass,
    SchedulerSettings,
    SortMode,
    StationConfig,
    TLE,
    WatchTarget,
)
from app.satnogs import SatNOGSClient
from app.solar import solar_elevation
from app.targets import TargetRepository


def _parse_remote_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except ValueError:
            return None


def _azimuth_in_range(value: float, minimum: float, maximum: float) -> bool:
    value, minimum, maximum = value % 360, minimum % 360, maximum % 360
    if minimum <= maximum:
        return minimum <= value <= maximum
    return value >= minimum or value <= maximum


def pass_allowed(item: PredictedPass, target: WatchTarget, station: StationConfig) -> tuple[bool, str | None]:
    if target.min_peak_elevation is not None and item.peak_elevation < target.min_peak_elevation:
        return False, "below_minimum_peak_elevation"
    if target.max_peak_elevation is not None and item.peak_elevation > target.max_peak_elevation:
        return False, "above_maximum_peak_elevation"
    if target.min_azimuth is not None and target.max_azimuth is not None:
        if not any(
            _azimuth_in_range(value, target.min_azimuth, target.max_azimuth)
            for value in item.azimuth_samples
        ):
            return False, "outside_azimuth_window"
    if target.requires_station_daylight:
        midpoint = item.start + (item.end - item.start) / 2
        if solar_elevation(midpoint, station.latitude, station.longitude) < target.daylight_solar_elevation:
            return False, "station_not_in_daylight"
    return True, None


def score_pass(item: PredictedPass, target: WatchTarget, mode: SortMode) -> float:
    if mode == SortMode.SATNOGS_DEFAULT:
        success_rate = target.transmitter_success_rate
        good_count = target.transmitter_good_count
        max_good_count = target.transmitter_max_good_count
        score = item.peak_elevation / 90.0
        if success_rate is not None:
            score *= success_rate
        if good_count is not None and max_good_count:
            score *= good_count / max_good_count
        return score
    return target.priority


def sort_passes(
    candidates: list[PredictedPass], targets: dict[UUID, WatchTarget], mode: SortMode
) -> list[PredictedPass]:
    for item in candidates:
        item.priority_score = score_pass(item, targets[item.target_id], mode)

    def key(item: PredictedPass):
        target = targets[item.target_id]
        if mode == SortMode.LIST_PRIORITY:
            return (target.sort_order, item.start, -item.peak_elevation)
        if mode == SortMode.LIST_PRIORITY_BEST_ELEVATION:
            return (target.sort_order, -item.peak_elevation, item.start)
        if mode == SortMode.BEST_ELEVATION:
            return (-item.peak_elevation, target.sort_order, item.start)
        return (-item.priority_score, item.start, target.sort_order)

    return sorted(candidates, key=key)


def select_non_conflicting(
    candidates: list[PredictedPass],
    observations: list[dict[str, Any]],
    buffer_seconds: int,
    passes_per_satellite: int,
    satellites_per_run: int,
) -> tuple[list[PredictedPass], list[dict[str, Any]]]:
    occupied: list[tuple[datetime, datetime, str]] = []
    for observation in observations:
        start = _parse_remote_datetime(observation.get("start"))
        end = _parse_remote_datetime(observation.get("end"))
        if start and end:
            occupied.append((start, end, f"observation:{observation.get('id', '?')}"))
    selected: list[PredictedPass] = []
    skipped: list[dict[str, Any]] = []
    count_by_target: dict[UUID, int] = {}
    admitted_targets: set[UUID] = set()
    buffer = timedelta(seconds=buffer_seconds)
    for item in candidates:
        if item.target_id not in admitted_targets:
            if len(admitted_targets) >= satellites_per_run:
                skipped.append(
                    {"pass": item.model_dump(mode="json"), "reason": "satellite_run_limit"}
                )
                continue
            admitted_targets.add(item.target_id)
        if count_by_target.get(item.target_id, 0) >= passes_per_satellite:
            skipped.append({"pass": item.model_dump(mode="json"), "reason": "per_satellite_limit"})
            continue
        start, end = item.start - buffer, item.end + buffer
        conflict = next(
            (label for occupied_start, occupied_end, label in occupied if start < occupied_end and occupied_start < end),
            None,
        )
        if conflict:
            skipped.append({"pass": item.model_dump(mode="json"), "reason": "conflict", "with": conflict})
            continue
        selected.append(item)
        occupied.append((start, end, f"selected:{item.target_id}"))
        count_by_target[item.target_id] = count_by_target.get(item.target_id, 0) + 1
    return selected, skipped


class Planner:
    def __init__(self, client: SatNOGSClient, targets: TargetRepository):
        self.client = client
        self.targets = targets

    async def make_plan(
        self,
        station: StationConfig,
        settings: SchedulerSettings,
        *,
        start: datetime | None = None,
        horizon_hours: float | None = None,
        engine_name: PredictionEngineName | None = None,
        sort_mode: SortMode | None = None,
        comparison_enabled: bool | None = None,
        target_ids: list[UUID] | None = None,
    ) -> PlanResult:
        now = datetime.now(timezone.utc)
        start = start or now + timedelta(minutes=settings.lead_minutes)
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        start = max(start.astimezone(timezone.utc), now + timedelta(minutes=1))
        horizon = min(horizon_hours or settings.horizon_hours, 48)
        end = min(start + timedelta(hours=horizon), now + timedelta(hours=48))
        engine_name = engine_name or settings.prediction_engine
        sort_mode = sort_mode or settings.sort_mode
        compare = settings.comparison_enabled if comparison_enabled is None else comparison_enabled

        allowed_ids = set(target_ids or [])
        targets = [
            target
            for target in self.targets.list()
            if target.enabled
            and target.health_status != "problem"
            and (not allowed_ids or target.id in allowed_ids)
        ]
        skipped: list[dict[str, Any]] = []
        if sort_mode == SortMode.SATNOGS_DEFAULT:
            scored_targets: list[WatchTarget] = []
            for target in targets:
                if (
                    target.transmitter_success_rate is None
                    or target.transmitter_good_count is None
                    or target.transmitter_max_good_count is None
                ):
                    skipped.append(
                        {
                            "target_id": str(target.id),
                            "reason": "transmitter_stats_unavailable",
                        }
                    )
                else:
                    scored_targets.append(target)
            targets = scored_targets
        tle_payload, _ = await self.client.tles([target.sat_id for target in targets])
        tle_by_sat: dict[str, TLE] = {}
        for raw in tle_payload:
            try:
                tle = TLE.model_validate(raw)
            except Exception:
                continue
            current = tle_by_sat.get(tle.sat_id)
            if current is None or (tle.updated or "") > (current.updated or ""):
                tle_by_sat[tle.sat_id] = tle

        primary_engine = engine_for(engine_name)
        secondary_name = (
            PredictionEngineName.SKYFIELD
            if engine_name == PredictionEngineName.SATNOGS_PREDICT
            else PredictionEngineName.SATNOGS_PREDICT
        )
        secondary_engine = engine_for(secondary_name) if compare else None
        candidates: list[PredictedPass] = []
        comparisons: list[dict[str, Any]] = []
        for target in targets:
            tle = tle_by_sat.get(target.sat_id)
            if not tle:
                skipped.append({"target_id": str(target.id), "reason": "missing_tle"})
                continue
            primary = await asyncio.to_thread(primary_engine.predict, target, tle, station, start, end)
            filtered: list[PredictedPass] = []
            for item in primary:
                allowed, reason = pass_allowed(item, target, station)
                if allowed:
                    filtered.append(item)
                else:
                    skipped.append({"pass": item.model_dump(mode="json"), "reason": reason})
            candidates.extend(filtered)
            if secondary_engine:
                secondary = await asyncio.to_thread(secondary_engine.predict, target, tle, station, start, end)
                secondary = [item for item in secondary if pass_allowed(item, target, station)[0]]
                comparisons.extend(compare_passes(filtered, secondary))

        targets_by_id = {target.id: target for target in targets}
        ordered = sort_passes(candidates, targets_by_id, sort_mode)
        observations = await self.client.all_future_observations(station.station_id)
        selected, conflict_skips = select_non_conflicting(
            ordered,
            observations,
            settings.conflict_buffer_seconds,
            settings.passes_per_satellite,
            settings.satellites_per_run,
        )
        skipped.extend(conflict_skips)
        return PlanResult(
            created_at=datetime.now(timezone.utc),
            start=start,
            end=end,
            engine=engine_name,
            sort_mode=sort_mode,
            candidates=ordered,
            selected=selected,
            skipped=skipped,
            comparisons=comparisons,
        )
