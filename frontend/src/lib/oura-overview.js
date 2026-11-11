// The recovery overview's logic: Oura's daily rows next to Gymly's own sessions, and one timeline
// of workouts in which a session the ring also detected appears once, not twice.
//
// Oura's workouts are never copied into S.workouts. They stay in the overview, which lives in
// the screen's memory only (views/OuraOverview.jsx), so the Gymly log, its statistics, progression,
// export, the Coach and the AI-assistant connections see exactly what was logged in Gymly —
// nothing from Oura. Matching here only decides how the two are shown together.

const MIN = 60000
// How far apart a session logged in Gymly and the ring's detection of it may start and still be
// the same thing: the ring starts its detection late and the log starts when the first set is
// tapped, so they rarely line up to the minute.
export const MATCH_SLACK_MS = 20 * MIN
// Oura activity names that are what Gymly logs. A Gymly session without times (an import) can
// only be matched by day, and then only to one of these.
const GYM_LIKE = /strength|weight|lifting|crossfit|functional|bodyweight|calisthenics|hiit|training/i

const valid = n => typeof n === 'number' && Number.isFinite(n)

/** Minutes two [start, end] spans share once each is widened by `slack`; 0 when apart. */
function overlap(a0, a1, b0, b1, slack) {
  return Math.max(0, Math.min(a1 + slack, b1 + slack) - Math.max(a0 - slack, b0 - slack))
}

/**
 * Pairs each Oura workout with at most one Gymly session and the other way round.
 * @param {object[]} ouraWorkouts  overview.workouts ({ id, day, start, end, activity, … })
 * @param {object[]} gymly         S.workouts ({ id, d, start, end, name, … })
 * @returns {{ entries: object[], matched: number }}  entries newest first:
 *   { kind: 'both', gymly, oura } | { kind: 'gymly', gymly } | { kind: 'oura', oura }
 */
export function workoutTimeline(ouraWorkouts, gymly, { slack = MATCH_SLACK_MS } = {}) {
  const ouras = (ouraWorkouts || []).filter(o => o && o.id)
  const gs = (gymly || []).filter(g => g && g.id && typeof g.d === 'string')
  // Every candidate pair with a score, best first; then a greedy one-to-one assignment.
  const pairs = []
  for (const o of ouras) for (const g of gs) {
    let score = 0
    if (valid(o.start) && valid(o.end) && valid(g.start)) {
      const gEnd = valid(g.end) && g.end > g.start ? g.end : g.start + 60 * MIN
      score = overlap(o.start, o.end, g.start, gEnd, slack)
    } else if (g.d === o.day && GYM_LIKE.test(o.activity || '')) {
      score = 1                                   // same day, same kind: the weakest match there is
    }
    if (score > 0) pairs.push({ o, g, score })
  }
  pairs.sort((a, b) => b.score - a.score)
  const usedO = new Set(), usedG = new Set(), both = []
  for (const p of pairs) {
    if (usedO.has(p.o.id) || usedG.has(p.g.id)) continue
    usedO.add(p.o.id); usedG.add(p.g.id)
    both.push({ kind: 'both', gymly: p.g, oura: p.o })
  }
  const entries = [
    ...both,
    ...gs.filter(g => !usedG.has(g.id)).map(g => ({ kind: 'gymly', gymly: g })),
    ...ouras.filter(o => !usedO.has(o.id)).map(o => ({ kind: 'oura', oura: o })),
  ]
  const when = e => (e.gymly && valid(e.gymly.start) ? e.gymly.start : null) ?? (e.oura && valid(e.oura.start) ? e.oura.start : null)
    ?? Date.parse((e.gymly?.d || e.oura?.day) + 'T12:00:00')
  entries.sort((a, b) => when(b) - when(a))
  return { entries, matched: both.length }
}

/** The Gymly sessions inside the overview's window: from the oldest day it covers. */
export function inWindow(gymly, days) {
  const oldest = (days || []).reduce((m, d) => (!m || d.day < m ? d.day : m), null)
  if (!oldest) return []
  return (gymly || []).filter(g => g && typeof g.d === 'string' && g.d >= oldest)
}

/** Oura's own bands for readiness and sleep scores: 85+ optimal, 70–84 good, below that pay attention. */
export function scoreBand(score) {
  if (!valid(score)) return null
  return score >= 85 ? 'optimal' : score >= 70 ? 'good' : 'attention'
}

/** 27000 → "7h 30m"; 2700 → "45m". */
export function fmtSleep(sec) {
  if (!valid(sec) || sec <= 0) return '–'
  const m = Math.round(sec / 60)
  const h = Math.floor(m / 60)
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

/** "strength_training" → "Strength training". */
export function activityName(a) {
  const s = String(a || 'workout').replace(/_/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Training sessions logged in Gymly per day, for the day rows. */
export function sessionsByDay(gymly) {
  const m = {}
  for (const g of gymly || []) if (g && typeof g.d === 'string') m[g.d] = (m[g.d] || 0) + 1
  return m
}
