# SatScheduler Web

SatScheduler Web is a single-ground-station SatNOGS observation planner designed for Docker,
CasaOS and low-power Debian/Armbian hosts. It is licensed under AGPL-3.0-or-later.

## Current features

- Ordered watch list with drag-equivalent up/down priority controls.
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
- Cursor-paginated upcoming Observation and Reception views.
- Persistent one-hour caches for satellite, transmitter, TLE, station and upcoming timelines.
- Uncached Reception loading whenever the page is opened or refreshed.
- JSON import/export in shared Web, native iOS-array and Android-envelope formats.

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
Reception pages and their artifact URLs never use this cache. Successful scheduling invalidates
upcoming Observation pages immediately.

Per-transmitter Network statistics are fetched only while adding/editing a watch target and kept
for 24 hours. The recent-good recommendation is cached for one hour. The selected transmitter's
success rate, good count and same-satellite maximum good count are saved with the target, so manual
and automatic batch planning performs no statistics request. SatNOGS default mode skips targets
whose saved statistics are unavailable; the other sort modes remain usable.

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

The settings page offers three exports. Shared Web JSON contains `watch_targets`, iOS
`watchTargets`, Android `androidWatchTargets`, and the Android-compatible `targets` alias. The iOS
export is the bare array consumed by the iOS model; the Android export is its native
`schemaVersion`/`exportedAt`/`targets` envelope. Import accepts all of those forms and both acronym
styles (`satelliteID`) and lower camel case (`satelliteId`).
