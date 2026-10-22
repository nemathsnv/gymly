import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { todayISO, fmtDate, localTZ } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { NOTE_MAX } from '../lib/history.js'
import { HABITS, COUNT_MAX, entryOf, habitStats, weekly, canLog } from '../lib/habits.js'
import { useSheetKeyboard } from '../lib/use-sheet-keyboard.js'
import Icon from '../components/Icon.jsx'
import HabitButtons, { setHabitStatus } from '../components/HabitButtons.jsx'
import HabitCalendar from '../components/HabitCalendar.jsx'
import { Button, Segmented, Stepper } from '../components/ui.jsx'

const HABIT = 'alcohol'

// One day's details: its status, the drinks and a private note. The status saves as it is tapped;
// the drinks and the note are kept with Save (or when the sheet is dismissed).
function HabitDay({ iso, close }) {
  const S = useStore(s => s.S)
  const noteRef = useRef(null)
  const onNoteFocus = useSheetKeyboard(noteRef)
  const e = entryOf(S, HABIT, iso)
  const [count, setCount] = useState(e?.count || 0)
  const [note, setNote] = useState(e?.note || '')
  const status = e?.status ?? null
  const here = localTZ()
  const draft = useRef({})
  draft.current = { count, note, status }
  // Drinks and note are written once, on the way out, whichever way the sheet closes.
  useEffect(() => () => {
    const cur = entryOf(useStore.getState().S, HABIT, iso)
    const d = draft.current
    const patch = {}
    if (d.note.trim() !== (cur?.note || '')) patch.note = d.note
    if (d.status === HABITS[HABIT].bad && (d.count || 0) !== (cur?.count || 0)) patch.count = d.count || null
    if (Object.keys(patch).length) setHabitStatus(HABIT, iso, patch)
  }, [iso])
  return <>
    <h3>{fmtDate(iso, true)}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>
      {t('Only what you log counts. A day you leave unlogged is never treated as alcohol-free.')}
    </div>
    <HabitButtons iso={iso} />
    {status === HABITS[HABIT].bad && <div className="row between" style={{ marginTop: 14 }}>
      <div className="lbl2">{t('Drinks (optional)')}</div>
      <Stepper value={count} min={0} max={COUNT_MAX} decimal={false} onChange={setCount} ariaLabel={t('Drinks (optional)')} />
    </div>}
    <textarea ref={noteRef} className="input" rows={3} maxLength={NOTE_MAX} value={note} style={{ marginTop: 14 }}
      placeholder={t('Private note (optional)')} onFocus={onNoteFocus} onChange={ev => setNote(ev.target.value)} />
    {e?.tz && e.tz !== here && <div className="muted small" style={{ marginTop: 8 }}>
      {t('Logged in {0}. This stays on {1}, wherever you are now.', e.tz, fmtDate(iso, true))}
    </div>}
    <div style={{ height: 16 }} />
    <Button variant="primary" onClick={close}>{t('Save')}</Button>
  </>
}
export const habitDaySheet = iso => canLog(iso) && useUI.getState().openSheet(close => <HabitDay iso={iso} close={close} />)

function Stat({ label, value, unit, sub }) {
  return <div className="habit-stat">
    <div className="lbl2">{label}</div>
    <div className="big">{value}{unit && <span className="muted" style={{ fontSize: '1rem' }}> {unit}</span>}</div>
    {sub && <div className="small muted">{sub}</div>}
  </div>
}

function Weeks({ rows }) {
  return <div className="habit-weeks" role="img" aria-label={t('Alcohol-free days per week, last 12 weeks')}>
    {rows.map(w => <div key={w.from} className="habit-week" title={`${fmtDate(w.from)} – ${fmtDate(w.to)}: ${w.free} / ${w.drank} / ${w.unlogged}`}>
      <div className="habit-week-bar">
        <span className="unlogged" style={{ flex: w.unlogged }} />
        <span className="drank" style={{ flex: w.drank }} />
        <span className="free" style={{ flex: w.free }} />
      </div>
    </div>)}
  </div>
}

export default function Habits() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const [range, setRange] = useState(30)
  const today = todayISO()
  const st = useMemo(() => habitStats(S, HABIT, today), [S.habitLog, today])
  const rows = useMemo(() => weekly(S, HABIT, 12, today), [S.habitLog, today])
  const ent = entryOf(S, HABIT, today)
  const diff = st.trend?.free
  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 10 }}><h1>{t('Habits')}</h1><div className="sub">{t('Alcohol')}</div></div>
    </div>

    <div className="card">
      <div className="row between" style={{ marginBottom: 10 }}>
        <div className="lbl2">{t('Today')} · {fmtDate(today, true)}</div>
        <Button size="sm" variant="ghost" icon="pencil" onClick={() => habitDaySheet(today)}>{ent?.note || ent?.count ? t('Details') : t('Add details')}</Button>
      </div>
      <HabitButtons iso={today} />
    </div>

    <div className="card">
      <div className="habit-stats">
        <Stat label={t('Current streak (days)')} value={st.current}
          sub={st.pending && st.current ? t('Log today to keep it going') : st.current === 0 && !st.pending ? t('Starts with the next alcohol-free day you log') : undefined} />
        <Stat label={t('Best streak (days)')} value={st.best} />
        <Stat label={t('Alcohol-free, last 30 days')} value={st.d30.free}
          sub={t('Logged: {0} · Not logged: {1}', st.d30.logged, st.d30.unlogged)} />
      </div>
      <div className="small muted" style={{ marginTop: 10 }}>
        {st.trend
          ? t('Alcohol-free days vs the 30 days before: {0}', diff === 0 ? '±0' : (diff > 0 ? '+' : '−') + Math.abs(diff))
          : t('A trend shows once each of the last two 30-day stretches has at least a week logged.')}
      </div>
      {st.d30.drinkDays > 0 && <div className="small muted" style={{ marginTop: 4 }}>{t('Drinks recorded in the last 30 days: {0}', st.d30.drinks)}</div>}
    </div>

    <div className="card">
      <div className="row between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{t('Calendar')}</h2>
        <Segmented className="seg-inline" value={range} onChange={setRange}
          options={[{ value: 30, label: t('30 days') }, { value: 90, label: t('90 days') }]} />
      </div>
      <HabitCalendar S={S} days={range} today={today} onDay={habitDaySheet} />
      <div className="habit-legend">
        <span><i className="free" />{t('No alcohol')}</span>
        <span><i className="drank" />{t('Drank alcohol')}</span>
        <span><i className="none" />{t('Not logged')}</span>
      </div>
      {st.ahead > 0 && <div className="small muted" style={{ marginTop: 10 }}>
        {t('Some entries are dated after today on this device, from another time zone. They count once their day arrives.')}
      </div>}
    </div>

    <div className="card">
      <h2 style={{ margin: '0 0 8px' }}>{t('Last 12 weeks')}</h2>
      <Weeks rows={rows} />
      <div className="small muted" style={{ marginTop: 8 }}>{t('Green: no alcohol. Orange: drank. Grey: not logged.')}</div>
    </div>

    <div className="muted small" style={{ margin: '4px 4px 24px' }}>
      {t('Your habit log syncs with your profile and is included in backups. It is never shared with AI assistants or the Coach.')}
    </div>
  </div>
}
