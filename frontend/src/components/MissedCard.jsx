import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { missedWorkouts, answerMissed } from '../lib/reschedule.js'
import { scheduleModeOf } from '../lib/rotation.js'
import { fmtDate } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { glyphOf } from '../lib/glyphs.js'
import { rescheduleSheet } from '../sheets.jsx'
import { Button } from './ui.jsx'
import Icon from './Icon.jsx'
import { tappable } from '../lib/use-sheet-keyboard.js'

// A scheduled session from a previous day that went by without a workout (lib/reschedule.js
// missedWorkouts): Home asks what to do with it and does nothing until answered.
//
//   Reschedule     — opens the preview of the shift; nothing changes before Apply
//   Skip           — let it go: nothing is made up and the week stays as it is
//   Keep schedule  — change nothing and stop asking
//
// Weekly plans only: a coach week or rotation already carries an undone session forward.
export default function MissedCard({ S, today }) {
  const update = useStore(s => s.update)
  if (S.active || scheduleModeOf(S) !== 'week') return null
  const missed = missedWorkouts(S, today)
  if (!missed.length) return null
  const isos = missed.map(m => m.iso)
  const routineOf = id => S.routines.find(r => r.id === id)
  const answer = act => {
    update(s => answerMissed(s, isos, act))
    useUI.getState().toast(act === 'skipped' ? t('Skipped. Your schedule stays as it is.') : t('Schedule kept as it is.'))
  }
  return <div className="card">
    <h2>{missed.length === 1 ? t('Missed workout') : t('Missed workouts')}</h2>
    <div className="list" style={{ marginBottom: 10 }}>
      {/* Each row reschedules just that day; the buttons below answer for all of them. */}
      {missed.map(m => <div key={m.iso} className="item" {...tappable(() => rescheduleSheet([m.iso]))}>
        <span className="lrow-i"><Icon name={glyphOf(routineOf(m.ids[0])?.emoji)} /></span>
        <div className="grow">
          <div className="tt">{m.ids.map(id => routineOf(id)?.name).filter(Boolean).join(' + ')}</div>
          <div className="ss">{fmtDate(m.iso, true)}</div>
        </div>
        {missed.length > 1 && <Icon name="chevronRight" className="chev" />}
      </div>)}
    </div>
    <div className="muted small" style={{ marginBottom: 12, lineHeight: 1.4 }}>
      {missed.length === 1
        ? t('Move it forward and shift the next sessions, skip it, or keep your schedule. Your weekly plan never changes.')
        : t('Tap one to reschedule just that day, or answer for all of them. Your weekly plan never changes.')}
    </div>
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <Button size="sm" variant="primary" icon="calendar" onClick={() => rescheduleSheet(isos)}>{missed.length === 1 ? t('Reschedule') : t('Reschedule all')}</Button>
      <Button size="sm" variant="tinted" onClick={() => answer('skipped')}>{t('Skip')}</Button>
      <Button size="sm" variant="ghost" onClick={() => answer('kept')}>{t('Keep schedule')}</Button>
    </div>
  </div>
}
