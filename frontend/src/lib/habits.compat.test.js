/* Habits across devices and app versions.

   - Offline edits on two devices of the same account merge entry by entry: different habits, a
     habit's days and its definition, a rename on one and a log on the other all survive.
   - The alcohol-only build still in production (6358351c, frozen in compat/habits-6358351c.js) on
     another device: it writes its own alcohol days only, its merge keeps every entry it cannot
     show, and nothing of what this build wrote is lost or set back through it.
   The server's half (an app from before habits, an API script) is api/test/sync-stamps-habits.test.js
   and api/test/server-habits.test.js. */
import { describe, expect, it } from 'vitest'
import * as OLD from './compat/habits-6358351c.js'
import { createHabit, withHabit, withEntry, habitList, habitOf, habitStats, entryOf, defKey, habitKey } from './habits.js'
import { mergeStates, mergeStampedMap, stampChange, stampReplace, localExtras, sinceReset, resetIdsOf } from './sync-merge.js'

const T = '2026-10-22'
const clone = v => JSON.parse(JSON.stringify(v))
const at = (now, today = T) => ({ now, today, tz: 'Europe/Lisbon' })
const profile = (habitLog, ts) => ({ unit: 'kg', _ts: ts, workouts: [], routines: [], habitLog })
// One device's change, stamped the way the store stamps it (useStore update → stampChange).
const change = (prev, wall, mut) => { const n = clone(prev); mut(n); n._ts = stampChange(prev, n, wall); return n }

// A profile this build wrote: two habits of the user's own with days, Alcohol renamed, days of all.
function newer() {
  let m = {
    'alcohol|2026-10-20': { s: 'free', tz: 'Europe/Lisbon', _ts: 1000 },
    'alcohol|2026-10-21': { s: 'drank', n: 2, note: 'Old note', tz: 'Europe/Lisbon', _ts: 1001 },
  }
  m = createHabit(m, { name: 'Read', icon: 'note', color: 'blue', kind: 'do' }, { now: 2000, id: 'hread' }).map
  m = createHabit(m, { name: 'Sugar', icon: 'flame', color: 'red', kind: 'avoid' }, { now: 2001, id: 'hsugar' }).map
  m = withEntry(m, 'hread', '2026-10-21', { status: 'good', note: 'Chapter 3' }, at(2002))
  m = withEntry(m, 'hread', '2026-10-22', { status: 'good' }, at(2003))
  m = withEntry(m, 'hsugar', '2026-10-22', { status: 'bad' }, at(2004))
  m = withHabit(m, 'alcohol', { name: 'Wine' }, { now: 2005 })
  return profile(m, 2005)
}

