// Machine level per cardio set, for the machines that are set by level, not by speed.
//
// A stepmill or stair climber has no belt to run at a speed: you pick a level on its console
// (StairMaster 1–20, most others 1–25), and that number is the whole intensity. Logged as a
// speed it was wrong twice over: the field read km/h, and a new row was seeded at 8 km/h nobody
// typed, which history, the text export and the FIT export then read back as a distance.
//
// `level` is the console's own number, with no unit, on the set itself:
// { min: 5, speed: 0, level: 8, done: true }. Like the treadmill's incline (lib/incline.js) it is
// optional everywhere. A set without it is what every set logged before this was, so nothing
// stored is rewritten and an older app that does not know the key leaves it alone (the server
// puts a key it never knew back from the stored copy, api/sync-stamps.js keepKeys). On these
// machines the set row asks for Level where it asked for Speed, and a new row starts at speed 0:
// a stored 0 reads as "no speed" (setLabel prints none), and every distance read off it is 0.

// No console goes this high; a typo past it is held at it rather than stored.
export const LEVEL_MAX = 50

// Read off the catalogue's English name and equipment, as lib/incline.js does. "stair up" (real
// stairs, body weight) is not here: on stairs there is nothing to set.
const LEVELLED = /stepmill|step ?mill|stair ?master|stair ?climb|stair ?mill|\bstepper\b|stair machine/i
const LEVELLED_EQ = new Set(['stepmill machine'])

/**
 * Whether a cardio exercise is set by a machine level instead of a speed: the stepmill and the
 * stair climbers and steppers of the catalogue, and an exercise of your own whose name says one.
 */
export function levelFits(ex) {
  if (!ex || typeof ex !== 'object') return false
  if (LEVELLED_EQ.has(String(ex.eq || '').toLowerCase())) return true
  return LEVELLED.test(String(ex.n || ''))
}

/**
 * A typed or stepped level as it is stored: a whole number from 1 to LEVEL_MAX. Nothing (a
 * cleared field) and 0 stay nothing, so the key goes rather than holding a level nobody set.
 */
export function clampLevel(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const level = Math.min(LEVEL_MAX, Math.round(n))
  return level >= 1 ? level : null
}

/** Whether a set carries a machine level. */
export const hasLevel = s => Number(s?.level) > 0

/** What a new row takes over from the set it follows: its level, when it had one. */
export const levelFrom = s => (hasLevel(s) ? { level: Number(s.level) } : {})
