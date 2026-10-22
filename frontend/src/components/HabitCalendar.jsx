import { useMemo } from 'react'
import { calendarRows } from '../lib/habits.js'
import { weekOrder, weekStartOf, DAYS, fmtDate } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'

const STATUS_LABEL = { free: 'No alcohol', drank: 'Drank alcohol' }

// The last `days` days as weeks: a filled green cell with a tick for an alcohol-free day, a filled
// orange one with a cross for a day with alcohol, a dashed outline for a day nobody logged. A
// day after today is faint and cannot be tapped. Shape as well as colour, for those who can't
// tell green from orange.
export default function HabitCalendar({ S, habit = 'alcohol', days = 30, today, onDay }) {
  const ws = weekStartOf(S)
  const rows = useMemo(() => calendarRows(S, habit, days, ws, today), [S.habitLog, habit, days, ws, today])
  return <div className="habit-cal" data-days={days}>
    <div className="habit-cal-h">{weekOrder(ws).map(d => <span key={d}>{t(DAYS[d])}</span>)}</div>
    {rows.map((row, i) => <div className="habit-cal-row" key={i}>
      {row.map(c => {
        if (c.out) return <span key={c.iso} className="habit-cell out" aria-hidden="true" />
        const state = c.future ? 'future' : c.status || 'none'
        const label = fmtDate(c.iso, true) + ', ' + (c.future ? t('Not yet') : t(STATUS_LABEL[c.status] || 'Not logged')) +
          (c.count ? ' · ' + c.count : '') + (c.hasNote ? ' · ' + t('Note') : '')
        return <button key={c.iso} className={'habit-cell ' + state + (c.today ? ' today' : '')} disabled={c.future}
          aria-label={label} title={label} onClick={() => onDay?.(c.iso)}>
          <span className="d">{+c.iso.slice(8)}</span>
          {c.status === 'free' && <Icon name="check" />}
          {c.status === 'drank' && <Icon name="xmark" />}
          {c.hasNote && <i aria-hidden="true" />}
        </button>
      })}
    </div>)}
  </div>
}
