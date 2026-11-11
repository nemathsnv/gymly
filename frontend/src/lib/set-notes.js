// A short note on one set (set menu → Note): "grip slipped", "a little twinge", "felt easy". It
// rides on the set row as `note` (on a per-side set the row, not a side; on a timed per-side pair
// the L row, where the menu opens), is kept when the workout is saved (finish-workout.js keeps a
// row's own keys), and shows as a small line under the row in the workout and after the set in
// History. It goes into MCP get_workout (`sets[].note`, local and hosted) and, like a workout's
// own note, the Coach's full workouts (api/coach/core/payload.js cleanWorkout); never into share
// cards. Ported from openGym 765dd3018.
//
// `note` on a set is not new to the data: the old Focus layout wrote it, and the server already
// counts it among the set keys an older app may drop on purpose (api/sync-stamps.js V139_DROPS),
// so a note cleared on one device stays cleared. A note written before the 140-character limit
// is shown whole and cut only when it is saved again.
import { isWarmupRow, hasCompletedWork } from './workout-model.js'

export const SET_NOTE_MAX = 140

/** The set's note, trimmed, or '' when it has none. */
export const setNoteOf = s => (s && typeof s.note === 'string' ? s.note.trim() : '')

/** `row` with `text` as its note (cut to SET_NOTE_MAX), or without one when `text` is blank. */
export function withSetNote(row, text) {
  const note = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, SET_NOTE_MAX)
  const { note: _old, ...rest } = row || {}
  return note ? { ...rest, note } : rest
}

/**
 * Every set's note of a saved entry, numbered the way the workout numbers its rows (warm-ups
 * apart, a timed per-side pair as one set): `[{ i, warm, n, note }]`, in order. Only sets that
 * carry completed work, as History lists only those.
 */
export function setNotesOf(entry, done = hasCompletedWork) {
  const sets = Array.isArray(entry?.sets) ? entry.sets : []
  const isWarm = isWarmupRow
  const out = []
  sets.forEach((s, i) => {
    const note = setNoteOf(s)
    if (!note || !done(s)) return
    const warm = isWarm(s)
    const k = sets.slice(0, i + 1).filter(x => isWarm(x) === warm).length
    out.push({ i, warm, n: s.side ? Math.ceil(k / 2) : k, note })
  })
  return out
}
