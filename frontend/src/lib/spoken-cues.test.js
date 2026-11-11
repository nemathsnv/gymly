// Spoken cues (lib/spoken-cues.js): what the timer says and when. Ported from upstream openGym
// 499d589d2, plus Gymly's own: no cues while the workout is paused, a rest that says "10 seconds"
// once however often it is paused and carried on, weights in the app's number format and the
// profile's unit, and a stepmill's machine level.
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('./speech.js', () => ({ speak: vi.fn(() => Promise.resolve(true)), hush: vi.fn(), SPEECH_RATES: { slow: 0.8, normal: 1, fast: 1.25 }, speechRateOf: S => S?.speechRate || 'normal' }))
const { speak, hush } = await import('./speech.js')
const { nextSetAfter, setCueText, restStartText, cues, bindCueState, cuesOn, sampleCue, restTickCue, withCue, cuedAfterChange } = await import('./spoken-cues.js')
const { _setLangState } = await import('./i18n-core.js')
const { setWeightDecimals } = await import('./format.js')
const de = (await import('../locales/de.js')).default
const ru = (await import('../locales/ru.js')).default

const BENCH = '0025', SQUAT = '0043', STEPMILL = '2311', TREADMILL = '2259'
const set = (w, r, done = false, extra = {}) => ({ w, r, done, ...extra })
const entry = (id, sets, target = { mode: 'reps' }, extra = {}) => ({ id, target, sets, ...extra })
const S = (entries, extra = {}) => ({ unit: 'kg', spokenCues: true, active: { cur: 0, start: 1, entries }, ...extra })

afterEach(() => { speak.mockClear(); hush.mockClear(); bindCueState(null); _setLangState('en', {}, null, null); setWeightDecimals(1) })

describe('what comes next after a rest', () => {
  test('the same exercise, then the next one down the list', () => {
    const a = { entries: [entry(BENCH, [set(80, 8, true), set(80, 8)]), entry(SQUAT, [set(100, 5)])] }
    expect(nextSetAfter(a, 0)).toEqual({ idx: 0, i: 1 })
    a.entries[0].sets[1].done = true
    expect(nextSetAfter(a, 0)).toEqual({ idx: 1, i: 0 })
  })
  test('round and round a superset', () => {
    const a = { entries: [entry(BENCH, [set(80, 8, true), set(80, 8)], undefined, { sg: 'g' }), entry(SQUAT, [set(100, 5), set(100, 5)], undefined, { sg: 'g' })] }
    expect(nextSetAfter(a, 0)).toEqual({ idx: 1, i: 0 })
    a.entries[1].sets[0].done = true
    expect(nextSetAfter(a, 1)).toEqual({ idx: 0, i: 1 })
  })
  test('a per-side row counts as done only once both sides are', () => {
    const half = { w: 20, r: 16, done: false, sides: { L: { w: 20, r: 8, done: true }, R: { w: 20, r: 8, done: false } } }
    expect(nextSetAfter({ entries: [entry('lunge', [half])] }, 0)).toEqual({ idx: 0, i: 0 })
  })
  test('nothing left, nothing next', () => {
    expect(nextSetAfter({ entries: [entry(BENCH, [set(80, 8, true)])] }, 0)).toBe(null)
    expect(nextSetAfter({ entries: [] }, 0)).toBe(null)
  })
})

