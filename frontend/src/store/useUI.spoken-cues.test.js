// @vitest-environment happy-dom
// Spoken cues against the real stores (useUI's rest and hold timers, workout-session.js pause):
// what is said as a rest starts, at 10 seconds and at its end, and at the end of a hold — and
// that a paused workout is silent and a rest it held and carried on never repeats itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({ ok: true })), setRemoteAuth: vi.fn() }))
vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), chime: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn() }))
vi.mock('../lib/speech.js', () => ({ speak: vi.fn(() => Promise.resolve(true)), hush: vi.fn(), SPEECH_RATES: { slow: 0.8, normal: 1, fast: 1.25 }, speechRateOf: S => S?.speechRate || 'normal' }))

import { DEF, useStore } from './useStore.js'
import { useUI, REST_KEY, restoreRest } from './useUI.js'
import { pauseWorkout, resumeWorkout } from './workout-session.js'
import { speak, hush } from '../lib/speech.js'

const clone = v => JSON.parse(JSON.stringify(v))
const said = () => speak.mock.calls.map(c => c[0])
const tick = s => vi.advanceTimersByTime(s * 1000)

let T0
const setup = (extra = {}) => {
  useStore.setState({ user: null, ready: true, S: { ...clone(DEF), sound: false, spokenCues: true, unit: 'kg', ...extra, active: {
    id: 'a1', d: '2026-10-22', start: T0, name: 'Push', routineIds: [], bw: null, cur: 0, workoutView: 'cards',
    entries: [
      { id: '0025', target: { mode: 'reps' }, sets: [{ w: 80, r: 8, done: true }, { w: 82.5, r: 8 }] },
      { id: 'plank', target: { mode: 'time', sec: 45 }, sets: [{ sec: 45 }] },
    ],
  } } })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-22T18:00:00'))
  T0 = Date.now()
  localStorage.clear()
  speak.mockClear(); hush.mockClear()
  useUI.setState({ timer: null, work: null })
  setup()
})
afterEach(() => {
  useUI.getState().stopRest()
  useUI.getState().stopWork()
  localStorage.clear()
  vi.useRealTimers()
})

describe('a rest, out loud', () => {
  it('the next set as it starts, 10 seconds before the end, and that it is over', () => {
    useUI.getState().startRest(30, 0, { forSet: 0 })
    expect(said()).toEqual(['Set 2, 82.5 kilos, 8 reps'])
    tick(19)
    expect(said()).toHaveLength(1)
    tick(1)
    expect(said()).toEqual(['Set 2, 82.5 kilos, 8 reps', '10 seconds'])
    tick(10)
    expect(said()).toEqual(['Set 2, 82.5 kilos, 8 reps', '10 seconds', 'Rest is over'])
  })

  it('off says nothing, and the switch-sides pause says nothing either', () => {
    setup({ spokenCues: false })
    useUI.getState().startRest(30, 0)
    tick(30)
    setup()
    useUI.getState().startRest(30, 1, { kind: 'switch' })
    tick(30)
    expect(said()).toEqual([])
  })

  it('a rest started again after it ran out does not announce the same set twice', () => {
    useUI.getState().startRest(20, 0)
    tick(20)
    speak.mockClear()
    useUI.getState().addRest(15)
    expect(useUI.getState().timer.ready).toBeFalsy()
    expect(said()).toEqual([])
  })
})

describe('a paused workout', () => {
  it('is silent, and the rest it held carries on without repeating what was said', () => {
    useUI.getState().startRest(30, 0)
    tick(20)                                  // "10 seconds" said
    expect(said()).toEqual(['Set 2, 82.5 kilos, 8 reps', '10 seconds'])
    pauseWorkout()
    expect(hush).toHaveBeenCalledTimes(1)     // a line still being said stops
    expect(useUI.getState().timer.paused).toBe(true)
    tick(60)
    resumeWorkout()
    expect(useUI.getState().timer.paused).toBeFalsy()
    tick(10)
    expect(said()).toEqual(['Set 2, 82.5 kilos, 8 reps', '10 seconds', 'Rest is over'])
  })

  it('a pause just before the mark still says it once, on carrying on', () => {
    useUI.getState().startRest(30, 0)
    tick(18)                                  // 12 left
    pauseWorkout()
    tick(30)
    resumeWorkout()
    tick(3)
    expect(said().filter(x => x === '10 seconds')).toHaveLength(1)
  })

  it('says nothing for a rest that runs while the workout is paused', () => {
    pauseWorkout()
    useUI.getState().startRest(30, 0)
    tick(30)
    expect(said()).toEqual([])
  })

  it('counts the end of a hold down, but not while paused', () => {
    useUI.getState().startWork(5, 'Plank', vi.fn())
    tick(4)
    expect(said()).toEqual(['3', '2', '1'])
    expect(speak.mock.calls.every(c => c[1].queue === false)).toBe(true)
    speak.mockClear()
    pauseWorkout()
    useUI.getState().startWork(5, 'Plank', vi.fn())
    tick(5)
    expect(said()).toEqual([])
  })
})

describe('time added, and a reload', () => {
  it('time added past the mark may hear "10 seconds" again', () => {
    useUI.getState().startRest(30, 0)
    tick(22)                                  // 8 left, "10 seconds" said
    useUI.getState().addRest(15)              // 23 left
    tick(13)
    expect(said().filter(x => x === '10 seconds')).toHaveLength(2)
  })

  it('a rest brought back after a reload keeps what it said', () => {
    useUI.getState().startRest(30, 0)
    tick(20)
    expect(JSON.parse(localStorage.getItem(REST_KEY)).cued).toEqual(['ten'])
    const saved = localStorage.getItem(REST_KEY)
    useUI.getState().stopRest()
    localStorage.setItem(REST_KEY, saved)
    speak.mockClear()
    expect(restoreRest()).toBe(true)
    expect(useUI.getState().timer.cued).toEqual(['ten'])
    tick(10)
    expect(said()).toEqual(['Rest is over'])
  })

  it('the notification’s Pause and Resume keep it, its +15 s past the mark clears it', () => {
    useUI.getState().startRest(30, 0)
    tick(21)                                  // 9 left
    const endsAt = useUI.getState().timer.endsAt
    useUI.getState().followNativeRest({ endsAt, left: 9, total: 30, paused: true })
    expect(useUI.getState().timer.cued).toEqual(['ten'])
    useUI.getState().followNativeRest({ endsAt: Date.now() + 9000, left: 9, total: 30, paused: false })
    expect(useUI.getState().timer.cued).toEqual(['ten'])
    useUI.getState().followNativeRest({ endsAt: Date.now() + 24000, left: 24, total: 30, paused: false })
    expect(useUI.getState().timer.cued).toEqual([])
  })
})
