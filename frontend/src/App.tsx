import { useEffect, useMemo, useRef, useState } from 'react'
import { api, formatUtc, frequency } from './api'
import type { Observation, Pass, Settings, Target, TransmitterInsight } from './types'

type Page = 'dashboard' | 'targets' | 'schedule' | 'observations' | 'receptions' | 'settings'
type Notify = (message: string, tone?: 'success' | 'error' | 'info') => void

const NAV: Array<{ id: Page; label: string; mark: string }> = [
  { id: 'dashboard', label: 'Overview', mark: 'OV' },
  { id: 'targets', label: 'Satellites', mark: 'SAT' },
  { id: 'schedule', label: 'Schedule', mark: 'SCH' },
  { id: 'observations', label: 'Upcoming', mark: 'UP' },
  { id: 'receptions', label: 'Receptions', mark: 'RX' },
  { id: 'settings', label: 'Settings', mark: 'SET' },
]

const defaultSettings: Settings = {
  prediction_engine: 'satnogs_predict', comparison_enabled: false,
  sort_mode: 'list_priority', trigger_mode: 'disabled', daily_time_local: '03:00',
  interval_hours: 6, upcoming_auto_refresh_enabled: false, upcoming_auto_refresh_hours: 6,
  horizon_hours: 48, lead_minutes: 10, satellites_per_run: 15,
  api_request_interval_seconds: 4, retry_individually: true, conflict_buffer_seconds: 300,
}

const CLIENT_CACHE_TTL = 60 * 60 * 1000
let satelliteCatalogCache: { results: any[]; expiresAt: number } | null = null
type ObservationCacheEntry = { items: Observation[]; cursor: string | null; pages: number; expiresAt: number; updatedAt?: number }
const OBSERVATION_CACHE_KEY = 'satscheduler-observation-cache-v1'
const observationViewCache: Partial<Record<'upcoming' | 'receptions', ObservationCacheEntry>> = (() => {
  try { return JSON.parse(localStorage.getItem(OBSERVATION_CACHE_KEY) || '{}') } catch { return {} }
})()

function saveObservationCache(kind: 'upcoming' | 'receptions', entry: ObservationCacheEntry) {
  observationViewCache[kind] = { ...entry, updatedAt: Date.now() }
  try { localStorage.setItem(OBSERVATION_CACHE_KEY, JSON.stringify(observationViewCache)) } catch { /* storage may be unavailable */ }
}

function mergeUpcomingCache(additions: Observation[]): Observation[] {
  const previous = observationViewCache.upcoming
  const byId = new Map<number, Observation>()
  for (const item of previous?.items || []) byId.set(item.id, item)
  for (const item of additions) byId.set(item.id, { ...byId.get(item.id), ...item })
  const items = [...byId.values()].sort((a, b) => new Date(a.start || 0).getTime() - new Date(b.start || 0).getTime())
  saveObservationCache('upcoming', { items, cursor: previous?.cursor || null, pages: previous?.pages || 1, expiresAt: previous?.expiresAt ?? Date.now() + CLIENT_CACHE_TTL })
  return items
}

function freshClientCache<T extends { expiresAt: number }>(entry?: T | null): entry is T {
  return Boolean(entry && entry.expiresAt > Date.now())
}

function useClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer) }, [])
  return now
}

export default function App() {
  const now = useClock()
  const [page, setPage] = useState<Page>('dashboard')
  const [observationDetail, setObservationDetail] = useState<{ page: 'observations' | 'receptions'; id: number } | null>(null)
  const [config, setConfig] = useState<any>(null)
  const [targets, setTargets] = useState<Target[]>([])
  const [settings, setSettings] = useState<Settings>(defaultSettings)
  const [notice, setNotice] = useState<{ message: string; tone: 'success' | 'error' | 'info' } | null>(null)
  const notify = (message: string, tone: 'success' | 'error' | 'info' = 'error') => setNotice({ message, tone })
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.tone === 'info' ? 3500 : 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const reload = async () => {
    try {
      const [configValue, targetValues, settingsValue] = await Promise.all([
        api<any>('/config'), api<Target[]>('/targets'), api<Settings>('/settings'),
      ])
      setConfig(configValue); setTargets(targetValues); setSettings(settingsValue)
    } catch (error) { notify(String(error)) }
  }
  useEffect(() => { reload() }, [])
  const navigate = (destination: Page, observationId?: number) => {
    setPage(destination)
    setObservationDetail(observationId && (destination === 'observations' || destination === 'receptions') ? { page: destination, id: observationId } : null)
  }

  return <div className="app-shell">
    <aside className="rail">
      <div className="brand"><span className="brand-orbit" /> <span>SatScheduler</span></div>
      <nav>{NAV.map(item => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => navigate(item.id)}>
        <span className="nav-mark">{item.mark}</span><span>{item.label}</span>
      </button>)}</nav>
      <div className="station-chip"><span className={config?.station ? 'signal online' : 'signal'} />
        <div><strong>{config?.station?.station_name || `Station ${config?.station?.station_id || '—'}`}</strong><small>{config?.station ? 'Configuration ready' : 'Needs configuration'}</small></div>
      </div>
    </aside>
    <GlobalUtcClock now={now} />
    <main>
      {notice && <button className={`notice ${notice.tone}`} onClick={() => setNotice(null)}>{notice.message}</button>}
      {page === 'dashboard' && <Dashboard config={config} targets={targets} onNavigate={navigate} onNotify={notify} />}
      {page === 'targets' && <Targets targets={targets} onChanged={reload} onNotify={notify} />}
      {page === 'schedule' && <Schedule settings={settings} targets={targets} onNotify={notify} />}
      {page === 'observations' && <ObservationList future title="Upcoming observations" initialSelected={observationDetail?.page === 'observations' ? observationDetail.id : null} onNotify={notify} />}
      {page === 'receptions' && <ObservationList future={false} title="Reception archive" initialSelected={observationDetail?.page === 'receptions' ? observationDetail.id : null} onNotify={notify} />}
      {page === 'settings' && <SettingsPage value={settings} config={config} onSaved={reload} onNotify={notify} />}
    </main>
  </div>
}

function GlobalUtcClock({ now }: { now: Date }) {
  return <div className="global-utc" aria-label={`Current UTC time ${now.toISOString()}`}><small>UTC</small><strong>{now.toISOString().slice(11, 19)}</strong><span>{now.toISOString().slice(0, 10)}</span></div>
}

function PageHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><small>{eyebrow}</small><h1>{title}</h1></div>{action}</header>
}