describe('the line for a set', () => {
  test('set number, weight and reps', () => {
    const e = entry(BENCH, [set(40, 5, true, { phase: 'warmup' }), set(80, 8, true), set(82.5, 8)])
    expect(setCueText(S([e]), e, 2)).toBe('Set 2, 82.5 kilos, 8 reps')
    expect(setCueText(S([e]), e, 0)).toBe('Warm-up, 40 kilos, 5 reps')
    expect(setCueText(S([e]), e, 9)).toBe('')
  })
  test('the profile’s unit, singular and plural', () => {
    const e = entry(BENCH, [set(1, 1), set(185, 8)])
    expect(setCueText(S([e], { unit: 'lb' }), e, 1)).toBe('Set 2, 185 pounds, 8 reps')
    expect(setCueText(S([e], { unit: 'lb' }), e, 0)).toBe('Set 1, 1 pound, 1 rep')
    expect(setCueText(S([e]), e, 0)).toBe('Set 1, 1 kilo, 1 rep')
  })
  test('weights in the app’s own number format (Settings → decimals, the language’s separator)', () => {
    const e = entry(BENCH, [set(81.25, 8)])
    expect(setCueText(S([e]), e, 0)).toBe('Set 1, 81.3 kilos, 8 reps')
    setWeightDecimals(2)
    expect(setCueText(S([e]), e, 0)).toBe('Set 1, 81.25 kilos, 8 reps')
    _setLangState('de', de, null, null)
    expect(setCueText(S([e]), e, 0)).toBe('Satz 1, 81,25 Kilo, 8 Wiederholungen')
  })
  test('bodyweight, holds, per side and cardio', () => {
    const pull = entry('pullup', [set(0, 1)])
    expect(setCueText(S([pull]), pull, 0)).toBe('Set 1, 1 rep')
    const plank = entry('plank', [{ sec: 45, done: false }], { mode: 'time', sec: 45 })
    expect(setCueText(S([plank]), plank, 0)).toBe('Set 1, 45 seconds')
    const lunge = entry('lunge', [{ w: 20, r: 16, done: false, sides: { L: { w: 20, r: 8 }, R: { w: 20, r: 8 } } }])
    expect(setCueText(S([lunge]), lunge, 0)).toBe('Set 1, 20 kilos, 8 reps per side')
    const run = entry(TREADMILL, [{ min: 20, speed: 10, done: false }], { mode: 'cardio' })
    expect(setCueText(S([run]), run, 0)).toBe('Set 1, 20 minutes')
  })
  test('a timed per-side pair is one set, as the workout screen numbers it', () => {
    const side = entry('plank', [{ sec: 30, side: 'L', done: true }, { sec: 30, side: 'R', done: true }, { sec: 30, side: 'L' }, { sec: 30, side: 'R' }], { mode: 'time', sec: 30 })
    expect(setCueText(S([side]), side, 2)).toBe('Set 2, 30 seconds')
  })
  test('a stepmill says its machine level, a set without one says none', () => {
    const climb = entry(STEPMILL, [{ min: 10, speed: 0, level: 8, done: true }, { min: 10, speed: 0, level: 9 }, { min: 5, speed: 0 }], { mode: 'cardio' })
    expect(setCueText(S([climb]), climb, 1)).toBe('Set 2, 10 minutes, Level 9')
    expect(setCueText(S([climb]), climb, 2)).toBe('Set 3, 5 minutes')
    _setLangState('de', de, null, null)
    expect(setCueText(S([climb]), climb, 1)).toBe('Satz 2, 10 Minuten, Stufe 9')
  })
  test('another exercise is named first', () => {
    const st = S([entry(BENCH, [set(80, 8, true)]), entry(SQUAT, [set(100, 5)])])
    expect(restStartText(st, 0)).toMatch(/^.+\. Set 1, 100 kilos, 5 reps$/)
    expect(restStartText(S([entry(BENCH, [set(80, 8, true)])]), 0)).toBe('')
  })
  test('the Settings sample', () => {
    expect(sampleCue('kg')).toBe('Set 3, 80 kilos, 8 reps')
    expect(sampleCue('lb')).toBe('Set 3, 185 pounds, 8 reps')
  })
  test('the language’s own plural forms', () => {
    _setLangState('ru', ru, null, null)
    expect(sampleCue('kg')).toBe('Подход 3, 80 килограммов, 8 повторений')
  })
})

