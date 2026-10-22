// The daily habit log (lib/habits.js): what a streak is and is not, missing and future days,
// edits, travel across time zones, and how two devices' logs merge.
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Server from '../../../api/sync-stamps.js'
import {
  COUNT_MAX, addDays, calendarRows, canLog, daysBetween, entryOf, habitKey, habitStats, isDay, lastDays, readEntry,
  statusOn, weekly, withEntry,
} from './habits.js'
import { todayISO } from './format.js'
import { NOTE_MAX } from './history.js'
import { highestStamp, mergeStates, resetIdsOf, stampChange, STAMPED_MAPS } from './sync-merge.js'

const TODAY = '2026-10-22'
const base = (over = {}) => ({
  unit: 'kg', week: {}, dayPlan: {}, workouts: [], routines: [], bodyweight: [], customEx: [], favEx: [],
  exWeights: {}, exNotes: {}, barWeights: {}, equipProfiles: [], gymCards: [], _ts: 0, ...over,
})
// A log from { day: 'free' | 'drank' }, written the way the app writes it.
const log = (days, extra = {}, today = TODAY) => Object.entries(days).reduce(
  (m, [iso, s]) => withEntry(m, 'alcohol', iso, { status: s, ...(extra[iso] || {}) }, { now: 1, today, tz: 'UTC' }), {})
const S = days => ({ habitLog: log(days) })
const run = (from, n, s = 'free') => Object.fromEntries(Array.from({ length: n }, (_, i) => [addDays(from, i), s]))

afterEach(() => { vi.useRealTimers() })

describe('calendar days', () => {
  it('accepts only real dates', () => {
    for (const ok of ['2026-10-22', '2024-02-29', '2000-01-01']) expect(isDay(ok)).toBe(true)
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-1-1', '26-10-22', '', null, undefined, 20261022, '2026-10-22T10:00']) expect(isDay(bad)).toBe(false)
  })

  it('moves by calendar days across months, leap days and years', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(daysBetween('2026-10-01', '2026-10-22')).toBe(21)
    expect(daysBetween('2026-10-22', '2026-10-01')).toBe(-21)
  })

  it('takes entries from the first day of 2000 to today, never later', () => {
    expect(canLog('2026-10-22', TODAY)).toBe(true)
    expect(canLog('2026-10-23', TODAY)).toBe(false)
    expect(canLog('1999-12-31', TODAY)).toBe(false)
    expect(canLog('2026-02-30', TODAY)).toBe(false)
  })
})

