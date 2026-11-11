// "Your week" and "Your month": a small Home card on the first day of a week (the profile's week
// start, S.weekStart) about the week before, and on the 1st about the month before. Tap it for the
// numbers and share them as a picture (components/Recap.jsx, components/ShareCard.jsx).
// Settings → Look & Home → On Home → Week and month recap turns it off (S.recap === false); the
// card's × puts that one away for good (S.recapSeen, its key). Both are plain settings, stamped on
// change and merged from the copy that changed them last (sync-merge.js stampEdits), so a recap
// put away on the phone is gone on the desktop too.
//
// Ported from openGym 4ba2a9757. Upstream reads these numbers off its performance report
// (lib/report.js), which Gymly does not have; they are counted here with the same helpers the
// rest of the app uses, so the card agrees with History, the calendar and the weekly sets card:
//  - a workout belongs to the local calendar day it is filed under (workoutDay), never a UTC one;
//  - volume is the one the workout saved (w.vol), or its sets counted again (workoutVolume) for a
//    record without it, warm-ups left out either way;
//  - sets are ticked work sets, a per-side set once per side (workSetsDone);
//  - new bests are the ones each workout recorded when it was finished (w.prs);
//  - the muscle that did the most work is the weekly sets card's count (loadOfWorkouts):
//    full sets for the muscles a lift mainly trains, part of one for the ones that help;
//  - the streak is the Home streak's (streakWeeks), as of the stretch's last day.
// A stretch with no workout gets no card at all: nobody needs a recap of a week off.
import { workoutDay, workoutDuration, workoutVolume, workSetsDone, streakWeeks } from './history.js'
import { loadOfWorkouts, rankOf, MUSCLE_NAME } from './muscles.js'
import { isoOf, todayISO, weekStartOf } from './format.js'

// Noon, so no DST change can move a date by a day when days are added or taken away.
const dateOf = iso => new Date(iso + 'T12:00:00')
const addDays = (iso, n) => { const d = dateOf(iso); d.setDate(d.getDate() + n); return isoOf(d) }
const round1 = n => Math.round((Number(n) || 0) * 10) / 10

export const recapOn = S => S?.recap !== false

/**
 * The stretch due today, or null: `{ kind: 'month' | 'week', from, to, key }`, both ends included,
 * as local calendar days. The 1st looks back on the month before; the week's first day on the week
 * before. A 1st that is also the first day of a week shows the month (the bigger story, and the
 * week is in it).
 */
export function recapPeriod(S, today = todayISO()) {
  const d = dateOf(today)
  if (d.getDate() === 1) {
    const to = addDays(today, -1)
    const from = to.slice(0, 8) + '01'
    return { kind: 'month', from, to, key: 'm:' + from.slice(0, 7) }
  }
  if (d.getDay() === weekStartOf(S)) {
    const from = addDays(today, -7)
    return { kind: 'week', from, to: addDays(today, -1), key: 'w:' + from }
  }
  return null
}

/** The workouts filed under a day from `from` to `to`, both included. */
export const workoutsIn = (S, { from, to }) => (S?.workouts || [])
  .filter(w => { const d = workoutDay(w); return !!d && d >= from && d <= to })

/**
 * The numbers of a stretch: `{ ...period, workouts, volume, sets, prs, days, ms, streak, top }`.
 * `top` is the muscle with the most sets, `{ slug, name, sets }`, or null when no set reached one.
 */
export function recapOf(S, period) {
  const list = workoutsIn(S, period)
  let volume = 0, sets = 0, ms = 0, prs = 0
  const days = new Set()
  for (const w of list) {
    volume += Number.isFinite(w.vol) ? w.vol : workoutVolume(w)
    sets += workSetsDone(w)
    ms += workoutDuration(w)
    prs += new Set(w.prs || []).size
    days.add(workoutDay(w))
  }
  const load = loadOfWorkouts(list)
  const slug = rankOf(load).worked[0]
  return {
    ...period,
    workouts: list.length,
    volume: round1(volume),
    sets,
    prs,
    days: days.size,
    ms,
    streak: list.length ? streakWeeks(S, period.to) : 0,
    top: slug ? { slug, name: MUSCLE_NAME[slug] || slug, sets: round1(load[slug]) } : null,
  }
}

/** The recap Home shows today, or null (off, nothing due, put away, or a stretch without a workout). */
export function recapDue(S, today = todayISO()) {
  if (!recapOn(S)) return null
  const p = recapPeriod(S, today)
  if (!p || S?.recapSeen === p.key) return null
  const r = recapOf(S, p)
  return r.workouts > 0 ? r : null
}
