// Spoken cues (Settings → Timer alerts → Spoken cues, off by default): the timer says what it
// knows, so the phone can stay on the bench.
//
//   rest starts      the next set: "Set 3, 80 kilos, 8 reps" (with the exercise's name first when
//                    the next set is another exercise's, as in a superset or after the last set)
//   10 s to go       "10 seconds" (rests of 20 seconds or more), once per rest
//   rest over        "Rest is over"
//   timed holds      "3", "2", "1" at the end of every hold
//
// All of it in the app's language, through lib/speech.js (the Android app's own voice, which
// turns music down for a moment and never pauses it; the browser's elsewhere). Only while a
// workout runs, is not paused (lib/workout-clock.js) and the page is on screen: a locked phone
// keeps the end tone and the notification it always had.
//
// What is said and when is decided here, from the state; useUI only calls the moments below.
// A rest remembers which of its cues it has had (`timer.cued`, see restTickCue), so a rest that
// a paused workout held and then carried on, or one brought back after a reload, never says
// "10 seconds" twice; the next set is only ever announced by startRest.
//
// Ported from upstream openGym 499d589d2 (and the Settings part of 62a90e6d2). Gymly has no holds
// that start by themselves, so there is no count-in and no "Go!"; weights are read in the
// profile's unit with the app's number format (lib/format.js fmtNum); a stepmill's set says its
// machine level (lib/machine-level.js).
import { isWarmupRow, isSideSet, setNumberAt } from './workout-model.js'
import { modeOf, supersetUnits } from './history.js'
import { fmtNum } from './format.js'
import { t, tn, tnf, exerciseNameFor } from './i18n-core.js'
import { EXIDX } from './exercises.js'
import { hasLevel } from './machine-level.js'
import { isPaused } from './workout-clock.js'
import { speak, hush, SPEECH_RATES, speechRateOf } from './speech.js'

/** Whether cues are on for this profile, and a workout is running and not paused. */
export const cuesOn = S => S?.spokenCues === true && !!S?.active && !isPaused(S.active)

const notDone = s => !!s && !(isSideSet(s) ? s.sides.L.done && s.sides.R.done : s.done)

/**
 * The set that comes after a rest started by entry `forIdx`: in a superset the next exercise of
 * the group that still has a set to do (round and round), else the same exercise, else the next
 * exercise down the list with one. `{ idx, i }` or null when the workout is done.
 */
export function nextSetAfter(active, forIdx) {
  const entries = active?.entries || []
  if (!entries.length) return null
  const firstOpen = idx => { const i = (entries[idx]?.sets || []).findIndex(notDone); return i >= 0 ? { idx, i } : null }
  const at = Number.isInteger(forIdx) && forIdx >= 0 && forIdx < entries.length ? forIdx : (active.cur || 0)
  const unit = supersetUnits(entries).find(u => u.includes(at)) || [at]
  if (unit.length > 1) {
    const k = unit.indexOf(at)
    for (let j = 1; j <= unit.length; j++) { const hit = firstOpen(unit[(k + j) % unit.length]); if (hit) return hit }
  } else {
    const hit = firstOpen(at)
    if (hit) return hit
  }
  for (let j = 1; j < entries.length; j++) { const hit = firstOpen((at + j) % entries.length); if (hit) return hit }
  return null
}

const unitOf = S => (S?.unit === 'lb' ? 'lb' : 'kg')
const weightWords = (w, unit) => (unit === 'lb' ? tnf('{0} pound', '{0} pounds', w, fmtNum(w)) : tnf('{0} kilo', '{0} kilos', w, fmtNum(w)))

/**
 * What to say for set `i` of `entry` ("Set 3, 80 kilos, 8 reps"). `name` (the exercise's) goes
 * first when given. Weights are stored and read in the profile's unit.
 *
 * Cardio says its minutes, and a set with a machine level (a stepmill or stair climber,
 * lib/machine-level.js) its level too ("Set 1, 20 minutes, Level 8"), as the set's label does
 * (history.js setLabel): that number is the whole intensity of the set and is dialled in on the
 * console before it starts, which is when the rest's announcement comes. A treadmill's speed is
 * not said (upstream says none either).
 */