describe('what a rest has said', () => {
  const tm = (extra = {}) => ({ left: 11, total: 90, endsAt: 0, ...extra })
  test('"10 seconds" at 10, or 9 when the tick came late, once, on long rests only', () => {
    expect(restTickCue(tm(), 11)).toBe(null)
    expect(restTickCue(tm(), 10)).toBe('ten')
    expect(restTickCue(tm(), 9)).toBe('ten')
    expect(restTickCue(tm(), 8)).toBe(null)
    expect(restTickCue(tm({ cued: ['ten'] }), 10)).toBe(null)
    expect(restTickCue(tm({ total: 15 }), 10)).toBe(null)
  })
  test('never on the switch-sides pause, a paused rest or one that is over', () => {
    expect(restTickCue(tm({ kind: 'switch' }), 10)).toBe(null)
    expect(restTickCue(tm({ paused: true }), 10)).toBe(null)
    expect(restTickCue(tm({ ready: true }), 10)).toBe(null)
    expect(restTickCue(null, 10)).toBe(null)
  })
  test('the record of it is a new array, without doubles', () => {
    const a = ['ten']
    expect(withCue(undefined, 'ten')).toEqual(['ten'])
    expect(withCue(a, 'ten')).toBe(a)
  })
  test('time added past the mark may say it again; a resume or a second of rounding does not', () => {
    expect(cuedAfterChange(['ten'], 6, 21)).toEqual([])
    expect(cuedAfterChange(['ten'], 10, 11)).toEqual(['ten'])
    expect(cuedAfterChange(['ten'], 8, 8)).toEqual(['ten'])
    expect(cuedAfterChange(['ten'], 25, 40)).toEqual([])
    expect(cuedAfterChange(['ten'], 9, 5)).toEqual(['ten'])
    expect(cuedAfterChange(undefined, 5, 40)).toBe(undefined)
  })
})

describe('the moments', () => {
  const st = S([entry(BENCH, [set(80, 8, true), set(80, 8)])])
  test('off, or no workout running, says nothing', () => {
    bindCueState(() => ({ ...st, spokenCues: false }))
    cues.restStarted(0); cues.restOver(); cues.count(3); cues.restLeft('ten')
    bindCueState(() => ({ ...st, active: null }))
    cues.restOver()
    expect(speak).not.toHaveBeenCalled()
    expect(cuesOn({ spokenCues: true, active: {} })).toBe(true)
  })
  test('a paused workout says nothing at all', () => {
    const paused = { ...st, active: { ...st.active, pausedAt: 5 } }
    expect(cuesOn(paused)).toBe(false)
    bindCueState(() => paused)
    expect(cues.restStarted(0)).toBe(false)
    cues.restLeft('ten'); cues.restOver(); cues.count(2)
    expect(speak).not.toHaveBeenCalled()
    // …and resumed, it talks again.
    bindCueState(() => ({ ...st, active: { ...st.active, pauses: [[5, 9]] } }))
    expect(cues.restOver()).toBe(true)
    expect(speak).toHaveBeenCalledTimes(1)
  })
  test('pausing stops a line still being said, only for someone who has cues on', () => {
    bindCueState(() => ({ ...st, spokenCues: false }))
    cues.hush()
    expect(hush).not.toHaveBeenCalled()
    bindCueState(() => st)
    cues.hush()
    expect(hush).toHaveBeenCalledTimes(1)
  })
  test('a rest: the next set, 10 seconds, then over', () => {
    bindCueState(() => st)
    cues.restStarted(0)
    cues.restLeft(null); cues.restLeft('ten')
    cues.restOver()
    expect(speak.mock.calls.map(c => c[0])).toEqual(['Set 2, 80 kilos, 8 reps', '10 seconds', 'Rest is over'])
  })
  test('the end of a hold counts 3, 2, 1, each cutting off the one before', () => {
    bindCueState(() => ({ ...st, speechRate: 'fast' }))
    cues.count(4); cues.count(3); cues.count(2); cues.count(1); cues.count(0)
    expect(speak.mock.calls.map(c => c[0])).toEqual(['3', '2', '1'])
    expect(speak.mock.calls.every(c => c[1].queue === false && c[1].rate === 1.25)).toBe(true)
  })
  test('a hidden page says nothing', () => {
    bindCueState(() => st)
    const hidden = Object.getOwnPropertyDescriptor(globalThis, 'document')
    globalThis.document = { hidden: true }
    try { cues.restOver() } finally { if (hidden) Object.defineProperty(globalThis, 'document', hidden); else delete globalThis.document }
    expect(speak).not.toHaveBeenCalled()
  })
})
