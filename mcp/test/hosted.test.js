// The hosted entry (src/hosted.js): V1's tools answering for whichever profile the call names,
// the two read tools it adds, and the helpers the API's write side borrows. In the API this file
// runs bundled with hosted-state.js in place of state.js; here the same swap is made with a mock.
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

vi.mock('../src/state.js', async () => import('../src/hosted-state.js'))
const { READ_TOOLS, runReadTool, helpers, todayFor, HABIT_TOOLS, runHabitTool, HABIT_LOG_MAX_DAYS, HABIT_LOG_DEFAULT_DAYS } = await import('../src/hosted.js')
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
  it('read an exercise merged into another in the app as the one it went into (#656)', () => {
    const doc = {
      ...ONE,
      workouts: [...ONE.workouts, { id: 'w3', d: daysAgo(1), start: 3, end: 3600003, name: 'Push', entries: [{ id: 'cx1', sets: [{ w: 70, r: 5, done: true }] }] }],
      exMerged: { cx1: { into: '0025', _ts: 5 } }
    }
    const before = JSON.stringify(doc)
    const out = runReadTool('get_workout', { workout_id: 'w3' }, doc, { id: 'u1', name: 'One' })
    expect(JSON.stringify(out)).toMatch(/bench press/i)
    expect(JSON.stringify(out)).not.toContain('my sled push')
    expect(JSON.stringify(doc)).toBe(before)
  })

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

describe('object keys are not exercises', () => {
  it('isKnownExercise and exerciseName refuse __proto__, constructor and friends', () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(helpers.isKnownExercise(id, ONE), id).toBe(false)
      expect(helpers.exerciseName(id, ONE), id).toBe(null)
    }
  })
})