export function setCueText(S, entry, i, { name = null } = {}) {
  const s = entry?.sets?.[i]
  if (!s) return ''
  const unit = unitOf(S)
  const mode = modeOf({ ...(entry.target || {}), id: entry.id })
  const parts = [isWarmupRow(s) ? t('Warm-up') : t('Set {0}', setNumberAt(entry.sets, i))]
  const w = Number(s.w) || 0
  if (mode === 'cardio') {
    const min = Number(s.min) || 0
    if (min > 0) parts.push(tnf('{0} minute', '{0} minutes', min, fmtNum(min)))
    if (hasLevel(s)) parts.push(t('Level {0}', fmtNum(Number(s.level))))
  } else if (mode === 'time') {
    if (w > 0) parts.push(weightWords(w, unit))
    const sec = Number(s.sec ?? entry.target?.sec) || 0
    if (sec > 0) parts.push(tn('{0} second', '{0} seconds', sec))
  } else {
    if (w > 0) parts.push(weightWords(w, unit))
    if (isSideSet(s)) {
      const r = Number(s.sides.L.r) || 0
      if (r > 0) parts.push(tn('{0} rep per side', '{0} reps per side', r))
    } else {
      const r = Number(s.r) || 0
      if (r > 0) parts.push(tn('{0} rep', '{0} reps', r))
    }
  }
  const line = parts.join(', ')
  return name ? `${name}. ${line}` : line
}

/** The line said when a rest starts after a set of entry `forIdx`, or '' when nothing is left. */
export function restStartText(S, forIdx) {
  const next = nextSetAfter(S?.active, forIdx)
  if (!next) return ''
  const entry = S.active.entries[next.idx]
  const other = next.idx !== forIdx
  const ex = EXIDX[entry.id]
  const name = other ? (ex ? exerciseNameFor(ex) : (entry.n || '')) || null : null
  return setCueText(S, entry, next.i, { name })
}

/* ------------------------- what a rest has said (useUI's timer.cued) ------------------------- */

// "10 seconds" is said on the tick that reaches 10, or 9 when that tick came late or a pause took
// the 10 away by rounding (useUI pauseRest holds Math.round of what was left). Never lower: by 8
// it would be wrong, and the beeps of the last three seconds are coming.
const TEN_FROM = 10
const TEN_TO = 9

/**
 * The cue a rest's tick at `left` seconds calls for, or null: 'ten' once per rest, on rests of 20
 * seconds or more, never on the switch-sides pause, a paused rest or one that is over. `tm` is
 * useUI's timer; what it already said is `tm.cued`.
 */
export function restTickCue(tm, left) {
  if (!tm || tm.kind === 'switch' || tm.paused || tm.ready) return null
  const cued = Array.isArray(tm.cued) ? tm.cued : []
  if (left <= TEN_FROM && left >= TEN_TO && (Number(tm.total) || 0) >= 20 && !cued.includes('ten')) return 'ten'
  return null
}

/** `cued` with `cue` added (a new array; the timer is replaced, never changed in place). */
export const withCue = (cued, cue) => (Array.isArray(cued) ? (cued.includes(cue) ? cued : [...cued, cue]) : [cue])

/**
 * What a rest still counts as said after its time left moved from `oldLeft` to `newLeft`: time
 * added (+15 s, the wheel, the notification's button) past the ten-second mark is a new run-up to
 * it, so "10 seconds" may come again. A resume never adds time; a second either way is rounding
 * (the notification's clock rounds up), not a change.
 */
export function cuedAfterChange(cued, oldLeft, newLeft) {
  if (!Array.isArray(cued) || !cued.includes('ten')) return cued
  if (newLeft > TEN_FROM && newLeft > (Number(oldLeft) || 0) + 1) return cued.filter(c => c !== 'ten')
  return cued
}

/* ------------------------------ the moments useUI calls ------------------------------ */

let readStore = null
/** useUI hands over how to read the profile (it owns no copy of it). */
export function bindCueState(get) { readStore = get }

const live = () => {
  const S = readStore?.()
  return cuesOn(S) && !(typeof document !== 'undefined' && document.hidden) ? S : null
}
const say = (S, text, opts = {}) => {
  if (!text) return false
  speak(text, { rate: SPEECH_RATES[speechRateOf(S)], ...opts }).catch?.(() => {})
  return true
}

export const cues = {
  /** A rest began after a set of entry `forIdx`. */
  restStarted(forIdx) { const S = live(); return S ? say(S, restStartText(S, forIdx)) : false },
  /** A rest's tick reached a cue restTickCue asked for ('ten'). */
  restLeft(cue) { if (cue !== 'ten') return false; const S = live(); return S ? say(S, t('10 seconds')) : false },
  /** The rest ran out on screen. */
  restOver() { const S = live(); return S ? say(S, t('Rest is over')) : false },
  /** The end of a hold: a number, cutting off whatever is still being said. */
  count(n) { if (!(n >= 1 && n <= 3)) return false; const S = live(); return S ? say(S, String(n), { queue: false }) : false },
  /** The workout was paused: stop mid-sentence rather than finish announcing a set. */
  hush() { if (readStore?.()?.spokenCues === true) hush() },
}

/** The line the Settings row says when tried: what a rest would announce. */
export const sampleCue = (unit = 'kg') => [t('Set {0}', 3), weightWords(unit === 'lb' ? 185 : 80, unit), tn('{0} rep', '{0} reps', 8)].join(', ')
