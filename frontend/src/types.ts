export type Target = {
  id: string
  name: string
  sat_id: string
  norad_cat_id?: number
  satellite_name?: string
  transmitter_uuid: string
  transmitter_description?: string
  center_frequency?: number
  sort_order: number
  priority: number
  enabled: boolean
  requires_station_daylight: boolean
  daylight_solar_elevation: number
  min_elevation?: number
  min_peak_elevation?: number
  max_peak_elevation?: number
  min_azimuth?: number
  max_azimuth?: number
  failure_count: number
  health_status: string
  last_error?: string
  transmitter_success_rate?: number
  transmitter_good_count?: number
  transmitter_max_good_count?: number
}

export type TransmitterStats = {
  total_count: number
  unknown_count: number
  future_count: number
  good_count: number
  bad_count: number
  unknown_rate: number
  future_rate: number
  success_rate: number
  bad_rate: number
}

export type TransmitterInsight = {
  uuid: string
  description?: string
  mode?: string
  downlink_low?: number
  downlink_high?: number
  network_stats?: TransmitterStats
  stats_max_good_count: number
  recent_good_count: number
  recommended: boolean
}

export type Settings = {
  prediction_engine: 'satnogs_predict' | 'skyfield'
  comparison_enabled: boolean
  sort_mode: 'list_priority' | 'list_priority_best_elevation' | 'best_elevation' | 'satnogs_default'
  trigger_mode: 'disabled' | 'daily' | 'interval'
  daily_time_local: string
  interval_hours: number
  horizon_hours: number
  lead_minutes: number
  satellites_per_run: number
  batch_size: number
  api_request_interval_seconds: number
  retry_individually: boolean
  problem_threshold: number
  conflict_buffer_seconds: number
}

export type Pass = {
  target_id: string
  sat_id: string
  satellite_name: string
  transmitter_uuid: string
  start: string
  peak: string
  end: string
  rise_azimuth: number
  peak_azimuth: number
  set_azimuth: number
  peak_elevation: number
  engine: string
  priority_score: number
}

export type Observation = {
  id: number
  start?: string
  end?: string
  satellite_name?: string
  tle0?: string
  tle1?: string
  tle2?: string
  tle_source?: string
  sat_id?: string
  norad_cat_id?: number
  ground_station?: number
  transmitter_uuid?: string
  transmitter_description?: string
  transmitter_mode?: string
  transmitter_baud?: number
  transmitter_downlink_low?: number
  transmitter_downlink_high?: number
  observation_frequency?: number
  center_frequency?: number
  station_name?: string
  station_lat?: number
  station_lng?: number
  station_alt?: number
  max_altitude?: number
  rise_azimuth?: number
  set_azimuth?: number
  status?: string
  vetted_status?: string
  waterfall?: string
  payload?: string
  demoddata?: Array<string | { url?: string; name?: string }>
  archive_url?: string
  archived?: boolean
  observer?: string
  client_version?: string
  client_metadata?: string | Record<string, any>
}
