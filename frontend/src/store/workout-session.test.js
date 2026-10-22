// @vitest-environment happy-dom
// Pause, resume, restart and discard of the running session (workout-session.js), against the real
// stores: what the screen shows, what is saved for a reload, and what the rest countdown does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({ ok: true })), setRemoteAuth: vi.fn() }))
vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), chime: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn() }))

import { DEF, useStore } from './useStore.js'
import { useUI, REST_KEY, WORK_KEY } from './useUI.js'
import { pauseWorkout, resumeWorkout, restartWorkout, discardWorkout } from './workout-session.js'
import { activeMs, isPaused } from '../lib/workout-clock.js'
import { streakWeeks } from '../lib/history.js'

const MIN = 60_000
const clone = v => JSON.parse(JSON.stringify(v))
const A = () => useStore.getState().S.active
// The copy a reload starts from (useStore persist → localStorage gym_state_v1).
const savedActive = () => JSON.parse(localStorage.getItem('gym_state_v1') || 'null')?.active ?? null
const history = [{ id: 'w0', d: '2026-10-14', start: 1, end: 2, routineIds: [], entries: [{ id: 'bench', sets: [{ w: 60, r: 8, done: true }] }] }]

let T0
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-22T18:00:00'))
  T0 = Date.now()
  localStorage.clear()
  useUI.setState({ timer: null, work: null })
  useStore.setState({ user: null, ready: true, S: { ...clone(DEF), workouts: clone(history), active: {
    id: 'a1', d: '2026-10-22', start: T0, name: 'Push', routineIds: [], bw: null, cur: 0, workoutView: 'cards',
    entries: [
      { id: 'bench', sets: [{ w: 60, r: 8, done: true, at: T0 + MIN }, { w: 62.5, r: 8 }], note: 'felt strong' },
      { id: 'plank', sets: [{ sec: 45 }] },
    ],
  } } })
})
afterEach(() => {
  useUI.getState().stopRest()
  useUI.getState().stopWork()
  localStorage.clear()
  vi.useRealTimers()
})

describe('pausing and resuming the workout', () => {
  it('stops the clock, survives a reload paused, and carries on from where it stood', () => {
    vi.advanceTimersByTime(10 * MIN)
    expect(pauseWorkout()).toBe(true)
    expect(isPaused(A())).toBe(true)
    // Saved straight away: the app killed now comes back paused at the same time.
    expect(savedActive()).toMatchObject({ id: 'a1', pausedAt: T0 + 10 * MIN })

    vi.advanceTimersByTime(30 * MIN)   // in the background, then reloaded
    expect(activeMs(savedActive(), Date.now())).toBe(10 * MIN)
    expect(activeMs(A(), Date.now())).toBe(10 * MIN)

    expect(resumeWorkout()).toBe(true)
    vi.advanceTimersByTime(5 * MIN)
    expect(activeMs(A(), Date.now())).toBe(15 * MIN)
    expect(savedActive().pauses).toEqual([[T0 + 10 * MIN, T0 + 40 * MIN]])
    expect(savedActive().pausedAt).toBeUndefined()
  })

  it('holds a rest that is counting down, and resuming carries that rest on', () => {
    useUI.getState().startRest(90, 0)
    vi.advanceTimersByTime(30_000)
    pauseWorkout()
    expect(useUI.getState().timer).toMatchObject({ left: 60, paused: true })
    vi.advanceTimersByTime(10 * MIN)
    expect(useUI.getState().timer).toMatchObject({ left: 60, paused: true })   // no chime mid-break
    resumeWorkout()
    expect(useUI.getState().timer.paused).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(useUI.getState().timer).toMatchObject({ ready: true })
  })

  it('leaves a rest you paused yourself paused, and the rest countdown is its own timer', () => {
    useUI.getState().startRest(90, 0)
    useUI.getState().pauseRest()
    pauseWorkout()
    expect(A().restHeld).toBeUndefined()
    resumeWorkout()
    expect(useUI.getState().timer).toMatchObject({ paused: true })
    // And the other way round: pausing the rest never touches the workout clock.
    expect(isPaused(A())).toBe(false)
  })

  it('logging and data entry carry on while paused, untouched by the clock', () => {
    pauseWorkout()
    useStore.getState().update(s => { s.active.entries[0].sets[1].done = true; s.active.entries[0].sets[1].at = Date.now() })
    resumeWorkout()
    expect(A().entries[0].sets.map(s => !!s.done)).toEqual([true, true])
    expect(A().entries[0].note).toBe('felt strong')
  })

  it('has nothing to pause for a past workout being logged', () => {
    useStore.getState().update(s => { s.active.backfill = { durationMin: 60 } })
    expect(pauseWorkout()).toBe(false)
    expect(isPaused(A())).toBe(false)
  })
})

describe('restarting the workout timer', () => {
  it('goes back to 0:00 and keeps every exercise, set and note as it was', () => {
    const before = clone(A().entries)
    vi.advanceTimersByTime(42 * MIN)
    pauseWorkout()
    vi.advanceTimersByTime(MIN)
    expect(restartWorkout()).toBe(true)
    expect(A().start).toBe(Date.now())
    expect(isPaused(A())).toBe(false)
    expect(activeMs(A(), Date.now())).toBe(0)
    vi.advanceTimersByTime(MIN)
    expect(activeMs(A(), Date.now())).toBe(MIN)
    expect(A().entries).toEqual(before)
    expect(A().id).toBe('a1')
    expect(savedActive()).toMatchObject({ id: 'a1', start: T0 + 43 * MIN, entries: before })
    expect(useStore.getState().S.workouts).toEqual(history)
  })

  it('carries on a rest the pause was holding', () => {
    useUI.getState().startRest(60, 0)
    pauseWorkout()
    restartWorkout()
    expect(useUI.getState().timer.paused).toBeUndefined()
  })
})

describe('discarding the workout', () => {
  it('leaves no history, no streak change and nothing running or saved for a reload', () => {
    const streak = streakWeeks(useStore.getState().S)
    useUI.getState().startRest(90, 0)
    useUI.getState().startWork(45, 'Plank', vi.fn(), { idx: 1, i: 0, id: 'plank' })
    pauseWorkout()
    expect(localStorage.getItem(WORK_KEY)).not.toBeNull()

    expect(discardWorkout('a1')).toBe(true)
    expect(A()).toBeNull()
    expect(savedActive()).toBeNull()
    expect(useStore.getState().S.workouts).toEqual(history)
    expect(streakWeeks(useStore.getState().S)).toBe(streak)
    expect(useUI.getState().timer).toBeNull()
    expect(useUI.getState().work).toBeNull()
    expect(localStorage.getItem(REST_KEY)).toBeNull()
    expect(localStorage.getItem(WORK_KEY)).toBeNull()
    // Nothing fires later for a workout that is gone.
    vi.advanceTimersByTime(10 * MIN)
    expect(A()).toBeNull()
    expect(useStore.getState().S.workouts).toEqual(history)
  })

  it('a stale confirm leaves the session that replaced it alone', () => {
    useStore.getState().update(s => { s.active.id = 'a2' })
    expect(discardWorkout('a1')).toBe(false)
    expect(A().id).toBe('a2')
  })

  it('never throws away an open edit of a saved workout', () => {
    useStore.getState().update(s => { s.active.editingWorkoutId = 'w0' })
    expect(discardWorkout('a1')).toBe(false)
    expect(A()).not.toBeNull()
  })
})
