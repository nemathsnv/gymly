import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { HABITS, withEntry, entryOf, canLog } from '../lib/habits.js'
import Icon from './Icon.jsx'

// The three answers for a day, in the order they are read. `null` is "not logged": the way back
// from either of the others, never an answer that counts for anything.
export const HABIT_CHOICES = [
  { value: 'free', label: 'No alcohol', icon: 'check' },
  { value: 'drank', label: 'Drank alcohol', icon: 'xmark' },
  { value: null, label: 'Not logged', icon: 'minus' },
]

/** Writes one day of a habit. Anything but a loggable day (a future one) is left alone. */
export function setHabitStatus(habit, iso, patch) {
  useStore.getState().update(s => { s.habitLog = withEntry(s.habitLog, habit, iso, patch) })
}

/**
 * One tap sets a day: No alcohol, Drank alcohol or Not logged. Saves at once, so Home and the
 * Habits screen share it. `onPick` runs after the write (the Habits screen offers the details).
 */
export default function HabitButtons({ iso, habit = 'alcohol', onPick }) {
  const S = useStore(s => s.S)
  const h = HABITS[habit]
  const cur = entryOf(S, habit, iso)?.status ?? null
  const allowed = canLog(iso)
  return <div className="habit-btns" role="group" aria-label={t('Alcohol')}>
    {HABIT_CHOICES.map(c => {
      const value = c.value === 'free' ? h.good : c.value === 'drank' ? h.bad : null
      const on = cur === value
      return <button key={String(c.value)} disabled={!allowed} className={'habit-btn ' + (value ?? 'none') + (on ? ' on' : '')}
        aria-pressed={on}
        onClick={() => { if (!on) { setHabitStatus(habit, iso, { status: value }); onPick?.(value) } }}>
        <Icon name={c.icon} /><span>{t(c.label)}</span>
      </button>
    })}
  </div>
}
