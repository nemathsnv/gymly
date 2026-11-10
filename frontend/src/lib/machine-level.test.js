// A stepmill's console level per cardio set (lib/machine-level.js): logged as a level with no
// unit, never as km/h, segment by segment, and read back everywhere a cardio set is read.
import { describe, it, expect } from 'vitest'
import { LEVEL_MAX, clampLevel, levelFits, hasLevel, levelFrom } from './machine-level.js'
import { EXIDX } from './exercises.js'
import { setLabel, buildSets, insertWarmupRow, copyRowAt, exLine } from './history.js'
import { bestSetFor } from './exercise-history.js'
import { workoutText } from './workout-text.js'
import { finishCardio } from './finish-compare.js'

const STEPMILL = '2311'       // walking on stepmill
const STEPPER = '0938'        // lever stepper
const STAIRS = '3009'         // stair up (real stairs, body weight)
const TREADMILL = '2259'      // walking on treadmill
const ELLIPTICAL = '2192'     // elliptical machine walk
const BIKE = '2138'           // stationary bike run v. 3

const history = sets => ({ exWeights: {}, workouts: [{ id: 'w1', d: '2026-10-01', start: 0, end: 1, entries: [{ id: STEPMILL, target: { sets: sets.length, min: 5 }, sets }] }] })

describe('levelFits', () => {
  it('is the stepmill and the stair machines of the catalogue', () => {
    for (const id of [STEPMILL, STEPPER]) expect(levelFits(EXIDX[id]), EXIDX[id].n).toBe(true)
  })
  it('not real stairs, a treadmill, an elliptical or a bike, which keep their speed', () => {
    for (const id of [STAIRS, TREADMILL, ELLIPTICAL, BIKE]) expect(levelFits(EXIDX[id]), EXIDX[id].n).toBe(false)
  })
  it('on your own exercise when its name says it is a stair machine', () => {
    expect(levelFits({ id: 'c1', n: 'StairMaster', bp: 'cardio', custom: true })).toBe(true)
    expect(levelFits({ id: 'c2', n: 'Stair climber', bp: 'cardio', custom: true })).toBe(true)
    expect(levelFits({ id: 'c3', n: 'Laufband', bp: 'cardio', custom: true })).toBe(false)
    expect(levelFits(null)).toBe(false)
  })
})

describe('clampLevel', () => {
  it('keeps a whole level from 1 up to the cap', () => {
    expect(clampLevel(5)).toBe(5)
    expect(clampLevel('8')).toBe(8)
    expect(clampLevel(7.6)).toBe(8)
    expect(clampLevel(99)).toBe(LEVEL_MAX)
  })
  it('leaves nothing, 0 and junk as nothing, so a cleared field drops the key', () => {
    for (const v of [null, undefined, '', 0, -3, 'hard', NaN]) expect(clampLevel(v)).toBe(null)
  })
  it('knows which sets carry one and what a new row takes over', () => {
    expect(hasLevel({ level: 5 })).toBe(true)
    expect(hasLevel({ level: 0 })).toBe(false)
    expect(hasLevel({ speed: 8 })).toBe(false)
    expect(hasLevel(null)).toBe(false)
    expect(levelFrom({ level: 8 })).toEqual({ level: 8 })
    expect(levelFrom({ speed: 8 })).toEqual({})
    expect(levelFrom(null)).toEqual({})
  })
})

