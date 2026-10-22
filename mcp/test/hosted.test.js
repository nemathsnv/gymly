// The hosted entry (src/hosted.js): V1's tools answering for whichever profile the call names,
// the two read tools it adds, and the helpers the API's write side borrows. In the API this file
// runs bundled with hosted-state.js in place of state.js; here the same swap is made with a mock.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/state.js', async () => import('../src/hosted-state.js'))
const { READ_TOOLS, runReadTool, helpers, todayFor } = await import('../src/hosted.js')
const { withState } = await import('../src/hosted-state.js')

const today = todayFor({})
const daysAgo = n => helpers.addDays(today, -n)
const ONE = {
  unit: 'kg',
  routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 60 }] }],
  week: { 1: ['r1'] },
  workouts: [
    { id: 'w1', d: daysAgo(20), start: 1, end: 3600001, name: 'Push', routineIds: ['r1'], entries: [{ id: '0025', sets: [{ w: 60, r: 5, done: true }] }] },
    { id: 'w2', d: daysAgo(3), start: 2, end: 3600002, name: 'Push', routineIds: ['r1'], entries: [{ id: '0025', sets: [{ w: 65, r: 5, done: true }] }] }
  ],
  bodyweight: [{ d: daysAgo(20), w: 81 }, { d: daysAgo(2), w: 80 }],
  customEx: [{ id: 'cx1', n: 'my sled push', bp: 'upper legs' }]
}
const TWO = { unit: 'lb', routines: [{ id: 'rz', name: 'Other profile', ex: [] }], workouts: [] }

describe('hosted read tools', () => {
  it('are V1\'s tools plus search_exercises and get_training_progress', () => {
    const names = READ_TOOLS.map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_routines', 'get_routine', 'get_week_plan', 'list_workouts', 'get_workout', 'estimate_1rm', 'muscle_balance', 'get_bodyweight', 'preview_session', 'search_exercises', 'get_training_progress']))
  })

  it('answer for the profile of the call, one after another, never the previous one', () => {
    const a = runReadTool('list_routines', {}, ONE, { id: 'u1', name: 'One' })
    const b = runReadTool('list_routines', {}, TWO, { id: 'u2', name: 'Two' })
    expect(a.routines.map(r => r.name)).toEqual(['Push'])
    expect(b.routines.map(r => r.name)).toEqual(['Other profile'])
    expect(b.unit).toBe('lb')
    expect(runReadTool('list_routines', {}, null, { id: 'u3', name: 'New' }).error).toMatch(/no synced state/)
  })

  it('refuses an async handler and a nested call rather than leak a profile across them', () => {
    expect(() => withState(ONE, { id: 'u', name: 'U' }, async () => 1)).toThrow(/synchronous/)
    expect(() => withState(ONE, { id: 'u', name: 'U' }, () => withState(TWO, { id: 'v', name: 'V' }, () => 1))).toThrow(/re-entrant/)
    // And the profile is cleared afterwards either way.
    expect(() => runReadTool('list_routines', {}, TWO, { id: 'u2', name: 'Two' })).not.toThrow()
  })

  it('search_exercises finds library and custom exercises and says where they are used', () => {
    const r = runReadTool('search_exercises', { query: 'bench press', limit: 3 }, ONE, { id: 'u1', name: 'One' })
    expect(r.results[0]).toMatchObject({ id: '0025', name: 'barbell bench press', in_routines: [{ id: 'r1', name: 'Push' }] })
    const c = runReadTool('search_exercises', { query: 'sled push' }, ONE, { id: 'u1', name: 'One' })
    expect(c.results.some(x => x.id === 'cx1' && x.custom)).toBe(true)
  })

  it('get_training_progress reads the trend from the app\'s own 1RM and volume code', () => {
    const r = runReadTool('get_training_progress', { weeks: 6 }, ONE, { id: 'u1', name: 'One' })
    expect(r.totals.sessions).toBe(2)
    expect(r.per_week).toHaveLength(6)
    const bench = r.lifts.find(l => l.id === '0025')
    expect(bench.first.w).toBe(60)
    expect(bench.latest.w).toBe(65)
    expect(bench.change).toBeGreaterThan(0)
    expect(r.bodyweight.change).toBe(-1)
  })
})

describe('helpers for the write side', () => {
  it('name exercises, read prescriptions and know which routine a date holds', () => {
    expect(helpers.exerciseName('0025', ONE)).toBe('barbell bench press')
    expect(helpers.exerciseName('cx1', ONE)).toBe('my sled push')
    expect(helpers.exerciseName('nope', ONE)).toBe(null)
    expect(helpers.isKnownExercise('0025', ONE)).toBe(true)
    expect(helpers.isKnownExercise('nope', ONE)).toBe(false)
    expect(helpers.prescription({ id: '0025', sets: 4, reps: 8, weight: 60 }, 'kg')).toBe('4 × 8 · 60 kg')
    const nextMonday = [...Array(7)].map((_, i) => helpers.addDays(today, i)).find(d => new Date(d + 'T12:00:00').getDay() === 1)
    expect(helpers.routineIdsOn(ONE, nextMonday)).toEqual(['r1'])
  })

  it('today is the profile owner\'s date when the profile names a time zone', () => {
    const t = new Date('2026-10-22T23:30:00Z')
    expect(todayFor({ reminder: { tz: 'Pacific/Auckland' } }, t)).toBe('2026-10-23')
    expect(todayFor({ reminder: { tz: 'America/Los_Angeles' } }, t)).toBe('2026-10-22')
    expect(todayFor({ reminder: { tz: 'Not/AZone' } }, t)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
