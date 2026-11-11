import { describe, expect, test } from 'vitest'
import { strengthLevel, strengthLevels, ageCoefficient, thresholdsFor, levelAt, liftOf, ageOf } from './strength-level.js'
import { mergeStates, stampEdits } from './sync-merge.js'

const BENCH = '0025', DB_BENCH = '0289', CURL_X = '0001'
const wk = (d, id, w, r, extra = {}) => ({ id: d + id, d, start: new Date(d + 'T10:00:00').getTime(), entries: [{ id, target: { mode: 'reps' }, sets: [{ w, r, done: true }], ...extra }] })
const base = extra => ({ unit: 'kg', bodyweight: [{ d: '2026-10-01', w: 80 }], workouts: [], ...extra })

describe('strength level per lift', () => {
  test('a 100 kg bench at 80 kg body weight is Intermediate for a man, Advanced for a woman', () => {
    const S = base({ workouts: [wk('2026-10-02', BENCH, 100, 1)] })
    expect(strengthLevel(S, BENCH)).toMatchObject({ lift: 'bench', name: 'intermediate', ratio: 1.25, e1rm: 100, bw: 80, next: { name: 'advanced', ratio: 1.5, weight: 120 } })
    expect(strengthLevel({ ...S, sex: 'female' }, BENCH)).toMatchObject({ name: 'advanced', next: { name: 'elite', weight: 120 } })
  })
  test('elite has no next level, and below the first line is still Beginner', () => {
    expect(strengthLevel(base({ workouts: [wk('2026-10-02', BENCH, 170, 1)] }), BENCH)).toMatchObject({ name: 'elite', next: null })
    expect(strengthLevel(base({ workouts: [wk('2026-10-02', BENCH, 20, 1)] }), BENCH)).toMatchObject({ name: 'beginner', level: 0 })
  })
  test('no weigh-in, no estimate or no standard: no level', () => {
    expect(strengthLevel(base({ bodyweight: [], workouts: [wk('2026-10-02', BENCH, 100, 1)] }), BENCH)).toBe(null)
    expect(strengthLevel(base(), BENCH)).toBe(null)
    expect(liftOf(CURL_X)).toBe(null)
    expect(strengthLevel(base({ workouts: [wk('2026-10-02', CURL_X, 30, 5)] }), CURL_X)).toBe(null)
  })
  test('dumbbells are graded per bell, also when logged as the total of both', () => {
    const S = base({ workouts: [wk('2026-10-02', DB_BENCH, 60, 1, { target: { mode: 'reps', dbLoad: 'total' } })] })
    expect(strengthLevel(S, DB_BENCH)).toMatchObject({ e1rm: 30, perBell: true })
  })
  test('age from 40 eases the lines by the masters coefficients', () => {
    expect(ageCoefficient(30)).toBe(1)
    expect(ageCoefficient(60)).toBeCloseTo(1.3)
    expect(ageCoefficient(62.5)).toBeCloseTo(1.365)
    expect(ageCoefficient(95)).toBe(2.03)
    expect(thresholdsFor('bench', { age: 60 })[2]).toBeCloseTo(1 / 1.3, 3)
    expect(ageOf({ birthYear: 1966 }, 2026)).toBe(60)
    expect(ageOf({}, 2026)).toBe(null)
    const S = base({ birthYear: 1966, workouts: [wk('2026-10-02', BENCH, 100, 1)] })
    expect(strengthLevel(S, BENCH).name).toBe('advanced')
  })
  test('levelAt and the list of lifts', () => {
    expect(levelAt(1.0, [0.5, 0.75, 1, 1.5, 2])).toBe(2)
    expect(levelAt(0.1, [0.5, 0.75, 1, 1.5, 2])).toBe(0)
    const S = base({ workouts: [wk('2026-10-02', BENCH, 100, 1), wk('2026-10-03', '0043', 200, 1)] })
    expect(strengthLevels(S).map(l => [l.lift, l.name])).toEqual([['squat', 'advanced'], ['bench', 'intermediate']])
  })
})

// Gymly: About you (sex, year of birth) are plain settings, stamped on change (sync-merge.js
// stampEdits) and merged from the copy that changed them last, like any other setting.
describe('About you across devices', () => {
  const start = () => base({ _ts: 100, routines: [] })
  const change = (S, at, mut) => { const n = structuredClone(S); mut(n); n._ts = at; return stampEdits(S, n, at) }
  test('the sex set on one device and the year on the other both survive, whichever is newer', () => {
    const phone = change(start(), 400, s => { s.sex = 'female' })
    const desk = change(start(), 800, s => { s.birthYear = 1966 })
    for (const m of [mergeStates(phone, desk), mergeStates(desk, phone)]) {
      expect(m.sex).toBe('female')
      expect(m.birthYear).toBe(1966)
    }
  })
  test('clearing the year later wins over the copy that still has it', () => {
    const both = change(start(), 400, s => { s.birthYear = 1966 })
    const cleared = change(both, 900, s => { delete s.birthYear })
    for (const m of [mergeStates(both, cleared), mergeStates(cleared, both)]) expect(m.birthYear).toBeUndefined()
  })
})
