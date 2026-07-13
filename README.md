# SatScheduler Web

SatScheduler Web is a single-ground-station SatNOGS observation planner designed for Docker,
CasaOS and low-power Debian/Armbian hosts. It is licensed under AGPL-3.0-or-later.

## Current features

- Ordered watch list with drag-equivalent up/down priority controls.
- Searchable satellite picker matching name, aliases, SatNOGS ID and NORAD ID, with a visible
  catalog loading state and a 100-row render limit.
- Satellite and transmitter selection from SatNOGS DB.
- Transmitter selection enriched with cached SatNOGS Network good/unknown/bad statistics,
  a three-color ratio bar and an iOS-compatible recommendation from the latest two good-observation
  pages.
- Batched TLE retrieval for all enabled targets.
- SatNOGS Predict and direct Skyfield/SGP4 prediction engines.
- Optional prediction comparison without duplicate scheduling.
- Minimum horizon, minimum/maximum culmination, wrapped azimuth and station-daylight filters.
- Four scheduling modes: list priority, list priority plus elevation, elevation only, and
  SatNOGS default priority scoring.
- Manual plan preview with single-pass or batch submission and per-observation fallback after batch failure.
- Daily station-local-time or fixed-hour automatic execution, limited to a 48-hour horizon.
- Overview card for the next observation with live listening state/countdowns, transmitter details,
  pass geometry and a polar plot.
- Background-paginated Upcoming view with live page/record progress, a matching 48-hour timeline,
  force refresh and completion/failure notifications.
- Cursor-paginated Reception archive.
- Reception detail view with waterfall, audio, transmitter/station metadata, pass geometry,
  polar plot, TLE, artifact links and a link to the matching SatNOGS Network page.
- Persistent one-hour caches for satellite, transmitter, TLE, station and upcoming timelines.
- Uncached Reception loading whenever the page is opened or refreshed.
- File and pasted-JSON import/export using the iOS-compatible SatScheduler watch-list format.

## Run with Docker Compose

```bash
cp .env.example .env
# Edit .env
docker compose up --build -d
```

Open `http://HOST:8080`.

Required values:

```dotenv
SATNOGS_API_TOKEN=your-network-api-token
SATNOGS_STATION_ID=1234
STATION_LATITUDE=35.6812
STATION_LONGITUDE=139.7671
STATION_ALTITUDE_M=40
STATION_TIMEZONE=Asia/Tokyo
```

Compose environment values take priority. When coordinates are omitted, the backend attempts to
read them from the SatNOGS Network station endpoint. All API scheduling timestamps remain UTC;
`STATION_TIMEZONE` is an IANA timezone used for daily automatic execution and display.
SQLite data is kept in the Compose-managed `satscheduler_data` volume so the unprivileged runtime
user can write safely on CasaOS hosts.

## ARMv7

The runtime uses Debian Bookworm slim and Debian's architecture-native NumPy package. The image is
structured for `linux/amd64` and `linux/arm/v7`; both native ARM64 startup and a full ARMv7 image
build have been verified. Build and publish the ARM image in CI rather than compiling scientific
dependencies on the target device.

```bash
docker buildx build --platform linux/amd64,linux/arm/v7 -t IMAGE --push .
```

## Cache behavior

Satellite catalogs, per-satellite transmitters, batched TLEs, station details and upcoming
Observation pages use a persistent one-hour TTL in SQLite. A manual refresh bypasses the TTL.
Reception pages, observation details and their artifact URLs never use this cache. Successful
scheduling invalidates upcoming Observation pages immediately.

Per-transmitter Network statistics are fetched only while adding/editing a watch target and kept
for 24 hours. The recent-good recommendation is cached for one hour. The selected transmitter's
success rate, good count and same-satellite maximum good count are saved with the target, so manual
and automatic batch planning performs no statistics request. SatNOGS default mode skips targets
whose saved statistics are unavailable; the other sort modes remain usable.

## Priority semantics

Watch-list priority is the visible up/down order. `List priority` follows that target order;
`List priority + best elevation` follows target order and prefers the highest pass for each target;
`Best elevation` ignores list order for the primary ranking; `SatNOGS default` uses the saved
transmitter statistics formula. The old numeric `priority` field remains accepted in JSON/API
payloads for compatibility, but it is no longer shown because none of these four modes uses it.

## Development

Backend:

```bash
python3 -m venv .venv
.venv/bin/pip install -e 'backend[dev]'
DATABASE_PATH=./data/satscheduler.db .venv/bin/uvicorn app.main:app --reload
```

Frontend:

```bash
cd frontend
pnpm install
pnpm run dev
```

Run checks:

```bash
.venv/bin/ruff check backend/app backend/tests
.venv/bin/pytest
cd frontend && pnpm run build
```

## Import/export compatibility

The settings page exports one watch-list format, matching the iOS app's
`schemaVersion`/`exportedAt`/`targets` envelope. Target records use iOS acronym keys such as
`satelliteID`, `transmitterID` and `stationIDs`, and include station names and snapshots. The same
file is accepted by the Android app. Files can be selected directly or JSON can be pasted.
During import, only targets whose `stationIDs` contain the configured station ID are accepted.
Targets for other stations are skipped; a file containing no matching targets does not erase the
existing watch list.

Import still accepts exports from early SatScheduler Web builds, including bare arrays,
`watch_targets`, `watchTargets`, `androidWatchTargets`, and Android lower-camel keys such as
`satelliteId`.
