import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { fmtDate, localTZ } from '../lib/format.js'
import { useToday } from '../lib/use-today.js'
import { t } from '../lib/i18n.js'
import { NOTE_MAX } from '../lib/history.js'
import { COUNT_MAX, entryOf, habitOf, habitStats, weekly, canLog } from '../lib/habits.js'
import { useSheetKeyboard } from '../lib/use-sheet-keyboard.js'
import Icon from '../components/Icon.jsx'
import HabitButtons, { setHabitStatus, habitName, habitWords } from '../components/HabitButtons.jsx'
import HabitCalendar from '../components/HabitCalendar.jsx'
import { habitEditSheet, setArchived } from '../components/HabitEditor.jsx'
import { Button, Segmented, Stepper } from '../components/ui.jsx'

// What a habit's screen says, in English (t() keys): Alcohol keeps its own sentences, every other
// habit the same neutral ones, with its own two answers where it names them.
const COPY = {
  alcohol: {
    unlogged: 'Only what you log counts. A day you leave unlogged is never treated as alcohol-free.',
    good30: 'Alcohol-free, last 30 days',
    startsWith: 'Starts with the next alcohol-free day you log',
    trend: 'Alcohol-free days vs the 30 days before: {0}',
    weeks: 'Alcohol-free days per week, last 12 weeks',
  },
  custom: {
    unlogged: 'Only what you log counts. A day you leave unlogged never counts as a success.',
    startsWith: 'Starts with the next successful day you log',
    trend: 'Successful days vs the 30 days before: {0}',
    weeks: 'Successful days per week, last 12 weeks',
  },
}
const copyOf = h => (h.builtin ? COPY.alcohol : COPY.custom)
const good30Of = h => (h.builtin ? t(COPY.alcohol.good30) : h.kind === 'avoid' ? t('Avoided, last 30 days') : t('Done, last 30 days'))

// One day's details: its status, the drinks (Alcohol) and a private note. The status saves as it
// is tapped; the drinks and the note are kept with Save (or when the sheet is dismissed).
function HabitDay({ habit, iso, close }) {
  const S = useStore(s => s.S)
  const noteRef = useRef(null)
  const onNoteFocus = useSheetKeyboard(noteRef)
  const h = habitOf(S, habit)
  const e = entryOf(S, habit, iso)
  const [count, setCount] = useState(e?.count || 0)
  const [note, setNote] = useState(e?.note || '')
  const status = e?.status ?? null
  const here = localTZ()
  const draft = useRef({})
  draft.current = { count, note, status }
  // Drinks and note are written once, on the way out, whichever way the sheet closes.
  useEffect(() => () => {
    const S = useStore.getState().S
    const cur = entryOf(S, habit, iso)
    const hh = habitOf(S, habit)
    const d = draft.current
    const patch = {}
    if (d.note.trim() !== (cur?.note || '')) patch.note = d.note
    if (hh?.count && d.status === hh.bad && (d.count || 0) !== (cur?.count || 0)) patch.count = d.count || null
    if (Object.keys(patch).length) setHabitStatus(habit, iso, patch)
  }, [habit, iso])
  if (!h) return null
  return <>
    <h3>{fmtDate(iso, true)}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{habitName(h)} · {t(copyOf(h).unlogged)}</div>
    <HabitButtons iso={iso} habit={habit} />
    {h.count && status === h.bad && <div className="row between" style={{ marginTop: 14 }}>
      <div className="lbl2">{t('Drinks (optional)')}</div>
      <Stepper value={count} min={0} max={COUNT_MAX} decimal={false} onChange={setCount} ariaLabel={t('Drinks (optional)')} />
    </div>}
    <textarea ref={noteRef} className="input" rows={3} maxLength={NOTE_MAX} value={note} style={{ marginTop: 14 }}
      placeholder={t('Private note (optional)')} aria-label={t('Private note (optional)')} onFocus={onNoteFocus} onChange={ev => setNote(ev.target.value)} />
    {e?.tz && e.tz !== here && <div className="muted small" style={{ marginTop: 8 }}>
      {t('Logged in {0}. This stays on {1}, wherever you are now.', e.tz, fmtDate(iso, true))}
    </div>}
    <div style={{ height: 16 }} />
    <Button variant="primary" onClick={close}>{t('Save')}</Button>
  </>
}
/** Opens one day of `habit` — any day up to today, so a past one can be corrected. */
export const habitDaySheet = (habit, iso) => canLog(iso) && useUI.getState().openSheet(close => <HabitDay habit={habit} iso={iso} close={close} />)

function Stat({ label, value, unit, sub }) {
  return <div className="habit-stat">
    <div className="lbl2">{label}</div>
    <div className="big">{value}{unit && <span className="muted" style={{ fontSize: '1rem' }}> {unit}</span>}</div>
    {sub && <div className="small muted">{sub}</div>}
  </div>
}

