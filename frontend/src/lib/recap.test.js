// Your week / Your month (lib/recap.js): which stretch is due on which day, what it counts, when the
// card shows, and the switch and the × across devices. Every date is a local calendar day, and the
// edges are pinned with the profile's week start: run it under any TZ (CI runs UTC; also try
// TZ=America/Los_Angeles, where a late Sunday workout is already Monday in UTC).
import { describe, expect, test } from 'vitest'
import { recapPeriod, recapOf, recapDue, recapOn, workoutsIn } from './recap.js'
import { mergeStates, stampEdits } from './sync-merge.js'

const BENCH = '0025', SQUAT = '0043'
// A workout on local day `d` at `hh:mm`, with `n` ticked work sets of 100 × 5.
const wk = (d, { n = 3, prs = [], id = BENCH, at = '10:00', vol, extra = {} } = {}) => {
  const start = new Date(`${d}T${at}:00`).getTime()
  return { id: 'w' + d + at, d, start, end: start + 3600000, prs, ...(vol != null ? { vol } : {}), entries: [{ id, target: { mode: 'reps' }, sets: Array.from({ length: n }, () => ({ w: 100, r: 5, done: true })) }], ...extra }
}
const S = extra => ({ unit: 'kg', weekStart: 1, bodyweight: [], workouts: [wk('2026-10-20'), wk('2026-10-22', { prs: [BENCH] }), wk('2026-09-15')], ...extra })

describe('which stretch is due', () => {
  test('the week’s first day looks back on last week, the 1st on last month, other days on nothing', () => {
    // 2026-10-26 is a Monday.
    expect(recapPeriod(S(), '2026-10-26')).toEqual({ kind: 'week', from: '2026-10-19', to: '2026-10-25', key: 'w:2026-10-19' })
    expect(recapPeriod(S(), '2026-10-01')).toEqual({ kind: 'month', from: '2026-09-01', to: '2026-09-30', key: 'm:2026-09' })
    expect(recapPeriod(S(), '2026-10-28')).toBe(null)
    expect(recapPeriod(S(), '2026-10-25')).toBe(null)   // a Sunday, the last day of a Monday week
  })
  test('a Sunday week start moves the week: Sunday to Saturday, due on the Sunday', () => {
    expect(recapPeriod(S({ weekStart: 0 }), '2026-10-25')).toEqual({ kind: 'week', from: '2026-10-18', to: '2026-10-24', key: 'w:2026-10-18' })
    expect(recapPeriod(S({ weekStart: 0 }), '2026-10-26')).toBe(null)
  })
  test('a 1st that is also the week’s first day shows the month', () => {
    // 2026-11-01 is a Sunday (and the night US clocks go back).
    expect(recapPeriod(S({ weekStart: 0 }), '2026-11-01')).toEqual({ kind: 'month', from: '2026-10-01', to: '2026-10-31', key: 'm:2026-10' })
    // 2027-03-01 is a Monday: February, 28 days.
    expect(recapPeriod(S(), '2027-03-01')).toEqual({ kind: 'month', from: '2027-02-01', to: '2027-02-28', key: 'm:2027-02' })
  })
  test('January looks back on December of the year before', () => {
    expect(recapPeriod(S(), '2027-01-01')).toEqual({ kind: 'month', from: '2026-12-01', to: '2026-12-31', key: 'm:2026-12' })
  })
  test('weeks across a clock change keep seven days', () => {
    // US clocks go back on Sun 1 Nov 2026, Europe's on Sun 25 Oct, US clocks go forward on Sun 8 Mar 2026.
    expect(recapPeriod(S(), '2026-11-02')).toMatchObject({ from: '2026-10-26', to: '2026-11-01' })
    expect(recapPeriod(S(), '2026-10-26')).toMatchObject({ from: '2026-10-19', to: '2026-10-25' })
    expect(recapPeriod(S(), '2026-03-09')).toMatchObject({ from: '2026-03-02', to: '2026-03-08' })
  })
})

