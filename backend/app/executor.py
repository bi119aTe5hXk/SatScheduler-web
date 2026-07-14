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
        should_cancel: Callable[[], bool] | None = None,
    ) -> dict:
        async def report(stage: str, message: str, **details: Any) -> None:
            if progress:
                await progress(stage, message, details)

        def pass_key(item: PredictedPass) -> str:
            return f"{item.target_id}:{item.start.isoformat()}"

        item_states = [
            {
                "key": pass_key(item),
                "target_id": str(item.target_id),
                "satellite_name": item.satellite_name,
                "start": item.start.isoformat(),
                "end": item.end.isoformat(),
                "status": "waiting",
                "observation_id": None,
                "error": None,
            }
            for item in passes
        ]
        states_by_key = {item["key"]: item for item in item_states}

        async def report_items(stage: str, message: str, **details: Any) -> None:
            await report(
                stage,
                message,
                items=[dict(item) for item in item_states],
                **details,
            )

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
        batch_size = settings.satellites_per_run
        total_batches = max(1, (len(passes) + batch_size - 1) // batch_size)
        failed_batches: list[tuple[list[PredictedPass], list[dict[str, Any]], str]] = []
        canceled = False
        await report_items(
            "queued",
            f"{len(passes)} observations waiting to be submitted",
            current=0,
            total=len(passes),
        )
        for batch_index, offset in enumerate(range(0, len(passes), batch_size), start=1):
            if should_cancel and should_cancel():
                canceled = True
                break
            batch = passes[offset : offset + batch_size]
            for item in batch:
                states_by_key[pass_key(item)]["status"] = "scheduling"
            await report_items(
                "submitting",
                f"Submitting batch {batch_index}/{total_batches} ({len(batch)} observations)",
                current=offset,
                total=len(passes),
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
                    state = states_by_key[pass_key(item)]
                    state.update(
                        status="scheduled",
                        observation_id=observation.get("id"),
                        error=None,
                    )
                await report_items(
                    "submitting",
                    f"Batch {batch_index}/{total_batches} scheduled",
                    current=offset + len(batch),
                    total=len(passes),
                )
            except Exception as batch_error:
                message = str(batch_error)
                if settings.retry_individually:
                    for item in batch:
                        states_by_key[pass_key(item)].update(
                            status="retry_waiting", error=message
                        )
                    failed_batches.append((batch, payload, message))
                    await report_items(
                        "submitting",
                        f"Batch {batch_index}/{total_batches} failed; queued for individual retry after all batches",
                        current=offset + len(batch),
                        total=len(passes),
                    )
                else:
                    for item in batch:
                        results.append(self._record_failure(run_id, item, message, 1))
                        states_by_key[pass_key(item)].update(
                            status="failed", error=message
                        )
                    await report_items(
                        "submitting",
                        f"Batch {batch_index}/{total_batches} failed",
                        current=offset + len(batch),
                        total=len(passes),
                    )
        retry_items = [
            (item, request, batch_error)
            for batch, payload, batch_error in failed_batches
            for item, request in zip(batch, payload)
        ]
        for retry_index, (item, request, _batch_error) in enumerate(retry_items, start=1):
            if should_cancel and should_cancel():
                canceled = True
                break
            state = states_by_key[pass_key(item)]
            state["status"] = "scheduling"
            await report_items(
                "retrying",
                f"Retrying {item.satellite_name} individually ({retry_index}/{len(retry_items)})",
                current=retry_index - 1,
                total=len(retry_items),
            )
            try:
                created = await self.client.create_observations([request])
                observation = created[0] if created else {}
                results.append(
                    self._record_result(run_id, item, "success", observation.get("id"), None, 2)
                )
                state.update(
                    status="scheduled",
                    observation_id=observation.get("id"),
                    error=None,
                )
            except Exception as exc:
                results.append(self._record_failure(run_id, item, str(exc), 2))
                state.update(status="failed", error=str(exc))
            await report_items(
                "retrying",
                f"Individual retry {retry_index}/{len(retry_items)} finished",
                current=retry_index,
                total=len(retry_items),
            )

        successes = sum(result["status"] == "success" for result in results)
        failures = len(results) - successes
        pending = sum(
            item["status"] not in {"scheduled", "failed"} for item in item_states
        )
        status = "canceled" if canceled else "completed" if failures == 0 else "partial" if successes else "failed"
        if canceled:
            await report_items(
                "canceled",
                "Submission stopped by user; unsubmitted observations remain available",
                current=successes + failures,
                total=len(passes),
            )
        with self.database.connection() as connection:
            connection.execute(
                """
                UPDATE schedule_runs SET status=?, finished_at=?, success_count=?, failure_count=?
                WHERE id=?
                """,
                (status, datetime.now(timezone.utc).isoformat(), successes, failures, run_id),
            )
        self.client.cache.expire(f"observations:{station.station_id}:1")
        return {
            "run_id": run_id,
            "status": status,
            "success_count": successes,
            "failure_count": failures,
            "pending_count": pending,
            "results": results,
            "items": item_states,
        }

    def _record_failure(self, run_id, item, message, attempts):
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
