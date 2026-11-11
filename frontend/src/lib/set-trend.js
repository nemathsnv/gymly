// Each set against the same set last time (openGym #907, idea and first version by @lodepav): a
// small ↑, = or ↓ beside a finished set, in the workout and on a saved workout's detail sheet.
//
// The finish summary answers "did today beat last time" once per lift. This asks it set by set,
// which is where a session usually goes wrong: the first two sets are up and the third drops off.
//
//  - "Last time" is what the workout screen already calls last time (history.js lastEntryFor:
//    the same routine first, else any workout), read from the log as it stood BEFORE the workout
//    in question, so an old workout is held against the one before it, never a later one. A
//    dumbbell exercise's history is read in the meaning this entry logs in (dumbbells.js
//    historyAs), so a past "40 total" is not held against today's "20 each".
//  - Work set N today against work set N last time. Warm-ups are never marked, a set with no
//    counterpart has nothing to say, and neither has a set that is not done yet.
//  - Better is decided weight first, then reps: more of one and no less of the other is up.
//    When they pull in different directions (heavier but fewer reps), the estimated 1RM with the
//    profile's formula (onerm.js) settles it, so 70 × 6 beats 60 × 8. On an assisted machine less
//    help is more. A set with no load goes by reps, a hold by its seconds, cardio by its minutes
//    and then its intensity: the machine level on a stepmill (machine-level.js), else the speed.
//    A per-side set compares its summary (the heavier side, both sides' reps).
//  - Any change of weight counts, however small the exercise's own + / − step (weight-step.js):
//    a 1.25 kg step is a heavier set, and the label says 1.25, not a rounded 1.3.
//
// Nothing is stored: it is worked out from the log whenever a row is drawn.
import { isWarmupRow, isSideSet, hasCompletedWork } from './workout-model.js'
import { lastEntryFor, modeOf, workoutAt, entryRoutineId, fmtSec } from './history.js'
import { isAssisted } from './exercises.js'
import { estimate1RM } from './onerm.js'
import { historyAs, entryDbLoad } from './dumbbells.js'
import { t, tn } from './i18n-core.js'
import { fmtNum, fmtPlate } from './format.js'

const EPS = 1e-6
const num = v => Number(v) || 0
const sign = n => (n > EPS ? 1 : n < -EPS ? -1 : 0)
const doneOf = s => (isSideSet(s) ? s.sides.L.done === true && s.sides.R.done === true : s?.done === true)

/** Whether the arrows are shown (Settings → Workout → Compare sets with last time). On unless switched off. */
export const setTrendOn = S => S?.setTrend !== false

/**
 * One set against its counterpart: `{ dir, by, delta }` or null when there is nothing honest to
 * say. `dir` is 1 (better), 0 (the same) or -1. `by` names what decided it: 'w' (weight; on an
 * assisted machine the help), 'r' (reps), 'e1rm', 'sec' (a hold), 'min', 'level' or 'speed'
 * (cardio). `delta` is the raw difference of that measure (today minus last time), for the label.
 */
export function setTrend(cur, prev, { mode = 'reps', assisted = false, formula } = {}) {
  if (!cur || !prev || isWarmupRow(cur) || isWarmupRow(prev)) return null
  if (mode === 'time') {
    const a = num(cur.sec), b = num(prev.sec)
    if (!(a > 0) || !(b > 0)) return null
    const d = a - b
    return { dir: sign(d), by: 'sec', delta: d }
  }
  if (mode === 'cardio') {
    const a = num(cur.min), b = num(prev.min)
    if (!(a > 0) || !(b > 0)) return null
    const d = a - b
    if (sign(d)) return { dir: sign(d), by: 'min', delta: d }
    // The same minutes: a stepmill goes by its console level (both sets have one), anything
    // else by its speed. A level against a speed compares nothing, so the minutes stand.
    const la = num(cur.level), lb = num(prev.level)
    if (la > 0 && lb > 0) return { dir: sign(la - lb), by: sign(la - lb) ? 'level' : 'min', delta: sign(la - lb) ? la - lb : 0 }
    const ds = num(cur.speed) - num(prev.speed)
    return sign(ds) && num(cur.speed) > 0 && num(prev.speed) > 0 ? { dir: sign(ds), by: 'speed', delta: ds } : { dir: 0, by: 'min', delta: 0 }
  }
  const r = num(cur.r), pr = num(prev.r)
  if (!(r > 0) || !(pr > 0)) return null
  const w = num(cur.w), pw = num(prev.w)
  const rawW = w - pw
  const dw = sign(assisted ? -rawW : rawW)
  const dr = sign(r - pr)
  if (!dw && !dr) return { dir: 0, by: 'w', delta: 0 }
  if (!dw) return { dir: dr, by: 'r', delta: r - pr }
  if (!dr || dw === dr) return { dir: dw, by: 'w', delta: rawW }
  // Heavier for fewer reps, or lighter for more: the estimated 1RM decides. Not on an assisted
  // machine (the load is the help, there is no max to estimate): there the help decides.
  if (assisted || !(w > 0) || !(pw > 0)) return { dir: dw, by: 'w', delta: rawW }
  const a = estimate1RM(w, r, formula), b = estimate1RM(pw, pr, formula)
  if (a == null || b == null) return { dir: dw, by: 'w', delta: rawW }
  const de = a - b
  return { dir: Math.abs(de) < 0.05 ? 0 : Math.sign(de), by: 'e1rm', delta: de }
}

