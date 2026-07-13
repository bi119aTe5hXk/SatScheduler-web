from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.cache import PersistentCache
from app.db import Database
from app.import_export import export_configuration, import_configuration
from app.planner import pass_allowed, select_non_conflicting, sort_passes
from app.schemas import (
    PredictedPass,
    PredictionEngineName,
    SortMode,
    StationConfig,
    WatchTarget,
)
from app.satnogs import SatNOGSClient, merge_transmitter_insights
from app.targets import TargetRepository


@pytest.fixture
def database(tmp_path: Path) -> Database:
    value = Database(tmp_path / "test.db")
    value.initialize()
    return value


def make_target(order: int, name: str, priority: float = 1.0) -> WatchTarget:
    now = datetime.now(timezone.utc)
    return WatchTarget(
        id=f"00000000-0000-0000-0000-{order + 1:012d}",
        name=name,
        sat_id=f"SAT-{order}",
        satellite_name=name,
        transmitter_uuid=f"TX-{order}",
        sort_order=order,
        priority=priority,
        created_at=now,
        updated_at=now,
    )


def make_pass(target: WatchTarget, peak_elevation: float) -> PredictedPass:
    start = datetime(2026, 7, 13, 0, target.sort_order, tzinfo=timezone.utc)
    return PredictedPass(
        target_id=target.id,
        sat_id=target.sat_id,
        satellite_name=target.name,
        transmitter_uuid=target.transmitter_uuid,
        start=start,
        peak=start + timedelta(minutes=5),
        end=start + timedelta(minutes=10),
        rise_azimuth=300,
        peak_azimuth=0,
        set_azimuth=60,
        peak_elevation=peak_elevation,
        azimuth_samples=[300, 0, 60],
        engine=PredictionEngineName.SKYFIELD,
    )


@pytest.mark.asyncio
async def test_persistent_cache_coalesces_fresh_value(database: Database):
    cache = PersistentCache(database)
    calls = 0

    async def fetch():
        nonlocal calls
        calls += 1
        return {"value": calls}

    first, _ = await cache.get_or_fetch("key", "test", timedelta(hours=1), fetch)
    second, _ = await cache.get_or_fetch("key", "test", timedelta(hours=1), fetch)
    assert first == second == {"value": 1}
    assert calls == 1


@pytest.mark.asyncio
async def test_satnogs_requests_share_configurable_interval(database: Database, monkeypatch):
    client = SatNOGSClient(PersistentCache(database), "", request_interval_seconds=0.04)
    started: list[float] = []

    class Response:
        @staticmethod
        def raise_for_status():
            return None

    async def fake_request(method, url, **kwargs):
        started.append(asyncio.get_running_loop().time())
        return Response()

    monkeypatch.setattr(client.http, "request", fake_request)
    await asyncio.gather(
        client._request("GET", "https://example.test/one"),
        client._request("POST", "https://example.test/two"),
    )
    await client.close()

    assert len(started) == 2
    assert started[1] - started[0] >= 0.035


@pytest.mark.asyncio
async def test_observation_pages_use_supported_time_filters(database: Database, monkeypatch):
    client = SatNOGSClient(PersistentCache(database), "")
    requests: list[dict] = []

    class Response:
        headers: dict = {}

        @staticmethod
        def json():
            return []

    async def fake_get(url, params=None):
        requests.append(params or {})
        return Response()

    monkeypatch.setattr(client, "_get", fake_get)
    await client.observation_page(4856, future=True, use_cache=False)
    await client.observation_page(4856, future=False, use_cache=False)
    await client.close()

    assert requests[0] == {"ground_station": 4856, "status": "future"}
    assert requests[1]["ground_station"] == 4856
    assert "end" in requests[1]
    assert "future" not in requests[1]


@pytest.mark.asyncio
async def test_reception_pages_reuse_one_hour_cache(database: Database, monkeypatch):
    client = SatNOGSClient(PersistentCache(database), "")
    calls = 0

    class Response:
        headers: dict = {}

        @staticmethod
        def json():
            return [{"id": 123}]

    async def fake_get(url, params=None):
        nonlocal calls
        calls += 1
        return Response()

    monkeypatch.setattr(client, "_get", fake_get)
    first = await client.observation_page(4856, future=False)
    second = await client.observation_page(4856, future=False)
    await client.close()

    assert first["results"] == second["results"] == [{"id": 123}]
    assert "payload" not in second["cache"]
    json.dumps(second)
    assert calls == 1


def test_sort_modes_are_distinct():
    first = make_target(0, "First")
    second = make_target(1, "Second")
    passes = [make_pass(first, 10), make_pass(second, 80)]
    targets = {target.id: target for target in (first, second)}
    assert sort_passes(passes, targets, SortMode.LIST_PRIORITY)[0].target_id == first.id
    assert sort_passes(passes, targets, SortMode.BEST_ELEVATION)[0].target_id == second.id