describe('entries: reading and writing', () => {
  const at = { now: 10, today: TODAY, tz: 'Europe/Lisbon' }

  it('writes one stamped entry per habit and day', () => {
    const m = withEntry({}, 'alcohol', '2026-10-20', { status: 'free', note: '  Dinner out ' }, at)
    expect(m).toEqual({ 'alcohol|2026-10-20': { s: 'free', note: 'Dinner out', tz: 'Europe/Lisbon', _ts: 10 } })
    expect(habitKey('alcohol', '2026-10-20')).toBe('alcohol|2026-10-20')
  })

  it('reads junk, cleared entries and unknown habits as nothing', () => {
    expect(readEntry('alcohol', { s: 'free' })).toMatchObject({ status: 'free' })
    for (const junk of [null, undefined, 'free', 3, ['free'], { _ts: 5 }, { s: 'maybe' }, { s: 'sober' }]) expect(readEntry('alcohol', junk)).toBeNull()
    expect(readEntry('smoking', { s: 'free' })).toBeNull()
    expect(readEntry('alcohol', { s: 'drank', n: 2.5 }).count).toBeNull()
    expect(readEntry('alcohol', { s: 'drank', n: COUNT_MAX + 1 }).count).toBeNull()
    expect(readEntry('alcohol', { s: 'free', n: 3 }).count).toBeNull()
    expect(readEntry('alcohol', { note: 'x'.repeat(NOTE_MAX + 20) }).note).toHaveLength(NOTE_MAX)
  })

  it('keeps the drink count only on a drank day', () => {
    let m = withEntry({}, 'alcohol', '2026-10-20', { status: 'drank', count: 3 }, at)
    expect(entryOf({ habitLog: m }, 'alcohol', '2026-10-20').count).toBe(3)
    m = withEntry(m, 'alcohol', '2026-10-20', { status: 'free' }, at)
    expect(m['alcohol|2026-10-20'].n).toBeUndefined()
    // back to drank: the old number does not come back
    m = withEntry(m, 'alcohol', '2026-10-20', { status: 'drank' }, at)
    expect(entryOf({ habitLog: m }, 'alcohol', '2026-10-20').count).toBeNull()
  })

  it('changing the status keeps the note; changing the note keeps the status', () => {
    let m = withEntry({}, 'alcohol', '2026-10-20', { status: 'free', note: 'Gym night' }, at)
    m = withEntry(m, 'alcohol', '2026-10-20', { status: 'drank' }, { ...at, now: 11 })
    expect(entryOf({ habitLog: m }, 'alcohol', '2026-10-20')).toMatchObject({ status: 'drank', note: 'Gym night' })
    m = withEntry(m, 'alcohol', '2026-10-20', { note: '' }, { ...at, now: 12 })
    expect(entryOf({ habitLog: m }, 'alcohol', '2026-10-20')).toMatchObject({ status: 'drank', note: '' })
  })

  it('"Not logged" is a stamped clear, not a deleted key, so it syncs', () => {
    let m = withEntry({}, 'alcohol', '2026-10-20', { status: 'drank', count: 2 }, at)
    m = withEntry(m, 'alcohol', '2026-10-20', { status: null }, { ...at, now: 11 })
    expect(m['alcohol|2026-10-20']).toEqual({ _ts: 11 })
    expect(statusOn({ habitLog: m }, 'alcohol', '2026-10-20', TODAY)).toBeNull()
  })

  it('refuses a future day, an impossible date and an unknown habit, and leaves the map as it was', () => {
    const m = log({ '2026-10-20': 'free' })
    expect(withEntry(m, 'alcohol', '2026-10-23', { status: 'free' }, at)).toBe(m)
    expect(withEntry(m, 'alcohol', '2027-01-01', { status: 'free' }, at)).toBe(m)
    expect(withEntry(m, 'alcohol', '2026-02-30', { status: 'free' }, at)).toBe(m)
    expect(withEntry(m, 'smoking', '2026-10-20', { status: 'free' }, at)).toBe(m)
    expect(withEntry(undefined, 'alcohol', '2026-10-23', { status: 'free' }, at)).toEqual({})
  })

  it('does not mutate the map it was given', () => {
    const m = log({ '2026-10-20': 'free' })
    const before = JSON.stringify(m)
    withEntry(m, 'alcohol', '2026-10-21', { status: 'drank' }, at)
    expect(JSON.stringify(m)).toBe(before)
  })
})

