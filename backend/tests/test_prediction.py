from datetime import datetime, timedelta, timezone

from app.prediction import SatnogsPredictionEngine, SkyfieldPredictionEngine, compare_passes
from app.schemas import StationConfig, TLE, WatchTarget


def test_prediction_engines_agree_on_iss_passes():
    start = datetime(2026, 7, 13, 9, 40, tzinfo=timezone.utc)
    target = WatchTarget(
        id="00000000-0000-0000-0000-000000000001",
        name="ISS",
        sat_id="XSKZ-5603-1870-9019-3066",
        norad_cat_id=25544,
        satellite_name="ISS",
        transmitter_uuid="test",
        sort_order=0,
        created_at=start,
        updated_at=start,
    )
    tle = TLE(
        tle0="0 ISS (ZARYA)",
        tle1="1 25544U 98067A   26194.12129675  .00004316  00000-0  86456-4 0  9992",
        tle2="2 25544  51.6304 171.7447 0006685 289.3803  70.6462 15.48996109575778",
        sat_id=target.sat_id,
        norad_cat_id=25544,
    )
    station = StationConfig(
        station_id=1,
        latitude=35.6812,
        longitude=139.7671,
        altitude_m=40,
        timezone="Asia/Tokyo",
    )
    direct = SkyfieldPredictionEngine().predict(target, tle, station, start, start + timedelta(hours=24))
    official = SatnogsPredictionEngine().predict(target, tle, station, start, start + timedelta(hours=24))
    assert direct
    assert len(direct) == len(official)
    comparisons = compare_passes(official, direct)
    assert all(item["matched"] for item in comparisons)
    assert max(abs(item["peak_elevation_delta"]) for item in comparisons) < 0.01

