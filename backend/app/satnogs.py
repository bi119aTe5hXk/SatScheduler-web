from __future__ import annotations

import asyncio
import re
from collections import Counter
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from app.cache import PersistentCache


DB_BASE_URL = "https://db.satnogs.org/api"
NETWORK_BASE_URL = "https://network.satnogs.org/api"
ONE_HOUR = timedelta(hours=1)
ONE_DAY = timedelta(days=1)


class SatNOGSError(RuntimeError):
    pass


def merge_transmitter_insights(
    transmitters: list[dict[str, Any]],
    stats_by_uuid: dict[str, dict[str, Any]],
    good_observations: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    available = {item.get("uuid") for item in transmitters}
    recent_counts = Counter(
        item.get("transmitter_uuid")
        for item in good_observations
        if item.get("transmitter_uuid") in available
    )
    recommended_uuid: str | None = None
    if len(transmitters) == 1:
        recommended_uuid = transmitters[0].get("uuid")
    elif recent_counts:
        recommended_uuid = min(recent_counts, key=lambda uuid: (-recent_counts[uuid], uuid))

    good_counts = [
        int(stats.get("good_count") or 0) for stats in stats_by_uuid.values()
    ]
    max_good_count = max(good_counts, default=0)
    return [
        {
            **transmitter,
            "network_stats": stats_by_uuid.get(str(transmitter.get("uuid"))),
            "stats_max_good_count": max_good_count,
            "recent_good_count": recent_counts.get(transmitter.get("uuid"), 0),
            "recommended": transmitter.get("uuid") == recommended_uuid,
        }
        for transmitter in transmitters
    ]


class SatNOGSClient:
    def __init__(
        self,
        cache: PersistentCache,
        api_token: str,
        request_interval_seconds: float | Callable[[], float] = 0.0,
    ):
        self.cache = cache
        self.api_token = api_token
        self.request_interval_seconds = request_interval_seconds
        self._request_lock = asyncio.Lock()
        self._last_request_started: float | None = None
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(30), follow_redirects=True)

    async def close(self) -> None:
        await self.http.aclose()

    def _configured_request_interval(self) -> float:
        value = (
            self.request_interval_seconds()
            if callable(self.request_interval_seconds)
            else self.request_interval_seconds
        )
        return max(0.0, min(30.0, float(value)))

    async def _wait_for_request_slot(self) -> None:
        async with self._request_lock:
            loop = asyncio.get_running_loop()
            if self._last_request_started is not None:
                remaining = (
                    self._last_request_started
                    + self._configured_request_interval()
                    - loop.time()
                )
                if remaining > 0:
                    await asyncio.sleep(remaining)
            self._last_request_started = loop.time()

    async def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        await self._wait_for_request_slot()
        response = await self.http.request(method, url, **kwargs)
        response.raise_for_status()
        return response

    async def _get(self, url: str, params: dict[str, Any] | None = None) -> httpx.Response:
        return await self._request("GET", url, params=params)

    async def satellites(self, force: bool = False) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        async def fetch() -> Any:
            response = await self._get(f"{DB_BASE_URL}/satellites/", {"status": "alive"})
            return response.json()

        return await self.cache.get_or_fetch(
            "satellites:alive", "satellites", ONE_HOUR, fetch, force=force
        )

    async def transmitters(
        self, sat_id: str, force: bool = False
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        async def fetch() -> Any:
            response = await self._get(f"{DB_BASE_URL}/transmitters/", {"sat_id": sat_id})
            return response.json()

        return await self.cache.get_or_fetch(
            f"transmitters:{sat_id}", "transmitters", ONE_HOUR, fetch, force=force
        )

    async def transmitter_stats(
        self, transmitter_uuid: str, force: bool = False
    ) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        async def fetch() -> Any:
            response = await self._get(
                f"{NETWORK_BASE_URL}/transmitters/", {"uuid": transmitter_uuid}
            )
            payload = response.json()
            item = payload[0] if isinstance(payload, list) and payload else None
            return item.get("stats") if item else None

        return await self.cache.get_or_fetch(
            f"transmitter-stats:{transmitter_uuid}",
            "transmitter-stats",
            ONE_DAY,
            fetch,
            force=force,
        )

    async def recent_good_observations(
        self, norad_cat_id: int, max_pages: int = 2, force: bool = False
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        async def fetch() -> Any:
            cursor: str | None = None
            results: list[dict[str, Any]] = []
            seen: set[str] = set()
            for _ in range(max_pages):
                params: dict[str, Any] = {
                    "status": "good",
                    "norad_cat_id": norad_cat_id,
                }
                if cursor:
                    params["cursor"] = cursor
                response = await self._get(f"{NETWORK_BASE_URL}/observations/", params)
                payload = response.json()
                if isinstance(payload, list):
                    results.extend(payload)
                    cursor = self._cursor_from_link(response.headers.get("link"))
                else:
                    results.extend(payload.get("results", payload.get("data", [])))
                    cursor = payload.get("next_cursor") or self._cursor_from_url(
                        payload.get("next")
                    )
                if not cursor or cursor in seen:
                    break
                seen.add(cursor)
            return results

        return await self.cache.get_or_fetch(
            f"recent-good:{norad_cat_id}:{max_pages}",
            "transmitter-recommendations",
            ONE_HOUR,
            fetch,
            force=force,
        )

    async def transmitter_insights(
        self, sat_id: str, force: bool = False
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        raw, db_cache = await self.transmitters(sat_id, force=force)
        matching = [item for item in raw if item.get("sat_id") == sat_id]
        active = [item for item in matching if item.get("status") == "active"]
        transmitters = active or matching
        semaphore = asyncio.Semaphore(4)

        async def load_stats(item: dict[str, Any]):
            uuid = str(item.get("uuid"))
            async with semaphore:
                try:
                    stats, _ = await self.transmitter_stats(uuid, force=force)
                except (httpx.HTTPError, SatNOGSError):
                    stats = None
            return uuid, stats

        loaded = await asyncio.gather(*(load_stats(item) for item in transmitters))
        stats_by_uuid = {uuid: stats for uuid, stats in loaded if stats is not None}
        norad_cat_id = next(
            (int(item["norad_cat_id"]) for item in transmitters if item.get("norad_cat_id")),
            None,
        )
        good_observations: list[dict[str, Any]] = []
        recommendation_cache: dict[str, Any] | None = None
        if len(transmitters) > 1 and norad_cat_id is not None:
            try:
                good_observations, recommendation_cache = await self.recent_good_observations(
                    norad_cat_id, max_pages=2, force=force
                )
            except (httpx.HTTPError, SatNOGSError):
                pass
        return merge_transmitter_insights(transmitters, stats_by_uuid, good_observations), {
            "transmitters": db_cache,
            "recommendation": recommendation_cache,
            "stats_ttl_hours": 24,
        }

    async def tles(
        self, sat_ids: list[str], force: bool = False
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        normalized = sorted(set(sat_ids))
        if not normalized:
            return [], {"fresh": True, "empty": True}
        cache_key = "tles:" + ",".join(normalized)

        async def fetch() -> Any:
            response = await self._get(
                f"{DB_BASE_URL}/tle/", {"sat_id": ",".join(normalized)}
            )
            return response.json()

        return await self.cache.get_or_fetch(
            cache_key, "tles", ONE_HOUR, fetch, force=force
        )

    async def station(
        self, station_id: int, force: bool = False
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        async def fetch() -> Any:
            response = await self._get(f"{NETWORK_BASE_URL}/stations/{station_id}")
            return response.json()

        return await self.cache.get_or_fetch(
            f"station:{station_id}", "station", ONE_HOUR, fetch, force=force
        )

    async def observation_page(
        self,
        station_id: int,
        *,
        future: bool,
        cursor: str | None = None,
        use_cache: bool = True,
        force: bool = False,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"ground_station": station_id}
        if future:
            params["status"] = "future"
        else:
            params["end"] = datetime.now(timezone.utc).isoformat()
        if cursor:
            params["cursor"] = cursor
        key = f"observations:{station_id}:{int(future)}:{cursor or 'first'}"

        async def fetch() -> Any:
            response = await self._get(f"{NETWORK_BASE_URL}/observations/", params)
            payload = response.json()
            if isinstance(payload, list):
                results = payload
                next_cursor = self._cursor_from_link(response.headers.get("link"))
            else:
                results = payload.get("results", payload.get("data", []))
                next_cursor = payload.get("next_cursor") or self._cursor_from_url(
                    payload.get("next")
                )
            return {"results": results, "next_cursor": next_cursor}

        if not use_cache:
            return await fetch()
        payload, metadata = await self.cache.get_or_fetch(
            key, "observations", ONE_HOUR, fetch, force=force
        )
        # Do not embed metadata["payload"] back into the payload itself: that creates
        # a recursive object which FastAPI cannot serialize.
        payload["cache"] = {
            name: value for name, value in metadata.items() if name != "payload"
        }
        return payload

    async def observation(self, observation_id: int) -> dict[str, Any]:
        response = await self._get(f"{NETWORK_BASE_URL}/observations/{observation_id}/")
        payload = response.json()
        if not isinstance(payload, dict):
            raise SatNOGSError("SatNOGS returned an invalid observation detail")
        return payload

    async def all_future_observations(
        self,
        station_id: int,
        max_pages: int = 20,
        force: bool = False,
        progress: Callable[[int, int], Awaitable[None]] | None = None,
    ) -> list[dict[str, Any]]:
        cursor: str | None = None
        results: list[dict[str, Any]] = []
        seen: set[str] = set()
        for page_number in range(max_pages):
            page = await self.observation_page(
                station_id,
                future=True,
                cursor=cursor,
                force=force and page_number == 0,
            )
            results.extend(page["results"])
            if progress:
                await progress(page_number + 1, len(results))
            cursor = page.get("next_cursor")
            if not cursor or cursor in seen:
                break
            seen.add(cursor)
        return results

    async def create_observations(self, requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not self.api_token:
            raise SatNOGSError("SATNOGS_API_TOKEN is not configured")
        try:
            response = await self._request(
                "POST",
                f"{NETWORK_BASE_URL}/observations/",
                json=requests,
                headers={"Authorization": f"Token {self.api_token}"},
                timeout=45,
            )
        except httpx.HTTPStatusError as exc:
            raise SatNOGSError(exc.response.text or str(exc)) from exc
        payload = response.json()
        if isinstance(payload, list):
            return payload
        return payload.get("results", [payload])

    @staticmethod
    def serialize_observation(
        station_id: int, transmitter_uuid: str, start: datetime, end: datetime
    ) -> dict[str, Any]:
        def format_datetime(value: datetime) -> str:
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

        return {
            "ground_station": station_id,
            "transmitter_uuid": transmitter_uuid,
            "start": format_datetime(start),
            "end": format_datetime(end),
        }

    @staticmethod
    def _cursor_from_url(url: str | None) -> str | None:
        if not url:
            return None
        values = parse_qs(urlparse(url).query).get("cursor")
        return values[0] if values else None

    @classmethod
    def _cursor_from_link(cls, link: str | None) -> str | None:
        if not link:
            return None
        match = re.search(r'<([^>]+)>;\s*rel="next"', link)
        return cls._cursor_from_url(match.group(1)) if match else None