describe('streaks: only logged days count', () => {
  const stats = (days, today = TODAY) => habitStats(S(days), 'alcohol', today)

  it('is the run of alcohol-free days up to and including today', () => {
    const s = stats(run('2026-10-18', 5))
    expect(s).toMatchObject({ current: 5, since: '2026-10-18', pending: false, best: 5 })
  })

  it('stands on yesterday while today is unlogged: not broken, not extended', () => {
    const s = stats(run('2026-10-18', 4))
    expect(s).toMatchObject({ current: 4, since: '2026-10-18', pending: true })
  })

  it('a day with alcohol today ends it', () => {
    const s = stats({ ...run('2026-10-18', 4), [TODAY]: 'drank' })
    expect(s).toMatchObject({ current: 0, pending: false, best: 4 })
  })

  it('a day nobody logged ends it: a gap is never assumed to be alcohol-free', () => {
    // 18, 19, [20 missing], 21 free, today unlogged
    const s = stats({ '2026-10-18': 'free', '2026-10-19': 'free', '2026-10-21': 'free' })
    expect(s.current).toBe(1)
    expect(s.best).toBe(2)
  })

  it('two unlogged days in a row (yesterday and today) leave no streak at all', () => {
    const s = stats(run('2026-10-10', 5))
    expect(s.current).toBe(0)
    expect(s.pending).toBe(true)
  })

  it('an empty log has no streak, no best and no trend', () => {
    const s = habitStats({}, 'alcohol', TODAY)
    expect(s).toMatchObject({ current: 0, best: 0, since: null, trend: null, ahead: 0 })
    expect(s.d30).toMatchObject({ free: 0, drank: 0, logged: 0, unlogged: 30 })
  })

  it('a day with alcohol in the middle splits the runs; best is the longest', () => {
    const s = stats({ ...run('2026-09-01', 10), '2026-09-11': 'drank', ...run('2026-09-12', 3) })
    expect(s.best).toBe(10)
    expect(s.current).toBe(0)
  })

  it('crosses a month and a year boundary', () => {
    const s = habitStats(S({ ...run('2025-12-28', 8) }), 'alcohol', '2026-01-04')
    expect(s).toMatchObject({ current: 8, since: '2025-12-28' })
  })

  it('a cleared day breaks the run like a missing one', () => {
    let m = log(run('2026-10-18', 5))
    m = withEntry(m, 'alcohol', '2026-10-20', { status: null }, { now: 9, today: TODAY })
    expect(habitStats({ habitLog: m }, 'alcohol', TODAY).current).toBe(2)
  })

  it('editing a past day to a drink resets the streak that ran through it', () => {
    let m = log(run('2026-10-10', 13))
    expect(habitStats({ habitLog: m }, 'alcohol', TODAY).current).toBe(13)
    m = withEntry(m, 'alcohol', '2026-10-15', { status: 'drank', count: 2 }, { now: 9, today: TODAY })
    const s = habitStats({ habitLog: m }, 'alcohol', TODAY)
    expect(s).toMatchObject({ current: 7, since: '2026-10-16', best: 7 })
  })

  it('backfilling a missing day joins the runs on either side of it', () => {
    let m = log({ '2026-10-18': 'free', '2026-10-19': 'free', '2026-10-21': 'free', [TODAY]: 'free' })
    expect(habitStats({ habitLog: m }, 'alcohol', TODAY).current).toBe(2)
    m = withEntry(m, 'alcohol', '2026-10-20', { status: 'free' }, { now: 9, today: TODAY })
    expect(habitStats({ habitLog: m }, 'alcohol', TODAY)).toMatchObject({ current: 5, best: 5 })
  })
})

describe('windows and trend', () => {
  it('counts free, drank and unlogged days of the last 30, and the drinks recorded', () => {
    const days = { ...run('2026-10-01', 10), '2026-10-11': 'drank', '2026-10-12': 'drank' }
    const m = withEntry(withEntry(log(days), 'alcohol', '2026-10-11', { count: 3 }, { now: 5, today: TODAY }),
      'alcohol', '2026-10-12', { count: 2 }, { now: 5, today: TODAY })
    const { d30 } = habitStats({ habitLog: m }, 'alcohol', TODAY)
    expect(d30).toMatchObject({ free: 10, drank: 2, logged: 12, unlogged: 18, drinks: 5, drinkDays: 2 })
  })

  it('shows no trend until both 30-day stretches have a week logged: unlogged is not a good day', () => {
    expect(habitStats(S(run('2026-10-01', 22)), 'alcohol', TODAY).trend).toBeNull()
    expect(habitStats(S(run('2026-09-25', 6)), 'alcohol', TODAY).trend).toBeNull()
  })

  it('compares the last 30 days with the 30 before', () => {
    const days = { ...run('2026-08-24', 20), ...run('2026-09-23', 30) }
    // previous 30 days: 2026-08-24 .. 2026-09-22 → 20 free logged there; last 30: 09-23..10-22 all free
    const s = habitStats(S(days), 'alcohol', TODAY)
    expect(s.d30.free).toBe(30)
    expect(s.trend).toEqual({ free: 30 - s.prev30.free, drank: 0 })
    expect(s.trend.free).toBeGreaterThan(0)
  })

  it('a worse stretch reads as fewer free days and more drank days', () => {
    const days = { ...run('2026-08-24', 30), ...run('2026-09-23', 15), ...run('2026-10-08', 15, 'drank') }
    const s = habitStats(S(days), 'alcohol', TODAY)
    expect(s.trend.free).toBeLessThan(0)
    expect(s.trend.drank).toBeGreaterThan(0)
  })

  it('splits the last 12 weeks into 7-day blocks ending today', () => {
    const w = weekly(S(run('2026-10-16', 7)), 'alcohol', 12, TODAY)
    expect(w).toHaveLength(12)
    expect(w[11]).toEqual({ from: '2026-10-16', to: TODAY, free: 7, drank: 0, unlogged: 0 })
    expect(w[10]).toMatchObject({ to: '2026-10-15', free: 0, unlogged: 7 })
  })

  it('lists the last n days oldest first, unlogged as null', () => {
    const d = lastDays(S({ '2026-10-21': 'free', [TODAY]: 'drank' }), 'alcohol', 3, TODAY)
    expect(d).toEqual([{ iso: '2026-10-20', status: null }, { iso: '2026-10-21', status: 'free' }, { iso: TODAY, status: 'drank' }])
  })
})