function Weeks({ rows, label }) {
  return <div className="habit-weeks" role="img" aria-label={label}>
    {rows.map(w => <div key={w.from} className="habit-week" title={`${fmtDate(w.from)} – ${fmtDate(w.to)}: ${w.free} / ${w.drank} / ${w.unlogged}`}>
      <div className="habit-week-bar">
        <span className="unlogged" style={{ flex: w.unlogged }} />
        <span className="drank" style={{ flex: w.drank }} />
        <span className="free" style={{ flex: w.free }} />
      </div>
    </div>)}
  </div>
}

/** One habit: today, its streaks and counts, its calendar and its last 12 weeks. `/habits/:id`. */
export default function HabitDetail({ id: idProp }) {
  const nav = useNavigate()
  const params = useParams()
  const id = idProp || params.id
  const S = useStore(s => s.S)
  const [range, setRange] = useState(30)
  const today = useToday()
  const h = habitOf(S, id)
  const st = useMemo(() => habitStats(S, id, today), [S.habitLog, id, today])
  const rows = useMemo(() => weekly(S, id, 12, today), [S.habitLog, id, today])
  // A habit that is not there (an old link, a definition cleared on another device): the list.
  if (!h) return <Navigate to="/habits" replace />
  const c = copyOf(h)
  const w = habitWords(h)
  const ent = entryOf(S, id, today)
  const diff = st.trend?.free
  const kindLabel = h.builtin ? null : h.kind === 'avoid' ? t('Avoid a habit') : t('Build a habit')
  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/habits')} aria-label={t('Habits')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 10, minWidth: 0 }}>
        <h1 className="habit-title">{habitName(h)}</h1>
        <div className="sub">{[t('Habits'), kindLabel, h.archived ? t('Archived') : null].filter(Boolean).join(' · ')}</div>
      </div>
      <button className="iconbtn" onClick={() => habitEditSheet(id)} aria-label={t('Edit habit')}><Icon name="pencil" /></button>
    </div>

    {h.archived && <div className="card">
      <div className="small muted" style={{ marginBottom: 10 }}>{t('Archived. Its history is kept; bring it back to show it on Home again.')}</div>
      <Button size="sm" variant="tinted" icon="undo" onClick={() => setArchived(id, false)}>{t('Unarchive')}</Button>
    </div>}

    <div className="card">
      <div className="row between" style={{ marginBottom: 10 }}>
        <div className="lbl2">{t('Today')} · {fmtDate(today, true)}</div>
        <Button size="sm" variant="ghost" icon="pencil" onClick={() => habitDaySheet(id, today)}>{ent?.note || ent?.count ? t('Details') : t('Add details')}</Button>
      </div>
      <HabitButtons iso={today} habit={id} />
    </div>

    <div className="card">
      <div className="habit-stats">
        <Stat label={t('Current streak (days)')} value={st.current}
          sub={st.pending && st.current ? t('Log today to keep it going') : st.current === 0 && !st.pending ? t(c.startsWith) : undefined} />
        <Stat label={t('Best streak (days)')} value={st.best} />
        <Stat label={good30Of(h)} value={st.d30.free}
          sub={t('Logged: {0} · Not logged: {1}', st.d30.logged, st.d30.unlogged)} />
      </div>
      <div className="small muted" style={{ marginTop: 10 }}>
        {st.trend
          ? t(c.trend, diff === 0 ? '±0' : (diff > 0 ? '+' : '−') + Math.abs(diff))
          : t('A trend shows once each of the last two 30-day stretches has at least a week logged.')}
      </div>
      {h.count && st.d30.drinkDays > 0 && <div className="small muted" style={{ marginTop: 4 }}>{t('Drinks recorded in the last 30 days: {0}', st.d30.drinks)}</div>}
    </div>

    <div className="card">
      <div className="row between" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>{t('Calendar')}</h2>
        <Segmented className="seg-inline" value={range} onChange={setRange}
          options={[{ value: 30, label: t('30 days') }, { value: 90, label: t('90 days') }]} />
      </div>
      <HabitCalendar S={S} habit={id} days={range} today={today} onDay={iso => habitDaySheet(id, iso)} />
      <div className="habit-legend">
        <span><i className="free" />{t(w.good)}</span>
        <span><i className="drank" />{t(w.bad)}</span>
        <span><i className="none" />{t('Not logged')}</span>
      </div>
      {st.ahead > 0 && <div className="small muted" style={{ marginTop: 10 }}>
        {t('Some entries are dated after today on this device, from another time zone. They count once their day arrives.')}
      </div>}
    </div>

    <div className="card">
      <h2 style={{ margin: '0 0 8px' }}>{t('Last 12 weeks')}</h2>
      <Weeks rows={rows} label={t(c.weeks)} />
      <div className="small muted" style={{ marginTop: 8 }}>
        {h.builtin ? t('Green: no alcohol. Orange: drank. Grey: not logged.') : t('Green: {0}. Orange: {1}. Grey: not logged.', t(w.good), t(w.bad))}
      </div>
    </div>

    <div className="muted small" style={{ margin: '4px 4px 24px' }}>
      {t('Your habit log syncs with your profile and is included in backups. It is never shared with AI assistants or the Coach.')}
    </div>
  </div>
}
