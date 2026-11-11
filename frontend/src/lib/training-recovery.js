// Training next to recovery: what the Training & recovery screen (views/OuraOverview.jsx) shows.
//
// Gymly's log is the source of truth for the training side — sessions, sets, reps, weights, RIR —
// read from S here and never changed. The recovery side is the Oura overview the server holds
// (api/oura), passed in as `days` (newest first, one row per day). Nothing in this module writes
// to S, decides what to lift, or turns a recovery reading into a change of plan: readings are
// shown beside the training as context, each with the date it was measured.
import { isWarmupRow } from './workout-model.js'
import { HARD_RIR, rirOf } from './effort.js'
import { effectiveRoutineIds } from './history.js'
import { weekKey, weekStartOf, isoOf } from './format.js'

const valid = n => typeof n === 'number' && Number.isFinite(n)
const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const shift = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoOf(d) }

/** One logged session: working sets done, hard sets (RIR ≤ 3), volume of loaded sets, average RIR. */
export function sessionStats(w) {
  let sets = 0, hard = 0, volume = 0, timedSec = 0
  const rirs = []
  for (const e of w?.entries || []) for (const s of e?.sets || []) {
    if (!s?.done || isWarmupRow(s)) continue
    sets++
    if (valid(s.w) && s.w > 0 && valid(s.r) && s.r > 0) volume += s.w * s.r
    if (valid(s.sec) && s.sec > 0) timedSec += s.sec
    const r = rirOf(s)
    if (valid(r)) { rirs.push(r); if (r <= HARD_RIR) hard++ }
  }
  const dur = valid(w?.start) && valid(w?.end) && w.end > w.start ? Math.round((w.end - w.start) / 60000) : null
  return { sets, hardSets: hard, volume: Math.round(volume), timedSec, avgRir: rirs.length ? Math.round(avg(rirs) * 10) / 10 : null, rated: rirs.length, durationMin: dur }
}

/** Routine names planned for a date by the current schedule (rest → []). */
export function plannedOn(S, iso, today) {
  try {
    return effectiveRoutineIds(S, iso, today).map(id => (S.routines || []).find(r => r.id === id)?.name).filter(Boolean)
  } catch { return [] }
}

/**
 * One row per day from `today` back `count` days: planned routines, logged sessions with their
 * stats, and that day's Oura row (or null). Planned days in the past read the *current*
 * schedule — the plan as it is now, not as it was then.
 */
export function dayRows(S, ouraDays, { today, count = 14 }) {
  const byDay = new Map((ouraDays || []).map(d => [d.day, d]))
  const logged = new Map()
  for (const w of S?.workouts || []) if (w && typeof w.d === 'string') logged.set(w.d, [...(logged.get(w.d) || []), w])
  const rows = []
  for (let i = 0; i < count; i++) {
    const day = shift(today, -i)
    const done = (logged.get(day) || []).map(w => ({ id: w.id, name: w.name, start: w.start, ...sessionStats(w) }))
    rows.push({ day, planned: plannedOn(S, day, today), done, oura: byDay.get(day) || null })
  }
  return rows
}

/**
 * Training load per week for the last `weeks` weeks (the profile's own week start), newest
 * first, with that week's average Oura readiness and sleep score beside it when there are any.
 */
export function weeklyLoad(S, ouraDays, { today, weeks = 6 }) {
  const ws = weekStartOf(S)
  const out = []
  for (let i = 0; i < weeks; i++) {
    const key = weekKey(shift(today, -7 * i), ws)
    out.push({ week: key, sessions: 0, sets: 0, hardSets: 0, volume: 0, rirs: [], readiness: [], sleep: [] })
  }
  const at = new Map(out.map(w => [w.week, w]))
  for (const w of S?.workouts || []) {
    if (!w || typeof w.d !== 'string') continue
    const row = at.get(weekKey(w.d, ws))
    if (!row) continue
    const s = sessionStats(w)
    row.sessions++; row.sets += s.sets; row.hardSets += s.hardSets; row.volume += s.volume
    if (s.avgRir != null) row.rirs.push(s.avgRir)
  }
  for (const d of ouraDays || []) {
    const row = at.get(weekKey(d.day, ws))
    if (!row) continue
    if (valid(d.readiness?.score)) row.readiness.push(d.readiness.score)
    if (valid(d.sleep?.score)) row.sleep.push(d.sleep.score)
  }
  return out.map(({ rirs, readiness, sleep, ...w }) => ({
    ...w,
    avgRir: rirs.length ? Math.round(avg(rirs) * 10) / 10 : null,
    readiness: readiness.length ? Math.round(avg(readiness)) : null,
    sleep: sleep.length ? Math.round(avg(sleep)) : null,
    ouraDays: readiness.length,
  }))
}

/** The newest reading of a metric with the day it was measured on, or null. */
export function latestOf(days, pick) {
  for (const d of days || []) { const v = pick(d); if (valid(v)) return { day: d.day, value: v } }
  return null
}

/**
 * A metric over time: the series (oldest first, for a sparkline), the average of the last
 * `recent` days and of the `baseline` days before them. Days without a reading are skipped, never
 * read as zero; an average needs at least 3 readings or it is null.
 */
export function trendOf(days, pick, { today, recent = 7, baseline = 30 } = {}) {
  const recentFrom = shift(today, -(recent - 1))
  const baseFrom = shift(today, -(recent + baseline - 1))
  const series = [], r = [], b = []
  for (const d of [...(days || [])].sort((x, y) => (x.day < y.day ? -1 : 1))) {
    const v = pick(d)
    if (!valid(v) || d.day < baseFrom || d.day > today) continue
    series.push({ day: d.day, value: v })
    if (d.day >= recentFrom) r.push(v); else b.push(v)
  }
  const ra = r.length >= 3 ? avg(r) : null, ba = b.length >= 3 ? avg(b) : null
  return {
    series,
    latest: series.length ? series[series.length - 1] : null,
    recentAvg: ra == null ? null : Math.round(ra * 10) / 10,
    baselineAvg: ba == null ? null : Math.round(ba * 10) / 10,
    delta: ra != null && ba != null ? Math.round((ra - ba) * 10) / 10 : null,
    recentN: r.length, baselineN: b.length,
  }
}

/** Oura activities that are not strength sessions (the cardio and movement Gymly did not log). */
export function ouraCardio(entries) {
  return (entries || []).filter(e => e.kind === 'oura' && !/strength|weight|lifting/i.test(e.oura?.activity || ''))
}
