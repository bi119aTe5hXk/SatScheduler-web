from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID, uuid4

from app.db import Database
from app.schemas import WatchTarget, WatchTargetInput


TARGET_COLUMNS = """
id, name, sat_id, norad_cat_id, satellite_name, transmitter_uuid,
transmitter_description, center_frequency, sort_order, priority, enabled,
requires_station_daylight, daylight_solar_elevation, min_elevation,
min_peak_elevation, max_peak_elevation, min_azimuth, max_azimuth,
transmitter_success_rate, transmitter_good_count, transmitter_max_good_count,
failure_count, health_status, last_error, created_at, updated_at
"""


def _row_to_target(row) -> WatchTarget:
    return WatchTarget(
        id=row["id"],
        name=row["name"],
        sat_id=row["sat_id"],
        norad_cat_id=row["norad_cat_id"],
        satellite_name=row["satellite_name"],
        transmitter_uuid=row["transmitter_uuid"],
        transmitter_description=row["transmitter_description"],
        center_frequency=row["center_frequency"],
        sort_order=row["sort_order"],
        priority=row["priority"],
        enabled=bool(row["enabled"]),
        requires_station_daylight=bool(row["requires_station_daylight"]),
        daylight_solar_elevation=row["daylight_solar_elevation"],
        min_elevation=row["min_elevation"],
        min_peak_elevation=row["min_peak_elevation"],
        max_peak_elevation=row["max_peak_elevation"],
        min_azimuth=row["min_azimuth"],
        max_azimuth=row["max_azimuth"],
        transmitter_success_rate=row["transmitter_success_rate"],
        transmitter_good_count=row["transmitter_good_count"],
        transmitter_max_good_count=row["transmitter_max_good_count"],
        failure_count=row["failure_count"],
        health_status=row["health_status"],
        last_error=row["last_error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class TargetRepository:
    def __init__(self, database: Database):
        self.database = database

    def list(self) -> list[WatchTarget]:
        with self.database.connection() as connection:
            rows = connection.execute(
                f"SELECT {TARGET_COLUMNS} FROM watch_targets ORDER BY sort_order, created_at"
            ).fetchall()
        return [_row_to_target(row) for row in rows]

    def get(self, target_id: UUID | str) -> WatchTarget | None:
        with self.database.connection() as connection:
            row = connection.execute(
                f"SELECT {TARGET_COLUMNS} FROM watch_targets WHERE id = ?",
                (str(target_id),),
            ).fetchone()
        return _row_to_target(row) if row else None

    def create(self, value: WatchTargetInput, target_id: UUID | None = None) -> WatchTarget:
        now = datetime.now(timezone.utc).isoformat()
        target_id = target_id or uuid4()
        with self.database.connection() as connection:
            next_order = connection.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM watch_targets"
            ).fetchone()["value"]
            connection.execute(
                """
                INSERT INTO watch_targets(
                    id, name, sat_id, norad_cat_id, satellite_name, transmitter_uuid,
                    transmitter_description, center_frequency, sort_order, priority, enabled,
                    requires_station_daylight, daylight_solar_elevation, min_elevation,
                    min_peak_elevation, max_peak_elevation, min_azimuth, max_azimuth,
                    transmitter_success_rate, transmitter_good_count, transmitter_max_good_count,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(target_id), value.name, value.sat_id, value.norad_cat_id,
                    value.satellite_name, value.transmitter_uuid,
                    value.transmitter_description, value.center_frequency, next_order,
                    value.priority, int(value.enabled), int(value.requires_station_daylight),
                    value.daylight_solar_elevation, value.min_elevation,
                    value.min_peak_elevation, value.max_peak_elevation,
                    value.min_azimuth, value.max_azimuth, value.transmitter_success_rate,
                    value.transmitter_good_count, value.transmitter_max_good_count, now, now,
                ),
            )
        return self.get(target_id)  # type: ignore[return-value]

    def update(self, target_id: UUID, value: WatchTargetInput) -> WatchTarget | None:
        now = datetime.now(timezone.utc).isoformat()
        with self.database.connection() as connection:
            cursor = connection.execute(
                """
                UPDATE watch_targets SET
                    name=?, sat_id=?, norad_cat_id=?, satellite_name=?, transmitter_uuid=?,
                    transmitter_description=?, center_frequency=?, priority=?, enabled=?,
                    requires_station_daylight=?, daylight_solar_elevation=?, min_elevation=?,
                    min_peak_elevation=?, max_peak_elevation=?, min_azimuth=?, max_azimuth=?,
                    transmitter_success_rate=?, transmitter_good_count=?,
                    transmitter_max_good_count=?, updated_at=?
                WHERE id=?
                """,
                (
                    value.name, value.sat_id, value.norad_cat_id, value.satellite_name,
                    value.transmitter_uuid, value.transmitter_description,
                    value.center_frequency, value.priority, int(value.enabled),
                    int(value.requires_station_daylight), value.daylight_solar_elevation,
                    value.min_elevation, value.min_peak_elevation, value.max_peak_elevation,
                    value.min_azimuth, value.max_azimuth, value.transmitter_success_rate,
                    value.transmitter_good_count, value.transmitter_max_good_count,
                    now, str(target_id),
                ),
            )
        return self.get(target_id) if cursor.rowcount else None

    def delete(self, target_id: UUID) -> bool:
        with self.database.connection() as connection:
            cursor = connection.execute("DELETE FROM watch_targets WHERE id = ?", (str(target_id),))
        return bool(cursor.rowcount)

    def reorder(self, ids: list[UUID]) -> list[WatchTarget]:
        existing = {str(target.id) for target in self.list()}
        requested = [str(value) for value in ids]
        if set(requested) != existing or len(requested) != len(existing):
            raise ValueError("reorder request must contain every target exactly once")
        with self.database.connection() as connection:
            for order, target_id in enumerate(requested):
                connection.execute(
                    "UPDATE watch_targets SET sort_order=?, updated_at=? WHERE id=?",
                    (order, datetime.now(timezone.utc).isoformat(), target_id),
                )
        return self.list()

    def record_failure(self, target_id: UUID, message: str, threshold: int) -> None:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT failure_count FROM watch_targets WHERE id=?", (str(target_id),)
            ).fetchone()
            if not row:
                return
            count = row["failure_count"] + 1
            status = "problem" if count >= threshold else "warning"
            connection.execute(
                "UPDATE watch_targets SET failure_count=?, health_status=?, last_error=?, updated_at=? WHERE id=?",
                (count, status, message, datetime.now(timezone.utc).isoformat(), str(target_id)),
            )

    def record_success(self, target_id: UUID) -> None:
        with self.database.connection() as connection:
            connection.execute(
                "UPDATE watch_targets SET failure_count=0, health_status='ok', last_error=NULL, updated_at=? WHERE id=?",
                (datetime.now(timezone.utc).isoformat(), str(target_id)),
            )

