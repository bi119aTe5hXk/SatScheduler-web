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
  interval_hours: 6, horizon_hours: 24, lead_minutes: 10, satellites_per_run: 30,
  passes_per_satellite: 1, batch_size: 20, api_request_interval_seconds: 4, retry_individually: true,
  problem_threshold: 3, conflict_buffer_seconds: 300,
}

const CLIENT_CACHE_TTL = 60 * 60 * 1000
let satelliteCatalogCache: { results: any[]; expiresAt: number } | null = null
const observationViewCache: Partial<Record<'upcoming' | 'receptions', { items: Observation[]; cursor: string | null; pages: number; expiresAt: number }>> = {}

function freshClientCache<T extends { expiresAt: number }>(entry?: T | null): entry is T {
  return Boolean(entry && entry.expiresAt > Date.now())
}

function useClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer) }, [])
  return now
}

export default function App() {
  const [page, setPage] = useState<Page>('dashboard')
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

  return <div className="app-shell">
    <aside className="rail">
      <div className="brand"><span className="brand-orbit" /> <span>SatScheduler</span></div>
      <nav>{NAV.map(item => <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)}>
        <span className="nav-mark">{item.mark}</span><span>{item.label}</span>
      </button>)}</nav>
      <div className="station-chip"><span className={config?.station ? 'signal online' : 'signal'} />
        <div><strong>{config?.station?.station_name || `Station ${config?.station?.station_id || '—'}`}</strong><small>{config?.station ? 'Configuration ready' : 'Needs configuration'}</small></div>
      </div>
    </aside>
    <main>
      {notice && <button className={`notice ${notice.tone}`} onClick={() => setNotice(null)}>{notice.message}</button>}
      {page === 'dashboard' && <Dashboard config={config} targets={targets} onNavigate={setPage} />}
      {page === 'targets' && <Targets targets={targets} onChanged={reload} onNotify={notify} />}
      {page === 'schedule' && <Schedule settings={settings} targets={targets} onNotify={notify} />}
      {page === 'observations' && <ObservationList future title="Upcoming observations" onNotify={notify} />}
      {page === 'receptions' && <ObservationList future={false} title="Reception archive" onNotify={notify} />}
      {page === 'settings' && <SettingsPage value={settings} config={config} onSaved={reload} onNotify={notify} />}
    </main>
  </div>
}

function PageHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><small>{eyebrow}</small><h1>{title}</h1></div>{action}</header>
}