def test_wrapped_azimuth_and_station_daylight_filter():
    target = make_target(0, "North pass")
    target.min_azimuth = 300
    target.max_azimuth = 60
    item = make_pass(target, 50)
    station = StationConfig(
        station_id=1,
        latitude=35,
        longitude=139,
        altitude_m=10,
        timezone="Asia/Tokyo",
    )
    assert pass_allowed(item, target, station)[0]


def test_ios_watch_list_import_and_export(database: Database):
    repository = TargetRepository(database)
    database.set_setting("station_config", {"station_id": 4856, "timezone": "Asia/Tokyo"})
    result = import_configuration(
        database,
        repository,
        {
            "exportedAt": "2026-07-13T14:47:51Z",
            "schemaVersion": 1,
            "targets": [
                {
                    "enabled": True,
                    "id": "2371A649-C2D6-4F87-B52D-3DE612947666",
                    "name": "ISS",
                    "satelliteID": "XSKZ-5603-1870-9019-3066",
                    "satelliteName": "ISS",
                    "stationIDs": [4856],
                    "stationNames": {"4856": "biGS"},
                    "stationSnapshots": {
                        "4856": {
                            "altitude": 100,
                            "id": 4856,
                            "latitude": 35.57,
                            "longitude": 139.433,
                            "minHorizon": 5,
                            "name": "biGS",
                        }
                    },
                    "transmitterID": "abc",
                    "requireStationDaylight": True,
                    "minPeakElevation": 20,
                    "minAzimuth": 300,
                    "maxAzimuth": 60,
                }
            ],
        },
        replace=True,
    )
    assert result["imported"] == 1
    assert result["skipped_station_mismatch"] == 0
    assert repository.list()[0].min_elevation == 5
    imported_station = database.get_setting("station_config", {})
    assert imported_station["station_id"] == 4856
    assert imported_station["station_name"] == "biGS"

    station = StationConfig(
        station_id=4856,
        latitude=35.57,
        longitude=139.433,
        altitude_m=100,
        timezone="Asia/Tokyo",
        station_name="biGS",
    )
    exported = export_configuration(repository, station)
    assert set(exported) == {"exportedAt", "schemaVersion", "targets"}
    assert exported["schemaVersion"] == 1
    assert exported["exportedAt"].endswith("Z")
    exported_target = exported["targets"][0]
    assert exported_target["satelliteID"] == "XSKZ-5603-1870-9019-3066"
    assert exported_target["stationNames"] == {"4856": "biGS"}
    assert exported_target["stationSnapshots"]["4856"]["minHorizon"] == 5
    assert exported_target["requireStationDaylight"] is True
    assert "satelliteId" not in exported_target
    assert "priority" not in exported_target

    mismatch = import_configuration(
        database,
        repository,
        {
            "schemaVersion": 1,
            "targets": [
                {
                    "name": "Other station satellite",
                    "satelliteID": "OTHER-SAT",
                    "stationIDs": [9999],
                }
            ],
        },
        replace=True,
    )
    assert mismatch == {"imported": 0, "skipped_station_mismatch": 1}
    assert [target.name for target in repository.list()] == ["ISS"]


def test_satellite_limit_is_applied_after_sorting():
    first = make_target(0, "First")
    second = make_target(1, "Second")
    ordered = sort_passes(
        [make_pass(first, 10), make_pass(second, 80)],
        {first.id: first, second.id: second},
        SortMode.BEST_ELEVATION,
    )
    selected, skipped = select_non_conflicting(ordered, [], 0, 1, 1)
    assert [item.target_id for item in selected] == [second.id]
    assert skipped[0]["reason"] == "satellite_run_limit"


def test_transmitter_insights_combine_stats_and_recent_recommendation():
    transmitters = [
        {"uuid": "tx-b", "description": "B"},
        {"uuid": "tx-a", "description": "A"},
    ]
    stats = {
        "tx-a": {"success_rate": 80, "good_count": 100},
        "tx-b": {"success_rate": 60, "good_count": 250},
    }
    observations = [
        {"transmitter_uuid": "tx-a"},
        {"transmitter_uuid": "tx-a"},
        {"transmitter_uuid": "tx-b"},
        {"transmitter_uuid": "not-selectable"},
    ]
    merged = merge_transmitter_insights(transmitters, stats, observations)
    by_uuid = {item["uuid"]: item for item in merged}
    assert by_uuid["tx-a"]["recommended"] is True
    assert by_uuid["tx-a"]["recent_good_count"] == 2
    assert by_uuid["tx-b"]["stats_max_good_count"] == 250
