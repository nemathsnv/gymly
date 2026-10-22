// The running session's lifecycle beyond start and finish: pausing, resuming and restarting its
// clock (lib/workout-clock.js), and discarding it. Each is one store update on S.active, which is
// saved locally on every change and carried whole between tabs and through every sync, so the
// state survives a reload, the app being killed, or the phone going back in the bag.
//
// The rest between sets is its own countdown (useUI's timer) and meets the workout clock only
// here: pausing the workout holds a rest that is counting down, so its end does not chime or push
// a notification in the middle of the break, and resuming carries that rest on — that one only,
// never a rest you had paused yourself before.
import { useStore } from './useStore.js'
import { useUI } from './useUI.js'
import { todayISO } from '../lib/format.js'
import { hasClock, isPaused, pauseClock, resumeClock, restartClock } from '../lib/workout-clock.js'

const store = () => useStore.getState()
const ui = () => useUI.getState()

export function pauseWorkout(now = Date.now()) {
  const A = store().S.active
  if (!hasClock(A) || isPaused(A)) return false
  const tm = ui().timer
  const holdRest = !!tm && !tm.ready && !tm.paused
  store().update(s => {
    if (s.active?.id !== A.id || !pauseClock(s.active, now)) return
    if (holdRest) s.active.restHeld = true
  })
  if (holdRest) ui().pauseRest()
  return true
}

export function resumeWorkout(now = Date.now()) {
  const A = store().S.active
  if (!isPaused(A)) return false
  const held = !!A.restHeld
  store().update(s => { if (s.active?.id === A.id) resumeClock(s.active, now) })
  if (held && ui().timer?.paused) ui().resumeRest()
  return true
}

// Back to 0:00 and running. A paused clock starts running again, and a rest the pause held
// carries on with it.
export function restartWorkout(now = Date.now()) {
  const A = store().S.active
  if (!hasClock(A)) return false
  const held = isPaused(A) && !!A.restHeld
  store().update(s => { if (s.active?.id === A.id) restartClock(s.active, now, todayISO()) })
  if (held && ui().timer?.paused) ui().resumeRest()
  return true
}

// Throwing the running session away. Nothing is written to S.workouts, so the history, the streak,
// the week's count, a rotation's pass and progression all read it as never started. What the
// session left running goes with it: the hold and the rest countdown (and their saved copies for a
// reload, useUI REST_KEY / WORK_KEY, with any alert booked for the rest's end). `id` is the session
// the confirm was asked about: one that has since been finished, or replaced in another tab, is
// left alone rather than wiped by a stale dialog.
export function discardWorkout(id = store().S.active?.id) {
  const A = store().S.active
  if (!A || A.id !== id || A.editingWorkoutId != null) return false
  ui().stopWork()
  ui().stopRest()
  store().update(s => { if (s.active?.id === id) s.active = null })
  return true
}
