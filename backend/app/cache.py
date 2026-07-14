from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from app.db import Database


Fetcher = Callable[[], Awaitable[Any]]


def parse_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class PersistentCache:
    def __init__(self, database: Database):
        self.database = database
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, key: str) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())

    def get_entry(self, key: str) -> dict[str, Any] | None:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT * FROM cache_entries WHERE cache_key = ?", (key,)
            ).fetchone()
        if not row:
            return None
        return {
            "key": row["cache_key"],
            "resource_type": row["resource_type"],
            "payload": json.loads(row["payload"]),
            "fetched_at": row["fetched_at"],
            "expires_at": row["expires_at"],
            "last_error": row["last_error"],
            "fresh": parse_datetime(row["expires_at"]) > datetime.now(timezone.utc),
        }

    def set_entry(self, key: str, resource_type: str, payload: Any, ttl: timedelta) -> None:
        now = datetime.now(timezone.utc)
        with self.database.connection() as connection:
            connection.execute(
                """
                INSERT INTO cache_entries(
                    cache_key, resource_type, payload, fetched_at, expires_at, last_error
                ) VALUES (?, ?, ?, ?, ?, NULL)
                ON CONFLICT(cache_key) DO UPDATE SET
                    resource_type=excluded.resource_type,
                    payload=excluded.payload,
                    fetched_at=excluded.fetched_at,
                    expires_at=excluded.expires_at,
                    last_error=NULL
                """,
                (
                    key,
                    resource_type,
                    json.dumps(payload, separators=(",", ":")),
                    now.isoformat(),
                    (now + ttl).isoformat(),
                ),
            )

    def replace_payload(self, key: str, payload: Any) -> bool:
        """Replace cached data without extending its freshness window."""
        with self.database.connection() as connection:
            cursor = connection.execute(
                "UPDATE cache_entries SET payload = ? WHERE cache_key = ?",
                (json.dumps(payload, separators=(",", ":")), key),
            )
        return cursor.rowcount > 0

    def expire(self, prefix: str | None = None) -> int:
        with self.database.connection() as connection:
            if prefix:
                cursor = connection.execute(
                    "DELETE FROM cache_entries WHERE cache_key LIKE ?", (f"{prefix}%",)
                )
            else:
                cursor = connection.execute("DELETE FROM cache_entries")
        return cursor.rowcount

    async def get_or_fetch(
        self,
        key: str,
        resource_type: str,
        ttl: timedelta,
        fetcher: Fetcher,
        *,
        force: bool = False,
        allow_stale: bool = True,
    ) -> tuple[Any, dict[str, Any]]:
        entry = self.get_entry(key)
        if entry and entry["fresh"] and not force:
            return entry["payload"], entry

        async with self._lock(key):
            entry = self.get_entry(key)
            if entry and entry["fresh"] and not force:
                return entry["payload"], entry
            try:
                payload = await fetcher()
                self.set_entry(key, resource_type, payload, ttl)
                fresh_entry = self.get_entry(key)
                return payload, fresh_entry or {"fresh": True}
            except Exception as exc:
                if entry and allow_stale:
                    with self.database.connection() as connection:
                        connection.execute(
                            "UPDATE cache_entries SET last_error = ? WHERE cache_key = ?",
                            (str(exc), key),
                        )
                    entry["last_error"] = str(exc)
                    entry["fresh"] = False
                    return entry["payload"], entry
                raise
