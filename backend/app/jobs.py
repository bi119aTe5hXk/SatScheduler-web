from __future__ import annotations

import logging
from datetime import timezone
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.config import ENV
from app.db import Database
from app.executor import ScheduleExecutor
from app.planner import Planner
from app.schemas import TriggerMode
from app.service import get_scheduler_settings, resolve_station


logger = logging.getLogger(__name__)
SCHEDULE_JOB_ID = "automatic-schedule"
UPCOMING_REFRESH_JOB_ID = "automatic-upcoming-refresh"


class AutomaticScheduler:
    def __init__(self, database: Database, planner: Planner, executor: ScheduleExecutor):
        self.database = database
        self.planner = planner
        self.executor = executor
        self.scheduler = AsyncIOScheduler(timezone=timezone.utc)

    def start(self) -> None:
        self.scheduler.start()
        self.reschedule()

    def shutdown(self) -> None:
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)

    def reschedule(self) -> None:
        for job_id in (SCHEDULE_JOB_ID, UPCOMING_REFRESH_JOB_ID):
            if self.scheduler.get_job(job_id):
                self.scheduler.remove_job(job_id)
        settings = get_scheduler_settings(self.database)
        if settings.trigger_mode != TriggerMode.DISABLED:
            if settings.trigger_mode == TriggerMode.DAILY:
                station_timezone = self.database.get_setting(
                    "station_timezone", ENV.station_timezone or "UTC"
                )
                hour, minute = [int(part) for part in settings.daily_time_local.split(":")]
                trigger = CronTrigger(hour=hour, minute=minute, timezone=ZoneInfo(station_timezone))
            else:
                trigger = IntervalTrigger(hours=settings.interval_hours, timezone=timezone.utc)
            self.scheduler.add_job(
                self.run_once,
                trigger=trigger,
                id=SCHEDULE_JOB_ID,
                replace_existing=True,
                coalesce=True,
                max_instances=1,
                misfire_grace_time=3600,
            )
        if settings.upcoming_auto_refresh_enabled:
            self.scheduler.add_job(
                self.refresh_upcoming,
                trigger=IntervalTrigger(
                    hours=settings.upcoming_auto_refresh_hours, timezone=timezone.utc
                ),
                id=UPCOMING_REFRESH_JOB_ID,
                replace_existing=True,
                coalesce=True,
                max_instances=1,
                misfire_grace_time=3600,
            )

    async def run_once(self) -> dict | None:
        settings = get_scheduler_settings(self.database)
        try:
            station = await resolve_station(self.database, self.planner.client)
            self.database.set_setting("station_timezone", station.timezone)
            plan = await self.planner.make_plan(station, settings)
            return await self.executor.execute(
                station, plan.selected, settings, trigger_type="automatic"
            )
        except Exception:
            logger.exception("Automatic scheduling failed")
            return None

    async def refresh_upcoming(self) -> dict | None:
        try:
            station = await resolve_station(self.database, self.planner.client)
            results = await self.planner.client.all_future_observations(
                station.station_id, force=True
            )
            payload = {"count": len(results)}
            self.database.set_setting("latest_upcoming_refresh", payload)
            return payload
        except Exception:
            logger.exception("Automatic Upcoming refresh failed")
            return None

    def status(self) -> dict:
        job = self.scheduler.get_job(SCHEDULE_JOB_ID)
        refresh_job = self.scheduler.get_job(UPCOMING_REFRESH_JOB_ID)
        return {
            "enabled": job is not None,
            "next_run_at": job.next_run_time.isoformat() if job and job.next_run_time else None,
            "upcoming_refresh": {
                "enabled": refresh_job is not None,
                "next_run_at": refresh_job.next_run_time.isoformat()
                if refresh_job and refresh_job.next_run_time
                else None,
            },
        }
