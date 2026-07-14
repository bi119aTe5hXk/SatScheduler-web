from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from app.db import Database
from app.schemas import PredictedPass, SchedulerSettings, StationConfig
from app.satnogs import SatNOGSClient
from app.targets import TargetRepository


class ScheduleExecutor:
    def __init__(
        self,
        database: Database,
        client: SatNOGSClient,
        targets: TargetRepository,
    ):
        self.database = database
        self.client = client
        self.targets = targets

    async def execute(
        self,
        station: StationConfig,
        passes: list[PredictedPass],
        settings: SchedulerSettings,
        trigger_type: str,
        progress: Callable[[str, str, dict[str, Any]], Awaitable[None]] | None = None,
    ) -> dict:
        async def report(stage: str, message: str, **details: Any) -> None:
            if progress:
                await progress(stage, message, details)

        run_id = str(uuid4())
        now = datetime.now(timezone.utc).isoformat()
        with self.database.connection() as connection:
            connection.execute(
                """
                INSERT INTO schedule_runs(
                    id, trigger_type, status, engine, sort_mode, started_at,
                    target_count, candidate_count
                ) VALUES (?, ?, 'submitting', ?, ?, ?, ?, ?)
                """,
                (
                    run_id,
                    trigger_type,
                    passes[0].engine.value if passes else settings.prediction_engine.value,
                    settings.sort_mode.value,
                    now,
                    len({item.target_id for item in passes}),
                    len(passes),
                ),
            )

        results: list[dict] = []
        total_batches = max(1, (len(passes) + settings.batch_size - 1) // settings.batch_size)
        for batch_index, offset in enumerate(
            range(0, len(passes), settings.batch_size), start=1
        ):
            batch = passes[offset : offset + settings.batch_size]
            await report(
                "submitting",
                f"Submitting batch {batch_index}/{total_batches} ({len(batch)} observations)",
                current=batch_index,
                total=total_batches,
            )
            payload = [
                self.client.serialize_observation(
                    station.station_id, item.transmitter_uuid, item.start, item.end
                )
                for item in batch
            ]
            try:
                created = await self.client.create_observations(payload)
                for index, item in enumerate(batch):
                    observation = created[index] if index < len(created) else {}
                    result = self._record_result(run_id, item, "success", observation.get("id"), None, 1)
                    results.append(result)
                    self.targets.record_success(item.target_id)
            except Exception as batch_error:
                if not settings.retry_individually:
                    for item in batch:
                        results.append(self._record_failure(run_id, item, str(batch_error), settings, 1))
                    continue
                for retry_index, (item, request) in enumerate(zip(batch, payload), start=1):
                    await report(
                        "retrying",
                        f"Retrying failed batch individually: {retry_index}/{len(batch)}",
                        current=retry_index,
                        total=len(batch),
                    )
                    try:
                        created = await self.client.create_observations([request])
                        observation = created[0] if created else {}
                        results.append(
                            self._record_result(run_id, item, "success", observation.get("id"), None, 2)
                        )
                        self.targets.record_success(item.target_id)
                    except Exception as exc:
                        results.append(self._record_failure(run_id, item, str(exc), settings, 2))

        successes = sum(result["status"] == "success" for result in results)
        failures = len(results) - successes
        status = "completed" if failures == 0 else "partial" if successes else "failed"
        with self.database.connection() as connection:
            connection.execute(
                """
                UPDATE schedule_runs SET status=?, finished_at=?, success_count=?, failure_count=?
                WHERE id=?
                """,
                (status, datetime.now(timezone.utc).isoformat(), successes, failures, run_id),
            )
        self.client.cache.expire(f"observations:{station.station_id}:1")
        return {"run_id": run_id, "status": status, "success_count": successes, "failure_count": failures, "results": results}

    def _record_failure(self, run_id, item, message, settings, attempts):
        self.targets.record_failure(item.target_id, message, settings.problem_threshold)
        return self._record_result(run_id, item, "failure", None, message, attempts)

    def _record_result(self, run_id, item, status, observation_id, error, attempts):
        item_id = str(uuid4())
        with self.database.connection() as connection:
            connection.execute(
                """
                INSERT INTO schedule_items(
                    id, run_id, target_id, observation_id, planned_start, planned_end,
                    status, attempt_count, error_message
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item_id, run_id, str(item.target_id), observation_id,
                    item.start.isoformat(), item.end.isoformat(), status, attempts, error,
                ),
            )
        return {"id": item_id, "target_id": str(item.target_id), "status": status, "observation_id": observation_id, "error": error}