describe('two devices of one account, offline', () => {
  it('habits made on each device are both there after the merge, either way round', () => {
    const base = profile({}, 100)
    const a = change(base, 1000, s => { s.habitLog = createHabit(s.habitLog, { name: 'Read' }, { now: 1000, id: 'ha' }).map })
    const b = change(base, 1001, s => { s.habitLog = createHabit(s.habitLog, { name: 'Walk' }, { now: 1001, id: 'hb' }).map })
    for (const m of [mergeStates(a, b), mergeStates(b, a)]) expect(habitList(m).map(h => h.id)).toEqual(['alcohol', 'ha', 'hb'])
  })

  it('a rename on one device and days logged on the other both survive', () => {
    const base = newer()
    const a = change(base, 3000, s => { s.habitLog = withHabit(s.habitLog, 'hread', { name: 'Read daily' }, { now: 3000 }) })
    const b = change(base, 3001, s => { s.habitLog = withEntry(s.habitLog, 'hread', '2026-10-20', { status: 'good' }, at(3001)) })
    for (const m of [mergeStates(a, b), mergeStates(b, a)]) {
      expect(habitOf(m, 'hread').name).toBe('Read daily')
      expect(habitStats(m, 'hread', T).current).toBe(3)
    }
  })

  it('archived on one device while logged on the other: still archived, the day kept', () => {
    const base = newer()
    const a = change(base, 3000, s => { s.habitLog = withHabit(s.habitLog, 'hsugar', { archived: true }, { now: 3000 }) })
    const b = change(base, 3001, s => { s.habitLog = withEntry(s.habitLog, 'hsugar', '2026-10-21', { status: 'good' }, at(3001)) })
    for (const m of [mergeStates(a, b), mergeStates(b, a)]) {
      expect(habitOf(m, 'hsugar').archived).toBe(true)
      expect(entryOf(m, 'hsugar', '2026-10-21').status).toBe('good')
    }
  })

  it('the same habit edited on both: the later edit wins as a whole, on both devices alike', () => {
    const base = newer()
    const a = change(base, 3000, s => { s.habitLog = withHabit(s.habitLog, 'hread', { name: 'A name', color: 'green' }, { now: 3000 }) })
    const b = change(base, 3005, s => { s.habitLog = withHabit(s.habitLog, 'hread', { icon: 'star' }, { now: 3005 }) })
    const ab = mergeStates(a, b), ba = mergeStates(b, a)
    expect(ab.habitLog).toEqual(ba.habitLog)
    expect(habitOf(ab, 'hread')).toMatchObject({ name: 'Read', icon: 'star', color: 'blue' })
  })

  it('a device whose clock runs behind still wins with an edit made after seeing the other\'s', () => {
    const base = newer()
    const seen = change(base, 9000, s => { s.habitLog = withHabit(s.habitLog, 'hread', { name: 'From the fast clock' }, { now: 9000 }) })
    // the slow phone (clock at 5000) synced `seen`, then renamed again
    const slow = change(seen, 5000, s => { s.habitLog = withHabit(s.habitLog, 'hread', { name: 'Later, on the slow clock' }, { now: 5000 }) })
    expect(habitOf(mergeStates(seen, slow), 'hread').name).toBe('Later, on the slow clock')
  })

  it('a correction of a past day and its note travel together as one entry', () => {
    const base = newer()
    const a = change(base, 3000, s => { s.habitLog = withEntry(s.habitLog, 'alcohol', '2026-10-21', { status: 'free', note: 'Was wrong' }, at(3000)) })
    expect(entryOf(mergeStates(base, a), 'alcohol', '2026-10-21')).toMatchObject({ status: 'free', note: 'Was wrong', count: null })
  })
})