describe('the calendar grid', () => {
  it('lays the days out in whole weeks from the week start, padding the first', () => {
    const rows = calendarRows(S({ [TODAY]: 'free' }), 'alcohol', 30, 1, TODAY)   // Thursday today
    expect(rows.every(r => r.length === 7)).toBe(true)
    const cells = rows.flat()
    expect(new Date(cells[0].iso + 'T12:00:00Z').getUTCDay()).toBe(1)
    const real = cells.filter(c => !c.out)
    expect(real[0].iso).toBe('2026-09-23')
    expect(real.filter(c => !c.future)).toHaveLength(30)
    expect(cells.find(c => c.today)).toMatchObject({ iso: TODAY, status: 'free' })
  })

  it('days after today in the last week are future and carry no status', () => {
    const cells = calendarRows(S({}), 'alcohol', 30, 1, TODAY).flat()
    const future = cells.filter(c => c.future)
    expect(future.map(c => c.iso)).toEqual(['2026-10-23', '2026-10-24', '2026-10-25'])
    expect(future.every(c => c.status === null)).toBe(true)
  })

  it('honours a Sunday week start', () => {
    const cells = calendarRows(S({}), 'alcohol', 90, 0, TODAY).flat()
    expect(new Date(cells[0].iso + 'T12:00:00Z').getUTCDay()).toBe(0)
    expect(cells.filter(c => !c.out && !c.future)).toHaveLength(90)
  })
})

describe('future days stay unlogged', () => {
  it('a stored entry dated after today is not read, counted or drawn until its day arrives', () => {
    const habitLog = { ...log(run('2026-10-19', 4)), 'alcohol|2026-10-23': { s: 'free', tz: 'Pacific/Auckland', _ts: 5 } }
    const s = habitStats({ habitLog }, 'alcohol', TODAY)
    expect(s).toMatchObject({ current: 4, ahead: 1 })
    expect(statusOn({ habitLog }, 'alcohol', '2026-10-23', TODAY)).toBeNull()
    expect(calendarRows({ habitLog }, 'alcohol', 30, 1, TODAY).flat().find(c => c.iso === '2026-10-23')).toMatchObject({ future: true, status: null })
    // the next day it counts
    expect(habitStats({ habitLog }, 'alcohol', '2026-10-23')).toMatchObject({ current: 5, ahead: 0 })
  })
})

