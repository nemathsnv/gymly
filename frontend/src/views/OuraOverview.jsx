import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import Icon from '../components/Icon.jsx'
import { Button, Segmented } from '../components/ui.jsx'
import { ouraOverview, ouraSync, overviewErrorMessage } from '../lib/oura-api.js'
import { workoutTimeline, inWindow, scoreBand, fmtSleep, activityName, sessionsByDay } from '../lib/oura-overview.js'

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

function Score({ label, value, band }) {
  return <div style={{ flex: 1, minWidth: 0 }}>
    <div className="small dim">{label}</div>
    <div className="stat-v" style={{ color: band ? BAND_COLOR[band] : undefined }}>{dash(value)}</div>
    {band && <div className="small dim">{t(BAND_LABEL[band])}</div>}
  </div>
}

/* The recovery overview: Oura's readiness, sleep, HRV, heart rate, activity, stress, SpO2 and
   cardiovascular numbers by day, beside the sessions logged in Gymly, and one workout list where a
   session the ring also detected shows once. The overview lives in this component's state only:
   it is never put in the store, so it is never synced, exported, or seen by the Coach or MCP. */
export default function OuraOverview() {
  const nav = useNavigate()
  const toast = useUI(s => s.toast)
  const workouts = useStore(s => s.S.workouts)
  const [days, setDays] = useState(14)
  const [ov, setOv] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async (fresh = false) => {
    setBusy(true); setErr(null)
    try { setOv(await (fresh ? ouraSync(days) : ouraOverview(days))) }
    catch (e) { setErr(e); if (fresh) toast(overviewErrorMessage(e, t)) }
    setBusy(false)
  }
  useEffect(() => { load(false) }, [days])

  const gymly = useMemo(() => inWindow(workouts, ov?.days), [workouts, ov])
  const timeline = useMemo(() => workoutTimeline(ov?.workouts, gymly), [ov, gymly])
  const perDay = useMemo(() => sessionsByDay(gymly), [gymly])
  const today = ov?.days?.[0]
  const cardio = ov?.days?.find(d => d.cardio?.vascularAge != null || d.cardio?.vo2Max != null)?.cardio
  const notShared = Object.entries(ov?.available || {}).filter(([, v]) => v !== 'ok')

  const head = <div className="hdr">
    <button className="iconbtn" onClick={() => nav('/settings/data')} aria-label={t('Settings')}><Icon name="chevronLeft" /></button>
    <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{t('Recovery overview')}</h1>
      <div className="sub">{t('From your Oura ring, next to your training in Gymly. Read-only.')}</div></div>
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
    <Segmented className="seg-range" value={days} onChange={setDays}
      options={[7, 14, 30].map(n => ({ value: n, label: t('{0} days', n) }))} />

    {!ov ? <div className="card muted">{t('Loading your Oura data…')}</div> : <>
      <div className="card" data-oura-today>
        <div className="small dim" style={{ marginBottom: 8 }}>{today ? fmtDate(today.day, true) : t('No Oura data in this period')}</div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Score label={t('Readiness')} value={today?.readiness?.score} band={scoreBand(today?.readiness?.score)} />
          <Score label={t('Sleep')} value={today?.sleep?.score} band={scoreBand(today?.sleep?.score)} />
          <Score label={t('Activity')} value={today?.activity?.score} band={scoreBand(today?.activity?.score)} />
        </div>
        <div className="small" style={{ marginTop: 10, lineHeight: 1.6 }}>
          {t('Slept {0}', fmtSleep(today?.sleep?.totalSec))} · {t('HRV {0} ms', dash(today?.sleep?.averageHrv))} · {t('Lowest heart rate {0} bpm', dash(today?.sleep?.lowestHeartRate))}
          {today?.stress?.summary ? <> · {t('Stress: {0}', t(STRESS_LABEL[today.stress.summary]))}</> : null}
          {today?.spo2?.average != null ? <> · {t('SpO2 {0}%', today.spo2.average)}</> : null}
        </div>
        {cardio && <div className="small dim" style={{ marginTop: 6 }}>
          {cardio.vascularAge != null && t('Cardiovascular age {0}', cardio.vascularAge)}
          {cardio.vascularAge != null && cardio.vo2Max != null && ' · '}
          {cardio.vo2Max != null && t('VO2 max {0}', cardio.vo2Max)}
        </div>}
      </div>

      <div className="card" data-oura-days>
        <h3 style={{ marginBottom: 8 }}>{t('By day')}</h3>
        <div style={{ overflowX: 'auto' }}>
          <table className="small" style={{ width: '100%', borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
            <thead><tr className="dim" style={{ textAlign: 'start' }}>
              {[t('Day'), t('Readiness'), t('Sleep'), t('HRV'), t('Low HR'), t('Steps'), t('Stress'), t('Gymly')].map(h =>
                <th key={h} scope="col" style={{ textAlign: 'start', fontWeight: 500, padding: '4px 10px 4px 0' }}>{h}</th>)}
            </tr></thead>
            <tbody>{ov.days.map(d => <tr key={d.day} style={{ borderTop: '.5px solid var(--sep)' }}>
              <th scope="row" style={{ textAlign: 'start', fontWeight: 500, padding: '6px 10px 6px 0' }}>{fmtDate(d.day)}</th>
              <td style={{ padding: '6px 10px 6px 0', color: BAND_COLOR[scoreBand(d.readiness?.score)] }}>{dash(d.readiness?.score)}</td>
              <td style={{ padding: '6px 10px 6px 0' }}>{dash(d.sleep?.score)}{d.sleep?.totalSec ? ' · ' + fmtSleep(d.sleep.totalSec) : ''}</td>
              <td style={{ padding: '6px 10px 6px 0' }}>{dash(d.sleep?.averageHrv)}</td>
              <td style={{ padding: '6px 10px 6px 0' }}>{dash(d.sleep?.lowestHeartRate)}</td>
              <td style={{ padding: '6px 10px 6px 0' }}>{d.activity?.steps != null ? d.activity.steps.toLocaleString() : '–'}</td>
              <td style={{ padding: '6px 10px 6px 0' }}>{d.stress?.summary ? t(STRESS_LABEL[d.stress.summary]) : '–'}</td>
              <td style={{ padding: '6px 0' }}>{perDay[d.day] ? t('{0} session(s)', perDay[d.day]) : '–'}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>

      <div className="card" data-oura-workouts>
        <h3 style={{ marginBottom: 4 }}>{t('Workouts')}</h3>
        <div className="small dim" style={{ marginBottom: 8 }}>{t('Sessions logged in Gymly, activities Oura detected, and both when they are the same session. Oura activities are shown here only and never added to your Gymly log.')}</div>
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
                {o && g ? ' · ' + t('Oura: {0}', activityName(o.activity)) : ''}
                {o?.intensity ? ' · ' + t(o.intensity === 'hard' ? 'Hard' : o.intensity === 'moderate' ? 'Moderate' : 'Easy') : ''}
              </div>
            </div>
            <span className="small" style={{ flexShrink: 0, color: e.kind === 'oura' ? 'var(--purple)' : 'var(--acc)' }}>{tag}</span>
          </div>
        })}
      </div>

      {notShared.length > 0 && <div className="card small dim" data-oura-not-shared>
        {t('Not available from Oura: {0}. A data type you switched off on Oura’s screen, or one your ring or membership does not provide, stays empty.',
          [...new Set(notShared.map(([k]) => t(TYPE_LABEL[k] || k)))].join(', '))}
      </div>}

      <div className="small dim" style={{ margin: '4px 4px 12px' }}>
        {t('Fetched {0}', time(ov.fetchedAt))}{ov.cached ? ' · ' + t('from the last few minutes') : ''}
      </div>
    </>}
    <Button icon="repeat" onClick={() => load(true)} disabled={busy}>{busy ? t('Syncing…') : t('Sync now')}</Button>
  </>
}
