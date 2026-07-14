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
  pages. The DB transmitter list renders first; Network evidence loads non-blockingly so a rate
  limit cannot prevent selecting or saving a target.
- Batched TLE retrieval for all enabled targets.
- SatNOGS Predict and direct Skyfield/SGP4 prediction engines.
- Optional prediction comparison without duplicate scheduling.
- Minimum 180-second observation duration, minimum horizon, minimum/maximum culmination, wrapped
  azimuth and station-daylight filters.
- Four scheduling modes: list priority, list priority plus elevation, elevation only, and
  SatNOGS default priority scoring.
- Manual plan preview that selects every non-conflicting pass, supports removing/reordering the
  review list, and requires confirmation before batch submission.
- iOS-compatible conflict handling: the configurable safety buffer applies around existing
  SatNOGS Observations, while candidates selected in the same plan use their actual pass times.
- A combined station/planning/submission timeline and live per-observation states. Submission can
  be stopped after the current request; successful rows are cleared while failed rows remain.
- Configurable API batch size and shared HTTP-only request spacing. All batches are attempted before
  observations from failed batches are retried individually.
- Server-side background plan/submission jobs with live TLE, orbit-prediction, Observation-page,
  ranking, selection, batch and retry progress.
- One-hour persistent plan-result cache; leaving the Schedule page does not cancel active work.
- Daily station-local-time or fixed-hour automatic execution, using a 48-hour default and maximum
  planning horizon.
- Overview card for the next observation with live listening state/countdowns, transmitter details,
  pass geometry and a polar plot.
- Background-paginated Upcoming view with live page/record progress, a matching 48-hour timeline,
  force refresh and completion/failure notifications.
- UTC-driven local timeline expiry/reordering, local Reception search across loaded observation and
  radio fields, Observer labels, colored reception states and compact pass Polar Plots in both lists.
- Cursor-paginated Reception archive with loaded-record Good/Bad/Unknown filtering.
- Reception detail view with waterfall, audio, transmitter/station metadata, pass geometry,
  polar plot, TLE, artifact links and a link to the matching SatNOGS Network page.
- Persistent one-hour caches for satellite, transmitter, TLE, station, Upcoming and Reception lists.
- A fixed UTC reference clock across every desktop and mobile page, conditional automatic-job
  settings, and full-width Reception waterfalls with separate Audio and Polar Plot panels.
- A shared configurable SatNOGS API request interval (4 seconds by default) covering DB/Network
  reads, pagination and observation submissions.
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

Satellite catalogs, per-satellite transmitters, batched TLEs, station details, Upcoming pages and
Reception pages use a persistent one-hour TTL in SQLite. The web UI also keeps satellite and
Observation lists for one hour so reopening a page does not make another backend request. A manual
refresh bypasses both cache layers. Observation details and their artifact URLs remain uncached.
Upcoming and Reception summaries also persist in browser storage and use stale-while-revalidate:
expired data remains visible while a background refresh runs. Successful scheduling is merged into
both the server's existing Upcoming cache and the browser cache immediately instead of clearing it.
An optional 1–24 hour Upcoming auto-refresh runs inside the backend scheduler, including when no
browser is open. Overview shows six cached Upcoming observations and six cached Reception results;
each entry opens its detail page. The Reception summary refresh requests only the newest page,
while an Upcoming refresh updates the complete paginated station timeline.

The latest completed planning result is stored for one hour. Opening Schedule restores that result
without recalculating; `Recalculate passes` explicitly starts a fresh background job. Calculation
and submission status remain on the server, so changing pages does not cancel either operation.
The UI polls only local status endpoints and shows skipped-reason counts plus a persistent,
per-observation live submission status list.

All outbound SatNOGS DB and Network requests share one global start-rate limiter. The interval is
configured in Settings under `API request interval seconds` (0.5–30 seconds, default 4); changing
it takes effect for the next request without restarting the container. A 3–5 second interval is
recommended to reduce HTTP 429 responses. Cache hits do not enter the limiter because they do not
make an external request.

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
