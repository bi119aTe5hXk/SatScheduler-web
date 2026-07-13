from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_targets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sat_id TEXT NOT NULL,
    norad_cat_id INTEGER,
    satellite_name TEXT,
    transmitter_uuid TEXT NOT NULL,
    transmitter_description TEXT,
    center_frequency INTEGER,
    sort_order INTEGER NOT NULL,
    priority REAL NOT NULL DEFAULT 1.0,
    enabled INTEGER NOT NULL DEFAULT 1,
    requires_station_daylight INTEGER NOT NULL DEFAULT 0,
    daylight_solar_elevation REAL NOT NULL DEFAULT -6,
    min_elevation REAL,
    min_peak_elevation REAL,
    max_peak_elevation REAL,
    min_azimuth REAL,
    max_azimuth REAL,
    transmitter_success_rate REAL,
    transmitter_good_count INTEGER,
    transmitter_max_good_count INTEGER,
    failure_count INTEGER NOT NULL DEFAULT 0,
    health_status TEXT NOT NULL DEFAULT 'ok',
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_entries (
    cache_key TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_error TEXT
);

CREATE TABLE IF NOT EXISTS schedule_runs (
    id TEXT PRIMARY KEY,
    trigger_type TEXT NOT NULL,
    status TEXT NOT NULL,
    engine TEXT NOT NULL,
    sort_mode TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    target_count INTEGER NOT NULL DEFAULT 0,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT
);

CREATE TABLE IF NOT EXISTS schedule_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES schedule_runs(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL,
    observation_id INTEGER,
    planned_start TEXT NOT NULL,
    planned_end TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
);
"""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat()


class Database:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as connection:
            connection.executescript(SCHEMA)

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            connection = sqlite3.connect(self.path, check_same_thread=False)
            connection.row_factory = sqlite3.Row
            try:
                yield connection
                connection.commit()
            finally:
                connection.close()

    def get_setting(self, key: str, default: Any = None) -> Any:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT value FROM app_settings WHERE key = ?", (key,)
            ).fetchone()
        return json.loads(row["value"]) if row else default

    def set_setting(self, key: str, value: Any) -> None:
        with self.connection() as connection:
            connection.execute(
                """
                INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (key, json.dumps(value), iso_now()),
            )

    def all_settings(self) -> dict[str, Any]:
        with self.connection() as connection:
            rows = connection.execute("SELECT key, value FROM app_settings").fetchall()
        return {row["key"]: json.loads(row["value"]) for row in rows}


db: Database | None = None


def configure_database(path: Path) -> Database:
    global db
    db = Database(path)
    db.initialize()
    return db


def get_db() -> Database:
    if db is None:
        raise RuntimeError("Database has not been initialized")
    return db