describe('a stepmill set with a level', () => {
  it('reads as minutes and a level, with no speed made up', () => {
    expect(setLabel(STEPMILL, { min: 5, speed: 0, level: 5, done: true })).toBe('5 min · Level 5')
    expect(setLabel(STEPMILL, { min: 5, speed: 0 })).toBe('5 min')
    // A level is a level in mph profiles too.
    expect(setLabel(STEPMILL, { min: 5, speed: 0, level: 8 }, null, 'mph')).toBe('5 min · Level 8')
  })

  it('leaves every set logged before it reading exactly as it did', () => {
    // An older stepmill set logged a speed, typed or seeded: it is history and reads as logged.
    expect(setLabel(STEPMILL, { min: 20, speed: 8, done: true })).toBe('20 min @ 8 km/h')
    expect(setLabel(TREADMILL, { min: 30, speed: 5.5, incline: 12 })).toBe('30 min @ 5.5 km/h · 12% incline')
    expect(setLabel(TREADMILL, { min: 30, speed: 0 })).toBe('30 min @ 0 km/h')
  })

  it('logs two segments at different levels as two sets, each read back on its own', () => {
    const sets = [{ min: 5, speed: 0, level: 5, done: true }, { min: 5, speed: 0, level: 8, done: true }]
    const w = { id: 'w', d: '2026-11-10', start: 0, end: 10 * 60000, name: 'Lower Body A', vol: 0,
      entries: [{ id: STEPMILL, target: { sets: 1, min: 5, speed: 8 }, sets }] }
    expect(workoutText(w, { unit: 'kg', nameOf: () => 'Walking on stepmill' })).toContain('5 min · Level 5')
    expect(workoutText(w, { unit: 'kg', nameOf: () => 'Walking on stepmill' })).toContain('5 min · Level 8')
    const rows = finishCardio(w)
    expect(rows[0].sets.map(s => setLabel(rows[0].id, s, rows[0].target))).toEqual(['5 min · Level 5', '5 min · Level 8'])
  })

  it('opens the next session at last time’s levels and no speed, not a default 8 km/h', () => {
    const cfg = { id: STEPMILL, sets: 2, min: 5, speed: 8 }
    expect(buildSets(history([{ min: 5, speed: 0, level: 5, done: true }, { min: 5, speed: 0, level: 8, done: true }]), cfg)).toEqual([
      { min: 5, speed: 0, level: 5, done: false },
      { min: 5, speed: 0, level: 8, done: false },
    ])
    // A first session, or one after sets logged with a speed, starts with no level and no speed.
    expect(buildSets({ exWeights: {}, workouts: [] }, cfg)).toEqual([
      { min: 5, speed: 0, done: false },
      { min: 5, speed: 0, done: false },
    ])
    expect(buildSets(history([{ min: 20, speed: 8, done: true }]), { ...cfg, sets: 1 })).toEqual([{ min: 20, speed: 0, done: false }])
  })

  it('leaves a treadmill’s rows as they were', () => {
    const cfg = { id: TREADMILL, sets: 1, min: 20, speed: 8 }
    expect(buildSets({ exWeights: {}, workouts: [] }, cfg)).toEqual([{ min: 20, speed: 8, done: false }])
  })

  it('comes along on a warm-up added in front of it and on a copied row', () => {
    const rows = insertWarmupRow([{ min: 5, speed: 0, level: 6, done: false }], 'cardio', { min: 5 })
    expect(rows[0]).toMatchObject({ min: 5, speed: 0, level: 6, phase: 'warmup' })
    expect(copyRowAt([{ min: 5, speed: 0, level: 6, done: true }], 0)[1]).toEqual({ min: 5, speed: 0, level: 6, done: false })
  })

  it('plans a stepmill as intervals of minutes, without a speed', () => {
    expect(exLine({ id: STEPMILL, sets: 2, min: 5, speed: 8 }, 'kg')).toBe('2 × 5 min')
    expect(exLine({ id: TREADMILL, sets: 1, min: 20, speed: 8 }, 'kg')).toBe('1 × 20 min @ 8 km/h')
  })

  it('ranks the best stepmill set by minutes, then by level', () => {
    const S = { exWeights: {}, workouts: [
      { id: 'a', d: '2026-10-01', entries: [{ id: STEPMILL, target: { mode: 'cardio' }, sets: [{ min: 5, speed: 0, level: 5, done: true }] }] },
      { id: 'b', d: '2026-10-08', entries: [{ id: STEPMILL, target: { mode: 'cardio' }, sets: [{ min: 5, speed: 0, level: 8, done: true }] }] },
    ] }
    expect(bestSetFor(S, STEPMILL, 'cardio').set.level).toBe(8)
  })
})
