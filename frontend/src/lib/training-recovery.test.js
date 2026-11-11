import { describe, expect, it } from 'vitest'
import { sessionStats, plannedOn, dayRows, weeklyLoad, latestOf, trendOf, ouraCardio } from './training-recovery.js'

const TODAY = '2026-11-11'   // a Wednesday
const set = (w, r, rir, extra = {}) => ({ w, r, rir, done: true, ...extra })
const workout = (id, d, sets, extra = {}) => ({ id, d, name: 'Push', start: Date.parse(d + 'T17:00:00'), end: Date.parse(d + 'T18:00:00'), entries: [{ id: '0001', sets }], ...extra })
const S = (over = {}) => ({
  weekStart: 1,
  routines: [{ id: 'r-push', name: 'Push' }, { id: 'r-legs', name: 'Legs' }],
  week: { 1: 'r-push', 3: 'r-legs' },          // Monday push, Wednesday legs
  dayPlan: {},
  workouts: [],
  ...over,
})

describe('sessionStats', () => {
  it('counts working sets, hard sets (RIR ≤ 3), loaded volume and average RIR; warm-ups and undone sets are out', () => {
    const w = workout('w', TODAY, [set(100, 5, 2), set(100, 5, 1), set(80, 8, 4), set(60, 10, null, { warmup: true }), { w: 100, r: 5, rir: 0, done: false }])
    expect(sessionStats(w)).toEqual({ sets: 3, hardSets: 2, volume: 1640, timedSec: 0, avgRir: 2.3, rated: 3, durationMin: 60 })
  })
  it('takes RPE as RIR, ignores bodyweight load, and has no duration without times', () => {
    const w = { entries: [{ sets: [{ w: 0, r: 12, rpe: 8, done: true }, { sec: 60, done: true }] }] }
    expect(sessionStats(w)).toMatchObject({ sets: 2, hardSets: 1, volume: 0, timedSec: 60, avgRir: 2, durationMin: null })
  })
})

describe('plannedOn and dayRows', () => {
  it('reads the current schedule for each day, a dayPlan override winning', () => {
    const s = S({ dayPlan: { '2026-11-10': 'rest' } })
    expect(plannedOn(s, '2026-11-09', TODAY)).toEqual(['Push'])   // Monday
    expect(plannedOn(s, '2026-11-10', TODAY)).toEqual([])         // Tuesday: rest
    expect(plannedOn(s, TODAY, TODAY)).toEqual(['Legs'])
  })
  it('lines up planned, done and the Oura row per day, newest first', () => {
    const s = S({ workouts: [workout('w1', '2026-11-09', [set(100, 5, 2)])] })
    const rows = dayRows(s, [{ day: '2026-11-09', readiness: { score: 70 } }], { today: TODAY, count: 3 })
    expect(rows.map(r => r.day)).toEqual(['2026-11-11', '2026-11-10', '2026-11-09'])
    expect(rows[2]).toMatchObject({ planned: ['Push'], done: [{ id: 'w1', sets: 1, hardSets: 1 }], oura: { readiness: { score: 70 } } })
    expect(rows[0]).toMatchObject({ planned: ['Legs'], done: [], oura: null })
  })
})

describe('weeklyLoad', () => {
  it('sums sessions, sets, hard sets and volume per week, with Oura averages beside it', () => {
    const s = S({ workouts: [workout('a', '2026-11-09', [set(100, 5, 2), set(100, 5, 2)]), workout('b', '2026-11-11', [set(50, 10, 5)]), workout('c', '2026-11-03', [set(100, 5, 1)])] })
    const days = [{ day: '2026-11-10', readiness: { score: 80 }, sleep: { score: 70 } }, { day: '2026-11-09', readiness: { score: 60 } }]
    const [thisWeek, lastWeek] = weeklyLoad(s, days, { today: TODAY, weeks: 2 })
    expect(thisWeek).toMatchObject({ week: '2026-11-09', sessions: 2, sets: 3, hardSets: 2, volume: 1500, avgRir: 3.5, readiness: 70, sleep: 70, ouraDays: 2 })
    expect(lastWeek).toMatchObject({ week: '2026-11-02', sessions: 1, hardSets: 1, readiness: null })
  })
})

describe('latestOf and trendOf', () => {
  const days = Array.from({ length: 40 }, (_, i) => {
    const d = new Date(Date.parse(TODAY + 'T12:00:00Z') - i * 86400000).toISOString().slice(0, 10)
    return { day: d, sleep: { averageHrv: i < 7 ? 40 : 50, lowestHeartRate: i === 0 ? null : 50 } }
  })
  it('the newest reading with its own date, skipping a day without one', () => {
    expect(latestOf(days, d => d.sleep?.lowestHeartRate)).toEqual({ day: '2026-11-10', value: 50 })
    expect(latestOf([], d => d.x)).toBe(null)
  })
  it('recent week against the 30 days before it; missing days skipped, never zero', () => {
    const t = trendOf(days, d => d.sleep?.averageHrv, { today: TODAY })
    expect(t.recentAvg).toBe(40)
    expect(t.baselineAvg).toBe(50)
    expect(t.delta).toBe(-10)
    expect(t.recentN).toBe(7)
    expect(t.baselineN).toBe(30)
    expect(t.series[0].day < t.series.at(-1).day).toBe(true)
    expect(trendOf(days.slice(0, 2), d => d.sleep?.averageHrv, { today: TODAY }).recentAvg).toBe(null)
  })
})

it('ouraCardio keeps Oura-only activities that are not strength sessions', () => {
  const entries = [
    { kind: 'oura', oura: { activity: 'running' } }, { kind: 'oura', oura: { activity: 'strength_training' } },
    { kind: 'both', oura: { activity: 'running' } }, { kind: 'gymly' },
  ]
  expect(ouraCardio(entries).map(e => e.oura.activity)).toEqual(['running'])
})
