import { useEffect, useMemo, useState } from 'react'
import { api, formatUtc, frequency } from './api'
import type { Observation, Pass, Settings, Target, TransmitterInsight } from './types'

type Page = 'dashboard' | 'targets' | 'schedule' | 'observations' | 'receptions' | 'settings'

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
  passes_per_satellite: 1, batch_size: 20, retry_individually: true,
  problem_threshold: 3, conflict_buffer_seconds: 300,
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
  const [notice, setNotice] = useState('')

  const reload = async () => {
    try {
      const [configValue, targetValues, settingsValue] = await Promise.all([
        api<any>('/config'), api<Target[]>('/targets'), api<Settings>('/settings'),
      ])
      setConfig(configValue); setTargets(targetValues); setSettings(settingsValue)
    } catch (error) { setNotice(String(error)) }
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
      {notice && <div className="notice" onClick={() => setNotice('')}>{notice}</div>}
      {page === 'dashboard' && <Dashboard config={config} targets={targets} onNavigate={setPage} />}
      {page === 'targets' && <Targets targets={targets} onChanged={reload} onError={setNotice} />}
      {page === 'schedule' && <Schedule settings={settings} targets={targets} onError={setNotice} />}
      {page === 'observations' && <ObservationList future title="Upcoming observations" />}
      {page === 'receptions' && <ObservationList future={false} title="Reception archive" />}
      {page === 'settings' && <SettingsPage value={settings} config={config} onSaved={reload} onError={setNotice} />}
    </main>
  </div>
}

function PageHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><small>{eyebrow}</small><h1>{title}</h1></div>{action}</header>
}

function Dashboard({ config, targets, onNavigate }: { config: any; targets: Target[]; onNavigate: (p: Page) => void }) {
  const now = useClock()
  const [upcoming, setUpcoming] = useState<Observation[]>([])
  useEffect(() => { api<any>('/observations/upcoming').then(value => setUpcoming(value.results || [])).catch(() => {}) }, [])
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
    <section className="split">
      <div className="panel"><div className="panel-title"><h2>Watch list health</h2></div>{targets.slice(0, 6).map(target => <div className="row" key={target.id}><span className={`health ${target.health_status}`} /> <strong>{target.satellite_name || target.name}</strong><span className="muted">{target.health_status}</span></div>)}</div>
      <div className="panel"><div className="panel-title"><h2>Prediction setup</h2></div><dl className="facts"><dt>Engine</dt><dd>{config?.scheduler?.prediction_engine?.replace('_', ' ')}</dd><dt>Sort mode</dt><dd>{config?.scheduler?.sort_mode?.replaceAll('_', ' ')}</dd><dt>Horizon</dt><dd>{config?.scheduler?.horizon_hours} hours</dd><dt>Station timezone</dt><dd>{config?.station?.timezone || 'UTC'}</dd></dl></div>
    </section>
  </div>
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

function Targets({ targets, onChanged, onError }: { targets: Target[]; onChanged: () => void; onError: (v: string) => void }) {
  const [editing, setEditing] = useState<Target | null | 'new'>(null)
  const move = async (index: number, offset: number) => { const next = [...targets]; const destination = index + offset; if (destination < 0 || destination >= next.length) return; [next[index], next[destination]] = [next[destination], next[index]]; await api('/targets/reorder', { method: 'PUT', body: JSON.stringify({ ids: next.map(t => t.id) }) }); onChanged() }
  const remove = async (id: string) => { if (!confirm('Delete this watch target?')) return; await api(`/targets/${id}`, { method: 'DELETE' }); onChanged() }
  return <div className="page"><PageHeader eyebrow="WATCH TARGETS" title="Satellite priority list" action={<button className="primary" onClick={() => setEditing('new')}>Add satellite</button>} />
    <div className="panel target-table">{targets.length === 0 && <div className="empty">No satellites yet. Add the first watch target.</div>}{targets.map((target, index) => <div className="target-row" key={target.id}>
      <div className="order-controls"><button onClick={() => move(index, -1)}>↑</button><span>{String(index + 1).padStart(2, '0')}</span><button onClick={() => move(index, 1)}>↓</button></div>
      <div className="target-main"><div><span className={`health ${target.health_status}`} /><strong>{target.satellite_name || target.name}</strong><small>{target.sat_id} · NORAD {target.norad_cat_id || '—'}</small></div><div className="tags">{target.requires_station_daylight && <span>Station daylight</span>}{target.min_peak_elevation != null && <span>Peak ≥ {target.min_peak_elevation}°</span>}{target.max_peak_elevation != null && <span>Peak ≤ {target.max_peak_elevation}°</span>}{target.min_azimuth != null && <span>Az {target.min_azimuth}–{target.max_azimuth}°</span>}</div></div>
      <div className="target-meta"><strong>{target.transmitter_description || target.transmitter_uuid}</strong><small>{frequency(target.center_frequency)}</small></div>
      <div className="row-actions"><button className="ghost" onClick={() => setEditing(target)}>Edit</button><button className="danger" onClick={() => remove(target.id).catch(e => onError(String(e)))}>Delete</button></div>
    </div>)}</div>{editing && <TargetEditor value={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged() }} onError={onError} />}</div>
}

