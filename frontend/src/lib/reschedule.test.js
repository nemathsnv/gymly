import { describe, expect, it } from 'vitest'
import {
  missedWorkouts, planReschedule, planAssignments, applyReschedule, answerMissed, readMissed, withMissed,
  missedAnswerOf, resolvedOff, scheduleDay, weeklyOn, recoveryWarnings, planChanges, weekEndOf, addDays
} from './reschedule.js'
import { effectiveRoutineIds, effectiveRoutine } from './history.js'
import { nudgeFor } from './nudge.js'
import { mergeStates, STAMPED_MAPS } from './sync-merge.js'
import * as Server from '../../../api/sync-stamps.js'
import { nudgeFor as serverNudgeFor } from '../../../api/nudge.js'

// An upper/lower split with conditioning on Wednesday and Saturday and Sunday off — the shape the
// feature was asked for with (Mon Upper A, Tue Lower A, Wed Cardio + Core, Thu Upper B,
// Fri Lower B, Sat Cardio + Core, Sun rest), with real catalogue exercises so the recovery check
// has muscles to read.
const R = {
  UA: { id: 'ua', name: 'Upper Body A', ex: ['3666', '0314', '0198', '0861', '0334', '11254', '0200', '0294', '9819'].map((id, i) => ({ id, sets: i ? 3 : 1 })) },
  LA: { id: 'la', name: 'Lower Body A', ex: ['3666', '0739', '0586', '0585', '1391', '9819', '0463'].map((id, i) => ({ id, sets: i ? 3 : 1 })) },
  CC: { id: 'cc', name: 'Cardio + Core', ex: ['3666', '1452', '9819', '0463'].map((id, i) => ({ id, sets: i ? 2 : 1 })) },
  UB: { id: 'ub', name: 'Upper Body B', ex: ['3666', '0198', '0861', '0314', '0334', '0383', '0200', '0294'].map((id, i) => ({ id, sets: i ? 3 : 1 })) },
  LB: { id: 'lb', name: 'Lower Body B', ex: ['3666', '0739', '0586', '0585', '1391', '0463'].map((id, i) => ({ id, sets: i ? 3 : 1 })) },
}
const WEEK = { 1: ['ua'], 2: ['la'], 3: ['cc'], 4: ['ub'], 5: ['lb'], 6: ['cc'] }
const wk = (d, id, extra = {}) => ({ id: 'w-' + d, d, name: Object.values(R).find(r => r.id === id).name, routineId: id, routineIds: [id], start: Date.parse(d + 'T08:00:00'), entries: [], ...extra })

// Tuesday 17 November 2026: Cardio + Core done on Saturday 14, Sunday 15 had Lower Body B pinned
// on it (a make-up that never happened), Monday 16's Upper Body A missed.
const base = (over = {}) => ({
  routines: Object.values(R).map(r => structuredClone(r)),
  week: structuredClone(WEEK),
  dayPlan: { '2026-11-13': 'rest', '2026-11-15': 'lb' },
  workouts: [wk('2026-11-10', 'la'), wk('2026-11-11', 'cc'), wk('2026-11-12', 'ub'), wk('2026-11-14', 'cc')],
  weekStart: 1,
  scheduleMode: 'week',
  queue: null, rotation: null,
  ...over,
})
const TODAY = '2026-11-17'
const names = (S, from, to) => {
  const out = {}
  for (let d = from; d <= to; d = addDays(d, 1)) out[d] = effectiveRoutine(S, d)?.name || 'Rest'
  return out
}

