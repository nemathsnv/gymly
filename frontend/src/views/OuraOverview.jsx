import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtDate, todayISO } from '../lib/format.js'
import Icon from '../components/Icon.jsx'
import { Button, Segmented } from '../components/ui.jsx'
import { ouraOverview, ouraSync, overviewErrorMessage } from '../lib/oura-api.js'
import { workoutTimeline, inWindow, scoreBand, fmtSleep, activityName } from '../lib/oura-overview.js'
import { dayRows, weeklyLoad, latestOf, trendOf, ouraCardio } from '../lib/training-recovery.js'

const BAND_COLOR = { optimal: 'var(--green)', good: 'var(--teal)', attention: 'var(--orange)' }
const BAND_LABEL = { optimal: 'Optimal', good: 'Good', attention: 'Pay attention' }
const STRESS_LABEL = { restored: 'Restored', normal: 'Normal', stressful: 'Stressful' }
// Data types the overview reads, named the way the person shared them on Oura's screen.
const TYPE_LABEL = {
  daily_readiness: 'Readiness', daily_sleep: 'Sleep', sleep: 'Sleep details', daily_activity: 'Activity',
  daily_stress: 'Stress', daily_spo2: 'SpO2', daily_cardiovascular_age: 'Cardiovascular age', vO2_max: 'VO2 max',
  workout: 'Workouts', heartrate: 'Heart rate',
}
const dash = v => (v == null ? '–' : v)
const time = ms => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
const when = ms => (ms ? fmtDate(new Date(ms).toISOString().slice(0, 10)) + ', ' + time(ms) : '–')
const cell = { padding: '6px 10px 6px 0', verticalAlign: 'top' }

/** A reading with the date it was measured on. */
function Reading({ label, r, unit = '', band, fmt = v => v }) {
  return <div style={{ minWidth: 0 }} data-reading={label}>
    <div className="small dim">{label}</div>
    <div className="stat-v" style={{ color: band ? BAND_COLOR[band] : undefined }}>{r ? fmt(r.value) + unit : '–'}</div>
    <div className="small dim">{r ? (band ? t(BAND_LABEL[band]) + ' · ' : '') + fmtDate(r.day) : t('no reading')}</div>
  </div>
}

/** A thin line over a series, no axes: the shape, with the numbers beside it in words. */
function Spark({ series, color = 'var(--acc)' }) {
  if (!series || series.length < 2) return null
  const vs = series.map(p => p.value)
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1
  const pts = series.map((p, i) => `${(i / (series.length - 1)) * 100},${28 - ((p.value - lo) / span) * 24}`).join(' ')
  return <svg viewBox="0 0 100 30" preserveAspectRatio="none" width="100%" height="30" aria-hidden="true" style={{ display: 'block', marginTop: 6 }}>
    <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
  </svg>
}

function Trend({ label, tr, unit, higherIs }) {
  const arrow = tr.delta == null ? '' : tr.delta > 0 ? '↑' : tr.delta < 0 ? '↓' : '→'
  return <div style={{ flex: 1, minWidth: 0 }} data-trend={label}>
    <div className="small dim">{label}</div>
    <div className="stat-v">{tr.recentAvg == null ? '–' : tr.recentAvg + unit}</div>
    <div className="small dim">
      {tr.recentAvg == null ? t('Not enough readings yet') : t('7-day average')}
      {tr.baselineAvg != null ? ' · ' + t('{0} vs the 30 days before ({1}{2})', arrow + Math.abs(tr.delta) + unit, tr.baselineAvg, unit) : ''}
    </div>
    <Spark series={tr.series} />
    <div className="small dim" style={{ marginTop: 2 }}>{higherIs}</div>
  </div>
}

/* Training & recovery: the training logged in Gymly beside the sleep and recovery readings from
   Oura. Gymly stays the record of what was lifted; Oura's readings are shown with the day they
   were measured, as context. Nothing here changes a plan or suggests a weight from a score, and
   the Oura data lives in this component's state only (never the store), so it is never synced,
   exported, sent by a webhook, or seen by the Coach or MCP. */
