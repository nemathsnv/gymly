import { afterEach, describe, expect, test } from 'vitest'
import { mergeExercise, undoMerge, mergePreview, mergeBlocked, mergedInto, mergedAway, applyExerciseMerges, withExerciseMerges } from './exercise-merge.js'
import { mergeStates, stampChange } from './sync-merge.js'
import { allExercises, EXIDX, registerCustom, searchExercises } from './exercises.js'

const BENCH = '0025'   // barbell bench press (catalogue)
const SQUAT = '0043'   // barbell full squat (catalogue)
const STEPMILL = '2311' // walking on stepmill (catalogue, logs a machine level)
const CUSTOM = 'c_benchfn'
const clone = v => JSON.parse(JSON.stringify(v))
const custom = { id: CUSTOM, n: 'Bench Press (Barbell)', bp: 'chest', eq: 'barbell', custom: true, tg: 'pectorals', media: { hash: 'abc', kind: 'image' }, url: 'https://example.com/bench', _ts: 1 }
const wk = (id, d, exId, sets, extra = {}) => ({ id, d, start: new Date(d + 'T10:00:00').getTime(), name: 'Push', prs: [], entries: [{ id: exId, target: { mode: 'reps' }, sets, n: 'Bench Press (Barbell)', muscleSnapshot: { n: 'Bench Press (Barbell)', bp: 'chest' } }], ...extra })
const set = (w, r) => ({ w, r, done: true })

function state() {
  return {
    unit: 'kg',
    customEx: [clone(custom)],
    workouts: [
      wk('w1', '2026-09-01', CUSTOM, [set(70, 8), set(70, 8)], { prs: [CUSTOM] }),
      wk('w2', '2026-09-05', CUSTOM, [set(72.5, 8)]),
      wk('w3', '2026-09-09', BENCH, [set(75, 5)]),
      wk('w4', '2026-09-10', SQUAT, [set(100, 5)]),
    ],
    routines: [
      { id: 'r1', name: 'Push', ex: [{ id: CUSTOM, sets: 3, reps: 8, warmupRows: [{ pct: 50, r: 8 }], sg: 'a' }, { id: SQUAT, sets: 3, reps: 5, sg: 'a' }] },
      { id: 'r2', name: 'Legs', ex: [{ id: SQUAT, sets: 3, reps: 5 }] },
    ],
    exWeights: { [CUSTOM]: { w: 72.5 }, [BENCH]: { w: 75 } },
    exNotes: { [CUSTOM]: 'Seat 4', [BENCH]: 'Grip 81' },
    favEx: [CUSTOM, SQUAT],
    barWeights: { [CUSTOM]: 20 },
    loadKind: { [CUSTOM]: { kind: 'pairs', _ts: 5 } },
    dbLoad: {},
    exEquip: { [CUSTOM]: { step: { kg: 1.25 }, pulley: null, _ts: 5 } },
    stackWeights: { [CUSTOM]: { unit: 'kg', weights: [5, 11.3, 18.1], _ts: 5 } },
    balanceOverrides: { 'tpl:bench': { id: CUSTOM, _ts: 5 } },
    active: null,
  }
}

afterEach(() => registerCustom([]))

