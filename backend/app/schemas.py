from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator, model_validator


class PredictionEngineName(StrEnum):
    SATNOGS_PREDICT = "satnogs_predict"
    SKYFIELD = "skyfield"


class SortMode(StrEnum):
    LIST_PRIORITY = "list_priority"
    LIST_PRIORITY_BEST_ELEVATION = "list_priority_best_elevation"
    BEST_ELEVATION = "best_elevation"
    SATNOGS_DEFAULT = "satnogs_default"


class TriggerMode(StrEnum):
    DISABLED = "disabled"
    DAILY = "daily"
    INTERVAL = "interval"


class WatchTargetInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    sat_id: str = Field(min_length=1, max_length=80)
    norad_cat_id: int | None = None
    satellite_name: str | None = None
    transmitter_uuid: str = Field(min_length=1, max_length=80)
    transmitter_description: str | None = None
    center_frequency: int | None = None
    priority: float = Field(default=1.0, ge=0, le=1)
    enabled: bool = True
    requires_station_daylight: bool = False
    daylight_solar_elevation: float = Field(default=-6, ge=-18, le=15)
    min_elevation: float | None = Field(default=None, ge=0, le=90)
    min_peak_elevation: float | None = Field(default=None, ge=0, le=90)
    max_peak_elevation: float | None = Field(default=None, ge=0, le=90)
    min_azimuth: float | None = Field(default=None, ge=0, le=360)
    max_azimuth: float | None = Field(default=None, ge=0, le=360)
    transmitter_success_rate: float | None = Field(default=None, ge=0, le=1)
    transmitter_good_count: int | None = Field(default=None, ge=0)
    transmitter_max_good_count: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_ranges(self) -> "WatchTargetInput":
        if (self.min_azimuth is None) != (self.max_azimuth is None):
            raise ValueError("minimum and maximum azimuth must be set together")
        if (
            self.min_peak_elevation is not None
            and self.max_peak_elevation is not None
            and self.min_peak_elevation > self.max_peak_elevation
        ):
            raise ValueError("minimum peak elevation cannot exceed maximum peak elevation")
        return self


class WatchTarget(WatchTargetInput):
    id: UUID = Field(default_factory=uuid4)
    sort_order: int = 0
    failure_count: int = 0
    health_status: str = "ok"
    last_error: str | None = None
    created_at: datetime
    updated_at: datetime


class ReorderRequest(BaseModel):
    ids: list[UUID]


class SchedulerSettings(BaseModel):
    prediction_engine: PredictionEngineName = PredictionEngineName.SATNOGS_PREDICT
    comparison_enabled: bool = False
    sort_mode: SortMode = SortMode.LIST_PRIORITY
    trigger_mode: TriggerMode = TriggerMode.DISABLED
    daily_time_local: str = "03:00"
    interval_hours: int = Field(default=6, ge=1, le=48)
    horizon_hours: float = Field(default=24, gt=0, le=48)
    lead_minutes: int = Field(default=10, ge=1, le=180)
    satellites_per_run: int = Field(default=30, ge=1, le=30)
    passes_per_satellite: int = Field(default=1, ge=1, le=20)
    batch_size: int = Field(default=20, ge=1, le=50)
    retry_individually: bool = True
    problem_threshold: int = Field(default=3, ge=1, le=20)
    conflict_buffer_seconds: int = Field(default=300, ge=0, le=3600)

    @field_validator("daily_time_local")
    @classmethod
    def validate_daily_time(cls, value: str) -> str:
        try:
            hour, minute = [int(part) for part in value.split(":", 1)]
        except (TypeError, ValueError) as exc:
            raise ValueError("daily time must use HH:MM") from exc
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError("daily time must use HH:MM")
        return f"{hour:02d}:{minute:02d}"


class StationConfig(BaseModel):
    station_id: int
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    altitude_m: float
    timezone: str
    station_name: str | None = None


class TLE(BaseModel):
    tle0: str
    tle1: str
    tle2: str
    tle_source: str | None = None
    sat_id: str
    norad_cat_id: int
    updated: str | None = None


class PredictedPass(BaseModel):
    target_id: UUID
    sat_id: str
    satellite_name: str
    transmitter_uuid: str
    start: datetime
    peak: datetime
    end: datetime
    rise_azimuth: float
    peak_azimuth: float
    set_azimuth: float
    peak_elevation: float
    azimuth_samples: list[float] = Field(default_factory=list)
    engine: PredictionEngineName
    priority_score: float = 0
    comparison: dict[str, Any] | None = None


class PlanRequest(BaseModel):
    start: datetime | None = None
    horizon_hours: float | None = Field(default=None, gt=0, le=48)
    engine: PredictionEngineName | None = None
    sort_mode: SortMode | None = None
    comparison_enabled: bool | None = None
    target_ids: list[UUID] | None = None


class PlanResult(BaseModel):
    created_at: datetime
    start: datetime
    end: datetime
    engine: PredictionEngineName
    sort_mode: SortMode
    candidates: list[PredictedPass]
    selected: list[PredictedPass]
    skipped: list[dict[str, Any]]
    comparisons: list[dict[str, Any]]


class ScheduleRequest(BaseModel):
    passes: list[PredictedPass]
    trigger_type: str = "manual"


class ImportEnvelope(BaseModel):
    schema_version: int = 1
    exported_at: datetime | None = None
    settings: dict[str, Any] = Field(default_factory=dict)
    watch_targets: list[dict[str, Any]] = Field(default_factory=list)

