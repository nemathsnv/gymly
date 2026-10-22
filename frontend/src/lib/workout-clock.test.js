// The running session's clock (workout-clock.js): paused time left out, every figure read from
// timestamps, so the time is the same after the app slept in the background, a reload, or the
// phone killing the home-screen app and the session coming back from storage.
import { describe, expect, it } from 'vitest'
import { activeMs, fmtClock, hasClock, isPaused, pauseClock, pausedWithin, restartClock, resumeClock } from './workout-clock.js'

const MIN = 60_000
const T0 = 1_800_000_000_000
const session = (over = {}) => ({ id: 'a', d: '2027-01-15', start: T0, cur: 0, entries: [
  { id: 'bench', sets: [{ w: 60, r: 8, done: true, at: T0 + 2 * MIN }, { w: 60, r: 8 }] },
], ...over })
// What a reload hands back: the copy saved to localStorage (or the app's file), parsed again.
const reload = a => JSON.parse(JSON.stringify(a))

describe('the workout clock', () => {
  it('a session never paused reads as it always did, now - start', () => {
    expect(activeMs(session(), T0 + 12 * MIN + 34_000)).toBe(12 * MIN + 34_000)
    expect(fmtClock(activeMs(session(), T0 + 12 * MIN + 34_000))).toBe('12:34')
    expect(fmtClock(0)).toBe('0:00')
    expect(fmtClock(75 * MIN + 2000)).toBe('75:02')   // minutes keep counting past the hour
  })

  it('holds still while paused and leaves the pause out once resumed', () => {
    const a = session()
    expect(pauseClock(a, T0 + 10 * MIN)).toBe(true)
    expect(isPaused(a)).toBe(true)
    expect(activeMs(a, T0 + 10 * MIN)).toBe(10 * MIN)
    expect(activeMs(a, T0 + 50 * MIN)).toBe(10 * MIN)   // a 40-minute phone call
    expect(resumeClock(a, T0 + 50 * MIN)).toBe(true)
    expect(isPaused(a)).toBe(false)
    expect(a.pauses).toEqual([[T0 + 10 * MIN, T0 + 50 * MIN]])
    expect(activeMs(a, T0 + 55 * MIN)).toBe(15 * MIN)
  })

  it('adds up several pauses', () => {
    const a = session()
    pauseClock(a, T0 + 5 * MIN); resumeClock(a, T0 + 8 * MIN)
    pauseClock(a, T0 + 20 * MIN); resumeClock(a, T0 + 30 * MIN)
    pauseClock(a, T0 + 40 * MIN)
    expect(activeMs(a, T0 + 90 * MIN)).toBe(40 * MIN - 3 * MIN - 10 * MIN)
    expect(pausedWithin(a, T0, T0 + 90 * MIN)).toBe(3 * MIN + 10 * MIN + 50 * MIN)
    expect(pausedWithin(a, T0 + 25 * MIN, T0 + 45 * MIN)).toBe(5 * MIN + 5 * MIN)
  })

  it('a second pause or resume changes nothing', () => {
    const a = session()
    pauseClock(a, T0 + MIN)
    expect(pauseClock(a, T0 + 2 * MIN)).toBe(false)
    expect(a.pausedAt).toBe(T0 + MIN)
    resumeClock(a, T0 + 3 * MIN)
    expect(resumeClock(a, T0 + 4 * MIN)).toBe(false)
    expect(a.pauses).toHaveLength(1)
  })

  it('reads the same after a reload, paused or running, however long the app was away', () => {
    const running = session()
    pauseClock(running, T0 + 5 * MIN); resumeClock(running, T0 + 7 * MIN)
    // The page was in the background for an hour, then reloaded: no tick counted, the clock reads
    // from its timestamps.
    expect(activeMs(reload(running), T0 + 67 * MIN)).toBe(65 * MIN)

    const paused = session()
    pauseClock(paused, T0 + 20 * MIN)
    const back = reload(paused)
    expect(isPaused(back)).toBe(true)
    expect(activeMs(back, T0 + 3 * 60 * MIN)).toBe(20 * MIN)
    resumeClock(back, T0 + 3 * 60 * MIN)
    expect(activeMs(back, T0 + 3 * 60 * MIN + MIN)).toBe(21 * MIN)
  })

  it('never runs backwards or below zero when the device clock moves', () => {
    const a = session()
    expect(activeMs(a, T0 - 5 * MIN)).toBe(0)
    pauseClock(a, T0 + 10 * MIN)
    resumeClock(a, T0 + 9 * MIN)   // the clock went back while paused: an empty pause
    expect(a.pauses).toEqual([[T0 + 10 * MIN, T0 + 10 * MIN]])
    expect(activeMs(a, T0 + 12 * MIN)).toBe(12 * MIN)
    // Malformed pauses from another build are ignored, not trusted.
    expect(activeMs({ start: T0, pauses: [null, ['x', 1], [T0, T0 + MIN]] }, T0 + 5 * MIN)).toBe(4 * MIN)
  })

  it('restarts at 0:00 and running, keeping every exercise and set exactly as it was', () => {
    const a = session()
    pauseClock(a, T0 + 10 * MIN); a.restHeld = true
    const entriesBefore = reload(a.entries)
    expect(restartClock(a, T0 + 30 * MIN, '2027-01-16')).toBe(true)
    expect(a.start).toBe(T0 + 30 * MIN)
    expect(a.d).toBe('2027-01-16')
    expect(isPaused(a)).toBe(false)
    expect(a.pauses).toBeUndefined()
    expect(a.restHeld).toBeUndefined()
    expect(activeMs(a, T0 + 30 * MIN)).toBe(0)
    expect(activeMs(a, T0 + 31 * MIN)).toBe(MIN)
    expect(a.entries).toEqual(entriesBefore)
    expect(a.id).toBe('a')
  })

  it('has no clock to pause or restart for a past workout being logged or a saved one being edited', () => {
    for (const a of [session({ backfill: { durationMin: 60 } }), session({ editingWorkoutId: 'w1' }), session({ start: undefined }), null]) {
      expect(hasClock(a)).toBe(false)
      expect(pauseClock(a, T0 + MIN)).toBe(false)
      expect(restartClock(a, T0 + MIN)).toBe(false)
    }
    expect(hasClock(session())).toBe(true)
  })
})
