import { describe, expect, it } from 'vitest'
import { workoutTimeline, inWindow, scoreBand, fmtSleep, activityName, sessionsByDay, MATCH_SLACK_MS } from './oura-overview.js'

const T = Date.parse('2026-11-10T17:00:00+01:00')
const MIN = 60000
const gym = (id, start, dur = 60, d = '2026-11-10', extra = {}) => ({ id, d, start, end: start == null ? undefined : start + dur * MIN, name: 'Push', ...extra })
const oura = (id, start, dur = 55, day = '2026-11-10', activity = 'strength_training') => ({ id, day, activity, start, end: start == null ? null : start + dur * MIN })

describe('workoutTimeline', () => {
  it('shows a session the ring also detected once, as both', () => {
    const { entries, matched } = workoutTimeline([oura('o1', T + 8 * MIN)], [gym('g1', T)])
    expect(matched).toBe(1)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'both', gymly: { id: 'g1' }, oura: { id: 'o1' } })
  })

  it('keeps an Oura-only activity (a run) and a Gymly-only session apart', () => {
    const run = oura('o-run', T - 26 * 60 * MIN, 40, '2026-11-09', 'running')
    const { entries } = workoutTimeline([run], [gym('g1', T)])
    expect(entries.map(e => e.kind)).toEqual(['gymly', 'oura'])
  })

  it('matches within the slack only: a detection that starts 15 min after the session ends still counts, an hour later does not', () => {
    expect(workoutTimeline([oura('o', T + 75 * MIN, 30)], [gym('g', T)]).matched).toBe(1)
    expect(workoutTimeline([oura('o', T + 60 * MIN + MATCH_SLACK_MS * 2 + MIN, 30)], [gym('g', T)]).matched).toBe(0)
  })

  it('pairs one to one, by the best overlap, never one Oura workout to two sessions', () => {
    const { entries, matched } = workoutTimeline(
      [oura('o1', T, 60)],
      [gym('g-close', T + 5 * MIN), gym('g-far', T + 50 * MIN, 30)],
    )
    expect(matched).toBe(1)
    expect(entries.find(e => e.kind === 'both').gymly.id).toBe('g-close')
    expect(entries.filter(e => e.kind === 'gymly').map(e => e.gymly.id)).toEqual(['g-far'])
  })

  it('a Gymly session without times (an import) matches by day, and only a gym-like activity', () => {
    const imported = gym('g-imp', null)
    expect(workoutTimeline([oura('o', T)], [imported]).matched).toBe(1)
    expect(workoutTimeline([oura('o', T, 30, '2026-11-10', 'walking')], [imported]).matched).toBe(0)
    expect(workoutTimeline([oura('o', T, 30, '2026-11-09')], [imported]).matched).toBe(0)
  })

  it('is newest first, and survives empty or odd input', () => {
    const { entries } = workoutTimeline([oura('old', T - 3 * 86400000, 30, '2026-11-07', 'cycling')], [gym('new', T)])
    expect(entries.map(e => (e.gymly || e.oura).id)).toEqual(['new', 'old'])
    expect(workoutTimeline(null, undefined)).toEqual({ entries: [], matched: 0 })
    expect(workoutTimeline([{}], [{ id: 'x' }]).entries).toEqual([])
  })
})

describe('helpers', () => {
  it('inWindow keeps the Gymly sessions from the oldest overview day on', () => {
    const ws = [gym('a', T, 60, '2026-11-01'), gym('b', T, 60, '2026-11-08'), gym('c', T, 60, '2026-11-10')]
    expect(inWindow(ws, [{ day: '2026-11-10' }, { day: '2026-11-08' }]).map(w => w.id)).toEqual(['b', 'c'])
    expect(inWindow(ws, [])).toEqual([])
  })
  it('scoreBand follows Oura\'s bands', () => {
    expect([90, 85, 84, 70, 69, null].map(scoreBand)).toEqual(['optimal', 'optimal', 'good', 'good', 'attention', null])
  })
  it('formats sleep and activity names', () => {
    expect(fmtSleep(27000)).toBe('7h 30m')
    expect(fmtSleep(2700)).toBe('45m')
    expect(fmtSleep(null)).toBe('–')
    expect(activityName('strength_training')).toBe('Strength training')
  })
  it('counts Gymly sessions per day', () => {
    expect(sessionsByDay([gym('a', T), gym('b', T), gym('c', T, 60, '2026-11-09')])).toEqual({ '2026-11-10': 2, '2026-11-09': 1 })
  })
})
