from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.cache import PersistentCache
from app.config import ENV
from app.db import configure_database
from app.executor import ScheduleExecutor
from app.import_export import export_configuration, import_configuration
from app.jobs import AutomaticScheduler
from app.planner import Planner
from app.satnogs import SatNOGSClient
from app.schemas import (
    PlanRequest,
    ReorderRequest,
    ScheduleRequest,
    SchedulerSettings,
    WatchTargetInput,
)
from app.service import get_scheduler_settings, resolve_station, save_scheduler_settings
from app.targets import TargetRepository


logging.basicConfig(level=getattr(logging, ENV.log_level, logging.INFO))
database = configure_database(ENV.database_path)
cache = PersistentCache(database)
client = SatNOGSClient(
    cache,
    ENV.api_token,
    request_interval_seconds=lambda: get_scheduler_settings(
        database
    ).api_request_interval_seconds,
)
targets = TargetRepository(database)
planner = Planner(client, targets)
executor = ScheduleExecutor(database, client, targets)
automatic_scheduler = AutomaticScheduler(database, planner, executor)


@asynccontextmanager
async def lifespan(_: FastAPI):
    automatic_scheduler.start()
    try:
        yield
    finally:
        automatic_scheduler.shutdown()
        await client.close()


app = FastAPI(title="SatScheduler Web", version="0.1.0", lifespan=lifespan)


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": app.version}


@app.get("/api/config")
async def config():
    try:
        station = await resolve_station(database, client)
        database.set_setting("station_timezone", station.timezone)
    except Exception as exc:
        station = None
        station_error = str(exc)
    else:
        station_error = None
    return {
        "station": station,
        "station_error": station_error,
        "api_token_configured": bool(ENV.api_token),
        "environment_managed": {
            "api_token": bool(ENV.api_token),
            "station_id": ENV.station_id is not None,
            "latitude": ENV.latitude is not None,
            "longitude": ENV.longitude is not None,
            "altitude_m": ENV.altitude_m is not None,
            "timezone": bool(ENV.station_timezone),
        },
        "scheduler": get_scheduler_settings(database),
        "automatic_job": automatic_scheduler.status(),
    }


@app.get("/api/settings", response_model=SchedulerSettings)
async def settings_get():
    return get_scheduler_settings(database)


@app.put("/api/settings", response_model=SchedulerSettings)
async def settings_put(value: SchedulerSettings):
    save_scheduler_settings(database, value)
    automatic_scheduler.reschedule()
    return value


@app.get("/api/satellites")
async def satellites(force: bool = False):
    payload, metadata = await client.satellites(force=force)
    return {"results": payload, "cache": metadata}


@app.get("/api/satellites/{sat_id}/transmitters")
async def transmitters(sat_id: str, force: bool = False):
    payload, metadata = await client.transmitters(sat_id, force=force)
    return {"results": payload, "cache": metadata}


@app.get("/api/satellites/{sat_id}/transmitter-insights")
async def transmitter_insights(sat_id: str, force: bool = False):
    payload, metadata = await client.transmitter_insights(sat_id, force=force)
    return {"results": payload, "cache": metadata}


@app.post("/api/tles/refresh")
async def refresh_tles():
    sat_ids = [target.sat_id for target in targets.list() if target.enabled]
    payload, metadata = await client.tles(sat_ids, force=True) if sat_ids else ([], {})
    return {"count": len(payload), "cache": metadata}


@app.get("/api/targets")
async def targets_list():
    return targets.list()


@app.post("/api/targets", status_code=201)
async def targets_create(value: WatchTargetInput):
    return targets.create(value)


@app.put("/api/targets/reorder")
async def targets_reorder(value: ReorderRequest):
    try:
        return targets.reorder(value.ids)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.put("/api/targets/{target_id}")
async def targets_update(target_id: UUID, value: WatchTargetInput):
    result = targets.update(target_id, value)
    if not result:
        raise HTTPException(404, "target not found")
    return result


@app.delete("/api/targets/{target_id}", status_code=204)
async def targets_delete(target_id: UUID):
    if not targets.delete(target_id):
        raise HTTPException(404, "target not found")


@app.post("/api/plans")
async def plans_create(request: PlanRequest):
    try:
        station = await resolve_station(database, client)
        settings = get_scheduler_settings(database)
        return await planner.make_plan(
            station,
            settings,
            start=request.start,
            horizon_hours=request.horizon_hours,
            engine_name=request.engine,
            sort_mode=request.sort_mode,
            comparison_enabled=request.comparison_enabled,
            target_ids=request.target_ids,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/schedules")
async def schedules_create(request: ScheduleRequest):
    station = await resolve_station(database, client)
    return await executor.execute(
        station,
        request.passes,
        get_scheduler_settings(database),
        request.trigger_type,
    )


@app.post("/api/schedules/run-automatic")
async def schedules_run_automatic():
    result = await automatic_scheduler.run_once()
    if result is None:
        raise HTTPException(502, "automatic scheduling failed")
    return result


@app.get("/api/observations/upcoming")
async def observations_upcoming(cursor: str | None = Query(default=None), force: bool = False):
    station = await resolve_station(database, client)
    return await client.observation_page(
        station.station_id, future=True, cursor=cursor, use_cache=True, force=force
    )


@app.get("/api/observations/overview")
async def observations_overview(force: bool = False):
    station = await resolve_station(database, client)
    results = await client.all_future_observations(station.station_id, force=force)
    results.sort(key=lambda item: item.get("start", ""))
    return {"results": results}


@app.get("/api/observations/receptions")
async def observations_receptions(
    cursor: str | None = Query(default=None), force: bool = False
):
    station = await resolve_station(database, client)
    return await client.observation_page(
        station.station_id, future=False, cursor=cursor, use_cache=True, force=force
    )


@app.get("/api/observations/{observation_id}")
async def observation_detail(observation_id: int):
    return await client.observation(observation_id)


@app.delete("/api/cache")
async def cache_clear(prefix: str | None = None):
    return {"deleted": cache.expire(prefix)}


@app.get("/api/export")
async def export_config():
    try:
        station = await resolve_station(database, client)
    except (TypeError, ValueError):
        station = None
    return export_configuration(targets, station)


@app.post("/api/import")
async def import_config(payload: Any = Body(...), replace: bool = True):
    try:
        result = import_configuration(database, targets, payload, replace)
        automatic_scheduler.reschedule()
        return result
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/runs")
async def runs(limit: int = Query(default=50, ge=1, le=200)):
    with database.connection() as connection:
        rows = connection.execute(
            "SELECT * FROM schedule_runs ORDER BY started_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(row) for row in rows]


static_dir = Path(__file__).resolve().parent.parent / "static"
if static_dir.exists():
    assets_dir = static_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        requested = static_dir / full_path
        if full_path and requested.is_file():
            return FileResponse(requested)
        return FileResponse(static_dir / "index.html")