// get_sleep: the Oura sleep the API holds in memory for the caller's profile, handed in per call.
describe('hosted get_sleep', () => {
  const TZ = 'Europe/Berlin'
  const S = { unit: 'kg', reminder: { on: false, time: '08:00', tz: TZ } }
  const tday = todayFor(S)
  const ago = n => helpers.addDays(tday, -n)
  // A night ending on day `d` (Berlin), in bed 23:05 the evening before.
  const night = (d, over = {}) => ({
    day: d,
    sleep: { totalSec: 27000, efficiency: 91, score: 85, averageHrv: 48, lowestHeartRate: 47, bedtimeStart: helpers.addDays(d, -1) + 'T23:05:00+01:00', bedtimeEnd: d + 'T07:10:00+01:00', type: 'long_sleep', ...over }
  })
  const snap = (nights, over = {}) => ({ configured: true, connected: true, lastSync: Date.parse('2026-11-24T06:00:00Z'), lastError: null, tz: TZ, nights, ...over })
  const run = (args, oura, doc = S, user = { id: 'u1', name: 'One' }) => runReadTool('get_sleep', args, doc, user, { oura })

  it('is a hosted read tool, not one of the stdio bridge\'s', async () => {
    expect(READ_TOOLS.map(t => t.name)).toContain('get_sleep')
    const { TOOLS } = await import('../src/tools.js')
    expect(TOOLS.map(t => t.name)).not.toContain('get_sleep')
  })

  it('defaults to the 7 days ending today: one entry per night with data, oldest first, and the latest', () => {
    const r = run({}, snap([night(ago(8)), night(ago(6)), night(ago(2), { totalSec: 25200, score: 78 }), night(tday)]))
    expect(r.from).toBe(ago(6))
    expect(r.to).toBe(tday)
    expect(r.days).toBe(7)
    expect(r.connected).toBe(true)
    expect(r.lastSync).toBe('2026-11-24T06:00:00.000Z')
    expect(r.nights.map(n => n.date)).toEqual([ago(6), ago(2), tday])
    expect(r.nights[1]).toEqual({
      date: ago(2), bedtimeStart: ago(3) + 'T23:05:00+01:00', bedtimeEnd: ago(2) + 'T07:10:00+01:00',
      totalSleepMin: 420, efficiency: 91, score: 78, averageHrv: 48, lowestHeartRate: 47
    })
    expect(r.latest.date).toBe(tday)
    expect(r.count).toBe(3)
    // Only these fields: nothing else Oura has is passed on.
    expect(Object.keys(r.nights[0]).sort()).toEqual(['averageHrv', 'bedtimeEnd', 'bedtimeStart', 'date', 'efficiency', 'lowestHeartRate', 'score', 'totalSleepMin'])
  })

  it('dates a night by the day it ended in the profile\'s zone; a night held without bedtimes keeps Oura\'s day', () => {
    // Woke 01:30 UTC: 02:30 or 03:30 in Berlin, still that day; New York puts it on the day before.
    const d = ago(3)
    const late = { day: ago(4), sleep: { totalSec: 14400, bedtimeStart: ago(4) + 'T21:30:00+00:00', bedtimeEnd: d + 'T01:30:00+00:00' } }
    expect(run({ from: ago(5), to: ago(3) }, snap([late])).nights.map(n => n.date)).toEqual([d])
    const ny = run({ from: ago(5), to: ago(3) }, snap([late], { tz: 'America/New_York' }), { unit: 'kg', reminder: { tz: 'America/New_York' } })
    expect(ny.nights.map(n => n.date)).toEqual([ago(4)])
    const old = run({ from: ago(5), to: ago(3) }, snap([{ day: ago(4), sleep: { totalSec: 26000, efficiency: 88, score: 80 } }]))
    expect(old.nights).toEqual([{ date: ago(4), bedtimeStart: null, bedtimeEnd: null, totalSleepMin: 433, efficiency: 88, score: 80, averageHrv: null, lowestHeartRate: null }])
  })

  it('without a reminder zone, uses the zone the Oura sync recorded: today and the night\'s date both', () => {
    const MKS = 'Asia/Makassar'                                   // UTC+8: 07:00 there is 23:00 UTC the day before
    const mToday = todayFor({ reminder: { tz: MKS } })
    const woke = { day: mToday, sleep: { totalSec: 25200, bedtimeStart: helpers.addDays(mToday, -1) + 'T23:00:00+08:00', bedtimeEnd: mToday + 'T07:00:00+08:00' } }
    const noReminder = { unit: 'kg', reminder: { on: false, time: '08:00', tz: null } }
    const r = run({}, snap([woke], { tz: MKS }), noReminder)
    expect([r.to, r.from, r.time_zone]).toEqual([mToday, helpers.addDays(mToday, -6), MKS])
    expect(r.nights.map(n => n.date)).toEqual([mToday])
    // No zone anywhere: the date the person woke on, from the timestamp's own offset, not UTC's.
    const bare = run({ from: helpers.addDays(mToday, -2), to: mToday }, snap([woke], { tz: null }), noReminder)
    expect(bare.time_zone).toBe(null)
    expect(bare.nights.map(n => n.date)).toEqual([mToday])
  })

  it('takes an explicit range up to 92 days and refuses more, or a reversed one', () => {
    const r = run({ from: ago(91), to: tday }, snap([night(ago(91)), night(ago(92))]))
    expect(r.days).toBe(92)
    expect(r.nights.map(n => n.date)).toEqual([ago(91)])
    expect(run({ from: ago(92), to: tday }, snap([])).error).toBe('invalid_range')
    expect(run({ from: tday, to: ago(1) }, snap([])).error).toBe('invalid_range')
    // `from` alone runs to today, however far back (up to 92 days).
    const f = run({ from: ago(2) }, snap([]))
    expect([f.from, f.to]).toEqual([ago(2), tday])
    const long = run({ from: ago(30) }, snap([night(ago(30)), night(ago(10)), night(tday)]))
    expect([long.from, long.to, long.days]).toEqual([ago(30), tday, 31])
    expect(long.nights.map(n => n.date)).toEqual([ago(30), ago(10), tday])
    expect(run({ from: ago(91) }, snap([])).days).toBe(92)
    expect(run({ from: ago(92) }, snap([])).error).toBe('invalid_range')
    // A `from` after today, with `to` left out, is a reversed range.
    expect(run({ from: helpers.addDays(tday, 1) }, snap([])).error).toBe('invalid_range')
  })

  it('says when Oura is not connected or not configured, and then lists nothing', () => {
    expect(run({}, null)).toMatchObject({ connected: false, lastSync: null, nights: [], latest: null })
    const gone = run({}, snap([night(tday)], { connected: false }))
    expect(gone.nights).toEqual([])
    expect(gone.note).toMatch(/not connected/)
    expect(run({}, { configured: false, connected: false, nights: [] }).note).toMatch(/not set up/)
    // A failed last sync still answers with the nights held, and says so.
    const stale = run({}, snap([night(tday)], { lastError: 'rate' }))
    expect(stale.nights).toHaveLength(1)
    expect(stale.note).toMatch(/last Oura sync failed/)
  })

  it('answers each call with its own profile\'s Oura data only, and none for a tool that is not get_sleep', () => {
    const a = run({}, snap([night(tday)]), S, { id: 'u1', name: 'One' })
    const b = run({}, snap([]), S, { id: 'u2', name: 'Two' })
    const c = run({}, null, S, { id: 'u3', name: 'Three' })
    expect(a.nights).toHaveLength(1)
    expect(b.nights).toEqual([])
    expect(c.nights).toEqual([])
    // The snapshot is never left behind for the next call.
    expect(() => withState(S, { id: 'u4', name: 'Four' }, () => 1)).not.toThrow()
    const after = runReadTool('get_sleep', {}, S, { id: 'u4', name: 'Four' })
    expect(after.connected).toBe(false)
    // A snapshot passed to another tool is not handed in.
    expect(() => runReadTool('list_routines', {}, ONE, { id: 'u1', name: 'One' }, { oura: snap([night(tday)]) })).not.toThrow()
  })
})