function TargetEditor({ value, onClose, onSaved, onError }: { value?: Target; onClose: () => void; onSaved: () => void; onError: (v: string) => void }) {
  const [satellites, setSatellites] = useState<any[]>([]), [loadingSatellites, setLoadingSatellites] = useState(true), [satelliteSearch, setSatelliteSearch] = useState(value?.satellite_name || value?.name || '')
  const [transmitters, setTransmitters] = useState<TransmitterInsight[]>([]), [loadingTransmitters, setLoadingTransmitters] = useState(false)
  const [form, setForm] = useState<any>(value || { name: '', sat_id: '', transmitter_uuid: '', priority: 1, enabled: true, requires_station_daylight: false, daylight_solar_elevation: -6 })
  useEffect(() => { setLoadingSatellites(true); api<any>('/satellites').then(v => setSatellites(v.results || [])).catch(e => onError(String(e))).finally(() => setLoadingSatellites(false)) }, [])
  const loadTransmitters = async (force = false) => { if (!form.sat_id) return; setLoadingTransmitters(true); try { const value = await api<any>(`/satellites/${form.sat_id}/transmitter-insights${force ? '?force=true' : ''}`); setTransmitters(value.results || []) } catch (e) { onError(String(e)); setTransmitters([]) } finally { setLoadingTransmitters(false) } }
  useEffect(() => { setTransmitters([]); loadTransmitters() }, [form.sat_id])
  const aliases = (satellite: any) => Array.isArray(satellite.names) ? satellite.names.join(', ') : satellite.names || satellite.aliases || satellite.alternative_names || ''
  const filteredSatellites = useMemo(() => { const keyword = satelliteSearch.trim().toLocaleLowerCase(); if (!keyword) return satellites; return satellites.filter(satellite => [satellite.sat_id, satellite.norad_cat_id, satellite.name, aliases(satellite)].some(value => String(value ?? '').toLocaleLowerCase().includes(keyword))) }, [satellites, satelliteSearch])
  const selectSatellite = (satellite: any) => { setSatelliteSearch(satellite.name || aliases(satellite) || satellite.sat_id); setForm({ ...form, sat_id: satellite.sat_id, transmitter_uuid: '', transmitter_success_rate: null, transmitter_good_count: null, transmitter_max_good_count: null }) }
  const number = (key: string, input: string) => setForm({ ...form, [key]: input === '' ? null : Number(input) })
  const save = async () => { const selected = satellites.find(s => s.sat_id === form.sat_id); const tx = transmitters.find(t => t.uuid === form.transmitter_uuid); const stats = tx?.network_stats; const preserveSnapshot = !tx && value?.transmitter_uuid === form.transmitter_uuid; const body = { ...form, name: form.name || selected?.name || 'Satellite', satellite_name: selected?.name || form.satellite_name, norad_cat_id: selected?.norad_cat_id || form.norad_cat_id, transmitter_description: tx?.description || form.transmitter_description, center_frequency: tx?.downlink_low || form.center_frequency, transmitter_success_rate: stats ? stats.success_rate / 100 : preserveSnapshot ? form.transmitter_success_rate ?? null : null, transmitter_good_count: stats?.good_count ?? (preserveSnapshot ? form.transmitter_good_count ?? null : null), transmitter_max_good_count: tx ? tx.stats_max_good_count : preserveSnapshot ? form.transmitter_max_good_count ?? null : null }; delete body.id; delete body.sort_order; delete body.failure_count; delete body.health_status; delete body.last_error; delete body.created_at; delete body.updated_at; await api(value ? `/targets/${value.id}` : '/targets', { method: value ? 'PUT' : 'POST', body: JSON.stringify(body) }); onSaved() }
  return <div className="modal-backdrop"><div className="modal"><div className="panel-title"><div><small>WATCH TARGET</small><h2>{value ? 'Edit satellite' : 'Add satellite'}</h2></div><button className="ghost" onClick={onClose}>Close</button></div>
    <section className="satellite-picker"><label>Search satellites<input value={satelliteSearch} onChange={e => setSatelliteSearch(e.target.value)} placeholder="Name, alias, SatNOGS ID or NORAD ID" /></label>{form.sat_id && <div className="selected-satellite"><span>Selected: <strong>{satellites.find(s => s.sat_id === form.sat_id)?.name || form.satellite_name || form.name}</strong></span><button className="ghost" onClick={() => { setSatelliteSearch(''); setForm({ ...form, sat_id: '', transmitter_uuid: '' }); setTransmitters([]) }}>Clear</button></div>}{loadingSatellites ? <div className="catalog-loading"><span className="spinner" /> Loading satellite catalog…</div> : <><div className="satellite-results">{filteredSatellites.slice(0, 100).map(satellite => <button className={form.sat_id === satellite.sat_id ? 'selected' : ''} key={satellite.sat_id} onClick={() => selectSatellite(satellite)}><div><strong>{satellite.name || aliases(satellite) || satellite.sat_id}</strong><small>NORAD {satellite.norad_cat_id || '—'} · {satellite.sat_id}</small>{aliases(satellite) && <small>Aliases: {aliases(satellite)}</small>}</div>{form.sat_id === satellite.sat_id && <span>Selected</span>}</button>)}</div>{!filteredSatellites.length && <div className="catalog-loading">No satellites match “{satelliteSearch}”.</div>}{filteredSatellites.length > 100 && <div className="catalog-limit">Showing first 100 of {filteredSatellites.length}; refine the search to narrow the list.</div>}</>}</section>
    <div className="form-grid"><label>Minimum horizon °<input type="number" value={form.min_elevation ?? ''} onChange={e => number('min_elevation', e.target.value)} /></label><label>Minimum peak °<input type="number" value={form.min_peak_elevation ?? ''} onChange={e => number('min_peak_elevation', e.target.value)} /></label><label>Maximum peak °<input type="number" value={form.max_peak_elevation ?? ''} onChange={e => number('max_peak_elevation', e.target.value)} /></label><label>Azimuth from °<input type="number" value={form.min_azimuth ?? ''} onChange={e => number('min_azimuth', e.target.value)} /></label><label>Azimuth to °<input type="number" value={form.max_azimuth ?? ''} onChange={e => number('max_azimuth', e.target.value)} /></label></div>
    {form.sat_id && <section className="transmitter-picker"><div className="picker-title"><div><small>TRANSMITTER EVIDENCE</small><strong>Select a transmitter</strong></div><button className="ghost" disabled={loadingTransmitters} onClick={() => loadTransmitters(true)}>Refresh stats</button></div>{loadingTransmitters && <div className="picker-loading">Loading Network statistics and two recent good-observation pages…</div>}{!loadingTransmitters && !transmitters.length && <div className="picker-loading">No active transmitters found.</div>}{transmitters.map(tx => <button className={`transmitter-choice ${form.transmitter_uuid === tx.uuid ? 'selected' : ''}`} key={tx.uuid} onClick={() => setForm({ ...form, transmitter_uuid: tx.uuid })}><div className="tx-heading"><div><strong>{tx.description || tx.mode || tx.uuid}</strong><small>{tx.mode || 'Unknown mode'} · {frequency(tx.downlink_low)}</small></div>{tx.recommended && <span className="recommended">Recommended{transmitters.length > 1 ? ` · ${tx.recent_good_count} recent good` : ''}</span>}</div><TransmitterStatsBar transmitter={tx} /></button>)}</section>}
    <label className="check"><input type="checkbox" checked={form.requires_station_daylight} onChange={e => setForm({ ...form, requires_station_daylight: e.target.checked })} /> Only schedule when the station is in daylight</label>
    <div className="modal-actions"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={!form.sat_id || !form.transmitter_uuid} onClick={() => save().catch(e => onError(String(e)))}>Save target</button></div>
  </div></div>
}