function Dashboard({ config, targets, onNavigate, onNotify }: { config: any; targets: Target[]; onNavigate: (p: Page, observationId?: number) => void; onNotify: Notify }) {
  const now = useClock()
  const [upcoming, setUpcoming] = useState<Observation[]>(observationViewCache.upcoming?.items || [])
  const [receptions, setReceptions] = useState<Observation[]>(observationViewCache.receptions?.items || [])
  const [refreshing, setRefreshing] = useState(false), [refreshingReceptions, setRefreshingReceptions] = useState(false)
  const refreshInFlight = useRef(false), receptionRefreshInFlight = useRef(false)
  const refreshTimeline = async (force = false) => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true; setRefreshing(true)
    try {
      const value = await api<any>(`/observations/overview${force ? '?force=true' : ''}`), items = value.results || []
      saveObservationCache('upcoming', { items, cursor: null, pages: 1, expiresAt: Date.now() + CLIENT_CACHE_TTL })
      setUpcoming(items)
    } finally { refreshInFlight.current = false; setRefreshing(false) }
  }
  const refreshReceptions = async (force = false) => {
    if (receptionRefreshInFlight.current) return
    receptionRefreshInFlight.current = true; setRefreshingReceptions(true)
    try {
      const value = await api<any>(`/observations/receptions${force ? '?force=true' : ''}`), items = value.results || []
      saveObservationCache('receptions', { items, cursor: value.next_cursor || null, pages: 1, expiresAt: Date.now() + CLIENT_CACHE_TTL })
      setReceptions(items)
    } finally { receptionRefreshInFlight.current = false; setRefreshingReceptions(false) }
  }
  useEffect(() => {
    const cached = observationViewCache.upcoming
    if (freshClientCache(cached)) return
    void refreshTimeline(false).catch(() => {})
  }, [])
  useEffect(() => {
    if (freshClientCache(observationViewCache.receptions)) return
    void refreshReceptions(false).catch(() => {})
  }, [])
  const next = useMemo(() => [...upcoming].filter(item => new Date(item.end || item.start || 0).getTime() > now.getTime()).sort((a, b) => new Date(a.start || 0).getTime() - new Date(b.start || 0).getTime())[0], [upcoming, now])
  const upcomingList = useMemo(() => [...upcoming].filter(item => new Date(item.end || item.start || 0).getTime() > now.getTime()).sort((a, b) => new Date(a.start || 0).getTime() - new Date(b.start || 0).getTime()).slice(0, 6), [upcoming, now])
  const receptionList = useMemo(() => [...receptions].sort((a, b) => new Date(b.end || b.start || 0).getTime() - new Date(a.end || a.start || 0).getTime()).slice(0, 6), [receptions])
  return <div className="page">
    <PageHeader eyebrow="GROUND CONTROL / SINGLE STATION" title="Observation overview" action={<button className="primary" onClick={() => onNavigate('schedule')}>Build schedule</button>} />
    <section className="hero-grid">
      <div className="utc-card"><small>LIVE UNIVERSAL TIME</small><strong>{now.toISOString().slice(11, 19)}</strong><span>{now.toISOString().slice(0, 10)} · UTC</span></div>
      <Metric label="Enabled satellites" value={String(targets.filter(t => t.enabled).length)} detail={`${targets.length} total watch targets`} />
      <Metric label="Upcoming" value={String(upcoming.length)} detail="Loaded first page" />
      <Metric label="Next automatic run" value={config?.automatic_job?.enabled ? 'ARMED' : 'OFF'} detail={formatUtc(config?.automatic_job?.next_run_at)} />
    </section>
    <section className="panel"><div className="panel-title"><div><small>48 HOUR WINDOW{refreshing ? ' · updating in background' : ''}</small><h2>Station timeline</h2></div><button className="ghost" onClick={() => onNavigate('observations')}>Open list</button></div>
      <Timeline observations={upcoming} />
    </section>
    <section className="panel next-observation"><div className="panel-title"><div><small>NEXT OBSERVATION</small><h2>{next ? observationSatellite(next) : 'No scheduled pass'}</h2></div>{next && <span className={`observation-status ${listeningStatus(next, now).className}`}>{listeningStatus(next, now).label}</span>}</div>
      {next ? <div className="next-observation-grid"><div className="next-observation-data"><div className="next-transmitter"><small>TRANSMITTER</small><strong>{next.transmitter_description || next.transmitter_mode || next.transmitter_uuid || 'Unknown transmitter'}</strong><span>{frequency(observationFrequency(next))} · {next.transmitter_mode || 'Unknown mode'}</span></div><div className="countdown-grid"><div><small>START</small><strong>{distanceFrom(now, next.start)}</strong><span>{formatUtc(next.start)}</span></div><div><small>END</small><strong>{distanceFrom(now, next.end)}</strong><span>{formatUtc(next.end)}</span></div></div><ObservationProgress observation={next} now={now} /><dl className="observation-facts"><dt>Duration</dt><dd>{observationDuration(next)}</dd><dt>Maximum elevation</dt><dd>{degrees(next.max_altitude)}</dd><dt>Rise azimuth</dt><dd>{degrees(next.rise_azimuth)}</dd><dt>Set azimuth</dt><dd>{degrees(next.set_azimuth)}</dd><dt>Observation ID</dt><dd><button className="observation-id-link" onClick={() => onNavigate('observations', next.id)}>#{next.id} →</button></dd></dl></div><PolarPlot observation={next} now={now} /></div> : <div className="empty">There are no upcoming observations in the loaded 48-hour window.</div>}
    </section>
    <section className="split">
      <div className="panel overview-list"><div className="panel-title"><div><small>NEXT 6</small><h2>Upcoming List</h2></div><div className="button-row"><button className="ghost" disabled={refreshing} onClick={() => refreshTimeline(true).then(() => onNotify('Upcoming timeline refreshed.', 'success')).catch(error => onNotify(String(error), 'error'))}>{refreshing ? 'Refreshing…' : 'Refresh'}</button><button className="ghost" onClick={() => onNavigate('observations')}>View all →</button></div></div>{upcomingList.map(item => <button className="overview-list-row" key={item.id} onClick={() => onNavigate('observations', item.id)}><div><strong>{observationSatellite(item)}</strong><small>#{item.id} · {item.transmitter_mode || item.transmitter_description || 'Unknown mode'}</small></div><div><strong>{formatUtc(item.start)}</strong><small>{observationDuration(item)} · {degrees(item.max_altitude)}</small></div><span>→</span></button>)}{!upcomingList.length && <div className="empty">No upcoming observations.</div>}</div>
      <div className="panel overview-list"><div className="panel-title"><div><small>LATEST 6</small><h2>Reception List</h2></div><div className="button-row"><button className="ghost" disabled={refreshingReceptions} onClick={() => refreshReceptions(true).then(() => onNotify('Latest Reception page refreshed.', 'success')).catch(error => onNotify(String(error), 'error'))}>{refreshingReceptions ? 'Refreshing…' : 'Refresh'}</button><button className="ghost" onClick={() => onNavigate('receptions')}>View all →</button></div></div>{receptionList.map(item => <button className="overview-list-row" key={item.id} onClick={() => onNavigate('receptions', item.id)}><div><strong>{observationSatellite(item)}</strong><small>#{item.id} · {item.transmitter_mode || item.transmitter_description || 'Unknown mode'}</small></div><div><strong>{formatUtc(item.end || item.start)}</strong><small>{item.vetted_status || 'unknown'} · {degrees(item.max_altitude)}</small></div><span>→</span></button>)}{!receptionList.length && <div className="empty">No recent receptions cached.</div>}</div>
    </section>
  </div>
}

function observationSatellite(item: Observation): string {
  return item.satellite_name || item.tle0?.replace(/^0\s+/, '') || (item.norad_cat_id ? `NORAD ${item.norad_cat_id}` : 'Unknown satellite')
}

function observationFrequency(item: Observation): number | undefined {
  return item.observation_frequency || item.center_frequency || item.transmitter_downlink_low
}

function degrees(value?: number): string {
  return value == null ? '—' : `${value.toFixed(1)}°`
}

function distanceFrom(now: Date, value?: string): string {
  if (!value) return '—'
  const seconds = Math.round((new Date(value).getTime() - now.getTime()) / 1000)
  const absolute = Math.abs(seconds), days = Math.floor(absolute / 86400), hours = Math.floor((absolute % 86400) / 3600), minutes = Math.floor((absolute % 3600) / 60), rest = absolute % 60
  const parts = days ? [`${days}d`, `${hours}h`] : hours ? [`${hours}h`, `${minutes}m`] : minutes ? [`${minutes}m`, `${rest}s`] : [`${rest}s`]
  return `${seconds >= 0 ? 'in ' : ''}${parts.join(' ')}${seconds < 0 ? ' ago' : ''}`
}

function listeningStatus(item: Observation, now: Date): { label: string; className: string } {
  const time = now.getTime(), start = new Date(item.start || 0).getTime(), end = new Date(item.end || 0).getTime()
  if (time >= start && time < end) return { label: 'Receiving now', className: 'live' }
  if (time < start) return { label: 'Scheduled', className: 'scheduled' }
  return { label: item.status || 'Finished', className: item.status === 'good' ? 'good' : 'finished' }
}

function observationProgress(item: Observation, now: Date): number {
  const start = new Date(item.start || 0).getTime(), end = new Date(item.end || 0).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  return Math.max(0, Math.min(1, (now.getTime() - start) / (end - start)))
}

function ObservationProgress({ observation, now }: { observation: Observation; now: Date }) {
  const progress = observationProgress(observation, now), live = listeningStatus(observation, now).className === 'live'
  return <div className={`observation-progress ${live ? 'live' : ''}`}><div><small>{live ? 'RECEPTION PROGRESS' : 'OBSERVATION WINDOW'}</small><span>{live ? `${Math.round(progress * 100)}%` : observationDuration(observation)}</span></div><div className="observation-progress-track"><span style={{ width: `${progress * 100}%` }} /></div></div>
}

function PolarPlot({ observation, now }: { observation: Observation; now?: Date }) {
  const center = 130, radius = 104
  const polar = (azimuth: number, elevation: number) => { const radians = (azimuth - 90) * Math.PI / 180, distance = radius * (1 - elevation / 90); return { x: center + distance * Math.cos(radians), y: center + distance * Math.sin(radians) } }
  const riseAzimuth = observation.rise_azimuth ?? 0, setAzimuth = observation.set_azimuth ?? 180
  const delta = ((setAzimuth - riseAzimuth + 540) % 360) - 180, peakAzimuth = (riseAzimuth + delta / 2 + 360) % 360
  const rise = polar(riseAzimuth, 0), peak = polar(peakAzimuth, observation.max_altitude ?? 0), set = polar(setAzimuth, 0)
  const control = { x: 2 * peak.x - (rise.x + set.x) / 2, y: 2 * peak.y - (rise.y + set.y) / 2 }
  const progress = now ? observationProgress(observation, now) : 0, live = now && listeningStatus(observation, now).className === 'live'
  const current = { x: (1 - progress) ** 2 * rise.x + 2 * (1 - progress) * progress * control.x + progress ** 2 * set.x, y: (1 - progress) ** 2 * rise.y + 2 * (1 - progress) * progress * control.y + progress ** 2 * set.y }
  return <div className="polar-wrap"><svg className="polar-plot" viewBox="0 0 260 260" role="img" aria-label={`Polar plot from ${riseAzimuth} degrees to ${setAzimuth} degrees, peak ${observation.max_altitude ?? 0} degrees`}><circle cx={center} cy={center} r={radius} /><circle cx={center} cy={center} r={radius * 2 / 3} /><circle cx={center} cy={center} r={radius / 3} /><line x1={center} y1={center - radius} x2={center} y2={center + radius} /><line x1={center - radius} y1={center} x2={center + radius} y2={center} /><text x={center} y="13">N</text><text x="250" y={center + 4}>E</text><text x={center} y="257">S</text><text x="10" y={center + 4}>W</text><text className="elevation-label" x={center + 4} y={center - radius * 2 / 3}>30°</text><text className="elevation-label" x={center + 4} y={center - radius / 3}>60°</text><path className="polar-path" d={`M ${rise.x} ${rise.y} Q ${control.x} ${control.y} ${set.x} ${set.y}`} /><circle className="polar-point rise" cx={rise.x} cy={rise.y} r="4" /><circle className="polar-point peak" cx={peak.x} cy={peak.y} r="5" /><circle className="polar-point set" cx={set.x} cy={set.y} r="4" />{live && <><circle className="polar-current-pulse" cx={current.x} cy={current.y} r="10" /><circle className="polar-current" cx={current.x} cy={current.y} r="5" /></>}</svg><div className="polar-legend"><span><i className="rise" />AOS {degrees(riseAzimuth)}</span><span><i className="peak" />MAX {degrees(observation.max_altitude)}</span><span><i className="set" />LOS {degrees(setAzimuth)}</span></div></div>
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="metric"><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>
}

function Timeline({ observations }: { observations: Observation[] }) {
  const start = Date.now(), span = 48 * 3600_000
  return <div className="timeline"><div className="timeline-axis"><span>NOW</span><span>+12H</span><span>+24H</span><span>+36H</span><span>+48H</span></div><div className="timeline-track">
    {observations.map(item => { const left = Math.max(0, Math.min(100, ((new Date(item.start || 0).getTime() - start) / span) * 100)); const width = Math.max(0.8, ((new Date(item.end || 0).getTime() - new Date(item.start || 0).getTime()) / span) * 100); return <span key={item.id} className="timeline-event" style={{ left: `${left}%`, width: `${width}%` }}><span className="timeline-tooltip"><strong>{observationSatellite(item)}</strong><span>{frequency(observationFrequency(item))} · {item.transmitter_mode || 'Unknown mode'}</span><span>{formatUtc(item.start)} → {formatUtc(item.end)}</span><span>{observationDuration(item)} · Observation #{item.id}</span></span></span> })}
  </div></div>
}

function ScheduleTimeline({ observations, passes, submissionItems, targets }: { observations: Observation[]; passes: Pass[]; submissionItems: any[]; targets: Target[] }) {
  const start = Date.now(), span = 48 * 3600_000
  const submissionByPass = new Map(submissionItems.map(item => [`${item.target_id}:${new Date(item.start).getTime()}`, item]))
  const events = [
    ...observations.map(item => ({ key: `observation-${item.id}`, start: item.start, end: item.end, label: observationSatellite(item), frequency: observationFrequency(item), mode: item.transmitter_mode, state: 'booked', id: item.id })),
    ...passes.filter(item => !submissionByPass.has(`${item.target_id}:${new Date(item.start).getTime()}`)).map(item => { const target = targets.find(value => value.id === item.target_id); return { key: `plan-${item.target_id}-${item.start}`, start: item.start, end: item.end, label: item.satellite_name, frequency: target?.center_frequency, mode: target?.transmitter_description, state: 'planned', id: undefined } }),
    ...submissionItems.map(item => { const target = targets.find(value => value.id === item.target_id); return { key: `submission-${item.key || `${item.target_id}-${item.start}`}`, start: item.start, end: item.end, label: item.satellite_name || target?.satellite_name || target?.name || item.target_id, frequency: target?.center_frequency, mode: target?.transmitter_description, state: item.status === 'scheduled' ? 'scheduled' : item.status === 'failed' ? 'failed' : item.status === 'scheduling' ? 'scheduling' : 'planned', id: item.observation_id } }),
  ]
  return <div className="schedule-timeline"><div className="timeline-legend"><span className="booked">Booked</span><span className="planned">Planned</span><span className="scheduling">Scheduling</span><span className="scheduled">Success</span><span className="failed">Failed</span></div><div className="timeline"><div className="timeline-axis"><span>NOW</span><span>+12H</span><span>+24H</span><span>+36H</span><span>+48H</span></div><div className="timeline-track">{events.map(event => { const eventStart = new Date(event.start || 0).getTime(), eventEnd = new Date(event.end || 0).getTime(); if (eventEnd < start || eventStart > start + span) return null; const left = Math.max(0, Math.min(100, ((eventStart - start) / span) * 100)), width = Math.max(0.8, ((eventEnd - eventStart) / span) * 100); return <span key={event.key} className={`timeline-event ${event.state}`} style={{ left: `${left}%`, width: `${width}%` }}><span className="timeline-tooltip"><strong>{event.label}</strong><span>{frequency(event.frequency)} · {event.mode || 'Unknown mode'}</span><span>{formatUtc(event.start)} → {formatUtc(event.end)}</span><span>{durationBetween(event.start, event.end)} · {event.state}{event.id ? ` · Observation #${event.id}` : ''}</span></span></span> })}</div></div></div>
}

function Targets({ targets, onChanged, onNotify }: { targets: Target[]; onChanged: () => void; onNotify: Notify }) {
  const [editing, setEditing] = useState<Target | null | 'new'>(null)
  const move = async (index: number, offset: number) => { const next = [...targets]; const destination = index + offset; if (destination < 0 || destination >= next.length) return; [next[index], next[destination]] = [next[destination], next[index]]; await api('/targets/reorder', { method: 'PUT', body: JSON.stringify({ ids: next.map(t => t.id) }) }); await onChanged(); onNotify('Satellite priority order updated.', 'success') }
  const remove = async (id: string) => { if (!confirm('Delete this watch target?')) return; const name = targets.find(target => target.id === id)?.satellite_name || targets.find(target => target.id === id)?.name || 'Satellite'; await api(`/targets/${id}`, { method: 'DELETE' }); await onChanged(); onNotify(`${name} deleted from the watch list.`, 'success') }
  return <div className="page"><PageHeader eyebrow="WATCH TARGETS" title="Satellite priority list" action={<button className="primary" onClick={() => setEditing('new')}>Add satellite</button>} />
    <div className="panel target-table">{targets.length === 0 && <div className="empty">No satellites yet. Add the first watch target.</div>}{targets.map((target, index) => <div className="target-row" key={target.id}>
      <div className="order-controls"><button onClick={() => move(index, -1).catch(error => onNotify(String(error), 'error'))}>↑</button><span>{String(index + 1).padStart(2, '0')}</span><button onClick={() => move(index, 1).catch(error => onNotify(String(error), 'error'))}>↓</button></div>
      <div className="target-main"><div><span className={`health ${target.health_status}`} /><strong>{target.satellite_name || target.name}</strong><small>{target.sat_id} · NORAD {target.norad_cat_id || '—'}</small></div><div className="tags">{target.requires_station_daylight && <span>Station daylight</span>}{target.min_peak_elevation != null && <span>Peak ≥ {target.min_peak_elevation}°</span>}{target.max_peak_elevation != null && <span>Peak ≤ {target.max_peak_elevation}°</span>}{target.min_azimuth != null && <span>Az {target.min_azimuth}–{target.max_azimuth}°</span>}</div></div>
      <div className="target-meta"><strong>{target.transmitter_description || target.transmitter_uuid}</strong><small>{frequency(target.center_frequency)}</small></div>
      <div className="row-actions"><button className="ghost" onClick={() => setEditing(target)}>Edit</button><button className="danger" onClick={() => remove(target.id).catch(e => onNotify(String(e), 'error'))}>Delete</button></div>
    </div>)}</div>{editing && <TargetEditor value={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={async () => { const action = editing === 'new' ? 'added' : 'updated'; setEditing(null); await onChanged(); onNotify(`Satellite ${action} successfully.`, 'success') }} onNotify={onNotify} />}</div>
}

function TargetEditor({ value, onClose, onSaved, onNotify }: { value?: Target; onClose: () => void; onSaved: () => void; onNotify: Notify }) {
  const [satellites, setSatellites] = useState<any[]>([]), [loadingSatellites, setLoadingSatellites] = useState(true), [satelliteSearch, setSatelliteSearch] = useState(value?.satellite_name || value?.name || '')
  const [transmitters, setTransmitters] = useState<TransmitterInsight[]>([]), [loadingTransmitters, setLoadingTransmitters] = useState(false)
  const [form, setForm] = useState<any>(value || { name: '', sat_id: '', transmitter_uuid: '', priority: 1, enabled: true, requires_station_daylight: false, daylight_solar_elevation: -6 })
  const loadSatellites = async (force = false) => { if (!force && freshClientCache(satelliteCatalogCache)) { setSatellites(satelliteCatalogCache.results); setLoadingSatellites(false); return } setLoadingSatellites(true); try { const value = await api<any>(`/satellites${force ? '?force=true' : ''}`); const results = value.results || []; satelliteCatalogCache = { results, expiresAt: Date.now() + CLIENT_CACHE_TTL }; setSatellites(results); if (force) onNotify(`Satellite catalog updated: ${results.length} records.`, 'success') } catch (error) { onNotify(`Satellite catalog update failed: ${String(error)}`, 'error') } finally { setLoadingSatellites(false) } }
  useEffect(() => { void loadSatellites(false) }, [])
  const loadTransmitters = async (force = false) => { if (!form.sat_id) return; setLoadingTransmitters(true); try { const value = await api<any>(`/satellites/${form.sat_id}/transmitter-insights${force ? '?force=true' : ''}`); setTransmitters(value.results || []); if (force) onNotify('Transmitter statistics updated.', 'success') } catch (e) { onNotify(String(e), 'error'); setTransmitters([]) } finally { setLoadingTransmitters(false) } }
  useEffect(() => { setTransmitters([]); loadTransmitters() }, [form.sat_id])
  const aliases = (satellite: any) => Array.isArray(satellite.names) ? satellite.names.join(', ') : satellite.names || satellite.aliases || satellite.alternative_names || ''
  const filteredSatellites = useMemo(() => { const keyword = satelliteSearch.trim().toLocaleLowerCase(); if (!keyword) return satellites; return satellites.filter(satellite => [satellite.sat_id, satellite.norad_cat_id, satellite.name, aliases(satellite)].some(value => String(value ?? '').toLocaleLowerCase().includes(keyword))) }, [satellites, satelliteSearch])
  const selectSatellite = (satellite: any) => { setSatelliteSearch(satellite.name || aliases(satellite) || satellite.sat_id); setForm({ ...form, sat_id: satellite.sat_id, transmitter_uuid: '', transmitter_success_rate: null, transmitter_good_count: null, transmitter_max_good_count: null }) }
  const number = (key: string, input: string) => setForm({ ...form, [key]: input === '' ? null : Number(input) })
  const save = async () => { const selected = satellites.find(s => s.sat_id === form.sat_id); const tx = transmitters.find(t => t.uuid === form.transmitter_uuid); const stats = tx?.network_stats; const preserveSnapshot = !tx && value?.transmitter_uuid === form.transmitter_uuid; const body = { ...form, name: form.name || selected?.name || 'Satellite', satellite_name: selected?.name || form.satellite_name, norad_cat_id: selected?.norad_cat_id || form.norad_cat_id, transmitter_description: tx?.description || form.transmitter_description, center_frequency: tx?.downlink_low || form.center_frequency, transmitter_success_rate: stats ? stats.success_rate / 100 : preserveSnapshot ? form.transmitter_success_rate ?? null : null, transmitter_good_count: stats?.good_count ?? (preserveSnapshot ? form.transmitter_good_count ?? null : null), transmitter_max_good_count: tx ? tx.stats_max_good_count : preserveSnapshot ? form.transmitter_max_good_count ?? null : null }; delete body.id; delete body.sort_order; delete body.failure_count; delete body.health_status; delete body.last_error; delete body.created_at; delete body.updated_at; await api(value ? `/targets/${value.id}` : '/targets', { method: value ? 'PUT' : 'POST', body: JSON.stringify(body) }); onSaved() }
  return <div className="modal-backdrop"><div className="modal"><div className="panel-title"><div><small>WATCH TARGET</small><h2>{value ? 'Edit satellite' : 'Add satellite'}</h2></div><button className="ghost" onClick={onClose}>Close</button></div>
    <section className="satellite-picker"><div className="picker-title"><label>Search satellites<input value={satelliteSearch} onChange={e => setSatelliteSearch(e.target.value)} placeholder="Name, alias, SatNOGS ID or NORAD ID" /></label><button className="ghost" disabled={loadingSatellites} onClick={() => loadSatellites(true)}>Refresh catalog</button></div>{form.sat_id && <div className="selected-satellite"><span>Selected: <strong>{satellites.find(s => s.sat_id === form.sat_id)?.name || form.satellite_name || form.name}</strong></span><button className="ghost" onClick={() => { setSatelliteSearch(''); setForm({ ...form, sat_id: '', transmitter_uuid: '' }); setTransmitters([]) }}>Clear</button></div>}{loadingSatellites ? <div className="catalog-loading"><span className="spinner" /> Loading satellite catalog…</div> : <><div className="satellite-results">{filteredSatellites.slice(0, 100).map(satellite => <button className={form.sat_id === satellite.sat_id ? 'selected' : ''} key={satellite.sat_id} onClick={() => selectSatellite(satellite)}><div><strong>{satellite.name || aliases(satellite) || satellite.sat_id}</strong><small>NORAD {satellite.norad_cat_id || '—'} · {satellite.sat_id}</small>{aliases(satellite) && <small>Aliases: {aliases(satellite)}</small>}</div>{form.sat_id === satellite.sat_id && <span>Selected</span>}</button>)}</div>{!filteredSatellites.length && <div className="catalog-loading">No satellites match “{satelliteSearch}”.</div>}{filteredSatellites.length > 100 && <div className="catalog-limit">Showing first 100 of {filteredSatellites.length}; refine the search to narrow the list.</div>}</>}</section>
    <div className="form-grid"><label>Minimum horizon °<input type="number" value={form.min_elevation ?? ''} onChange={e => number('min_elevation', e.target.value)} /></label><label>Minimum peak °<input type="number" value={form.min_peak_elevation ?? ''} onChange={e => number('min_peak_elevation', e.target.value)} /></label><label>Maximum peak °<input type="number" value={form.max_peak_elevation ?? ''} onChange={e => number('max_peak_elevation', e.target.value)} /></label><label>Azimuth from °<input type="number" value={form.min_azimuth ?? ''} onChange={e => number('min_azimuth', e.target.value)} /></label><label>Azimuth to °<input type="number" value={form.max_azimuth ?? ''} onChange={e => number('max_azimuth', e.target.value)} /></label></div>
    {form.sat_id && <section className="transmitter-picker"><div className="picker-title"><div><small>TRANSMITTER EVIDENCE</small><strong>Select a transmitter</strong></div><button className="ghost" disabled={loadingTransmitters} onClick={() => loadTransmitters(true)}>Refresh stats</button></div>{loadingTransmitters && <div className="picker-loading">Loading Network statistics and two recent good-observation pages…</div>}{!loadingTransmitters && !transmitters.length && <div className="picker-loading">No active transmitters found.</div>}{transmitters.map(tx => <button className={`transmitter-choice ${form.transmitter_uuid === tx.uuid ? 'selected' : ''}`} key={tx.uuid} onClick={() => setForm({ ...form, transmitter_uuid: tx.uuid })}><div className="tx-heading"><div><strong>{tx.description || tx.mode || tx.uuid}</strong><small>{tx.mode || 'Unknown mode'} · {frequency(tx.downlink_low)}</small></div>{tx.recommended && <span className="recommended">Recommended{transmitters.length > 1 ? ` · ${tx.recent_good_count} recent good` : ''}</span>}</div><TransmitterStatsBar transmitter={tx} /></button>)}</section>}
    <label className="check"><input type="checkbox" checked={form.requires_station_daylight} onChange={e => setForm({ ...form, requires_station_daylight: e.target.checked })} /> Only schedule when the station is in daylight</label>
    <div className="modal-actions"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={!form.sat_id || !form.transmitter_uuid} onClick={() => save().catch(e => onNotify(String(e), 'error'))}>Save target</button></div>
  </div></div>
}

function TransmitterStatsBar({ transmitter }: { transmitter: TransmitterInsight }) {
  const stats = transmitter.network_stats
  if (!stats) return <div className="stats-missing">Network statistics unavailable · SatNOG default cannot score this transmitter</div>
  const good = stats.good_count || 0, bad = stats.bad_count || 0, unknown = (stats.unknown_count || 0) + (stats.future_count || 0), total = Math.max(1, good + bad + unknown)
  const pct = (value: number) => `${(value / total) * 100}%`
  return <div className="tx-stats"><div className="ratio-bar" title={`Bad ${bad} · Unknown/future ${unknown} · Good ${good}`}><span className="ratio-bad" style={{ width: pct(bad) }} /><span className="ratio-unknown" style={{ width: pct(unknown) }} /><span className="ratio-good" style={{ width: pct(good) }} /></div><div className="ratio-legend"><span className="bad">Bad {stats.bad_rate}%</span><span className="unknown">Unknown {Math.round((unknown / total) * 100)}%</span><span className="good">Good {stats.success_rate}%</span><span>{stats.good_count.toLocaleString()} valid receptions</span></div></div>
}

function Schedule({ settings, targets, onNotify }: { settings: Settings; targets: Target[]; onNotify: Notify }) {
  const [plan, setPlan] = useState<any>(null), [draftPasses, setDraftPasses] = useState<Pass[]>([]), [planJob, setPlanJob] = useState<any>({ status: 'idle' }), [scheduleJob, setScheduleJob] = useState<any>({ status: 'idle' }), [result, setResult] = useState<any>(null)
  const [stationObservations, setStationObservations] = useState<Observation[]>(observationViewCache.upcoming?.items || []), [timelineLoading, setTimelineLoading] = useState(false)
  const activePlanJob = useRef<string | null>(null), activeScheduleJob = useRef<string | null>(null), loadedPlanJob = useRef<string | null>(null), processedScheduleJob = useRef<string | null>(null), timelineRefreshInFlight = useRef(false)
  const refreshStationTimeline = async (force = false) => {
    if (timelineRefreshInFlight.current) return
    timelineRefreshInFlight.current = true; setTimelineLoading(true)
    try {
      const value = await api<any>(`/observations/overview${force ? '?force=true' : ''}`), items = value.results || []
      setStationObservations(items)
      saveObservationCache('upcoming', { items, cursor: null, pages: 1, expiresAt: Date.now() + CLIENT_CACHE_TTL })
    } finally { timelineRefreshInFlight.current = false; setTimelineLoading(false) }
  }
  const updateJobs = async () => {
    try {
      const [nextPlanJob, nextScheduleJob] = await Promise.all([api<any>('/plans/status'), api<any>('/schedules/status')])
      setPlanJob(nextPlanJob); setScheduleJob(nextScheduleJob)
      if (nextPlanJob.status === 'completed' && nextPlanJob.result) {
        if (loadedPlanJob.current !== nextPlanJob.job_id) { setPlan(nextPlanJob.result); setDraftPasses([...(nextPlanJob.result.selected || [])]); loadedPlanJob.current = nextPlanJob.job_id }
        if (activePlanJob.current === nextPlanJob.job_id) { onNotify(`Plan calculated: ${nextPlanJob.result.selected?.length || 0} passes selected.`, 'success'); activePlanJob.current = null }
      } else if (nextPlanJob.status === 'failed' && activePlanJob.current === nextPlanJob.job_id) { onNotify(`Plan calculation failed: ${nextPlanJob.message}`, 'error'); activePlanJob.current = null }
      if (nextScheduleJob.status === 'completed' && nextScheduleJob.result) {
        setResult(nextScheduleJob.result)
        if (processedScheduleJob.current !== nextScheduleJob.job_id) {
          const resultItems = nextScheduleJob.result.items || []
          const keep = new Set(resultItems.filter((item: any) => item.status !== 'scheduled').map((item: any) => `${item.target_id}:${new Date(item.start).getTime()}`))
          const plannedByKey = new Map([...(plan?.selected || []), ...draftPasses].map((item: Pass) => [`${item.target_id}:${new Date(item.start).getTime()}`, item]))
          const additions: Observation[] = resultItems.filter((item: any) => item.status === 'scheduled' && item.observation_id).map((item: any) => {
            const planned = plannedByKey.get(`${item.target_id}:${new Date(item.start).getTime()}`), target = targets.find(value => value.id === item.target_id)
            return { id: Number(item.observation_id), start: item.start, end: item.end, satellite_name: item.satellite_name || planned?.satellite_name || target?.satellite_name || target?.name, sat_id: planned?.sat_id || target?.sat_id, transmitter_uuid: planned?.transmitter_uuid || target?.transmitter_uuid, transmitter_description: target?.transmitter_description, center_frequency: target?.center_frequency, max_altitude: planned?.peak_elevation, rise_azimuth: planned?.rise_azimuth, set_azimuth: planned?.set_azimuth, status: 'future' }
          })
          if (additions.length) setStationObservations(mergeUpcomingCache(additions))
          setDraftPasses(current => current.filter(item => keep.has(`${item.target_id}:${new Date(item.start).getTime()}`)))
          processedScheduleJob.current = nextScheduleJob.job_id
        }
        if (activeScheduleJob.current === nextScheduleJob.job_id) { const canceled = nextScheduleJob.result.status === 'canceled'; onNotify(canceled ? `Scheduling stopped: ${nextScheduleJob.result.success_count || 0} succeeded, ${nextScheduleJob.result.pending_count || 0} remain.` : `Scheduling finished: ${nextScheduleJob.result.success_count || 0} succeeded, ${nextScheduleJob.result.failure_count || 0} failed.`, canceled ? 'info' : nextScheduleJob.result.failure_count ? 'error' : 'success'); activeScheduleJob.current = null }
      } else if (nextScheduleJob.status === 'failed' && activeScheduleJob.current === nextScheduleJob.job_id) { onNotify(`Scheduling failed: ${nextScheduleJob.message}`, 'error'); activeScheduleJob.current = null }
    } catch (error) { onNotify(`Cannot read background task status: ${String(error)}`, 'error') }
  }
  useEffect(() => { void updateJobs() }, [])
  useEffect(() => {
    const cached = observationViewCache.upcoming
    if (cached?.items.length) setStationObservations(cached.items)
    if (freshClientCache(cached)) return
    void refreshStationTimeline(false).catch(error => onNotify(`Station timeline update failed: ${String(error)}`, 'error'))
  }, [])
  useEffect(() => {
    if (planJob.status !== 'running' && scheduleJob.status !== 'running') return
    const timer = window.setInterval(() => void updateJobs(), 1000)
    return () => window.clearInterval(timer)
  }, [planJob.status, scheduleJob.status])
  const build = async () => { try { const job: any = await api('/plans/start?force=true', { method: 'POST', body: JSON.stringify({}) }); activePlanJob.current = job.job_id; setPlanJob(job); onNotify('Plan calculation started in the background.', 'info') } catch (error) { onNotify(String(error), 'error') } }
  const startSchedule = async (passes: Pass[]) => { try { setResult(null); const job: any = await api('/schedules/start', { method: 'POST', body: JSON.stringify({ passes, trigger_type: 'manual' }) }); activeScheduleJob.current = job.job_id; setScheduleJob(job); onNotify('Observation submission started in the background.', 'info') } catch (error) { onNotify(String(error), 'error') } }
  const cancelSchedule = async () => { try { const job = await api<any>('/schedules/cancel', { method: 'POST' }); setScheduleJob(job); onNotify('Stop requested. The current API request will finish before submission stops.', 'info') } catch (error) { onNotify(`Cannot stop submission: ${String(error)}`, 'error') } }
  const submit = async () => { if (!draftPasses.length) { onNotify('The review list is empty. Recalculate the plan or keep at least one pass.', 'error'); return } if (confirm(`Submit the ${draftPasses.length} reviewed observations in the displayed order?`)) await startSchedule(draftPasses) }
  const movePass = (index: number, delta: number) => setDraftPasses(current => { const destination = index + delta; if (destination < 0 || destination >= current.length) return current; const next = [...current], [item] = next.splice(index, 1); next.splice(destination, 0, item); return next })
  const removePass = (index: number) => setDraftPasses(current => current.filter((_, itemIndex) => itemIndex !== index))
  const loading = planJob.status === 'running', submitting = scheduleJob.status === 'running'
  const skipReasons = useMemo(() => Object.entries((plan?.skipped || []).reduce((counts: Record<string, number>, item: any) => { const reason = item.reason || 'unknown'; counts[reason] = (counts[reason] || 0) + 1; return counts }, {})).sort((a: any, b: any) => b[1] - a[1]), [plan])
  const submissionItems = scheduleJob.items || result?.items || []
  return <div className="page"><PageHeader eyebrow="PLANNING DESK" title="Build an observation plan" action={<button className="primary" disabled={loading || submitting || !targets.length} onClick={build}>{loading ? 'Calculating…' : 'Recalculate passes'}</button>} />
    <section className="hero-grid"><Metric label="Engine" value={settings.prediction_engine === 'satnogs_predict' ? 'SatNOGS' : 'Skyfield'} detail={settings.comparison_enabled ? 'Comparison enabled' : 'Primary only'} /><Metric label="Sort mode" value={settings.sort_mode.replaceAll('_', ' ')} detail="Configured in Settings" /><Metric label="Planning horizon" value={`${settings.horizon_hours}H`} detail="All non-conflicting passes" /><Metric label="Enabled targets" value={String(targets.filter(t => t.enabled).length)} detail={`${settings.satellites_per_run} observations / API batch`} /></section>
    {loading && <JobProgress job={planJob} label="PLAN CALCULATION" />}{submitting && <JobProgress job={scheduleJob} label="OBSERVATION SUBMISSION" action={<button className="danger" disabled={scheduleJob.stage === 'canceling'} onClick={cancelSchedule}>{scheduleJob.stage === 'canceling' ? 'Stopping…' : 'Stop submission'}</button>} />}
    <section className="panel schedule-timeline-panel"><div className="panel-title"><div><small>STATION + CURRENT PLAN · 48 HOURS</small><h2>Scheduling timeline</h2></div>{timelineLoading && <span className="timeline-count">Updating station reservations…</span>}</div><ScheduleTimeline observations={stationObservations} passes={draftPasses} submissionItems={submissionItems} targets={targets} /></section>
    {!plan && !loading && <div className="panel empty">No cached plan is available. Calculate a preview before submitting observations.</div>}{plan && <div className="panel review-plan"><div className="panel-title"><div><small>REVIEW REQUIRED · {formatUtc(plan.start)} → {formatUtc(plan.end)}{planJob.cached ? ' · cached result' : ''}</small><h2>{draftPasses.length} ready to submit / {plan.selected.length} available</h2></div><button className="primary" disabled={!draftPasses.length || submitting || loading} onClick={submit}>{submitting ? 'Submitting…' : `Confirm and submit ${draftPasses.length}`}</button></div><p className="review-help">All non-conflicting passes are included by default. Remove unwanted passes or change their submission order before confirming.</p>{!plan.selected.length && <div className="result warning">No non-conflicting passes were selected. The reasons below explain why.</div>}<div className="skip-summary">{skipReasons.slice(0, 8).map(([reason, count]: any) => <span key={reason}><strong>{count}</strong>{String(reason).replaceAll('_', ' ')}</span>)}</div><div className="pass-list">{draftPasses.map((item: Pass, index: number) => <div className="pass-row review-row" key={`${item.target_id}-${item.start}`}><div className="pass-order"><strong>#{index + 1}</strong><span><button className="ghost" aria-label={`Move ${item.satellite_name} up`} disabled={submitting || index === 0} onClick={() => movePass(index, -1)}>↑</button><button className="ghost" aria-label={`Move ${item.satellite_name} down`} disabled={submitting || index === draftPasses.length - 1} onClick={() => movePass(index, 1)}>↓</button></span></div><div><strong>{item.satellite_name}</strong><small>{item.engine.replace('_', ' ')}</small></div><div><strong>{formatUtc(item.start)}</strong><small>{Math.round((new Date(item.end).getTime() - new Date(item.start).getTime()) / 1000)} sec</small></div><div><strong>{item.peak_elevation.toFixed(1)}° peak</strong><small>Az {item.rise_azimuth.toFixed(0)}° → {item.set_azimuth.toFixed(0)}°</small></div><button className="danger" disabled={submitting} onClick={() => removePass(index)}>Remove</button></div>)}{!draftPasses.length && plan.selected.length > 0 && <div className="empty">All passes were removed from this review list. Recalculate to restore them.</div>}</div></div>}
    {submissionItems.length > 0 && <div className={`panel schedule-result ${result?.failure_count || result?.status === 'canceled' || scheduleJob.status === 'failed' ? 'warning' : result ? 'success' : ''}`}><div className="panel-title"><div><small>{submitting ? 'LIVE SUBMISSION STATUS' : 'LAST SUBMISSION RESULT'}</small><h2>{result ? result.status === 'canceled' ? `Run canceled: ${result.success_count} scheduled, ${result.pending_count} remaining` : `Run ${result.status}: ${result.success_count} scheduled, ${result.failure_count} failed` : `${submissionItems.filter((item: any) => item.status === 'scheduled').length} / ${submissionItems.length} scheduled`}</h2></div>{result?.run_id && <span className="muted">{result.run_id}</span>}</div><div className="submission-status-list">{submissionItems.map((item: any, index: number) => <div className={`submission-status-row ${item.status}`} key={item.key || `${item.target_id}-${item.start}`}><span className="submission-index">#{index + 1}</span><div><strong>{item.satellite_name || item.target_id}</strong><small>{formatUtc(item.start)}</small></div><span className="submission-state">{item.status === 'waiting' ? 'Waiting' : item.status === 'retry_waiting' ? 'Retry queued' : item.status === 'scheduling' ? 'Scheduling…' : item.status === 'scheduled' ? `Scheduled${item.observation_id ? ` #${item.observation_id}` : ''}` : 'Failed'}</span>{item.error && <small className="submission-error">{item.error}</small>}</div>)}</div></div>}
  </div>
}

function JobProgress({ job, label, action }: { job: any; label: string; action?: React.ReactNode }) {
  const progress = job.progress || {}, current = progress.current ?? progress.page, total = progress.total
  const percentage = current != null && total ? Math.min(100, (current / total) * 100) : null
  return <section className="panel job-progress"><div className="job-progress-heading"><span className="spinner" /><div><small>{label} · {String(job.stage || 'working').replaceAll('_', ' ')}</small><strong>{job.message || 'Working in the background…'}</strong></div>{current != null && <span>{current}{total ? ` / ${total}` : ''}</span>}{action}</div><div className={`job-progress-bar ${percentage == null ? 'indeterminate' : ''}`}><span style={percentage == null ? undefined : { width: `${percentage}%` }} /></div>{progress.records != null && <small>{progress.records} records loaded</small>}<p>Safe to leave this page. The task continues on the server.</p></section>
}

function ObservationList({ future, title, initialSelected, onNotify }: { future: boolean; title: string; initialSelected: number | null; onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void }) {
  const initialCache = observationViewCache[future ? 'upcoming' : 'receptions']
  const [items, setItems] = useState<Observation[]>(initialCache?.items || []), [cursor, setCursor] = useState<string | null>(initialCache?.cursor || null), [loading, setLoading] = useState(false), [selected, setSelected] = useState<number | null>(initialSelected)
  const [receptionFilter, setReceptionFilter] = useState<'all' | 'good' | 'bad' | 'unknown'>('all')
  const [progress, setProgress] = useState({ page: 0, records: 0 })
  const request = useRef<AbortController | null>(null)
  const loadUpcoming = async (force = false, silent = false) => {
    const cached = observationViewCache.upcoming
    if (!force && freshClientCache(cached)) { setItems(cached.items); setCursor(cached.cursor); setProgress({ page: cached.pages, records: cached.items.length }); return }
    if (silent && request.current) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true); setProgress({ page: 0, records: items.length })
    const collected: Observation[] = [], seenIds = new Set<number>(), seenCursors = new Set<string>()
    let nextCursor: string | null = null, pages = 0
    try {
      while (pages < 20) {
        const params = new URLSearchParams()
        if (nextCursor) params.set('cursor', nextCursor)
        if (force) params.set('force', 'true')
        const data = await api<any>(`/observations/upcoming${params.size ? `?${params}` : ''}`, { signal: controller.signal })
        pages += 1
        for (const item of data.results || []) if (!seenIds.has(item.id)) { seenIds.add(item.id); collected.push(item) }
        collected.sort((a, b) => new Date(a.start || 0).getTime() - new Date(b.start || 0).getTime())
        setItems([...collected]); setProgress({ page: pages, records: collected.length })
        nextCursor = data.next_cursor || null
        if (!nextCursor || seenCursors.has(nextCursor)) break
        seenCursors.add(nextCursor)
      }
      saveObservationCache('upcoming', { items: [...collected], cursor: nextCursor, pages, expiresAt: Date.now() + CLIENT_CACHE_TTL })
      if (!silent) onNotify(`Upcoming observations updated: ${collected.length} records from ${pages} page${pages === 1 ? '' : 's'}.`, 'success')
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        if (collected.length) saveObservationCache('upcoming', { items: [...collected], cursor: nextCursor, pages, expiresAt: Date.now() + CLIENT_CACHE_TTL })
        onNotify(`Upcoming observations ${collected.length ? 'partially updated' : 'update failed'} after page ${pages}: ${String(error)}`, 'error')
      }
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false) }
    }
  }
  const loadReceptionPage = async (reset = false, force = false) => {
    const cached = observationViewCache.receptions
    if (reset && !force && freshClientCache(cached)) { setItems(cached.items); setCursor(cached.cursor); return }
    setLoading(true)
    try {
      const activeCursor = reset ? null : cursor, params = new URLSearchParams()
      if (activeCursor) params.set('cursor', activeCursor)
      if (force) params.set('force', 'true')
      const data = await api<any>(`/observations/receptions${params.size ? `?${params}` : ''}`)
      const nextCursor = data.next_cursor || null
      setItems(previous => { const merged = reset ? data.results : [...previous, ...data.results.filter((value: Observation) => !previous.some(item => item.id === value.id))]; saveObservationCache('receptions', { items: merged, cursor: nextCursor, pages: reset ? 1 : (observationViewCache.receptions?.pages || 1) + 1, expiresAt: Date.now() + CLIENT_CACHE_TTL }); return merged })
      setCursor(nextCursor)
      if (reset) onNotify(`Reception archive updated: ${data.results.length} records loaded.`, 'success')
    } catch (error) { onNotify(`Reception archive update failed: ${String(error)}`, 'error') }
    finally { setLoading(false) }
  }
  useEffect(() => {
    const cached = observationViewCache[future ? 'upcoming' : 'receptions']
    setItems(cached?.items || []); setCursor(cached?.cursor || null); setSelected(initialSelected)
    if (future) void loadUpcoming(false); else void loadReceptionPage(true, false)
    return () => request.current?.abort()
  }, [future])
  useEffect(() => { setSelected(initialSelected) }, [initialSelected])
  if (selected != null) return <ObservationDetail observationId={selected} future={future} onBack={() => setSelected(null)} />
  const receptionStatus = (item: Observation): 'good' | 'bad' | 'unknown' => item.vetted_status === 'good' ? 'good' : item.vetted_status === 'bad' ? 'bad' : 'unknown'
  const statusCounts = items.reduce((counts, item) => { counts[receptionStatus(item)] += 1; return counts }, { good: 0, bad: 0, unknown: 0 })
  const visibleItems = future || receptionFilter === 'all' ? items : items.filter(item => receptionStatus(item) === receptionFilter)
  return <div className="page"><PageHeader eyebrow={future ? 'STATION QUEUE' : 'RECEIVED SIGNALS'} title={title} action={<button className="ghost" onClick={() => future ? loadUpcoming(true) : loadReceptionPage(true, true)}>{loading ? (future ? 'Restart refresh' : 'Refreshing…') : 'Refresh'}</button>} />
    {future && <section className="panel upcoming-timeline"><div className="panel-title"><div><small>48 HOUR WINDOW</small><h2>Observation timeline</h2></div><span className="timeline-count">{items.length} observations</span></div><Timeline observations={items} /></section>}
    {future && loading && <div className="fetch-progress"><span className="spinner" /><div><strong>{progress.page ? `Fetching page ${progress.page + 1}…` : 'Starting background update…'}</strong><small>{progress.page} page{progress.page === 1 ? '' : 's'} · {progress.records} observations loaded</small></div></div>}
    {!future && <section className="reception-filters" aria-label="Reception status filter"><span>STATUS</span>{(['all', 'good', 'bad', 'unknown'] as const).map(status => <button key={status} className={receptionFilter === status ? 'active' : ''} onClick={() => setReceptionFilter(status)}>{status}<strong>{status === 'all' ? items.length : statusCounts[status]}</strong></button>)}<small>Counts apply to the {items.length} loaded records.</small></section>}
    <div className="panel observation-list">{visibleItems.map(item => <button className="observation-row" key={item.id} onClick={() => setSelected(item.id)}><div className="obs-id">#{item.id}</div><div><strong>{observationSatellite(item)}</strong><small>{item.transmitter_description || item.transmitter_mode || item.transmitter_uuid || 'Unknown transmitter'}</small></div><div><strong>{formatUtc(item.start)}</strong><small>to {formatUtc(item.end)}</small></div><div><strong>{degrees(item.max_altitude)}</strong><small>{item.vetted_status || (future ? 'scheduled' : 'unknown')}</small></div><span className="detail-chevron">View detail →</span></button>)}{!visibleItems.length && !loading && <div className="empty">{!future && receptionFilter !== 'all' ? `No ${receptionFilter} receptions in the loaded records.` : 'No records returned.'}</div>}{!items.length && loading && <div className="catalog-loading"><span className="spinner" /> Waiting for the first page…</div>}</div>
    {!future && cursor && <button className="load-more" onClick={() => loadReceptionPage()} disabled={loading}>{loading ? 'Loading…' : 'Load next page'}</button>}
  </div>
}

function ObservationDetail({ observationId, future, onBack }: { observationId: number; future: boolean; onBack: () => void }) {
  const [item, setItem] = useState<Observation | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  useEffect(() => { setLoading(true); api<Observation>(`/observations/${observationId}`).then(setItem).catch(e => setError(String(e))).finally(() => setLoading(false)) }, [observationId])
  const detailLabel = future ? 'UPCOMING DETAIL' : 'RECEPTION DETAIL'
  if (loading) return <div className="page"><PageHeader eyebrow={detailLabel} title={`Observation #${observationId}`} action={<button className="ghost" onClick={onBack}>← Back</button>} /><div className="panel catalog-loading"><span className="spinner" /> Loading observation detail…</div></div>
  if (!item || error) return <div className="page"><PageHeader eyebrow={detailLabel} title={`Observation #${observationId}`} action={<button className="ghost" onClick={onBack}>← Back</button>} /><div className="panel empty">{error || 'Observation not found.'}</div></div>
  const metadata = observationMetadata(item), radio = metadata?.radio, parameters = radio?.parameters || {}, demoddata = item.demoddata || []
  return <div className="page observation-detail"><PageHeader eyebrow={`${detailLabel} / #${item.id}`} title={observationSatellite(item)} action={<div className="button-row"><button className="ghost" onClick={onBack}>← Back</button><a className="ghost button-link" href={`https://network.satnogs.org/observations/${item.id}/`} target="_blank" rel="noreferrer">Open SatNOGS ↗</a></div>} />
    <section className="observation-detail-hero"><div><span className={`observation-status ${item.vetted_status === 'good' ? 'good' : item.vetted_status === 'bad' ? 'bad' : 'finished'}`}>{item.vetted_status || item.status || 'unknown'}</span><strong>{formatUtc(item.start)}</strong><small>{formatUtc(item.end)} · {observationDuration(item)}</small></div><div><small>TRANSMITTER</small><strong>{item.transmitter_description || item.transmitter_uuid || 'Unknown transmitter'}</strong><span>{frequency(observationFrequency(item))} · {item.transmitter_mode || 'Unknown mode'}{item.transmitter_baud ? ` · ${item.transmitter_baud.toLocaleString()} baud` : ''}</span></div><div><small>GROUND STATION</small><strong>{item.station_name || `Station ${item.ground_station || '—'}`}</strong><span>{item.station_lat ?? '—'}, {item.station_lng ?? '—'} · {item.station_alt ?? '—'} m</span></div></section>
    {future ? <section className="panel upcoming-detail-polar"><div className="panel-title"><div><small>PASS TRACK</small><h2>Polar plot</h2></div></div><PolarPlot observation={item} /></section> : <><section className="reception-media-grid"><div className="panel reception-audio"><div className="panel-title"><div><small>AUDIO RECORDING</small><h2>Listen</h2></div></div>{item.payload ? <audio controls preload="metadata" src={item.payload} /> : <p className="muted">No audio was uploaded.</p>}</div><div className="panel reception-polar"><div className="panel-title"><div><small>PASS TRACK</small><h2>Polar plot</h2></div></div><PolarPlot observation={item} /></div></section><section className="panel waterfall-panel"><div className="panel-title"><div><small>SPECTRUM</small><h2>Full-size waterfall</h2></div>{item.waterfall && <a href={item.waterfall} target="_blank" rel="noreferrer">Open original / zoom ↗</a>}</div>{item.waterfall ? <a className="waterfall-image-link" href={item.waterfall} target="_blank" rel="noreferrer" title="Open the original image for browser zoom and panning"><img src={item.waterfall} alt={`Waterfall for observation ${item.id}`} loading="lazy" /></a> : <div className="empty">No waterfall was uploaded.</div>}</section></>}
    <section className="split reception-details"><div className="panel"><div className="panel-title"><div><small>PASS GEOMETRY</small><h2>Observation data</h2></div></div><dl className="detail-facts"><dt>Maximum elevation</dt><dd>{degrees(item.max_altitude)}</dd><dt>Rise azimuth</dt><dd>{degrees(item.rise_azimuth)}</dd><dt>Set azimuth</dt><dd>{degrees(item.set_azimuth)}</dd><dt>NORAD catalog ID</dt><dd>{item.norad_cat_id || '—'}</dd><dt>SatNOGS satellite ID</dt><dd>{item.sat_id || '—'}</dd><dt>Observer</dt><dd>{item.observer || '—'}</dd><dt>Client version</dt><dd>{item.client_version || '—'}</dd><dt>Radio</dt><dd>{radio?.name || '—'}{radio?.version ? ` ${radio.version}` : ''}</dd><dt>Receiver gain</dt><dd>{parameters.gain ? `${parameters.gain} dB` : '—'}</dd><dt>Sample rate</dt><dd>{parameters['samp-rate-rx'] || '—'}</dd></dl></div><div className="panel"><div className="panel-title"><div><small>ORBITAL ELEMENTS</small><h2>TLE used for observation</h2></div><span className="muted">{item.tle_source || 'Unknown source'}</span></div><pre className="tle-block">{[item.tle0, item.tle1, item.tle2].filter(Boolean).join('\n') || 'No TLE available.'}</pre>{!future && <><div className="detail-assets"><a className={`ghost button-link ${item.payload ? '' : 'disabled'}`} href={item.payload || undefined} target="_blank" rel="noreferrer">Audio file</a><a className={`ghost button-link ${item.archive_url ? '' : 'disabled'}`} href={item.archive_url || undefined} target="_blank" rel="noreferrer">Archive</a></div>{demoddata.length > 0 && <div className="demod-list"><small>DECODED DATA</small>{demoddata.map((entry, index) => { const url = typeof entry === 'string' ? entry : entry.url; return url ? <a key={url} href={url} target="_blank" rel="noreferrer">{typeof entry === 'string' ? `Frame ${index + 1}` : entry.name || `Frame ${index + 1}`}</a> : null })}</div>}</>}</div></section>
  </div>
}

function observationMetadata(item: Observation): any {
  if (!item.client_metadata) return null
  if (typeof item.client_metadata === 'object') return item.client_metadata
  try { return JSON.parse(item.client_metadata) } catch { return null }
}

function observationDuration(item: Observation): string {
  return durationBetween(item.start, item.end)
}

function durationBetween(start?: string, end?: string): string {
  if (!start || !end) return '—'
  const seconds = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000))
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function SettingsPage({ value, config, onSaved, onNotify }: { value: Settings; config: any; onSaved: () => void; onNotify: Notify }) {
  const [form, setForm] = useState<Settings>(value), [importText, setImportText] = useState(''), [importFileName, setImportFileName] = useState('')
  useEffect(() => setForm(value), [value])
  const set = (key: keyof Settings, val: any) => setForm({ ...form, [key]: val })
  const save = async () => { await api('/settings', { method: 'PUT', body: JSON.stringify(form) }); await onSaved(); onNotify('Scheduler settings saved successfully.', 'success') }
  const exportFilename = () => { const now = new Date(), pad = (part: number) => String(part).padStart(2, '0'); return `SatScheduler-WatchList-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json` }
  const download = async () => { const payload = await api<any>('/export'); const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = exportFilename(); anchor.click(); URL.revokeObjectURL(url); onNotify(`Exported ${targetCount(payload) || 0} watch-list targets.`, 'success') }
  const targetCount = (payload: any) => Array.isArray(payload?.targets) ? payload.targets.length : Array.isArray(payload) ? payload.length : Array.isArray(payload?.watch_targets) ? payload.watch_targets.length : Array.isArray(payload?.watchTargets) ? payload.watchTargets.length : Array.isArray(payload?.androidWatchTargets) ? payload.androidWatchTargets.length : null
  const chooseFile = async (file?: File) => { if (!file) return; try { const text = await file.text(); const payload = JSON.parse(text); const count = targetCount(payload); if (count == null) throw new Error('This file does not contain a SatScheduler targets array.'); setImportText(JSON.stringify(payload, null, 2)); setImportFileName(`${file.name} · ${count} targets`) } catch (error) { setImportText(''); setImportFileName(''); onNotify(`Cannot read import file: ${String(error)}`, 'error') } }
  const importConfig = async () => { const payload = JSON.parse(importText), count = targetCount(payload); if (count == null) throw new Error('JSON does not contain a SatScheduler targets array.'); if (!confirm(`Import ${count} targets for station ${config?.station?.station_id || '—'} and replace the current watch list? Targets for other stations will be skipped.`)) return; const result = await api<{ imported: number; skipped_station_mismatch: number }>('/import?replace=true', { method: 'POST', body: JSON.stringify(payload) }); setImportText(''); setImportFileName(`Imported ${result.imported} · skipped ${result.skipped_station_mismatch} for station mismatch`); await onSaved(); onNotify(`Import completed: ${result.imported} targets imported, ${result.skipped_station_mismatch} skipped.`, 'success') }
  return <div className="page"><PageHeader eyebrow="SYSTEM CONFIGURATION" title="Scheduler settings" action={<button className="primary" onClick={() => save().catch(e => onNotify(String(e), 'error'))}>Save settings</button>} />
    <section className="split"><div className="panel"><div className="panel-title"><h2>Prediction and ranking</h2></div><div className="form-grid"><label>Primary engine<select value={form.prediction_engine} onChange={e => set('prediction_engine', e.target.value)}><option value="satnogs_predict">SatNOGS Predict</option><option value="skyfield">Direct Skyfield</option></select><small className="field-help">The engine used to calculate pass times, elevation and azimuth. This engine supplies the actual scheduling candidates.</small></label><label>Sort mode<select value={form.sort_mode} onChange={e => set('sort_mode', e.target.value)}><option value="list_priority">List priority</option><option value="list_priority_best_elevation">List priority + best elevation</option><option value="best_elevation">Best elevation only</option><option value="satnogs_default">SatNOG default mode</option></select><small className="field-help">Controls which candidate passes are considered first when passes conflict or a run limit is reached.</small></label></div><label className="check setting-check"><input type="checkbox" checked={form.comparison_enabled} onChange={e => set('comparison_enabled', e.target.checked)} /><span>Run the secondary prediction engine for comparison<small className="field-help">Calculates the same passes with the other engine and records timing differences. It does not change which engine schedules observations.</small></span></label></div>
      <div className="panel"><div className="panel-title"><div><small>AUTOMATIC BATCH SCHEDULING</small><h2>Automatic execution</h2></div></div><div className="form-grid"><label>Mode<select value={form.trigger_mode} onChange={e => set('trigger_mode', e.target.value)}><option value="disabled">Disabled</option><option value="daily">Daily, station local time</option><option value="interval">Every N hours</option></select><small className="field-help">Choose whether automatic planning is disabled, runs once per local day, or repeats at an hourly interval.</small></label>{form.trigger_mode === 'daily' && <label>Daily time<input type="time" value={form.daily_time_local} onChange={e => set('daily_time_local', e.target.value)} /><small className="field-help">Interpreted in the station timezone configured by Docker Compose.</small></label>}{form.trigger_mode === 'interval' && <NumberField label="Interval hours" help="The interval is measured between automatic runs." value={form.interval_hours} min={1} max={48} onChange={v => set('interval_hours', v)} />}<div className="setting-divider"><small>AUTOMATIC TIMELINE REFRESH</small><strong>Upcoming cache</strong></div><label className="check setting-check setting-switch"><input type="checkbox" checked={form.upcoming_auto_refresh_enabled} onChange={e => set('upcoming_auto_refresh_enabled', e.target.checked)} /><span>Automatically refresh Upcoming on the server<small className="field-help">Runs independently in the Docker service, including when no browser is open.</small></span></label>{form.upcoming_auto_refresh_enabled && <NumberField label="Upcoming refresh hours" help="The server fetches the complete station timeline every 1–24 hours." value={form.upcoming_auto_refresh_hours} min={1} max={24} step={1} onChange={v => set('upcoming_auto_refresh_hours', v)} />}</div></div></section>
    <section className="split"><div className="panel"><div className="panel-title"><h2>Planning, batch and API policy</h2></div><div className="form-grid"><NumberField label="Horizon hours" help="How far ahead both manual and automatic planning calculate. SatNOGS accepts at most 48 hours." value={form.horizon_hours} min={0.5} max={48} step={0.5} onChange={v => set('horizon_hours', v)} /><NumberField label="Lead time minutes" help="Starts the planning window this many minutes after calculation begins, avoiding observations too close to submit safely." value={form.lead_minutes} min={1} max={180} onChange={v => set('lead_minutes', v)} /><NumberField label="Satellites / run" help="Number of planned observations sent in each SatNOGS batch request. For example, 60 observations with a value of 15 are submitted as four API batches." value={form.satellites_per_run} min={1} max={50} onChange={v => set('satellites_per_run', v)} /><NumberField label="API request interval seconds" help="Minimum delay between real SatNOGS HTTP requests, including pagination and scheduling POSTs. It is not applied to local orbit calculations. 3–5 seconds is recommended to avoid HTTP 429." value={form.api_request_interval_seconds} min={0.5} max={30} step={0.5} onChange={v => set('api_request_interval_seconds', v)} /><NumberField label="Conflict buffer seconds" help="Safety margin applied only around reservations already present at the station. Planned passes are compared using their actual times. 300 seconds matches the iOS planner." value={form.conflict_buffer_seconds} min={0} max={3600} onChange={v => set('conflict_buffer_seconds', v)} /></div><label className="check setting-check"><input type="checkbox" checked={form.retry_individually} onChange={e => set('retry_individually', e.target.checked)} /><span>Retry failed batches one observation at a time<small className="field-help">All batch requests are attempted first. Afterwards, every observation from a failed batch is retried separately so one invalid pass does not block the rest.</small></span></label></div>
      <div className="panel"><div className="panel-title"><h2>Compose-managed station</h2></div><dl className="facts"><dt>API token</dt><dd>{config?.api_token_configured ? 'Configured' : 'Missing'}</dd><dt>Station</dt><dd>{config?.station?.station_id || 'Missing'}</dd><dt>Coordinates</dt><dd>{config?.station ? `${config.station.latitude}, ${config.station.longitude}, ${config.station.altitude_m} m` : 'Missing'}</dd><dt>Timezone</dt><dd>{config?.station?.timezone || 'UTC'}</dd></dl></div></section>
    <section className="panel"><div className="panel-title"><div><small>IOS-COMPATIBLE WATCH LIST</small><h2>Import and export</h2></div><button className="ghost" onClick={() => download().catch(e => onNotify(String(e), 'error'))}>Export JSON</button></div><div className="import-file"><label>Select a SatScheduler watch-list file<input type="file" accept=".json,application/json" onChange={e => { chooseFile(e.target.files?.[0]); e.target.value = '' }} /></label>{importFileName && <small>{importFileName}</small>}</div><textarea value={importText} onChange={e => { setImportText(e.target.value); setImportFileName(e.target.value ? 'Pasted JSON' : '') }} placeholder="Or paste an iOS-compatible SatScheduler JSON export here…" /><button className="primary" disabled={!importText.trim()} onClick={() => importConfig().catch(e => onNotify(String(e), 'error'))}>Replace watch list from JSON</button></section>
  </div>
}

function NumberField({ label, help, value, min, max, step, onChange }: { label: string; help?: string; value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void }) { return <label>{label}<input type="number" value={value} min={min} max={max} step={step} onChange={e => onChange(Number(e.target.value))} />{help && <small className="field-help">{help}</small>}</label> }