describe('missed-workout detection', () => {
  it('finds the scheduled days since the last workout that have no workout, oldest first', () => {
    expect(missedWorkouts(base(), TODAY)).toEqual([
      { iso: '2026-11-15', ids: ['lb'] },
      { iso: '2026-11-16', ids: ['ua'] },
    ])
  })
  it('never counts today, a rest day, a completed day or a day before the last workout', () => {
    const S = base({ workouts: [...base().workouts, wk('2026-11-16', 'ua')] })
    expect(missedWorkouts(S, TODAY)).toEqual([])
    // 13 Nov was a rest override, 12 Nov was trained: neither is missed even with a wider window.
    expect(missedWorkouts(base(), TODAY, { lookback: 7 }).map(m => m.iso)).not.toContain('2026-11-13')
  })
  it('a day with a note or an answer is not asked about again', () => {
    const S = base({ dayNotes: { '2026-11-15': { tag: 'sick', _ts: 1 } }, missedDays: { '2026-11-16': { act: 'kept', _ts: 1 } } })
    expect(missedWorkouts(S, TODAY)).toEqual([])
  })
  it('a floating rotation carries a missed session itself: nothing to ask', () => {
    const S = base({ queue: { ids: ['ua', 'la'], since: 0, startsOn: '2026-11-01', label: '', rotationId: 'r1' }, rotation: { id: 'r1', sequence: ['ua', 'la'], label: '' } })
    expect(missedWorkouts(S, TODAY)).toEqual([])
  })
  it('several missed days in a row are all reported', () => {
    const S = base({ dayPlan: {} })
    expect(missedWorkouts(S, '2026-11-19').map(m => m.iso)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18'])
  })
})

describe('planReschedule: moving a missed session forward', () => {
  it('reproduces the requested week: Upper A today, the rest shifted, Sunday kept as rest', () => {
    const S = base()
    const p = planReschedule(S, { missed: ['2026-11-16'], today: TODAY })
    expect(p.ok).toBe(true)
    expect(p.from).toBe('2026-11-17')
    expect(p.until).toBe('2026-11-22')
    expect(p.writes).toEqual({
      '2026-11-17': 'ua', '2026-11-18': 'la', '2026-11-19': 'cc', '2026-11-20': 'ub', '2026-11-21': 'lb',
    })
    expect(p.resolutions).toEqual({ '2026-11-16': { act: 'moved', to: '2026-11-17' } })
    // Saturday's Cardio + Core no longer fits before the week turns over: listed, not lost.
    expect(p.dropped).toEqual([{ routine_id: 'cc', planned_on: '2026-11-21', missed: false }])
    expect(p.warnings.some(w => w.type === 'dropped' && w.routine_id === 'cc')).toBe(true)

    applyReschedule(S, p, 1000)
    expect(names(S, '2026-11-17', '2026-11-24')).toEqual({
      '2026-11-17': 'Upper Body A', '2026-11-18': 'Lower Body A', '2026-11-19': 'Cardio + Core',
      '2026-11-20': 'Upper Body B', '2026-11-21': 'Lower Body B', '2026-11-22': 'Rest',
      // Monday 23 is the regular week again.
      '2026-11-23': 'Upper Body A', '2026-11-24': 'Lower Body A',
    })
    expect(S.week).toEqual(WEEK)
    expect(missedAnswerOf(S, '2026-11-16')).toEqual({ act: 'moved', to: '2026-11-17' })
  })

  it('never touches the weekly plan, completed workouts or routines', () => {
    const S = base()
    const before = structuredClone({ week: S.week, workouts: S.workouts, routines: S.routines })
    applyReschedule(S, planReschedule(S, { missed: ['2026-11-16'], today: TODAY }))
    expect({ week: S.week, workouts: S.workouts, routines: S.routines }).toEqual(before)
  })

  it('a day already trained is kept as it is, and what it trained is not scheduled again', () => {
    // Trained Lower A this morning instead: Upper A goes to tomorrow, Lower A is not repeated.
    const S = base({ workouts: [...base().workouts, wk(TODAY, 'la')] })
    const p = planReschedule(S, { missed: ['2026-11-16'], today: TODAY })
    expect(p.from).toBe('2026-11-18')
    expect(p.writes['2026-11-17']).toBeUndefined()
    expect(p.days.find(d => d.date === TODAY)).toBeUndefined()
    applyReschedule(S, p)
    expect(names(S, '2026-11-18', '2026-11-22')).toEqual({
      '2026-11-18': 'Upper Body A', '2026-11-19': 'Cardio + Core', '2026-11-20': 'Upper Body B', '2026-11-21': 'Lower Body B', '2026-11-22': 'Rest',
    })
  })

  it('a completed day inside the span stays fixed; the shift flows around it', () => {
    // Cardio + Core already done on Thursday 19 (planned there: Upper B), logged ahead of time.
    const S = base({ workouts: [...base().workouts, wk('2026-11-19', 'cc')] })
    const p = planReschedule(S, { missed: ['2026-11-16'], from: TODAY, today: TODAY })
    expect(p.writes['2026-11-19']).toBeUndefined()
    expect(p.days.find(d => d.date === '2026-11-19').fixed).toBe(true)
    applyReschedule(S, p)
    // Cardio + Core, done on the 19th, is not owed again: the shift picks up with Upper B after it.
    expect(names(S, TODAY, '2026-11-22')).toEqual({
      '2026-11-17': 'Upper Body A', '2026-11-18': 'Lower Body A', '2026-11-19': 'Upper Body B',
      '2026-11-20': 'Upper Body B', '2026-11-21': 'Lower Body B', '2026-11-22': 'Rest',
    })
    expect(S.dayPlan['2026-11-19']).toBeUndefined()
    expect(S.workouts.filter(w => w.d === '2026-11-19')).toHaveLength(1)
  })

  it('a missed session made up on a later day is not scheduled again', () => {
    // Friday 13's Lower Body B was missed and done on Saturday 14 instead.
    const S = base({ dayPlan: {}, workouts: [...base().workouts.slice(0, 3), wk('2026-11-14', 'lb')] })
    const p = planReschedule(S, { missed: ['2026-11-13'], from: '2026-11-15', until: '2026-11-17', today: '2026-11-15' })
    expect(p.ok).toBe(true)
    expect(p.alreadyDone).toEqual([{ routine_id: 'lb', missed_on: '2026-11-13', done_on: '2026-11-14' }])
    expect(p.writes).toEqual({})
    expect(p.dropped).toEqual([])
  })

  it('several missed days keep their order and push the week by as many days', () => {
    const S = base({ dayPlan: {} })
    const p = planReschedule(S, { missed: ['2026-11-16', '2026-11-17'], today: '2026-11-18' })
    applyReschedule(S, p)
    expect(names(S, '2026-11-18', '2026-11-22')).toEqual({
      '2026-11-18': 'Upper Body A', '2026-11-19': 'Lower Body A', '2026-11-20': 'Cardio + Core', '2026-11-21': 'Upper Body B', '2026-11-22': 'Rest',
    })
    expect(p.dropped.map(d => d.routine_id)).toEqual(['lb', 'cc'])
    expect(p.resolutions).toEqual({ '2026-11-16': { act: 'moved', to: '2026-11-18' }, '2026-11-17': { act: 'moved', to: '2026-11-19' } })
  })

  it('rest days are kept by default; fillRest lets a catch-up session take one', () => {
    const S = base({ dayPlan: {} })
    const kept = planReschedule(S, { missed: ['2026-11-21'], from: '2026-11-22', today: '2026-11-22' })
    // Sunday is the only day left in that week and it is a rest day: the session cannot fit.
    expect(kept.writes).toEqual({})
    expect(kept.dropped).toEqual([{ routine_id: 'cc', planned_on: '2026-11-21', missed: true }])
    expect(kept.resolutions).toEqual({})
    const filled = planReschedule(S, { missed: ['2026-11-21'], from: '2026-11-22', today: '2026-11-22', fillRest: true })
    expect(filled.writes).toEqual({ '2026-11-22': 'cc' })
    expect(filled.resolutions).toEqual({ '2026-11-21': { act: 'moved', to: '2026-11-22' } })
  })

  it('a longer span runs into the next week and lands everything', () => {
    const S = base({ dayPlan: {} })
    const p = planReschedule(S, { missed: ['2026-11-16'], until: '2026-11-29', today: TODAY })
    expect(p.dropped).toEqual([{ routine_id: 'cc', planned_on: '2026-11-28', missed: false }])
    applyReschedule(S, p)
    expect(effectiveRoutine(S, '2026-11-23').name).toBe('Cardio + Core')
  })

  it('refuses the past, a completed day, a rest day and a span too long', () => {
    const S = base()
    expect(planReschedule(S, { missed: ['2026-11-16'], from: '2026-11-16', today: TODAY }).ok).toBe(false)
    expect(planReschedule(S, { missed: ['2026-11-14'], today: TODAY }).errors.join()).toMatch(/already has a workout/)
    expect(planReschedule(S, { missed: ['2026-11-13'], today: TODAY }).errors.join()).toMatch(/nothing was planned/)
    expect(planReschedule(S, { missed: ['2026-11-16'], until: '2027-01-30', today: TODAY }).ok).toBe(false)
    expect(planReschedule(S, { missed: [], today: TODAY }).ok).toBe(false)
  })

  it('refuses a combined day rather than silently dropping one of its routines', () => {
    const S = base({ week: { ...WEEK, 1: ['ua', 'cc'] } })
    const p = planReschedule(S, { missed: ['2026-11-16'], today: TODAY })
    expect(p.ok).toBe(false)
    expect(p.errors.join()).toMatch(/combines/)
  })

  it('defaults to every detected missed day', () => {
    const p = planReschedule(base(), { today: TODAY })
    expect(p.missed.map(m => m.iso)).toEqual(['2026-11-15', '2026-11-16'])
    expect(p.writes['2026-11-17']).toBe('lb')
  })

  it('drops an override the weekly plan now matches instead of writing a redundant one', () => {
    const S = base({ dayPlan: { '2026-11-17': 'cc' } })
    const p = planAssignments(S, [{ date: '2026-11-17', routine_id: 'la' }], { today: TODAY })
    expect(p.writes).toEqual({ '2026-11-17': null })
    applyReschedule(S, p)
    expect(S.dayPlan['2026-11-17']).toBeUndefined()
    expect(effectiveRoutine(S, TODAY).name).toBe('Lower Body A')
  })
})

describe('timezone and calendar boundaries', () => {
  it('works from the date strings alone, across a month end and a DST change', () => {
    const S = base({ dayPlan: {}, workouts: [] })
    const p = planReschedule(S, { missed: ['2026-10-26'], from: '2026-10-27', until: '2026-11-01', today: '2026-10-27' })
    expect(p.writes).toEqual({ '2026-10-27': 'ua', '2026-10-28': 'la', '2026-10-29': 'cc', '2026-10-30': 'ub', '2026-10-31': 'lb' })
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30')
  })
  it('the week ends on Sunday for a Monday start and on Saturday for a Sunday start', () => {
    expect(weekEndOf({ weekStart: 1 }, '2026-11-17')).toBe('2026-11-22')
    expect(weekEndOf({ weekStart: 0 }, '2026-11-17')).toBe('2026-11-21')
    expect(weekEndOf({ weekStart: 1 }, '2026-11-22')).toBe('2026-11-22')
  })
  it('"today" is the caller\'s date: a day that has not ended where the user is, is not missed yet', () => {
    // At 01:00 in Bali (UTC+8) on the 17th the server's UTC clock still reads the 16th.
    const S = base()
    expect(missedWorkouts(S, '2026-11-16').map(m => m.iso)).toEqual(['2026-11-15'])
    expect(missedWorkouts(S, '2026-11-17').map(m => m.iso)).toEqual(['2026-11-15', '2026-11-16'])
  })
})

describe('planAssignments: explicit one-time dates', () => {
  const REQUESTED = [
    { date: '2026-11-17', routine_id: 'ua' }, { date: '2026-11-18', routine_id: 'la' }, { date: '2026-11-19', routine_id: 'cc' },
    { date: '2026-11-20', routine_id: 'ub' }, { date: '2026-11-21', routine_id: 'lb' }, { date: '2026-11-22', routine_id: 'rest' },
  ]
  it('applies the requested week and records Monday\'s session as moved to today', () => {
    const S = base()
    const p = planAssignments(S, REQUESTED, { answers: [{ date: '2026-11-15', act: 'kept' }], today: TODAY })
    expect(p.ok).toBe(true)
    expect(p.resolutions).toEqual({ '2026-11-16': { act: 'moved', to: '2026-11-17' }, '2026-11-15': { act: 'kept' } })
    applyReschedule(S, p)
    expect(effectiveRoutineIds(S, TODAY)).toEqual(['ua'])
    expect(names(S, '2026-11-17', '2026-11-23')['2026-11-23']).toBe('Upper Body A')
    expect(missedWorkouts(S, TODAY)).toEqual([])
    // Sunday was already a rest day: no override is written for it.
    expect(p.writes['2026-11-22']).toBeUndefined()
  })
  it('names a session the dates no longer hold, and a session assigned twice', () => {
    const p = planAssignments(base(), [{ date: '2026-11-18', routine_id: 'ua' }, { date: '2026-11-19', routine_id: 'ua' }], { today: TODAY })
    expect(p.warnings.map(w => w.type)).toEqual(expect.arrayContaining(['dropped', 'duplicate']))
  })
  it('refuses a past date, a completed day, a date given twice and an unknown routine', () => {
    const S = base({ workouts: [...base().workouts, wk('2026-11-18', 'la')] })
    expect(planAssignments(S, [{ date: '2026-11-16', routine_id: 'ua' }], { today: TODAY }).errors.join()).toMatch(/past/)
    expect(planAssignments(S, [{ date: '2026-11-18', routine_id: 'ua' }], { today: TODAY }).errors.join()).toMatch(/workout logged/)
    expect(planAssignments(S, [{ date: '2026-11-19', routine_id: 'ua' }, { date: '2026-11-19', routine_id: 'la' }], { today: TODAY }).ok).toBe(false)
    expect(planAssignments(S, [{ date: '2026-11-19', routine_id: 'nope' }], { today: TODAY }).ok).toBe(false)
  })
  it('null puts a date back on the weekly plan', () => {
    const S = base({ dayPlan: { '2026-11-18': 'ua' } })
    applyReschedule(S, planAssignments(S, [{ date: '2026-11-18', routine_id: null }], { today: TODAY }))
    expect(S.dayPlan['2026-11-18']).toBeUndefined()
    expect(effectiveRoutine(S, '2026-11-18').name).toBe('Cardio + Core')
  })
})

describe('Skip and Keep schedule', () => {
  it('skip records the day as let go and shifts nothing', () => {
    const S = base()
    answerMissed(S, ['2026-11-16'], 'skipped', 5)
    expect(S.dayPlan).toEqual(base().dayPlan)
    expect(missedAnswerOf(S, '2026-11-16')).toEqual({ act: 'skipped' })
    expect(resolvedOff(S, '2026-11-16')).toBe(true)
    expect(effectiveRoutine(S, TODAY).name).toBe('Lower Body A')
  })
  it('keep changes nothing but stops the question', () => {
    const S = base()
    answerMissed(S, ['2026-11-15', '2026-11-16'], 'kept', 5)
    expect(missedWorkouts(S, TODAY)).toEqual([])
    expect(resolvedOff(S, '2026-11-16')).toBe(false)
  })
  it('a skipped or moved day is excused from the missed-day nudge, on the device and the server', () => {
    const S = base({ dayPlan: {} })
    expect(nudgeFor(S, '2026-11-16')).toEqual(['ua'])
    expect(serverNudgeFor(S, '2026-11-16')).toBe('ua')
    answerMissed(S, ['2026-11-16'], 'skipped')
    expect(nudgeFor(S, '2026-11-16')).toBe(null)
    expect(serverNudgeFor(S, '2026-11-16')).toBe(null)
  })
  it('a stored answer reads back cleanly and a cleared one reads as none', () => {
    expect(readMissed({ act: 'moved', to: '2026-11-17', _ts: 1 })).toEqual({ act: 'moved', to: '2026-11-17' })
    expect(readMissed({ act: 'bogus' })).toBe(null)
    expect(readMissed(withMissed({}, '2026-11-16', null, 9)['2026-11-16'])).toBe(null)
  })
})

describe('recovery checks', () => {
  it('the requested week has no back-to-back muscle clash and no long streak', () => {
    const p = planReschedule(base(), { missed: ['2026-11-16'], today: TODAY })
    expect(p.warnings.filter(w => w.type !== 'dropped')).toEqual([])
  })
  it('warns about the same muscles on consecutive days and about too many days in a row', () => {
    const S = base({ workouts: [] })
    const back = recoveryWarnings(S, [{ date: '2026-11-17', ids: ['ua'] }, { date: '2026-11-18', ids: ['ub'] }])
    expect(back.some(w => w.type === 'muscles' && w.muscles.includes('deltoids'))).toBe(true)
    const long = recoveryWarnings(S, ['17', '18', '19', '20', '21', '22'].map((d, i) => ({ date: '2026-11-' + d, ids: [['ua', 'la', 'cc', 'ub', 'lb', 'cc'][i]] })))
    expect(long.some(w => w.type === 'streak' && w.days === 6)).toBe(true)
  })
  it('counts the days trained just before the plan towards the streak', () => {
    const S = base({ workouts: ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'].map(d => wk(d, 'cc')) })
    const w = recoveryWarnings(S, [{ date: '2026-11-17', ids: ['ua'] }, { date: '2026-11-18', ids: ['la'] }])
    expect(w.some(x => x.type === 'streak' && x.days === 6)).toBe(true)
  })
})

describe('schedule view', () => {
  it('names each day as done, missed, moved, today or planned', () => {
    const S = base()
    applyReschedule(S, planReschedule(S, { missed: ['2026-11-16'], today: TODAY }))
    expect(scheduleDay(S, '2026-11-14', TODAY).status).toBe('done')
    expect(scheduleDay(S, '2026-11-15', TODAY).status).toBe('missed')
    expect(scheduleDay(S, '2026-11-16', TODAY)).toMatchObject({ status: 'moved', answer: { act: 'moved', to: TODAY } })
    expect(scheduleDay(S, TODAY, TODAY)).toMatchObject({ status: 'today', planned: ['ua'], weekly: ['la'], override: 'ua' })
    expect(scheduleDay(S, '2026-11-22', TODAY).status).toBe('rest')
    expect(weeklyOn(S, '2026-11-19', TODAY)).toEqual(['ub'])
  })
  it('planChanges is false for an empty or refused plan', () => {
    expect(planChanges(planReschedule(base(), { missed: [], today: TODAY }))).toBe(false)
  })
})

describe('sync', () => {
  it('missedDays is a stamped map on the device and the server', () => {
    expect(STAMPED_MAPS).toContain('missedDays')
    expect(Server.STAMPED_MAPS).toEqual(STAMPED_MAPS)
  })
  it('two devices answering different days keep both; the same day keeps the later answer', () => {
    const a = base({ missedDays: { '2026-11-15': { act: 'kept', _ts: 10 }, '2026-11-16': { act: 'skipped', _ts: 10 } } })
    const b = base({ missedDays: { '2026-11-16': { act: 'moved', to: TODAY, _ts: 20 } } })
    const m = mergeStates(a, b)
    expect(readMissed(m.missedDays['2026-11-15'])).toEqual({ act: 'kept' })
    expect(readMissed(m.missedDays['2026-11-16'])).toEqual({ act: 'moved', to: TODAY })
  })
  it('a profile written before this feature (no missedDays) reads as nothing answered', () => {
    const { missedDays, ...old } = base()
    expect(missedDays).toBeUndefined()
    expect(missedWorkouts(old, TODAY)).toHaveLength(2)
    expect(scheduleDay(old, '2026-11-16', TODAY).status).toBe('missed')
  })
})
