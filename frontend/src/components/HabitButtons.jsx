import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { withEntry, entryOf, canLog, habitOf } from '../lib/habits.js'
import Icon from './Icon.jsx'

// The words for a habit's two answers, in English (the keys t() takes): Alcohol keeps its own,
// any other habit's follow its kind. "Not logged" is the same for all.
const WORDS = {
  alcohol: { good: 'No alcohol', bad: 'Drank alcohol' },
  do: { good: 'Done', bad: 'Not done' },
  avoid: { good: 'Avoided', bad: 'Did it' },
}
/** { good, bad }: the untranslated labels of `h`'s two answers. */
export const habitWords = h => (h?.builtin ? WORDS.alcohol : WORDS[h?.kind] || WORDS.do)
/** What a habit is called on screen: the name it was given, or Alcohol in the app's language. */
export const habitName = h => h?.name || t('Alcohol')
/** The calendar and buttons draw a good day green (`free`) and a bad one orange (`drank`). */
export const ROLE_CLASS = { good: 'free', bad: 'drank' }

/** A habit's icon on its colour, the way a Settings row shows its own. */
export function HabitIcon({ h }) {
  return <span className="lrow-i" style={{ background: `var(--${h?.color || 'teal'})` }}><Icon name={h?.icon || 'heart'} /></span>
}

/** Writes one day of a habit. Anything but a loggable day (a future one) is left alone. */
export function setHabitStatus(habit, iso, patch) {
  useStore.getState().update(s => { s.habitLog = withEntry(s.habitLog, habit, iso, patch) })
}

/**
 * One tap sets a day: the habit's good answer, its bad one, or Not logged. Saves at once, so Home
 * and the Habits screens share it. `onPick` runs after the write. Nothing for a habit that does
 * not exist.
 */
export default function HabitButtons({ iso, habit = 'alcohol', onPick }) {
  const S = useStore(s => s.S)
  const h = habitOf(S, habit)
  if (!h) return null
  const w = habitWords(h)
  const cur = entryOf(S, habit, iso)?.status ?? null
  const allowed = canLog(iso)
  // The three answers in the order they are read. `null` is "not logged": the way back from
  // either of the others, never an answer that counts for anything.
  const choices = [
    { value: h.good, cls: 'free', label: w.good, icon: 'check' },
    { value: h.bad, cls: 'drank', label: w.bad, icon: 'xmark' },
    { value: null, cls: 'none', label: 'Not logged', icon: 'minus' },
  ]
  return <div className="habit-btns" role="group" aria-label={habitName(h)}>
    {choices.map(c => {
      const on = cur === c.value
      return <button key={c.cls} disabled={!allowed} className={'habit-btn ' + c.cls + (on ? ' on' : '')}
        aria-pressed={on}
        onClick={() => { if (!on) { setHabitStatus(habit, iso, { status: c.value }); onPick?.(c.value) } }}>
        <Icon name={c.icon} /><span>{t(c.label)}</span>
      </button>
    })}
  </div>
}