describe('the edges of a week are local days', () => {
  test('late Sunday is in the week that ended, just after midnight Monday is not', () => {
    const st = S({ workouts: [wk('2026-10-19', { at: '00:15' }), wk('2026-10-25', { at: '23:30' }), wk('2026-10-26', { at: '00:30' })] })
    const p = recapPeriod(st, '2026-10-26')
    expect(workoutsIn(st, p).map(w => w.d)).toEqual(['2026-10-19', '2026-10-25'])
    expect(recapOf(st, p).workouts).toBe(2)
  })
  test('a workout with no day of its own is placed by its local start, not the UTC date', () => {
    // 23:30 on Sunday local time: in Los Angeles that is already Monday in UTC.
    const late = wk('2026-10-25', { at: '23:30' })
    delete late.d
    const st = S({ workouts: [late] })
    expect(recapOf(st, recapPeriod(st, '2026-10-26')).workouts).toBe(1)
    expect(recapDue(st, '2026-11-02')).toBe(null)
  })
  test('with a Sunday start, Saturday night is in and the Sunday it is due is not', () => {
    const st = S({ weekStart: 0, workouts: [wk('2026-10-18', { at: '06:00' }), wk('2026-10-24', { at: '23:45' }), wk('2026-10-25', { at: '07:00' })] })
    expect(workoutsIn(st, recapPeriod(st, '2026-10-25')).map(w => w.d)).toEqual(['2026-10-18', '2026-10-24'])
  })
  test('the month runs from the 1st to its last day', () => {
    const st = S({ workouts: [wk('2026-09-30', { at: '23:50' }), wk('2026-10-01', { at: '00:10' }), wk('2026-10-31', { at: '23:59' }), wk('2026-11-01', { at: '00:01' })] })
    expect(workoutsIn(st, recapPeriod(st, '2026-11-01')).map(w => w.d)).toEqual(['2026-10-01', '2026-10-31'])
  })
})

describe('what a recap counts', () => {
  test('workouts, volume, work sets, new bests, active days, time and the muscle that did the most', () => {
    const r = recapOf(S(), recapPeriod(S(), '2026-10-26'))
    expect(r).toMatchObject({ kind: 'week', from: '2026-10-19', to: '2026-10-25', workouts: 2, volume: 3000, sets: 6, prs: 1, days: 2, ms: 2 * 3600000 })
    expect(r.top).toEqual({ slug: 'chest', name: 'Chest', sets: 6 })
  })
  test('the volume a workout saved wins; one without it is counted from its sets, warm-ups left out', () => {
    const warm = wk('2026-10-21', { extra: {} })
    warm.entries[0].sets.unshift({ w: 40, r: 5, done: true, phase: 'warmup' })
    const st = S({ workouts: [wk('2026-10-20', { vol: 1234.5 }), warm] })
    const r = recapOf(st, recapPeriod(st, '2026-10-26'))
    expect(r.volume).toBe(1234.5 + 1500)
    expect(r.sets).toBe(6)
  })
  test('a lift counted twice in one workout is one new best, two days with two workouts are two days', () => {
    const st = S({ workouts: [wk('2026-10-20', { prs: [BENCH, BENCH] }), wk('2026-10-20', { at: '18:00', prs: [SQUAT], id: SQUAT }), wk('2026-10-23')] })
    const r = recapOf(st, recapPeriod(st, '2026-10-26'))
    expect(r).toMatchObject({ workouts: 3, prs: 2, days: 2 })
  })
  test('the top muscle is the weekly sets card’s count: legs beat chest on more sets, a tie in body order', () => {
    const st = S({ workouts: [wk('2026-10-20', { n: 2 }), wk('2026-10-22', { id: SQUAT, n: 5 })] })
    // The squat trains glutes and quads in full: five sets each, and the glutes come first.
    expect(recapOf(st, recapPeriod(st, '2026-10-26')).top).toEqual({ slug: 'gluteal', name: 'Glutes', sets: 5 })
  })
  test('the streak is the weeks in a row up to the week the recap is about', () => {
    const st = S({ workouts: [wk('2026-09-29'), wk('2026-10-06'), wk('2026-10-14'), wk('2026-10-20'), wk('2026-10-26')] })
    // Weeks of 28 Sep, 5, 12 and 19 Oct; the workout on the day it is due does not change it.
    expect(recapOf(st, recapPeriod(st, '2026-10-26')).streak).toBe(4)
    // A week off breaks it.
    const gap = S({ workouts: [wk('2026-09-29'), wk('2026-10-14'), wk('2026-10-20')] })
    expect(recapOf(gap, recapPeriod(gap, '2026-10-26')).streak).toBe(2)
    // A Sunday week puts Sunday 18 Oct in the same week as Saturday 24 Oct.
    const sun = S({ weekStart: 0, workouts: [wk('2026-10-11'), wk('2026-10-18')] })
    expect(recapOf(sun, recapPeriod(sun, '2026-10-25')).streak).toBe(2)
  })
  test('a stretch where no set reached a muscle has no top muscle', () => {
    const st = S({ workouts: [{ ...wk('2026-10-20'), entries: [] }] })
    expect(recapOf(st, recapPeriod(st, '2026-10-26')).top).toBe(null)
  })
})