function TransmitterStatsBar({ transmitter }: { transmitter: TransmitterInsight }) {
  const stats = transmitter.network_stats
  if (!stats) return <div className="stats-missing">Network statistics unavailable · SatNOG default cannot score this transmitter</div>
  const good = stats.good_count || 0, bad = stats.bad_count || 0, unknown = (stats.unknown_count || 0) + (stats.future_count || 0), total = Math.max(1, good + bad + unknown)
  const pct = (value: number) => `${(value / total) * 100}%`
  return <div className="tx-stats"><div className="ratio-bar" title={`Bad ${bad} · Unknown/future ${unknown} · Good ${good}`}><span className="ratio-bad" style={{ width: pct(bad) }} /><span className="ratio-unknown" style={{ width: pct(unknown) }} /><span className="ratio-good" style={{ width: pct(good) }} /></div><div className="ratio-legend"><span className="bad">Bad {stats.bad_rate}%</span><span className="unknown">Unknown {Math.round((unknown / total) * 100)}%</span><span className="good">Good {stats.success_rate}%</span><span>{stats.good_count.toLocaleString()} valid receptions</span></div></div>
}

function Schedule({ settings, targets, onError }: { settings: Settings; targets: Target[]; onError: (v: string) => void }) {
  const [plan, setPlan] = useState<any>(null), [loading, setLoading] = useState(false), [result, setResult] = useState<any>(null)
  const build = async () => { setLoading(true); try { setPlan(await api('/plans', { method: 'POST', body: JSON.stringify({}) })) } catch (e) { onError(String(e)) } finally { setLoading(false) } }
  const submit = async () => { if (!plan?.selected?.length || !confirm(`Submit ${plan.selected.length} observations?`)) return; setLoading(true); try { setResult(await api('/schedules', { method: 'POST', body: JSON.stringify({ passes: plan.selected, trigger_type: 'manual' }) })) } catch (e) { onError(String(e)) } finally { setLoading(false) } }
  const submitOne = async (item: Pass) => { if (!confirm(`Schedule ${item.satellite_name} at ${formatUtc(item.start)}?`)) return; setLoading(true); try { setResult(await api('/schedules', { method: 'POST', body: JSON.stringify({ passes: [item], trigger_type: 'manual-single' }) })) } catch (e) { onError(String(e)) } finally { setLoading(false) } }
  return <div className="page"><PageHeader eyebrow="PLANNING DESK" title="Build an observation plan" action={<button className="primary" disabled={loading || !targets.length} onClick={build}>{loading ? 'Calculating…' : 'Calculate passes'}</button>} />
    <section className="hero-grid"><Metric label="Engine" value={settings.prediction_engine === 'satnogs_predict' ? 'SatNOGS' : 'Skyfield'} detail={settings.comparison_enabled ? 'Comparison enabled' : 'Primary only'} /><Metric label="Sort mode" value={settings.sort_mode.replaceAll('_', ' ')} detail="Configured in Settings" /><Metric label="Planning horizon" value={`${settings.horizon_hours}H`} detail={`Maximum ${settings.passes_per_satellite} pass / satellite`} /><Metric label="Enabled targets" value={String(targets.filter(t => t.enabled).length)} detail={`Limit ${settings.satellites_per_run} per run`} /></section>
    {!plan && <div className="panel empty">Calculate a preview before submitting observations.</div>}{plan && <div className="panel"><div className="panel-title"><div><small>{formatUtc(plan.start)} → {formatUtc(plan.end)}</small><h2>{plan.selected.length} selected / {plan.candidates.length} candidates</h2></div><button className="primary" onClick={submit}>Submit selected</button></div><div className="pass-list">{plan.selected.map((item: Pass) => <div className="pass-row" key={`${item.target_id}-${item.start}`}><div><strong>{item.satellite_name}</strong><small>{item.engine.replace('_', ' ')}</small></div><div><strong>{formatUtc(item.start)}</strong><small>{Math.round((new Date(item.end).getTime() - new Date(item.start).getTime()) / 1000)} sec</small></div><div><strong>{item.peak_elevation.toFixed(1)}° peak</strong><small>Az {item.rise_azimuth.toFixed(0)}° → {item.set_azimuth.toFixed(0)}°</small></div><button className="ghost" disabled={loading} onClick={() => submitOne(item)}>Schedule one</button></div>)}</div></div>}
    {result && <div className={`result ${result.failure_count ? 'warning' : 'success'}`}>Run {result.status}: {result.success_count} scheduled, {result.failure_count} failed.</div>}
  </div>
}