describe('the alcohol-only build (6358351c) on another device', () => {
  it('reads Alcohol exactly as before, whatever else the log holds', () => {
    const S = newer()
    expect(OLD.statusOn(S, 'alcohol', '2026-10-20', T)).toBe('free')
    expect(OLD.entryOf(S, 'alcohol', '2026-10-21')).toMatchObject({ status: 'drank', count: 2 })
    expect(OLD.habitStats(S, 'alcohol', T)).toMatchObject({ current: 0, best: 1 })
    // the definitions and the other habits' days are not days of Alcohol to it
    expect(OLD.habitStats(S, 'alcohol', T).d90.logged).toBe(2)
    expect(OLD.calendarRows(S, 'alcohol', 30, 1, T).flat().filter(c => c.status).length).toBe(2)
  })

  it('its log of a day writes that day only, keeping every habit and definition', () => {
    const S = newer()
    const log = OLD.withEntry(S.habitLog, 'alcohol', T, { status: 'free' }, at(4000))
    for (const [k, v] of Object.entries(S.habitLog)) expect(log[k]).toEqual(v)
    expect(log['alcohol|2026-10-22']).toMatchObject({ s: 'free' })
    // it cannot write days of a habit it does not know
    expect(OLD.withEntry(S.habitLog, 'hread', '2026-10-20', { status: 'good' }, at(4001))).toBe(S.habitLog)
  })

  it('its merge (per entry, unchanged since 6358351c) neither drops nor sets back what this build wrote', () => {
    const fresh = newer()
    // the old phone was offline with the profile from before any of it, and logged Alcohol since
    const stale = profile({ 'alcohol|2026-10-20': { s: 'free', tz: 'Europe/Lisbon', _ts: 1000 } }, 1500)
    const oldPhone = change(stale, 9999, s => { s.habitLog = OLD.withEntry(s.habitLog, 'alcohol', '2026-10-19', { status: 'drank' }, at(9999)) })
    for (const m of [mergeStates(oldPhone, fresh), mergeStates(fresh, oldPhone)]) {
      for (const [k, v] of Object.entries(fresh.habitLog)) expect(m.habitLog[k]).toEqual(v)
      expect(habitList(m).map(h => h.id)).toEqual(['alcohol', 'hread', 'hsugar'])
      expect(habitOf(m, 'alcohol').name).toBe('Wine')
      expect(entryOf(m, 'alcohol', '2026-10-19').status).toBe('drank')   // its own change is kept too
    }
  })

  it('an older entry of its own never wins over a newer one: only the stamp decides', () => {
    const n = { 'hread|2026-10-21': { s: 'good', _ts: 5000 }, 'hread|def': { name: 'Read', _ts: 5000 } }
    const o = { 'hread|2026-10-21': { _ts: 4000 }, 'hread|def': { _ts: 4000 } }
    expect(mergeStampedMap(o, n)).toEqual(n)
    expect(mergeStampedMap(n, o)).toEqual(n)
  })

  it('this build keeps the fields of a day the old build cannot have written', () => {
    const S = newer()
    S.habitLog['alcohol|2026-10-20'].future = 'kept'
    const log = withEntry(S.habitLog, 'alcohol', '2026-10-20', { note: 'n' }, at(5000))
    expect(log['alcohol|2026-10-20']).toMatchObject({ future: 'kept', s: 'free', note: 'n' })
  })
})

describe('backup, import, reset and sign-in', () => {
  it('a backup is the profile: every habit, definition and day goes in it and comes back', () => {
    const S = newer()
    const backup = JSON.parse(JSON.stringify(S, null, 2))
    expect(backup.habitLog).toEqual(S.habitLog)
    expect(habitList(backup, { archived: null }).map(h => h.name || h.id)).toEqual(['Wine', 'Read', 'Sugar'])
  })

  it('a backup that replaces the profile clears the habits and days it does not hold, so no merge brings them back', () => {
    const backup = profile({ 'alcohol|2026-10-20': { s: 'free', _ts: 1000 } }, 1000)
    const cur = newer()
    const next = stampReplace(clone(backup), [cur], 9000)
    // the backup's own version of a day the profile held differently is the latest choice
    expect(next.habitLog['alcohol|2026-10-20']).toEqual({ s: 'free', _ts: 9000 })
    expect(next.habitLog[defKey('hread')]).toEqual({ _ts: 9000 })
    expect(next.habitLog[habitKey('hread', T)]).toEqual({ _ts: 9000 })
    // the device that still had the old copy merges with it, and the replace holds
    const m = mergeStates(cur, next)
    expect(habitList(m, { archived: null }).map(h => h.id)).toEqual(['alcohol'])
    expect(habitOf(m, 'alcohol').name).toBeNull()
  })

  it('"Reset everything" names every habit entry, so a device that has not seen it loses them all', () => {
    const S = newer()
    const ids = resetIdsOf(S)
    expect(ids.habitLog).toEqual(expect.arrayContaining([defKey('hread'), defKey('hsugar'), defKey('alcohol'), habitKey('hread', T)]))
    expect(sinceReset(S, 9000, ids).habitLog).toEqual({})
  })

  it('signing in asks about a habit made while signed out, even before any day was logged', () => {
    const local = profile(createHabit({}, { name: 'Read' }, { now: 1, id: 'hread' }).map, 1)
    expect(localExtras(local, profile({}, 2)).setup).toBe(1)
    expect(localExtras(local, profile(clone(local.habitLog), 2)).setup).toBeUndefined()
  })
})