export default function OuraOverview() {
  const nav = useNavigate()
  const toast = useUI(s => s.toast)
  const S = useStore(s => s.S)
  const unit = S.unit || 'kg'
  const [range, setRange] = useState(14)
  const [ov, setOv] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const today = todayISO()

  // Trends need 37 days whatever the table shows; one request covers both.
  const fetchDays = Math.max(range, 37)
  const load = async (fresh = false) => {
    setBusy(true); setErr(null)
    try { setOv(await (fresh ? ouraSync(fetchDays) : ouraOverview(fetchDays))) }
    catch (e) { setErr(e); if (fresh) toast(overviewErrorMessage(e, t)) }
    setBusy(false)
  }
  useEffect(() => { load(false) }, [fetchDays])

  const days = ov?.days || []
  const rows = useMemo(() => dayRows(S, days, { today, count: range }), [S, days, today, range])
  const weeks = useMemo(() => weeklyLoad(S, days, { today, weeks: 6 }), [S, days, today])
  const gymly = useMemo(() => inWindow(S.workouts, rows.map(r => ({ day: r.day }))), [S.workouts, rows])
  const timeline = useMemo(() => workoutTimeline((ov?.workouts || []).filter(w => w.day >= rows[rows.length - 1]?.day), gymly), [ov, gymly, rows])
  const cardio = ouraCardio(timeline.entries)
  const hrv = useMemo(() => trendOf(days, d => d.sleep?.averageHrv, { today }), [days, today])
  const rhr = useMemo(() => trendOf(days, d => d.sleep?.lowestHeartRate, { today }), [days, today])
  const latest = {
    readiness: latestOf(days, d => d.readiness?.score),
    sleep: latestOf(days, d => d.sleep?.score),
    slept: latestOf(days, d => d.sleep?.totalSec),
    hrv: latestOf(days, d => d.sleep?.averageHrv),
    rhr: latestOf(days, d => d.sleep?.lowestHeartRate),
    steps: latestOf(days, d => d.activity?.steps),
    stress: latestOf(days, d => (d.stress?.summary ? 1 : null)),
    spo2: latestOf(days, d => d.spo2?.average),
    vascular: latestOf(days, d => d.cardio?.vascularAge),
    vo2: latestOf(days, d => d.cardio?.vo2Max),
  }
  const stressDay = latest.stress && days.find(d => d.day === latest.stress.day)
  const notShared = Object.entries(ov?.available || {}).filter(([, v]) => v !== 'ok')

  const head = <div className="hdr">
    <button className="iconbtn" onClick={() => nav('/settings/data')} aria-label={t('Settings')}><Icon name="chevronLeft" /></button>
    <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{t('Training & recovery')}</h1>
      <div className="sub">{t('Your Gymly training next to your Oura sleep and recovery.')}</div></div>
  </div>

  if (err && !ov) return <>
    {head}
    <div className="card muted" data-oura-error>{overviewErrorMessage(err, t)}</div>
    <Button onClick={() => (err?.data?.code === 'reauth' || err?.data?.code === 'off' ? nav('/settings/data') : load(false))}>
      {err?.data?.code === 'reauth' ? t('Connect Oura again') : err?.data?.code === 'off' ? t('Settings') : t('Try again')}
    </Button>
  </>

  return <>
    {head}

    <div className="card small" data-oura-provenance style={{ lineHeight: 1.6 }}>
      <div><b>{t('Training')}</b> · {t('from your Gymly log, the record of every set, weight and RIR.')}</div>
      <div><b>{t('Recovery')}</b> · {t('from Oura, read-only.')} {ov ? t('Synced {0}', when(ov.lastSync)) : t('Loading…')}
        {ov?.lastError ? ' · ' + t('the last sync failed ({0}); showing what was synced before', ov.lastError) : ''}</div>
      <div className="dim" style={{ marginTop: 6 }}>{t('Readings are context, not instructions: Gymly never changes your plan or weights because of an Oura score. How you feel in the warm-up still counts.')}</div>
    </div>

    {!ov ? <div className="card muted">{t('Loading your Oura data…')}</div> : <>
      <div className="card" data-oura-today>
        <h3 style={{ marginBottom: 8 }}>{t('Latest readings')}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 12 }}>
          <Reading label={t('Readiness')} r={latest.readiness} band={scoreBand(latest.readiness?.value)} />
          <Reading label={t('Sleep score')} r={latest.sleep} band={scoreBand(latest.sleep?.value)} />
          <Reading label={t('Slept')} r={latest.slept} fmt={fmtSleep} />
          <Reading label={t('HRV')} r={latest.hrv} unit=" ms" />
          <Reading label={t('Lowest heart rate')} r={latest.rhr} unit=" bpm" />
          <Reading label={t('Steps')} r={latest.steps} fmt={v => v.toLocaleString()} />
          {latest.spo2 && <Reading label={t('SpO2')} r={latest.spo2} unit="%" />}
          {latest.vascular && <Reading label={t('Cardiovascular age')} r={latest.vascular} />}
          {latest.vo2 && <Reading label={t('VO2 max')} r={latest.vo2} />}
        </div>
        {stressDay && <div className="small dim" style={{ marginTop: 10 }}>{t('Stress: {0}', t(STRESS_LABEL[stressDay.stress.summary]))} · {fmtDate(stressDay.day)}</div>}
      </div>

      <div className="card" data-oura-trends>
        <h3 style={{ marginBottom: 8 }}>{t('Trends')}</h3>
        <div style={{ display: 'flex', gap: 16 }}>
          <Trend label={t('HRV')} tr={hrv} unit=" ms" higherIs={t('Higher than your own usual tends to mean better recovered.')} />
          <Trend label={t('Lowest heart rate')} tr={rhr} unit=" bpm" higherIs={t('Higher than your own usual can follow hard training, poor sleep, alcohol or illness.')} />
        </div>
      </div>

      <div className="card" data-oura-load>
        <h3 style={{ marginBottom: 4 }}>{t('Training load by week')}</h3>
        <div className="small dim" style={{ marginBottom: 8 }}>{t('Working sets from your Gymly log; hard sets are those with 3 or fewer reps in reserve. Readiness and sleep are that week’s Oura averages.')}</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="small" style={{ width: '100%', borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
            <thead><tr className="dim">
              {[t('Week of'), t('Sessions'), t('Sets'), t('Hard'), t('Avg RIR'), t('Volume'), t('Readiness'), t('Sleep')].map(h =>
                <th key={h} scope="col" style={{ ...cell, textAlign: 'start', fontWeight: 500 }}>{h}</th>)}
            </tr></thead>
            <tbody>{weeks.map(w => <tr key={w.week} style={{ borderTop: '.5px solid var(--sep)' }}>
              <th scope="row" style={{ ...cell, textAlign: 'start', fontWeight: 500 }}>{fmtDate(w.week)}</th>
              <td style={cell}>{w.sessions}</td>
              <td style={cell}>{w.sets}</td>
              <td style={cell}>{w.hardSets}</td>
              <td style={cell}>{dash(w.avgRir)}</td>
              <td style={cell}>{w.volume ? w.volume.toLocaleString() + ' ' + unit : '–'}</td>
              <td style={{ ...cell, color: BAND_COLOR[scoreBand(w.readiness)] }}>{dash(w.readiness)}</td>
              <td style={cell}>{dash(w.sleep)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>

      <Segmented className="seg-range" value={range} onChange={setRange}
        options={[7, 14, 30].map(n => ({ value: n, label: t('{0} days', n) }))} />

      <div className="card" data-oura-days>
        <h3 style={{ marginBottom: 4 }}>{t('Day by day')}</h3>
        <div className="small dim" style={{ marginBottom: 8 }}>{t('Planned is your current schedule. Each Oura reading belongs to the day Oura dates it.')}</div>
        <div style={{ overflowX: 'auto' }}>
          <table className="small" style={{ width: '100%', borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
            <thead><tr className="dim">
              {[t('Day'), t('Planned'), t('Done'), t('Sets · RIR'), t('Readiness'), t('Sleep'), t('HRV'), t('Low HR'), t('Steps')].map(h =>
                <th key={h} scope="col" style={{ ...cell, textAlign: 'start', fontWeight: 500 }}>{h}</th>)}
            </tr></thead>
            <tbody>{rows.map(r => {
              const sets = r.done.reduce((a, d) => a + d.sets, 0)
              const rirs = r.done.filter(d => d.avgRir != null)
              const o = r.oura
              return <tr key={r.day} data-day={r.day} style={{ borderTop: '.5px solid var(--sep)' }}>
                <th scope="row" style={{ ...cell, textAlign: 'start', fontWeight: 500 }}>{fmtDate(r.day)}</th>
                <td style={cell}>{r.planned.length ? r.planned.join(' + ') : t('Rest')}</td>
                <td style={cell}>{r.done.length ? r.done.map(d => d.name).join(' + ') : r.planned.length && r.day < today ? t('not done') : '–'}</td>
                <td style={cell}>{sets ? sets + (rirs.length ? ' · ' + (Math.round(rirs.reduce((a, d) => a + d.avgRir, 0) / rirs.length * 10) / 10) : '') : '–'}</td>
                <td style={{ ...cell, color: BAND_COLOR[scoreBand(o?.readiness?.score)] }}>{dash(o?.readiness?.score)}</td>
                <td style={cell}>{dash(o?.sleep?.score)}{o?.sleep?.totalSec ? ' · ' + fmtSleep(o.sleep.totalSec) : ''}</td>
                <td style={cell}>{dash(o?.sleep?.averageHrv)}</td>
                <td style={cell}>{dash(o?.sleep?.lowestHeartRate)}</td>
                <td style={cell}>{o?.activity?.steps != null ? o.activity.steps.toLocaleString() : '–'}</td>
              </tr>
            })}</tbody>
          </table>
        </div>
      </div>

      <div className="card" data-oura-workouts>
        <h3 style={{ marginBottom: 4 }}>{t('Workouts and cardio')}</h3>
        <div className="small dim" style={{ marginBottom: 8 }}>{t('Sessions logged in Gymly, activities Oura recorded, and both when they are the same session. Gymly keeps the sets, reps and weights; Oura’s summary is shown beside it and never replaces or adds to your log.')}</div>
        {!timeline.entries.length && <div className="small muted">{t('No workouts in this period')}</div>}
        {timeline.entries.map(e => {
          const g = e.gymly, o = e.oura
          const tag = e.kind === 'both' ? t('Gymly + Oura') : e.kind === 'gymly' ? t('Gymly') : t('Oura')
          return <div key={(g?.id || '') + '|' + (o?.id || '')} data-kind={e.kind} className="row between" style={{ gap: 12, padding: '8px 0', borderTop: '.5px solid var(--sep)' }}>
            <div style={{ minWidth: 0 }}>
              <div>{g ? g.name || t('Workout') : activityName(o.label || o.activity)}</div>
              <div className="small dim">
                {fmtDate(g?.d || o.day)}{(g?.start || o?.start) ? ' · ' + time(g?.start || o?.start) : ''}
                {o?.calories != null ? ' · ' + t('{0} kcal', o.calories) : ''}
                {o?.distance ? ' · ' + (Math.round(o.distance / 100) / 10) + ' km' : ''}
                {o && g ? ' · ' + t('Oura: {0}', activityName(o.activity)) : ''}
                {o?.intensity ? ' · ' + t(o.intensity === 'hard' ? 'Hard' : o.intensity === 'moderate' ? 'Moderate' : 'Easy') : ''}
              </div>
            </div>
            <span className="small" style={{ flexShrink: 0, color: e.kind === 'oura' ? 'var(--purple)' : 'var(--acc)' }}>{tag}</span>
          </div>
        })}
        {cardio.length > 0 && <div className="small dim" style={{ marginTop: 8 }}>{t('{0} cardio or other activities recorded by Oura in this period.', cardio.length)}</div>}
      </div>

      {notShared.length > 0 && <div className="card small dim" data-oura-not-shared>
        {t('Not available from Oura: {0}. A data type you switched off on Oura’s screen, or one your ring or membership does not provide, stays empty.',
          [...new Set(notShared.map(([k]) => t(TYPE_LABEL[k] || k)))].join(', '))}
      </div>}

      <div className="small dim" style={{ margin: '4px 4px 12px' }}>
        {t('Oura data is kept for up to 90 days in the server’s memory while you use this screen, synced automatically every few hours, and never saved or shared.')}
      </div>
    </>}
    <Button icon="repeat" onClick={() => load(true)} disabled={busy}>{busy ? t('Syncing…') : t('Sync now')}</Button>
  </>
}