describe('when the card shows', () => {
  test('due, off, put away, or a week without a workout', () => {
    expect(recapDue(S(), '2026-10-26')).toMatchObject({ key: 'w:2026-10-19', workouts: 2 })
    expect(recapDue(S({ recap: false }), '2026-10-26')).toBe(null)
    expect(recapDue(S({ recapSeen: 'w:2026-10-19' }), '2026-10-26')).toBe(null)
    expect(recapDue(S({ workouts: [] }), '2026-10-26')).toBe(null)
    expect(recapDue(S({ workouts: [wk('2026-10-12')] }), '2026-10-26')).toBe(null)   // only the week before
    expect(recapDue(S(), '2026-10-27')).toBe(null)   // the day after: gone, not carried over
  })
  test('putting one away leaves the next one alone', () => {
    const st = S({ recapSeen: 'w:2026-10-19', workouts: [wk('2026-10-20'), wk('2026-10-27')] })
    expect(recapDue(st, '2026-11-01')).toMatchObject({ kind: 'month', key: 'm:2026-10' })
    expect(recapDue(st, '2026-11-02')).toMatchObject({ kind: 'week', key: 'w:2026-10-26' })
  })
  test('on unless switched off', () => {
    expect(recapOn({})).toBe(true)
    expect(recapOn({ recap: true })).toBe(true)
    expect(recapOn({ recap: false })).toBe(false)
  })
})

// The × and the switch are plain settings, stamped on change (sync-merge.js stampEdits) and taken
// from the copy that changed them last, so a recap put away on the phone stays away on the desktop
// even when the desktop changed something else later.
describe('the × and the switch across devices', () => {
  const base = () => ({ _ts: 100, unit: 'kg', weekStart: 1, workouts: [wk('2026-10-20')], routines: [], bodyweight: [] })
  const change = (st, at, mut) => { const n = structuredClone(st); mut(n); n._ts = at; return stampEdits(st, n, at) }
  test('put away on the phone, a weigh-in goal set later on the desktop: put away on both', () => {
    const phone = change(base(), 400, s => { s.recapSeen = 'w:2026-10-19' })
    const desk = change(base(), 800, s => { s.targetW = 80 })
    for (const m of [mergeStates(phone, desk), mergeStates(desk, phone)]) {
      expect(m.recapSeen).toBe('w:2026-10-19')
      expect(m.targetW).toBe(80)
      expect(recapDue(m, '2026-10-26')).toBe(null)
    }
  })
  test('switched off on one device and on again later on the other: the later choice wins', () => {
    const off = change(base(), 400, s => { s.recap = false })
    const on = change(off, 900, s => { s.recap = true })
    for (const m of [mergeStates(off, on), mergeStates(on, off)]) expect(m.recap).toBe(true)
  })
})