describe('merging an exercise into another (#656)', () => {
  test('the preview counts what moves', () => {
    expect(mergePreview(state(), CUSTOM, BENCH)).toMatchObject({ workouts: 2, sets: 3, routines: 1, note: true, custom: true, same: false })
    expect(mergePreview(state(), 'nothing', BENCH)).toMatchObject({ workouts: 0, sets: 0, routines: 0, note: false, custom: false })
  })

  test('all history, plans and settings move to the target, and the custom source is gone', () => {
    const S = state()
    registerCustom(S.customEx)
    mergeExercise(S, CUSTOM, BENCH, { now: 1000 })
    const ids = S.workouts.flatMap(w => w.entries.map(e => e.id))
    expect(ids).toEqual([BENCH, BENCH, BENCH, SQUAT])
    // the custom snapshot goes, the catalogue answers for a catalogue target
    expect(S.workouts[0].entries[0].muscleSnapshot).toBeUndefined()
    expect(S.workouts[0].entries[0].n).toBeUndefined()
    expect(S.workouts[0].entries[0].sets).toEqual([set(70, 8), set(70, 8)])
    expect(S.workouts[0].prs).toEqual([BENCH])
    // workouts it changed are stamped, the others are not
    expect(S.workouts[0]._ts).toBe(1000)
    expect(S.workouts[2]._ts).toBeUndefined()
    // the routine slot keeps its warm-ups and its superset
    expect(S.routines[0].ex[0]).toEqual({ id: BENCH, sets: 3, reps: 8, warmupRows: [{ pct: 50, r: 8 }], sg: 'a' })
    expect(S.routines[1]).toEqual(state().routines[1])
    // the better kept weight, both notes, the star
    expect(S.exWeights).toEqual({ [BENCH]: { w: 75 } })
    expect(S.exNotes).toEqual({ [BENCH]: 'Grip 81\nSeat 4' })
    expect(S.favEx).toEqual([BENCH, SQUAT])
    // per-exercise settings the target had none of, stamped as moved
    expect(S.barWeights).toEqual({ [BENCH]: 20 })
    expect(S.loadKind).toEqual({ [BENCH]: { kind: 'pairs', _ts: 1000 } })
    expect(S.exEquip).toEqual({ [BENCH]: { step: { kg: 1.25 }, pulley: null, _ts: 1000 } })
    expect(S.stackWeights).toEqual({ [BENCH]: { unit: 'kg', weights: [5, 11.3, 18.1], _ts: 1000 } })
    expect(S.balanceOverrides['tpl:bench']).toEqual({ id: BENCH, _ts: 1000 })
    expect(S.customEx).toEqual([])
    expect(S.exMerged[CUSTOM]).toEqual({ into: BENCH, n: 'Bench Press (Barbell)', _ts: 1000 })
    expect(mergedInto(S, CUSTOM)).toBe(BENCH)
    expect(mergedInto(S, BENCH)).toBe(BENCH)
  })

  test('the better kept weight wins, and a target keeps its own settings', () => {
    const S = state()
    S.exWeights[CUSTOM] = { w: 90 }
    S.barWeights[BENCH] = 15
    S.exEquip[BENCH] = { step: { kg: 2.5 }, pulley: null, _ts: 3 }
    mergeExercise(S, CUSTOM, BENCH, { now: 1000 })
    expect(S.exWeights[BENCH].w).toBe(90)
    expect(S.barWeights[BENCH]).toBe(15)
    expect(S.exEquip).toEqual({ [BENCH]: { step: { kg: 2.5 }, pulley: null, _ts: 3 } })
  })

  test('a weight stack (#688) moves unless the target has its own list; a cleared one takes it', () => {
    const own = state()
    own.stackWeights[BENCH] = { unit: 'kg', weights: [10, 20], _ts: 3 }
    mergeExercise(own, CUSTOM, BENCH, { now: 1000 })
    expect(own.stackWeights).toEqual({ [BENCH]: { unit: 'kg', weights: [10, 20], _ts: 3 } })
    const cleared = state()
    cleared.stackWeights[BENCH] = { _ts: 3 }
    mergeExercise(cleared, CUSTOM, BENCH, { now: 1000 })
    expect(cleared.stackWeights).toEqual({ [BENCH]: { unit: 'kg', weights: [5, 11.3, 18.1], _ts: 1000 } })
  })

  test('a stepmill keeps the machine level on every set it moves', () => {
    const S = state()
    S.customEx.push({ id: 'c_stairs', n: 'Gym stairmaster', bp: 'cardio', eq: '', custom: true })
    S.workouts.push({ id: 'w5', d: '2026-09-11', start: 5, name: 'Cardio', entries: [{ id: 'c_stairs', target: { mode: 'cardio' }, sets: [{ min: 10, speed: 0, level: 8, done: true }] }] })
    mergeExercise(S, 'c_stairs', STEPMILL, { now: 1000 })
    expect(S.workouts.at(-1).entries[0]).toMatchObject({ id: STEPMILL, sets: [{ min: 10, speed: 0, level: 8, done: true }] })
  })

  test('a catalogue source is hidden from the lists instead of removed, and its name finds the target', () => {
    const S = state()
    const squatName = EXIDX[SQUAT].n
    mergeExercise(S, SQUAT, BENCH, { now: 1000 })
    expect(S.exMerged[SQUAT]).toEqual({ into: BENCH, _ts: 1000 })
    const all = allExercises(S)
    expect(all.some(e => e.id === SQUAT)).toBe(false)
    expect(all.some(e => e.id === BENCH)).toBe(true)
    expect(searchExercises(all, squatName).map(e => e.id)).toContain(BENCH)
    expect([...mergedAway(S)]).toEqual([SQUAT])
    // undone, it is back in the lists and its name finds it again, not the bench press
    const T = state()
    const { undo } = mergeExercise(T, SQUAT, BENCH, { now: 1000 })
    undoMerge(T, undo, { now: 2000 })
    const back = allExercises(T)
    expect(back.some(e => e.id === SQUAT)).toBe(true)
    expect(searchExercises(back, squatName).map(e => e.id)).not.toContain(BENCH)
  })

  test('a custom source’s name finds the target after the source is gone', () => {
    const S = state()
    registerCustom(S.customEx)
    mergeExercise(S, CUSTOM, SQUAT, { now: 1000 })
    registerCustom(S.customEx)
    const found = searchExercises(allExercises(S), 'bench press (barbell)')
    expect(found.map(e => e.id)).toContain(SQUAT)
  })

  test('a custom target takes the source picture and link when it has none, and the history its name', () => {
    const S = state()
    S.customEx.push({ id: 'c_other', n: 'My bench', bp: 'chest', custom: true })
    registerCustom(S.customEx)
    mergeExercise(S, CUSTOM, 'c_other', { now: 1000 })
    expect(S.customEx).toEqual([expect.objectContaining({ id: 'c_other', media: custom.media, url: custom.url })])
    expect(S.workouts[0].entries[0]).toMatchObject({ id: 'c_other', n: 'My bench' })
    expect(S.workouts[0].entries[0].muscleSnapshot.n).toBe('My bench')
  })

  test('what cannot be merged', () => {
    const S = state()
    expect(mergeBlocked(S, CUSTOM, CUSTOM)).toBeTruthy()
    expect(mergeBlocked(S, CUSTOM, 'nope')).toBeTruthy()
    expect(mergeBlocked(S, CUSTOM, null)).toBeTruthy()
    expect(mergeBlocked({ ...S, active: { entries: [{ id: CUSTOM, sets: [] }] } }, CUSTOM, BENCH)).toBe('Finish your current workout first')
    expect(mergeBlocked(S, CUSTOM, BENCH)).toBe(null)
    expect(() => mergeExercise(S, CUSTOM, CUSTOM)).toThrow('Pick a different exercise.')
    // nothing goes into an exercise merged away, back into the source or anywhere else
    mergeExercise(S, SQUAT, BENCH, { now: 1 })
    expect(mergeBlocked(S, BENCH, SQUAT)).toBeTruthy()
    expect(mergeBlocked(S, CUSTOM, SQUAT)).toBeTruthy()
  })

  test('a merge of a merge follows through', () => {
    const S = state()
    registerCustom(S.customEx)
    mergeExercise(S, CUSTOM, SQUAT, { now: 1 })
    mergeExercise(S, SQUAT, BENCH, { now: 2 })
    expect(mergedInto(S, CUSTOM)).toBe(BENCH)
    expect(S.workouts.flatMap(w => w.entries.map(e => e.id))).toEqual([BENCH, BENCH, BENCH, BENCH])
  })

  test('Undo puts everything back and clears the record with a stamp', () => {
    const S = state()
    const was = clone(S)
    const { undo } = mergeExercise(S, CUSTOM, BENCH, { now: 1000 })
    undoMerge(S, undo, { now: 2000 })
    const { exMerged, workouts, loadKind, exEquip, stackWeights, balanceOverrides, ...rest } = S
    const { workouts: w0, loadKind: l0, exEquip: e0, stackWeights: s0, balanceOverrides: b0, ...rest0 } = was
    expect(rest).toEqual(rest0)
    // the stamped settings are back as they were, stamped again so a sync keeps them
    expect(loadKind).toEqual({ [CUSTOM]: { ...l0[CUSTOM], _ts: 2000 } })
    expect(exEquip).toEqual({ [CUSTOM]: { ...e0[CUSTOM], _ts: 2000 } })
    expect(stackWeights).toEqual({ [CUSTOM]: { ...s0[CUSTOM], _ts: 2000 } })
    expect(balanceOverrides).toEqual({ 'tpl:bench': { id: CUSTOM, _ts: 2000 } })
    expect(workouts.map(w => w.entries[0])).toEqual(w0.map(w => w.entries[0]))
    expect(workouts[0]._ts).toBe(2000)
    expect(workouts[2]._ts).toBeUndefined()
    expect(exMerged[CUSTOM]).toEqual({ into: null, _ts: 2000 })
    expect(mergedAway(S)).toBe(null)
  })
})