describe('time zones: the recorded day never moves', () => {
  const realTZ = process.env.TZ
  afterEach(() => { if (realTZ === undefined) delete process.env.TZ; else process.env.TZ = realTZ })

  it('"today" follows the device, a logged day is the string it was written as', () => {
    // 23:30 on 22 Oct in Lisbon is already the 23rd in Auckland and still the 22nd in Honolulu
    const instant = new Date('2026-10-22T22:30:00Z')
    vi.useFakeTimers(); vi.setSystemTime(instant)
    process.env.TZ = 'Europe/Lisbon'
    const lisbon = todayISO()
    process.env.TZ = 'Pacific/Auckland'
    const auckland = todayISO()
    process.env.TZ = 'Pacific/Honolulu'
    const honolulu = todayISO()
    expect([lisbon, auckland, honolulu]).toEqual(['2026-10-22', '2026-10-23', '2026-10-22'])

    process.env.TZ = 'Europe/Lisbon'
    let m = withEntry({}, 'alcohol', lisbon, { status: 'drank', count: 2 })
    expect(m[habitKey('alcohol', '2026-10-22')]).toMatchObject({ s: 'drank', n: 2, tz: 'Europe/Lisbon' })
    // the same entry, read on a device that has since flown to Auckland, is still the 22nd
    process.env.TZ = 'Pacific/Auckland'
    expect(statusOn({ habitLog: m }, 'alcohol', '2026-10-22', todayISO())).toBe('drank')
    expect(statusOn({ habitLog: m }, 'alcohol', '2026-10-23', todayISO())).toBeNull()
    // and on a device that has flown west, "today" is behind: nothing logged ahead of it is read
    process.env.TZ = 'Pacific/Honolulu'
    m = withEntry(m, 'alcohol', '2026-10-23', { status: 'free' }, { now: 5, today: '2026-10-23' })   // logged in Auckland
    expect(statusOn({ habitLog: m }, 'alcohol', '2026-10-23', todayISO())).toBeNull()
    expect(habitStats({ habitLog: m }, 'alcohol', todayISO()).ahead).toBe(1)
  })

  it('daylight-saving changes neither add nor drop a day', () => {
    // US clocks go back on 1 Nov 2026, forward on 8 Mar 2026; Lisbon on 25 Oct and 29 Mar
    for (const tz of ['America/New_York', 'Europe/Lisbon', 'Pacific/Auckland', 'Australia/Lord_Howe']) {
      process.env.TZ = tz
      expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
      expect(addDays('2026-03-07', 2)).toBe('2026-03-09')
      expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31)
      const s = habitStats({ habitLog: log(run('2026-10-20', 14), {}, '2026-11-02') }, 'alcohol', '2026-11-02')
      expect(s).toMatchObject({ current: 14, since: '2026-10-20' })
      const rows = calendarRows(S({}), 'alcohol', 30, 1, '2026-11-02').flat().filter(c => !c.out && !c.future)
      expect(rows).toHaveLength(30)
      expect(new Set(rows.map(c => c.iso)).size).toBe(30)
    }
  })

  it('a travel day that was skipped stays unlogged: the streak is broken, not bridged', () => {
    // flew east on the 20th and never logged the 21st
    const s = habitStats(S({ ...run('2026-10-15', 6), '2026-10-22': 'free' }), 'alcohol', TODAY)
    expect(s.current).toBe(1)
    expect(s.best).toBe(6)
  })
})