// The habit tools (gymly:habits:read on the hosted endpoint): the only way any of the habit log
// leaves the server. They copy named fields out of it; notes, zones, stamps and anything a later
// app adds stay behind.
describe('hosted habit tools', () => {
  const NOW = new Date('2026-10-10T12:00:00Z')
  const doc = {
    unit: 'kg', sex: 'female', birthYear: 1966,
    habitLog: {
      'alcohol|def': { name: 'Wine', future: 'DEF-FUTURE', _ts: 1 },
      'alcohol|2026-10-01': { s: 'drank', n: 2, note: 'NOTE-SENTINEL', tz: 'Europe/Lisbon', _ts: 5 },
      'alcohol|2026-10-02': { s: 'free', mood: 'DAY-FUTURE', tz: 'Europe/Lisbon', _ts: 6 },
      'alcohol|2026-10-03': { note: 'NOTE-ONLY-SENTINEL', tz: 'Europe/Lisbon', _ts: 7 },
      'alcohol|2026-10-04': { _ts: 8 },
      'hread|def': { name: 'Read', kind: 'do', icon: 'note', color: 'blue', at: Date.UTC(2026, 8, 1), _ts: 2 },
      'hread|2026-10-02': { s: 'good', note: 'NOTE-SENTINEL-2', tz: 'Europe/Lisbon', _ts: 9 },
      'hold|def': { name: 'Old one', kind: 'avoid', archived: true, at: 3, _ts: 3 },
      'hold|2026-10-01': { s: 'bad', n: 7, _ts: 4 },
      // a day of a habit whose definition was cleared: the app no longer shows it, nor do these tools
      'hgone|2026-10-01': { s: 'good', _ts: 4 },
      'junk': 'x', 'hread|not-a-day': { s: 'good' }
    }
  }
  const NEVER = /NOTE-|FUTURE|Europe\/Lisbon|"_ts":|"note":|"tz":|"mood":|hgone|female|1966/

  it('are list_habits and get_habit_log, with a bounded range', () => {
    expect(HABIT_TOOLS.map(t => t.name)).toEqual(['list_habits', 'get_habit_log'])
    expect(HABIT_LOG_MAX_DAYS).toBe(92)
    expect(HABIT_LOG_DEFAULT_DAYS).toBe(14)
  })

  it('list_habits names each habit with an explicit set of fields', () => {
    const out = runHabitTool('list_habits', {}, doc, NOW)
    expect(out.habits.map(h => [h.id, h.name, h.kind, h.archived])).toEqual([
      ['alcohol', 'Wine', 'avoid', false], ['hold', 'Old one', 'avoid', true], ['hread', 'Read', 'do', false]
    ])
    expect(out.habits[2]).toEqual({ id: 'hread', name: 'Read', builtin: false, kind: 'do', archived: false, answers: { good: 'good', bad: 'bad' }, counts: false, icon: 'note', color: 'blue', created: '2026-09-01' })
    expect(runHabitTool('list_habits', { include_archived: false }, doc, NOW).habits.map(h => h.id)).toEqual(['alcohol', 'hread'])
    expect(JSON.stringify(out)).not.toMatch(NEVER)
  })

  it('get_habit_log gives status and count per logged day, never a note, and a note-only or cleared day not at all', () => {
    const out = runHabitTool('get_habit_log', { from: '2026-09-30', to: '2026-10-05' }, doc, NOW)
    expect(out.entries).toEqual([
      { habit_id: 'alcohol', date: '2026-10-01', status: 'drank', result: 'bad', count: 2 },
      // a count on a habit that takes none is not one
      { habit_id: 'hold', date: '2026-10-01', status: 'bad', result: 'bad', count: null },
      { habit_id: 'alcohol', date: '2026-10-02', status: 'free', result: 'good', count: null },
      { habit_id: 'hread', date: '2026-10-02', status: 'good', result: 'good', count: null }
    ])
    expect(out.entries.every(e => Object.keys(e).join() === 'habit_id,date,status,result,count')).toBe(true)
    expect(JSON.stringify(out)).not.toMatch(NEVER)
    // The document it read from is left as it was.
    expect(doc.habitLog['alcohol|2026-10-01'].note).toBe('NOTE-SENTINEL')
  })

  it('bounds the range: 14 days ending today by default, at most 92, in order', () => {
    const def = runHabitTool('get_habit_log', {}, doc, NOW)
    // "today" is the profile's date, here the zone of the device that last wrote a day
    expect([def.from, def.to, def.days, def.today]).toEqual(['2026-09-27', '2026-10-10', 14, '2026-10-10'])
    expect(runHabitTool('get_habit_log', { from: '2026-10-01' }, doc, NOW)).toMatchObject({ from: '2026-10-01', to: '2026-10-10', days: 10 })
    expect(runHabitTool('get_habit_log', { to: '2026-10-02' }, doc, NOW)).toMatchObject({ from: '2026-09-19', to: '2026-10-02', days: 14 })
    expect(runHabitTool('get_habit_log', { from: '2026-07-02', to: '2026-10-01' }, doc, NOW).days).toBe(92)
    expect(runHabitTool('get_habit_log', { from: '2026-07-01', to: '2026-10-01' }, doc, NOW).error).toBe('invalid_range')
    expect(runHabitTool('get_habit_log', { from: '2026-10-05', to: '2026-10-01' }, doc, NOW).error).toBe('invalid_range')
    const schema = z.object(HABIT_TOOLS[1].schema)
    for (const bad of [{ from: '2026-02-30' }, { to: '2026-1-01' }, { from: 'yesterday' }]) expect(schema.safeParse(bad).success).toBe(false)
  })

  it('habit_id narrows to one habit, and an id that is not one of this profile\'s is not found', () => {
    expect(runHabitTool('get_habit_log', { from: '2026-10-01', to: '2026-10-02', habit_id: 'hread' }, doc, NOW).entries.map(e => e.habit_id)).toEqual(['hread'])
    for (const id of ['hgone', 'nope', '__proto__', 'hread|def']) expect(runHabitTool('get_habit_log', { habit_id: id }, doc, NOW).error).toBe('not_found')
  })

  it('a profile without a log has Alcohol and no days; one never synced reads the same', () => {
    for (const S of [{ unit: 'kg' }, null]) {
      expect(runHabitTool('list_habits', {}, S, NOW).habits.map(h => h.name)).toEqual(['Alcohol'])
      expect(runHabitTool('get_habit_log', {}, S, NOW).entries).toEqual([])
    }
  })

  it('every other read tool still never sees the log', () => {
    const out = runReadTool('list_routines', {}, doc, { id: 'u1', name: 'One' })
    expect(JSON.stringify(out)).not.toMatch(/Wine|hread|NOTE-/)
  })
})