describe('a merge on one device, a workout on another', () => {
  test('the other copy’s workout against the source moves over when the copies meet', () => {
    const base = state()
    const phone = clone(base)
    const prev = clone(phone)
    mergeExercise(phone, CUSTOM, BENCH, { now: 5000 })
    stampChange(prev, phone, 5000)
    phone._ts = 5000
    // the tablet logged against the custom exercise before it heard of the merge
    const tablet = clone(base)
    tablet.workouts.push(wk('w9', '2026-09-12', CUSTOM, [set(80, 6)]))
    tablet._ts = 4000
    for (const merged of [mergeStates(phone, tablet), mergeStates(tablet, phone)]) {
      expect(merged.workouts.find(w => w.id === 'w9').entries[0].id).toBe(BENCH)
      expect(merged.workouts.flatMap(w => w.entries.map(e => e.id)).includes(CUSTOM)).toBe(false)
      expect(merged.routines.flatMap(r => r.ex.map(c => c.id)).includes(CUSTOM)).toBe(false)
      expect(merged.customEx.some(c => c.id === CUSTOM)).toBe(false)
      expect(merged.exMerged[CUSTOM].into).toBe(BENCH)
    }
  })

  test('an Undo on one device wins over the merge the other still holds', () => {
    const base = state()
    const phone = clone(base)
    let prev = clone(phone)
    const { undo } = mergeExercise(phone, CUSTOM, BENCH, { now: 5000 })
    stampChange(prev, phone, 5000)
    phone._ts = 5000
    const tablet = clone(phone)
    prev = clone(phone)
    undoMerge(phone, undo, { now: 6000 })
    stampChange(prev, phone, 6000)
    phone._ts = 6000
    // the tablet changed something else later, so its copy is the newer one as a whole
    tablet.restSec = 120
    tablet._ts = 7000
    for (const merged of [mergeStates(tablet, phone), mergeStates(phone, tablet)]) {
      expect(merged.exMerged[CUSTOM].into).toBe(null)
      expect(merged.customEx.some(c => c.id === CUSTOM)).toBe(true)
      expect(merged.workouts.find(w => w.id === 'w1').entries[0].id).toBe(CUSTOM)
      expect(merged.routines[0].ex[0].id).toBe(CUSTOM)
    }
  })

  test('applyExerciseMerges leaves a copy without merges alone', () => {
    const S = state()
    expect(applyExerciseMerges(S)).toBe(0)
    expect(S).toEqual(state())
    S.exMerged = { [CUSTOM]: { into: null, _ts: 1 } }
    expect(applyExerciseMerges(S)).toBe(0)
  })

  test('withExerciseMerges reads a copy in line without touching it', () => {
    const S = state()
    expect(withExerciseMerges(S)).toBe(S)
    S.exMerged = { [CUSTOM]: { into: BENCH, _ts: 1 } }
    const before = clone(S)
    const read = withExerciseMerges(S)
    expect(S).toEqual(before)
    expect(read.workouts[0].entries[0].id).toBe(BENCH)
    expect(read.routines[0].ex[0].id).toBe(BENCH)
    expect(read.customEx).toEqual([])
  })
})