describe('syncing two devices', () => {
  const entry = (iso, s, ts) => ({ ['alcohol|' + iso]: { s, tz: 'UTC', _ts: ts } })

  it('habitLog is a stamped map in the app and in the server\'s copy of the rules', () => {
    expect(STAMPED_MAPS).toContain('habitLog')
    expect(Server.STAMPED_MAPS).toContain('habitLog')
  })

  it('keeps the days each device logged', () => {
    const phone = base({ _ts: 100, habitLog: entry('2026-10-20', 'free', 90) })
    const desk = base({ _ts: 200, habitLog: entry('2026-10-21', 'drank', 20) })
    const m = mergeStates(phone, desk)
    expect(Object.keys(m.habitLog).sort()).toEqual(['alcohol|2026-10-20', 'alcohol|2026-10-21'])
    expect(mergeStates(desk, phone).habitLog).toEqual(m.habitLog)
  })

  it('the later edit of the same day wins, whichever copy is newer overall', () => {
    const phone = base({ _ts: 100, habitLog: entry('2026-10-20', 'free', 90) })
    const desk = base({ _ts: 300, habitLog: entry('2026-10-20', 'drank', 40) })
    expect(mergeStates(phone, desk).habitLog['alcohol|2026-10-20'].s).toBe('free')
    expect(mergeStates(desk, phone).habitLog['alcohol|2026-10-20'].s).toBe('free')
  })

  it('a day taken back to "not logged" on one device is not brought back by the other', () => {
    const cleared = base({ _ts: 100, habitLog: { 'alcohol|2026-10-20': { _ts: 80 } } })
    const stale = base({ _ts: 300, habitLog: entry('2026-10-20', 'free', 40) })
    const m = mergeStates(cleared, stale)
    expect(statusOn(m, 'alcohol', '2026-10-20', TODAY)).toBeNull()
  })

  it('a copy from before habits existed loses none of them', () => {
    const mine = base({ _ts: 100, habitLog: entry('2026-10-20', 'free', 90) })
    const old = base({ _ts: 300 })
    expect(mergeStates(mine, old).habitLog).toEqual(mine.habitLog)
    expect(mergeStates(old, mine).habitLog).toEqual(mine.habitLog)
  })

  it('a logging device with a clock far behind still wins over what it has seen', () => {
    const prev = base({ _ts: 1000, habitLog: entry('2026-10-20', 'free', 900) })
    const next = clone(prev)
    next.habitLog = withEntry(next.habitLog, 'alcohol', '2026-10-20', { status: 'drank' }, { now: 5, today: TODAY })
    const at = stampChange(prev, next, 5)
    expect(next.habitLog['alcohol|2026-10-20']._ts).toBe(at)
    expect(at).toBeGreaterThan(900)
  })

  it('two devices editing the same day at once: one whole entry survives, the same on both, never a mix', () => {
    // neither had seen the other's write: the phone sets a note, the desktop sets drinks
    const at = { today: TODAY, tz: 'UTC' }
    const seed = withEntry({}, 'alcohol', '2026-10-20', { status: 'drank' }, { ...at, now: 10 })
    const phone = base({ _ts: 100, habitLog: withEntry(seed, 'alcohol', '2026-10-20', { note: 'wedding' }, { ...at, now: 50 }) })
    const desk = base({ _ts: 90, habitLog: withEntry(seed, 'alcohol', '2026-10-20', { count: 4 }, { ...at, now: 60 }) })
    const a = mergeStates(phone, desk).habitLog['alcohol|2026-10-20']
    const b = mergeStates(desk, phone).habitLog['alcohol|2026-10-20']
    expect(a).toEqual(b)                              // both devices settle on the same entry
    expect(a).toEqual(desk.habitLog['alcohol|2026-10-20'])   // the later write, whole: status and drinks intact
    expect(readEntry('alcohol', a)).toMatchObject({ status: 'drank', count: 4 })
  })

  it('an edit made after seeing the other device\'s write wins even from a clock that runs behind', () => {
    const at = { today: TODAY, tz: 'UTC' }
    const server = base({ _ts: 1000, habitLog: withEntry({}, 'alcohol', '2026-10-20', { status: 'drank' }, { ...at, now: 900 }) })
    const mine = clone(server)
    mine.habitLog = withEntry(mine.habitLog, 'alcohol', '2026-10-20', { status: 'free' }, { ...at, now: 5 })
    mine._ts = stampChange(server, mine, 5)
    expect(mergeStates(mine, server).habitLog['alcohol|2026-10-20'].s).toBe('free')
    expect(mergeStates(server, mine).habitLog['alcohol|2026-10-20'].s).toBe('free')
  })

  it('"reset everything" names the habit entries it wipes', () => {
    const before = base({ _ts: 1000, habitLog: entry('2026-10-20', 'free', 900) })
    expect(resetIdsOf(before).habitLog).toEqual(['alcohol|2026-10-20'])
  })

  it('counts toward the stamps a copy carries', () => {
    expect(highestStamp(base({ _ts: 1, habitLog: entry('2026-10-20', 'free', 777) }))).toBe(777)
    expect(Server.highestStamp(base({ _ts: 1, habitLog: entry('2026-10-20', 'free', 777) }))).toBe(777)
  })
})

function clone(o) { return JSON.parse(JSON.stringify(o)) }
