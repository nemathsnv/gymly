// The running session's clock: how long the workout has been going, less the time it was paused.
// Everything is a timestamp on S.active, never a ticking counter, so the clock reads the same after
// the app was in the background, the page reloaded or the phone killed the home-screen app:
//
//   start     when the clock started (beginWorkout, or the last Restart)
//   pausedAt  set while the clock is paused: when the pause began
//   pauses    [[from, to], ...] the pauses that have ended, oldest first
//
// A session from before this has neither pause field and reads exactly as it always did,
// now - start. The fields are live-session bookkeeping: buildCompletedWorkout writes its own
// whitelist, so none of them reaches S.workouts (the saved duration is end - start, see
// finish-workout.js activeEnd).

export const isPaused = active => Number.isFinite(active?.pausedAt)

// A clock that can be paused and restarted: a live session. A workout being logged into the past
// or a saved one being edited has no clock running (Workout.jsx shows its date instead).
export const hasClock = active => !!active && !active.backfill && active.editingWorkoutId == null && Number.isFinite(active.start)

const intervals = active => {
  const done = Array.isArray(active?.pauses)
    ? active.pauses.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    : []
  return isPaused(active) ? [...done, [active.pausedAt, Infinity]] : done
}

// How much of [from, to] the clock spent paused. The pause still running counts up to `to`.
export function pausedWithin(active, from, to) {
  if (!(to > from)) return 0
  let ms = 0
  for (const [a, b] of intervals(active)) {
    const lo = Math.max(a, from), hi = Math.min(b, to)
    if (hi > lo) ms += hi - lo
  }
  return ms
}

// Milliseconds the workout has been running at `now`: from its start, paused time left out.
// Paused, the figure holds still. A clock set back (now before start) reads zero, never negative.
export function activeMs(active, now = Date.now()) {
  const start = Number(active?.start)
  if (!Number.isFinite(start) || !(now > start)) return 0
  return Math.max(0, now - start - pausedWithin(active, start, now))
}

// "12:34", as the header and the tab bar have always shown it: minutes keep counting past the hour.
export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

// The three changes, each made on the draft S.active inside a store update. Each returns whether
// it changed anything, so a second tap (or a second tab) is a no-op rather than a second pause.

export function pauseClock(active, now = Date.now()) {
  if (!hasClock(active) || isPaused(active)) return false
  active.pausedAt = Math.max(now, active.start)
  return true
}

export function resumeClock(active, now = Date.now()) {
  if (!isPaused(active)) return false
  // A clock that went backwards while paused (a time-zone or manual change) closes an empty pause
  // rather than one that runs back in time and would add to the active figure.
  const pause = [active.pausedAt, Math.max(active.pausedAt, now)]
  active.pauses = [...(Array.isArray(active.pauses) ? active.pauses : []), pause]
  delete active.pausedAt
  delete active.restHeld
  return true
}

// Back to 0:00 and running, from now: the session started by accident at home, or left open
// before the real one began. Only the clock moves — the exercises, every set and every tick stay
// as they are. The day goes with it, so a session restarted after midnight files under today.
export function restartClock(active, now = Date.now(), today = null) {
  if (!hasClock(active)) return false
  active.start = now
  if (today) active.d = today
  delete active.pausedAt
  delete active.pauses
  delete active.restHeld
  return true
}