function ObservationList({ future, title }: { future: boolean; title: string }) {
  const [items, setItems] = useState<Observation[]>([]), [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const load = async (reset = false) => { setLoading(true); setError(''); try { const activeCursor = reset ? null : cursor; const query = activeCursor ? `?cursor=${encodeURIComponent(activeCursor)}` : ''; const data = await api<any>(`/observations/${future ? 'upcoming' : 'receptions'}${query}`); setItems(previous => reset ? data.results : [...previous, ...data.results.filter((v: Observation) => !previous.some(p => p.id === v.id))]); setCursor(data.next_cursor || null) } catch (e) { setError(String(e)) } finally { setLoading(false) } }
  useEffect(() => { setItems([]); setCursor(null); load(true) }, [future])
  return <div className="page"><PageHeader eyebrow={future ? 'STATION QUEUE' : 'RECEIVED SIGNALS'} title={title} action={<button className="ghost" onClick={() => load(true)} disabled={loading}>Refresh</button>} />{error && <div className="notice">{error}</div>}<div className="panel observation-list">{items.map(item => <article key={item.id}><div className="obs-id">#{item.id}</div><div><strong>{item.satellite_name || `NORAD ${item.norad_cat_id || '—'}`}</strong><small>{item.transmitter_description || item.transmitter_mode || item.transmitter_uuid || 'Unknown transmitter'}</small></div><div><strong>{formatUtc(item.start)}</strong><small>to {formatUtc(item.end)}</small></div><div><strong>{item.max_altitude != null ? `${item.max_altitude.toFixed(1)}°` : '—'}</strong><small>{item.vetted_status || (future ? 'scheduled' : 'unknown')}</small></div>{!future && <div className="asset-links">{item.waterfall && <a href={item.waterfall} target="_blank">Waterfall</a>}{item.payload && <a href={item.payload} target="_blank">Audio</a>}{item.archive_url && <a href={item.archive_url} target="_blank">Archive</a>}</div>}</article>)}{!items.length && !loading && <div className="empty">No records returned.</div>}</div>{cursor && <button className="load-more" onClick={() => load()} disabled={loading}>{loading ? 'Loading…' : 'Load next page'}</button>}</div>
}

function SettingsPage({ value, config, onSaved, onError }: { value: Settings; config: any; onSaved: () => void; onError: (v: string) => void }) {
  const [form, setForm] = useState<Settings>(value), [importText, setImportText] = useState('')
  useEffect(() => setForm(value), [value])
  const set = (key: keyof Settings, val: any) => setForm({ ...form, [key]: val })
  const save = async () => { await api('/settings', { method: 'PUT', body: JSON.stringify(form) }); onSaved() }
  const download = async (format: 'shared' | 'ios' | 'android') => { const payload = await api<any>(`/export?format=${format}`); const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `satscheduler-${format}-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); URL.revokeObjectURL(url) }
  const importConfig = async () => { await api('/import?replace=true', { method: 'POST', body: importText }); setImportText(''); onSaved() }
  return <div className="page"><PageHeader eyebrow="SYSTEM CONFIGURATION" title="Scheduler settings" action={<button className="primary" onClick={() => save().catch(e => onError(String(e)))}>Save settings</button>} />
    <section className="split"><div className="panel"><div className="panel-title"><h2>Prediction and ranking</h2></div><div className="form-grid"><label>Primary engine<select value={form.prediction_engine} onChange={e => set('prediction_engine', e.target.value)}><option value="satnogs_predict">SatNOGS Predict</option><option value="skyfield">Direct Skyfield</option></select></label><label>Sort mode<select value={form.sort_mode} onChange={e => set('sort_mode', e.target.value)}><option value="list_priority">List priority</option><option value="list_priority_best_elevation">List priority + best elevation</option><option value="best_elevation">Best elevation only</option><option value="satnogs_default">SatNOG default mode</option></select></label></div><label className="check"><input type="checkbox" checked={form.comparison_enabled} onChange={e => set('comparison_enabled', e.target.checked)} /> Run the secondary prediction engine for comparison</label></div>
      <div className="panel"><div className="panel-title"><h2>Automatic execution</h2></div><div className="form-grid"><label>Mode<select value={form.trigger_mode} onChange={e => set('trigger_mode', e.target.value)}><option value="disabled">Disabled</option><option value="daily">Daily, station local time</option><option value="interval">Every N hours</option></select></label><label>Daily time<input type="time" value={form.daily_time_local} onChange={e => set('daily_time_local', e.target.value)} /></label><NumberField label="Interval hours" value={form.interval_hours} onChange={v => set('interval_hours', v)} /><NumberField label="Horizon hours" value={form.horizon_hours} onChange={v => set('horizon_hours', v)} /></div></div></section>
    <section className="split"><div className="panel"><div className="panel-title"><h2>Batch policy</h2></div><div className="form-grid"><NumberField label="Satellites / run" value={form.satellites_per_run} onChange={v => set('satellites_per_run', v)} /><NumberField label="Passes / satellite" value={form.passes_per_satellite} onChange={v => set('passes_per_satellite', v)} /><NumberField label="API batch size" value={form.batch_size} onChange={v => set('batch_size', v)} /><NumberField label="Problem threshold" value={form.problem_threshold} onChange={v => set('problem_threshold', v)} /></div></div>
      <div className="panel"><div className="panel-title"><h2>Compose-managed station</h2></div><dl className="facts"><dt>API token</dt><dd>{config?.api_token_configured ? 'Configured' : 'Missing'}</dd><dt>Station</dt><dd>{config?.station?.station_id || 'Missing'}</dd><dt>Coordinates</dt><dd>{config?.station ? `${config.station.latitude}, ${config.station.longitude}, ${config.station.altitude_m} m` : 'Missing'}</dd><dt>Timezone</dt><dd>{config?.station?.timezone || 'UTC'}</dd></dl></div></section>
    <section className="panel"><div className="panel-title"><div><small>IOS / ANDROID / WEB</small><h2>Import and export</h2></div><div className="button-row"><button className="ghost" onClick={() => download('shared').catch(e => onError(String(e)))}>Web</button><button className="ghost" onClick={() => download('ios').catch(e => onError(String(e)))}>iOS</button><button className="ghost" onClick={() => download('android').catch(e => onError(String(e)))}>Android</button></div></div><textarea value={importText} onChange={e => setImportText(e.target.value)} placeholder="Paste a SatScheduler JSON export here…" /><button className="primary" disabled={!importText.trim()} onClick={() => importConfig().catch(e => onError(String(e)))}>Replace configuration from JSON</button></section>
  </div>
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) { return <label>{label}<input type="number" value={value} onChange={e => onChange(Number(e.target.value))} /></label> }