function Dashboard({ config, targets, onNavigate }: { config: any; targets: Target[]; onNavigate: (p: Page) => void }) {
  const now = useClock()
  const [upcoming, setUpcoming] = useState<Observation[]>([])
  useEffect(() => { api<any>('/observations/overview').then(value => setUpcoming(value.results || [])).catch(() => {}) }, [])
  const next = useMemo(() => [...upcoming].filter(item => new Date(item.end || item.start || 0).getTime() > now.getTime()).sort((a, b) => new Date(a.start || 0).getTime() - new Date(b.start || 0).getTime())[0], [upcoming, now])
  return <div className="page">
    <PageHeader eyebrow="GROUND CONTROL / SINGLE STATION" title="Observation overview" action={<button className="primary" onClick={() => onNavigate('schedule')}>Build schedule</button>} />
    <section className="hero-grid">
      <div className="utc-card"><small>LIVE UNIVERSAL TIME</small><strong>{now.toISOString().slice(11, 19)}</strong><span>{now.toISOString().slice(0, 10)} · UTC</span></div>
      <Metric label="Enabled satellites" value={String(targets.filter(t => t.enabled).length)} detail={`${targets.length} total watch targets`} />
      <Metric label="Upcoming" value={String(upcoming.length)} detail="Loaded first page" />
      <Metric label="Next automatic run" value={config?.automatic_job?.enabled ? 'ARMED' : 'OFF'} detail={formatUtc(config?.automatic_job?.next_run_at)} />
    </section>
    <section className="panel"><div className="panel-title"><div><small>48 HOUR WINDOW</small><h2>Station timeline</h2></div><button className="ghost" onClick={() => onNavigate('observations')}>Open list</button></div>
      <Timeline observations={upcoming} />
    </section>
    <section className="panel next-observation"><div className="panel-title"><div><small>NEXT OBSERVATION</small><h2>{next ? observationSatellite(next) : 'No scheduled pass'}</h2></div>{next && <span className={`observation-status ${listeningStatus(next, now).className}`}>{listeningStatus(next, now).label}</span>}</div>
      {next ? <div className="next-observation-grid"><div className="next-observation-data"><div className="next-transmitter"><small>TRANSMITTER</small><strong>{next.transmitter_description || next.transmitter_mode || next.transmitter_uuid || 'Unknown transmitter'}</strong><span>{frequency(observationFrequency(next))} · {next.transmitter_mode || 'Unknown mode'}</span></div><div className="countdown-grid"><div><small>START</small><strong>{distanceFrom(now, next.start)}</strong><span>{formatUtc(next.start)}</span></div><div><small>END</small><strong>{distanceFrom(now, next.end)}</strong><span>{formatUtc(next.end)}</span></div></div><dl className="observation-facts"><dt>Maximum elevation</dt><dd>{degrees(next.max_altitude)}</dd><dt>Rise azimuth</dt><dd>{degrees(next.rise_azimuth)}</dd><dt>Set azimuth</dt><dd>{degrees(next.set_azimuth)}</dd><dt>Observation ID</dt><dd>#{next.id}</dd></dl></div><PolarPlot observation={next} /></div> : <div className="empty">There are no upcoming observations in the loaded 48-hour window.</div>}
    </section>
    <section className="split">
      <div className="panel"><div className="panel-title"><h2>Watch list health</h2></div>{targets.slice(0, 6).map(target => <div className="row" key={target.id}><span className={`health ${target.health_status}`} /> <strong>{target.satellite_name || target.name}</strong><span className="muted">{target.health_status}</span></div>)}</div>
      <div className="panel"><div className="panel-title"><h2>Prediction setup</h2></div><dl className="facts"><dt>Engine</dt><dd>{config?.scheduler?.prediction_engine?.replace('_', ' ')}</dd><dt>Sort mode</dt><dd>{config?.scheduler?.sort_mode?.replaceAll('_', ' ')}</dd><dt>Horizon</dt><dd>{config?.scheduler?.horizon_hours} hours</dd><dt>Station timezone</dt><dd>{config?.station?.timezone || 'UTC'}</dd></dl></div>
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

function PolarPlot({ observation }: { observation: Observation }) {
  const center = 130, radius = 104
  const polar = (azimuth: number, elevation: number) => { const radians = (azimuth - 90) * Math.PI / 180, distance = radius * (1 - elevation / 90); return { x: center + distance * Math.cos(radians), y: center + distance * Math.sin(radians) } }
  const riseAzimuth = observation.rise_azimuth ?? 0, setAzimuth = observation.set_azimuth ?? 180
  const delta = ((setAzimuth - riseAzimuth + 540) % 360) - 180, peakAzimuth = (riseAzimuth + delta / 2 + 360) % 360
  const rise = polar(riseAzimuth, 0), peak = polar(peakAzimuth, observation.max_altitude ?? 0), set = polar(setAzimuth, 0)
  const control = { x: 2 * peak.x - (rise.x + set.x) / 2, y: 2 * peak.y - (rise.y + set.y) / 2 }
  return <div className="polar-wrap"><svg className="polar-plot" viewBox="0 0 260 260" role="img" aria-label={`Polar plot from ${riseAzimuth} degrees to ${setAzimuth} degrees, peak ${observation.max_altitude ?? 0} degrees`}><circle cx={center} cy={center} r={radius} /><circle cx={center} cy={center} r={radius * 2 / 3} /><circle cx={center} cy={center} r={radius / 3} /><line x1={center} y1={center - radius} x2={center} y2={center + radius} /><line x1={center - radius} y1={center} x2={center + radius} y2={center} /><text x={center} y="13">N</text><text x="250" y={center + 4}>E</text><text x={center} y="257">S</text><text x="10" y={center + 4}>W</text><text className="elevation-label" x={center + 4} y={center - radius * 2 / 3}>30°</text><text className="elevation-label" x={center + 4} y={center - radius / 3}>60°</text><path className="polar-path" d={`M ${rise.x} ${rise.y} Q ${control.x} ${control.y} ${set.x} ${set.y}`} /><circle className="polar-point rise" cx={rise.x} cy={rise.y} r="4" /><circle className="polar-point peak" cx={peak.x} cy={peak.y} r="5" /><circle className="polar-point set" cx={set.x} cy={set.y} r="4" /></svg><div className="polar-legend"><span><i className="rise" />AOS {degrees(riseAzimuth)}</span><span><i className="peak" />MAX {degrees(observation.max_altitude)}</span><span><i className="set" />LOS {degrees(setAzimuth)}</span></div></div>
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="metric"><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>
}

function Timeline({ observations }: { observations: Observation[] }) {
  const start = Date.now(), span = 48 * 3600_000
  return <div className="timeline"><div className="timeline-axis"><span>NOW</span><span>+12H</span><span>+24H</span><span>+36H</span><span>+48H</span></div><div className="timeline-track">
    {observations.map(item => { const left = Math.max(0, Math.min(100, ((new Date(item.start || 0).getTime() - start) / span) * 100)); const width = Math.max(0.8, ((new Date(item.end || 0).getTime() - new Date(item.start || 0).getTime()) / span) * 100); return <span key={item.id} className="timeline-event" style={{ left: `${left}%`, width: `${width}%` }} title={`${item.satellite_name || item.norad_cat_id} · ${formatUtc(item.start)}`} /> })}
  </div></div>
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
  const [plan, setPlan] = useState<any>(null), [loading, setLoading] = useState(false), [result, setResult] = useState<any>(null)
  const build = async () => { setLoading(true); try { const value: any = await api('/plans', { method: 'POST', body: JSON.stringify({}) }); setPlan(value); onNotify(`Plan calculated: ${value.selected?.length || 0} passes selected.`, 'success') } catch (e) { onNotify(String(e), 'error') } finally { setLoading(false) } }
  const showScheduleResult = (value: any) => { setResult(value); if (value.success_count) delete observationViewCache.upcoming; const message = `Scheduling finished: ${value.success_count || 0} succeeded, ${value.failure_count || 0} failed.`; onNotify(message, value.failure_count ? 'error' : 'success') }
  const submit = async () => { if (!plan?.selected?.length || !confirm(`Submit ${plan.selected.length} observations?`)) return; setLoading(true); try { showScheduleResult(await api('/schedules', { method: 'POST', body: JSON.stringify({ passes: plan.selected, trigger_type: 'manual' }) })) } catch (e) { onNotify(String(e), 'error') } finally { setLoading(false) } }
  const submitOne = async (item: Pass) => { if (!confirm(`Schedule ${item.satellite_name} at ${formatUtc(item.start)}?`)) return; setLoading(true); try { showScheduleResult(await api('/schedules', { method: 'POST', body: JSON.stringify({ passes: [item], trigger_type: 'manual-single' }) })) } catch (e) { onNotify(String(e), 'error') } finally { setLoading(false) } }
  return <div className="page"><PageHeader eyebrow="PLANNING DESK" title="Build an observation plan" action={<button className="primary" disabled={loading || !targets.length} onClick={build}>{loading ? 'Calculating…' : 'Calculate passes'}</button>} />
    <section className="hero-grid"><Metric label="Engine" value={settings.prediction_engine === 'satnogs_predict' ? 'SatNOGS' : 'Skyfield'} detail={settings.comparison_enabled ? 'Comparison enabled' : 'Primary only'} /><Metric label="Sort mode" value={settings.sort_mode.replaceAll('_', ' ')} detail="Configured in Settings" /><Metric label="Planning horizon" value={`${settings.horizon_hours}H`} detail={`Maximum ${settings.passes_per_satellite} pass / satellite`} /><Metric label="Enabled targets" value={String(targets.filter(t => t.enabled).length)} detail={`Limit ${settings.satellites_per_run} per run`} /></section>
    {!plan && <div className="panel empty">Calculate a preview before submitting observations.</div>}{plan && <div className="panel"><div className="panel-title"><div><small>{formatUtc(plan.start)} → {formatUtc(plan.end)}</small><h2>{plan.selected.length} selected / {plan.candidates.length} candidates</h2></div><button className="primary" onClick={submit}>Submit selected</button></div><div className="pass-list">{plan.selected.map((item: Pass) => <div className="pass-row" key={`${item.target_id}-${item.start}`}><div><strong>{item.satellite_name}</strong><small>{item.engine.replace('_', ' ')}</small></div><div><strong>{formatUtc(item.start)}</strong><small>{Math.round((new Date(item.end).getTime() - new Date(item.start).getTime()) / 1000)} sec</small></div><div><strong>{item.peak_elevation.toFixed(1)}° peak</strong><small>Az {item.rise_azimuth.toFixed(0)}° → {item.set_azimuth.toFixed(0)}°</small></div><button className="ghost" disabled={loading} onClick={() => submitOne(item)}>Schedule one</button></div>)}</div></div>}
    {result && <div className={`result ${result.failure_count ? 'warning' : 'success'}`}>Run {result.status}: {result.success_count} scheduled, {result.failure_count} failed.</div>}
  </div>
}

function ObservationList({ future, title, onNotify }: { future: boolean; title: string; onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void }) {
  const [items, setItems] = useState<Observation[]>([]), [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(false), [selected, setSelected] = useState<number | null>(null)
  const [progress, setProgress] = useState({ page: 0, records: 0 })
  const request = useRef<AbortController | null>(null)
  const loadUpcoming = async (force = false) => {
    const cached = observationViewCache.upcoming
    if (!force && freshClientCache(cached)) { setItems(cached.items); setCursor(cached.cursor); setProgress({ page: cached.pages, records: cached.items.length }); return }
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true); setItems([]); setCursor(null); setProgress({ page: 0, records: 0 })
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
      observationViewCache.upcoming = { items: [...collected], cursor: nextCursor, pages, expiresAt: Date.now() + CLIENT_CACHE_TTL }
      onNotify(`Upcoming observations updated: ${collected.length} records from ${pages} page${pages === 1 ? '' : 's'}.`, 'success')
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        if (collected.length) observationViewCache.upcoming = { items: [...collected], cursor: nextCursor, pages, expiresAt: Date.now() + CLIENT_CACHE_TTL }
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
      setItems(previous => { const merged = reset ? data.results : [...previous, ...data.results.filter((value: Observation) => !previous.some(item => item.id === value.id))]; observationViewCache.receptions = { items: merged, cursor: nextCursor, pages: reset ? 1 : (observationViewCache.receptions?.pages || 1) + 1, expiresAt: Date.now() + CLIENT_CACHE_TTL }; return merged })
      setCursor(nextCursor)
      if (reset) onNotify(`Reception archive updated: ${data.results.length} records loaded.`, 'success')
    } catch (error) { onNotify(`Reception archive update failed: ${String(error)}`, 'error') }
    finally { setLoading(false) }
  }
  useEffect(() => {
    setItems([]); setCursor(null); setSelected(null)
    if (future) void loadUpcoming(false); else void loadReceptionPage(true, false)
    return () => request.current?.abort()
  }, [future])
  if (!future && selected != null) return <ObservationDetail observationId={selected} onBack={() => setSelected(null)} />
  return <div className="page"><PageHeader eyebrow={future ? 'STATION QUEUE' : 'RECEIVED SIGNALS'} title={title} action={<button className="ghost" onClick={() => future ? loadUpcoming(true) : loadReceptionPage(true, true)}>{loading ? (future ? 'Restart refresh' : 'Refreshing…') : 'Refresh'}</button>} />
    {future && <section className="panel upcoming-timeline"><div className="panel-title"><div><small>48 HOUR WINDOW</small><h2>Observation timeline</h2></div><span className="timeline-count">{items.length} observations</span></div><Timeline observations={items} /></section>}
    {future && loading && <div className="fetch-progress"><span className="spinner" /><div><strong>{progress.page ? `Fetching page ${progress.page + 1}…` : 'Starting background update…'}</strong><small>{progress.page} page{progress.page === 1 ? '' : 's'} · {progress.records} observations loaded</small></div></div>}
    <div className="panel observation-list">{items.map(item => <button className="observation-row" key={item.id} onClick={() => !future && setSelected(item.id)} disabled={future}><div className="obs-id">#{item.id}</div><div><strong>{observationSatellite(item)}</strong><small>{item.transmitter_description || item.transmitter_mode || item.transmitter_uuid || 'Unknown transmitter'}</small></div><div><strong>{formatUtc(item.start)}</strong><small>to {formatUtc(item.end)}</small></div><div><strong>{degrees(item.max_altitude)}</strong><small>{item.vetted_status || (future ? 'scheduled' : 'unknown')}</small></div>{!future && <span className="detail-chevron">View detail →</span>}</button>)}{!items.length && !loading && <div className="empty">No records returned.</div>}{!items.length && loading && <div className="catalog-loading"><span className="spinner" /> Waiting for the first page…</div>}</div>
    {!future && cursor && <button className="load-more" onClick={() => loadReceptionPage()} disabled={loading}>{loading ? 'Loading…' : 'Load next page'}</button>}
  </div>
}

function ObservationDetail({ observationId, onBack }: { observationId: number; onBack: () => void }) {
  const [item, setItem] = useState<Observation | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  useEffect(() => { setLoading(true); api<Observation>(`/observations/${observationId}`).then(setItem).catch(e => setError(String(e))).finally(() => setLoading(false)) }, [observationId])
  if (loading) return <div className="page"><PageHeader eyebrow="RECEPTION DETAIL" title={`Observation #${observationId}`} action={<button className="ghost" onClick={onBack}>← Back</button>} /><div className="panel catalog-loading"><span className="spinner" /> Loading observation detail…</div></div>
  if (!item || error) return <div className="page"><PageHeader eyebrow="RECEPTION DETAIL" title={`Observation #${observationId}`} action={<button className="ghost" onClick={onBack}>← Back</button>} /><div className="panel empty">{error || 'Observation not found.'}</div></div>
  const metadata = observationMetadata(item), radio = metadata?.radio, parameters = radio?.parameters || {}, demoddata = item.demoddata || []
  return <div className="page observation-detail"><PageHeader eyebrow={`RECEPTION DETAIL / #${item.id}`} title={observationSatellite(item)} action={<div className="button-row"><button className="ghost" onClick={onBack}>← Back</button><a className="ghost button-link" href={`https://network.satnogs.org/observations/${item.id}/`} target="_blank" rel="noreferrer">Open SatNOGS ↗</a></div>} />
    <section className="observation-detail-hero"><div><span className={`observation-status ${item.vetted_status === 'good' ? 'good' : item.vetted_status === 'bad' ? 'bad' : 'finished'}`}>{item.vetted_status || item.status || 'unknown'}</span><strong>{formatUtc(item.start)}</strong><small>{formatUtc(item.end)} · {observationDuration(item)}</small></div><div><small>TRANSMITTER</small><strong>{item.transmitter_description || item.transmitter_uuid || 'Unknown transmitter'}</strong><span>{frequency(observationFrequency(item))} · {item.transmitter_mode || 'Unknown mode'}{item.transmitter_baud ? ` · ${item.transmitter_baud.toLocaleString()} baud` : ''}</span></div><div><small>GROUND STATION</small><strong>{item.station_name || `Station ${item.ground_station || '—'}`}</strong><span>{item.station_lat ?? '—'}, {item.station_lng ?? '—'} · {item.station_alt ?? '—'} m</span></div></section>
    <section className="reception-media-grid"><div className="panel waterfall-panel"><div className="panel-title"><div><small>SPECTRUM</small><h2>Waterfall</h2></div>{item.waterfall && <a href={item.waterfall} target="_blank" rel="noreferrer">Open original ↗</a>}</div>{item.waterfall ? <img src={item.waterfall} alt={`Waterfall for observation ${item.id}`} loading="lazy" /> : <div className="empty">No waterfall was uploaded.</div>}</div><div className="panel reception-side"><div><small>AUDIO RECORDING</small><h2>Listen</h2>{item.payload ? <audio controls preload="metadata" src={item.payload} /> : <p className="muted">No audio was uploaded.</p>}</div><PolarPlot observation={item} /></div></section>
    <section className="split reception-details"><div className="panel"><div className="panel-title"><div><small>PASS GEOMETRY</small><h2>Observation data</h2></div></div><dl className="detail-facts"><dt>Maximum elevation</dt><dd>{degrees(item.max_altitude)}</dd><dt>Rise azimuth</dt><dd>{degrees(item.rise_azimuth)}</dd><dt>Set azimuth</dt><dd>{degrees(item.set_azimuth)}</dd><dt>NORAD catalog ID</dt><dd>{item.norad_cat_id || '—'}</dd><dt>SatNOGS satellite ID</dt><dd>{item.sat_id || '—'}</dd><dt>Observer</dt><dd>{item.observer || '—'}</dd><dt>Client version</dt><dd>{item.client_version || '—'}</dd><dt>Radio</dt><dd>{radio?.name || '—'}{radio?.version ? ` ${radio.version}` : ''}</dd><dt>Receiver gain</dt><dd>{parameters.gain ? `${parameters.gain} dB` : '—'}</dd><dt>Sample rate</dt><dd>{parameters['samp-rate-rx'] || '—'}</dd></dl></div><div className="panel"><div className="panel-title"><div><small>ORBITAL ELEMENTS</small><h2>TLE used for observation</h2></div><span className="muted">{item.tle_source || 'Unknown source'}</span></div><pre className="tle-block">{[item.tle0, item.tle1, item.tle2].filter(Boolean).join('\n') || 'No TLE available.'}</pre><div className="detail-assets"><a className={`ghost button-link ${item.payload ? '' : 'disabled'}`} href={item.payload || undefined} target="_blank" rel="noreferrer">Audio file</a><a className={`ghost button-link ${item.archive_url ? '' : 'disabled'}`} href={item.archive_url || undefined} target="_blank" rel="noreferrer">Archive</a></div>{demoddata.length > 0 && <div className="demod-list"><small>DECODED DATA</small>{demoddata.map((entry, index) => { const url = typeof entry === 'string' ? entry : entry.url; return url ? <a key={url} href={url} target="_blank" rel="noreferrer">{typeof entry === 'string' ? `Frame ${index + 1}` : entry.name || `Frame ${index + 1}`}</a> : null })}</div>}</div></section>
  </div>
}

function observationMetadata(item: Observation): any {
  if (!item.client_metadata) return null
  if (typeof item.client_metadata === 'object') return item.client_metadata
  try { return JSON.parse(item.client_metadata) } catch { return null }
}

function observationDuration(item: Observation): string {
  if (!item.start || !item.end) return '—'
  const seconds = Math.max(0, Math.round((new Date(item.end).getTime() - new Date(item.start).getTime()) / 1000))
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
    <section className="split"><div className="panel"><div className="panel-title"><h2>Prediction and ranking</h2></div><div className="form-grid"><label>Primary engine<select value={form.prediction_engine} onChange={e => set('prediction_engine', e.target.value)}><option value="satnogs_predict">SatNOGS Predict</option><option value="skyfield">Direct Skyfield</option></select></label><label>Sort mode<select value={form.sort_mode} onChange={e => set('sort_mode', e.target.value)}><option value="list_priority">List priority</option><option value="list_priority_best_elevation">List priority + best elevation</option><option value="best_elevation">Best elevation only</option><option value="satnogs_default">SatNOG default mode</option></select></label></div><label className="check"><input type="checkbox" checked={form.comparison_enabled} onChange={e => set('comparison_enabled', e.target.checked)} /> Run the secondary prediction engine for comparison</label></div>
      <div className="panel"><div className="panel-title"><h2>Automatic execution</h2></div><div className="form-grid"><label>Mode<select value={form.trigger_mode} onChange={e => set('trigger_mode', e.target.value)}><option value="disabled">Disabled</option><option value="daily">Daily, station local time</option><option value="interval">Every N hours</option></select></label><label>Daily time<input type="time" value={form.daily_time_local} onChange={e => set('daily_time_local', e.target.value)} /></label><NumberField label="Interval hours" value={form.interval_hours} onChange={v => set('interval_hours', v)} /><NumberField label="Horizon hours" value={form.horizon_hours} onChange={v => set('horizon_hours', v)} /></div></div></section>
    <section className="split"><div className="panel"><div className="panel-title"><h2>Batch and API policy</h2></div><div className="form-grid"><NumberField label="Satellites / run" value={form.satellites_per_run} onChange={v => set('satellites_per_run', v)} /><NumberField label="Passes / satellite" value={form.passes_per_satellite} onChange={v => set('passes_per_satellite', v)} /><NumberField label="API batch size" value={form.batch_size} onChange={v => set('batch_size', v)} /><NumberField label="API request interval seconds" value={form.api_request_interval_seconds} min={0.5} max={30} step={0.5} onChange={v => set('api_request_interval_seconds', v)} /><NumberField label="Problem threshold" value={form.problem_threshold} onChange={v => set('problem_threshold', v)} /></div><p className="muted settings-note">All SatNOGS DB and Network requests share this minimum interval. 3–5 seconds is recommended.</p></div>
      <div className="panel"><div className="panel-title"><h2>Compose-managed station</h2></div><dl className="facts"><dt>API token</dt><dd>{config?.api_token_configured ? 'Configured' : 'Missing'}</dd><dt>Station</dt><dd>{config?.station?.station_id || 'Missing'}</dd><dt>Coordinates</dt><dd>{config?.station ? `${config.station.latitude}, ${config.station.longitude}, ${config.station.altitude_m} m` : 'Missing'}</dd><dt>Timezone</dt><dd>{config?.station?.timezone || 'UTC'}</dd></dl></div></section>
    <section className="panel"><div className="panel-title"><div><small>IOS-COMPATIBLE WATCH LIST</small><h2>Import and export</h2></div><button className="ghost" onClick={() => download().catch(e => onNotify(String(e), 'error'))}>Export JSON</button></div><div className="import-file"><label>Select a SatScheduler watch-list file<input type="file" accept=".json,application/json" onChange={e => { chooseFile(e.target.files?.[0]); e.target.value = '' }} /></label>{importFileName && <small>{importFileName}</small>}</div><textarea value={importText} onChange={e => { setImportText(e.target.value); setImportFileName(e.target.value ? 'Pasted JSON' : '') }} placeholder="Or paste an iOS-compatible SatScheduler JSON export here…" /><button className="primary" disabled={!importText.trim()} onClick={() => importConfig().catch(e => onNotify(String(e), 'error'))}>Replace watch list from JSON</button></section>
  </div>
}

function NumberField({ label, value, min, max, step, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void }) { return <label>{label}<input type="number" value={value} min={min} max={max} step={step} onChange={e => onChange(Number(e.target.value))} /></label> }
