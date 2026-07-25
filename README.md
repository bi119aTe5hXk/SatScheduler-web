# SatScheduler Web

SatScheduler Web is a single-ground-station SatNOGS observation planner for Docker, CasaOS and
low-power Debian/Armbian hosts. It is licensed under AGPL-3.0-or-later.

## Features

- Single-station watch list with satellite/transmitter management.
- Searchable satellite picker with transmitter statistics and recommendations.
- SatNOGS Predict and Skyfield/SGP4 pass prediction.
- Manual and scheduled batch observation planning.
- Configurable scheduling modes, pass filters, API request interval and retry behavior.
- Upcoming observations timeline, next-observation overview, polar plot and ground-track map.
- Reception archive with status filtering, search, waterfall/audio/detail pages.
- Server-side SQLite cache shared by all browsers/devices.
- iOS-compatible watch-list import/export.
- Docker image support for `linux/amd64`, `linux/arm64` and `linux/arm/v7`.

## Run with Docker Compose

```bash
cp .env.example .env
# Edit .env
docker compose pull
docker compose up -d
```

Open `http://HOST:8080`.

The default Compose file pulls:

```yaml
image: ghcr.io/bi119ate5hxk/satscheduler-web:latest
```

Required values:

```dotenv
SATNOGS_API_TOKEN=your-network-api-token
SATNOGS_STATION_ID=1234
STATION_LATITUDE=35.6812
STATION_LONGITUDE=139.7671
STATION_ALTITUDE_M=40
STATION_TIMEZONE=Asia/Tokyo
```

Coordinates can be omitted; the backend will try to read them from the SatNOGS Network station
endpoint. `STATION_TIMEZONE` is the station-local IANA timezone used for daily automatic execution
and display. Scheduling timestamps sent to SatNOGS remain UTC.

SQLite data is stored in the Compose-managed `satscheduler_data` volume.

## Update

```bash
docker compose pull
docker compose up -d
```

If GHCR reports `manifest unknown`, make sure the `latest` package exists and is public. You can
also use an explicit tag such as `:edge` if that is the only published tag.

## Local development build

Use the development override when building from source:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

This keeps the normal `compose.yaml` suitable for CasaOS and low-power hosts.

## Cache behavior

Frequently used SatNOGS data is cached in SQLite to reduce API calls. Satellite catalogs,
transmitters, TLEs, station details, Upcoming pages, Reception pages and planning results are reused
when fresh. Expired list data can still be shown immediately while the backend refreshes it in the
background.

Manual refresh bypasses the relevant cache. Observation detail pages and artifact URLs are fetched
on demand.

All outbound SatNOGS requests share the configurable API request interval in Settings. A 3–5 second
interval is recommended to reduce HTTP 429 responses.

## Scheduling modes

Watch-list order is the visible priority order.

- `List priority`: follows the watch-list order.
- `List priority + best elevation`: follows watch-list order and prefers the best pass per target.
- `Best elevation`: ranks primarily by maximum elevation.
- `SatNOGS default`: uses saved transmitter statistics.

The old numeric `priority` field remains accepted in JSON/API payloads for compatibility, but it is
not shown in the UI.

## Import/export compatibility

The settings page exports the iOS-compatible SatScheduler watch-list format. The same file is
accepted by the Android app. Imports only accept targets whose `stationIDs` include the configured
station ID; targets for other stations are skipped.

Legacy SatScheduler Web export shapes are still accepted.

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

Checks:

```bash
.venv/bin/ruff check backend/app backend/tests
.venv/bin/pytest
cd frontend && pnpm run build
```
