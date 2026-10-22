import { useMemo } from 'react'
import { calendarRows, habitOf } from '../lib/habits.js'
import { weekOrder, weekStartOf, DAYS, fmtDate } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { habitWords, ROLE_CLASS } from './HabitButtons.jsx'

// The last `days` days of a habit as weeks: a filled green cell with a tick for a good day, a
// filled orange one with a cross for a bad day, a dashed outline for a day nobody logged. A day
// after today is faint and cannot be tapped. Shape as well as colour, for those who can't tell
// green from orange; the habit's own words in each cell's accessible name.
export default function HabitCalendar({ S, habit = 'alcohol', days = 30, today, onDay }) {
  const ws = weekStartOf(S)
  const rows = useMemo(() => calendarRows(S, habit, days, ws, today), [S.habitLog, habit, days, ws, today])
  const w = habitWords(habitOf(S, habit))
  return <div className="habit-cal" data-days={days}>
    <div className="habit-cal-h">{weekOrder(ws).map(d => <span key={d}>{t(DAYS[d])}</span>)}</div>
    {rows.map((row, i) => <div className="habit-cal-row" key={i}>
      {row.map(c => {
        if (c.out) return <span key={c.iso} className="habit-cell out" aria-hidden="true" />
        const state = c.future ? 'future' : ROLE_CLASS[c.role] || 'none'
        const label = fmtDate(c.iso, true) + ', ' + (c.future ? t('Not yet') : t(c.role ? w[c.role] : 'Not logged')) +
          (c.count ? ' · ' + c.count : '') + (c.hasNote ? ' · ' + t('Note') : '')
        return <button key={c.iso} className={'habit-cell ' + state + (c.today ? ' today' : '')} disabled={c.future}
          aria-label={label} title={label} onClick={() => onDay?.(c.iso)}>
          <span className="d">{+c.iso.slice(8)}</span>
          {c.role === 'good' && <Icon name="check" />}
          {c.role === 'bad' && <Icon name="xmark" />}
          {c.hasNote && <i aria-hidden="true" />}
        </button>
      })}
    </div>)}
  </div>
}