/**
 * The trend of every row of `entry` against `last` (lastEntryFor's answer: its `sets` are the
 * done work sets of last time, in order), as an array aligned with `entry.sets`; null where a
 * row has none (a warm-up, a set not done, a set with no counterpart).
 */
export function setTrendsFor(entry, last, { formula, mode, assisted } = {}) {
  const rows = Array.isArray(entry?.sets) ? entry.sets : []
  const prev = Array.isArray(last?.sets) ? last.sets.filter(s => s && !isWarmupRow(s)) : []
  if (!prev.length) return rows.map(() => null)
  const cfg = { ...(entry.target || {}), id: entry.id }
  const m = mode || modeOf(cfg)
  // A hold today against reps last time (or the other way round) compares nothing.
  const lastMode = last?.target ? modeOf({ ...last.target, id: entry.id }) : m
  if (lastMode !== m) return rows.map(() => null)
  const helped = assisted ?? isAssisted(entry)
  let n = -1
  return rows.map(s => {
    if (!s || isWarmupRow(s)) return null
    n++
    if (!doneOf(s) || !hasCompletedWork(s)) return null
    return setTrend(s, prev[n], { mode: m, assisted: helped, formula })
  })
}

/**
 * Last time for an entry of the running session, from `H` (the history it was built from,
 * backfill.js sessionHistory): lastEntryFor by the entry's routine, with a dumbbell exercise's
 * past read in the meaning this entry logs in.
 */
export function lastTimeFor(H, entry, rid = entry?.rid) {
  if (!H || !entry) return null
  return lastEntryFor(historyAs(H, entry.id, entryDbLoad(entry)), entry.id, rid)
}

/**
 * Last time as of a saved workout `w`: the log as it stood before it (the workouts that came
 * earlier), asked the way the workout screen asks (lastTimeFor, by the entry's own routine).
 */
export function lastTimeBefore(S, w, entry) {
  const at = workoutAt(w)
  const before = (S?.workouts || []).filter(x => x && x !== w && (w?.id == null || x.id !== w.id) && workoutAt(x) < at)
  return lastTimeFor({ ...S, workouts: before }, entry, entryRoutineId(w, entry))
}

/** The glyph for a trend. */
export const trendGlyph = tr => (!tr ? '' : tr.dir > 0 ? '↑' : tr.dir < 0 ? '↓' : '=')

/** The CSS modifier for a trend's colour. */
export const trendClass = tr => (!tr ? '' : tr.dir > 0 ? 'up' : tr.dir < 0 ? 'down' : 'same')

/**
 * What a trend says out loud, for the screen reader and the tooltip: "2.5 kg more than last
 * time", "1 rep fewer than last time", "Same as last time". `unit` is the weight unit shown.
 */
export function trendLabel(tr, unit = 'kg') {
  if (!tr) return ''
  if (tr.dir === 0) return t('Same as last time')
  const up = tr.dir > 0
  const d = Math.abs(tr.delta)
  if (tr.by === 'w') {
    // fmtPlate keeps the hundredths: an exercise stepping by 1.25 reads 1.25, not 1.3.
    const amount = fmtPlate(d) + ' ' + unit
    // On an assisted machine the weight is the help: less of it is the better set.
    if (tr.delta < 0 && up) return t('{0} less help than last time', amount)
    if (tr.delta > 0 && !up) return t('{0} more help than last time', amount)
    return t(up ? '{0} more than last time' : '{0} less than last time', amount)
  }
  if (tr.by === 'r') {
    const n = Math.round(d)
    return up ? tn('{0} more rep than last time', '{0} more reps than last time', n) : tn('{0} rep fewer than last time', '{0} reps fewer than last time', n)
  }
  if (tr.by === 'e1rm') return t(up ? 'Better estimated 1RM than last time' : 'Lower estimated 1RM than last time')
  if (tr.by === 'sec') return t(up ? '{0} longer than last time' : '{0} shorter than last time', fmtSec(Math.round(d)))
  if (tr.by === 'min') return t(up ? '{0} longer than last time' : '{0} shorter than last time', fmtNum(Math.round(d * 10) / 10) + ' min')
  if (tr.by === 'level') return t(up ? 'Higher level than last time' : 'Lower level than last time')
  if (tr.by === 'speed') return t(up ? 'Faster than last time' : 'Slower than last time')
  return ''
}
