/* Habits of your own (lib/habits.js): the alcohol-only log read as it is (no migration writes),
   habits made, edited, archived and brought back, each with its own days, streaks and counts, the
   two kinds, and the rules that hold for every habit: an unlogged day is never a good one, future
   days cannot be written, a day is a date string whatever the time zone. */
import { describe, expect, it } from 'vitest'
import {
  ALCOHOL, CUSTOM, HABIT_MAX, NAME_MAX, defKey, habitKey, isHabitId, newHabitId, rulesOf,
  habitOf, habitList, withHabit, createHabit, withEntry, entryOf, statusOn, habitStats, weekly, calendarRows, lastDays,
} from './habits.js'

const T = '2026-10-22'
const at = { today: T, tz: 'Europe/Lisbon' }
const deepFreeze = o => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze) } return o }
const clone = v => JSON.parse(JSON.stringify(v))
const make = (map, fields, now, id) => createHabit(map, fields, { now, id })
const logDays = (map, habit, days, now = 100) =>
  Object.entries(days).reduce((m, [iso, s], i) => withEntry(m, habit, iso, { status: s }, { now: now + i, ...at }), map)

// A profile exactly as the alcohol-only build (6358351c) leaves it: days, drinks, notes, zones, a
// cleared day, and nothing else.
const PROD_LOG = () => ({
  'alcohol|2026-10-15': { s: 'free', tz: 'Europe/Lisbon', _ts: 1760000000001 },
  'alcohol|2026-10-16': { s: 'free', tz: 'Europe/Lisbon', _ts: 1760000000002 },
  'alcohol|2026-10-17': { s: 'drank', n: 3, note: 'Wedding', tz: 'Europe/Lisbon', _ts: 1760000000003 },
  'alcohol|2026-10-18': { _ts: 1760000000004 },
  'alcohol|2026-10-19': { s: 'free', note: 'Long run', tz: 'Asia/Bangkok', _ts: 1760000000005 },
  'alcohol|2026-10-20': { s: 'free', tz: 'Asia/Bangkok', _ts: 1760000000006 },
  'alcohol|2026-10-21': { s: 'free', tz: 'Asia/Bangkok', _ts: 1760000000007 },
})

describe('the alcohol-only log, read by this build (the migration)', () => {
  it('is Alcohol, active, with every day, drink count, note and zone as it was', () => {
    const S = deepFreeze({ habitLog: PROD_LOG() })
    expect(habitList(S).map(h => h.id)).toEqual(['alcohol'])
    expect(habitOf(S, 'alcohol')).toMatchObject({ builtin: true, name: null, kind: 'avoid', archived: false, good: 'free', bad: 'drank', count: true })
    expect(entryOf(S, 'alcohol', '2026-10-17')).toEqual({ status: 'drank', count: 3, note: 'Wedding', tz: 'Europe/Lisbon' })
    expect(entryOf(S, 'alcohol', '2026-10-19')).toEqual({ status: 'free', count: null, note: 'Long run', tz: 'Asia/Bangkok' })
    expect(entryOf(S, 'alcohol', '2026-10-18')).toBeNull()
  })

  it('gives the same streaks and counts it always did', () => {
    const st = habitStats({ habitLog: PROD_LOG() }, 'alcohol', T)
    expect(st).toMatchObject({ current: 3, since: '2026-10-19', pending: true, best: 3 })
    expect(st.d30).toMatchObject({ free: 5, drank: 1, logged: 6, unlogged: 24, drinks: 3, drinkDays: 1 })
  })

  it('writes nothing to read it, and reads the same every time (repeatable)', () => {
    const log = PROD_LOG()
    const S = deepFreeze({ habitLog: log })            // a write would throw on the frozen map
    const once = [habitList(S), habitList(S, { archived: null }), habitStats(S, 'alcohol', T), weekly(S, 'alcohol', 12, T)]
    const twice = [habitList(S), habitList(S, { archived: null }), habitStats(S, 'alcohol', T), weekly(S, 'alcohol', 12, T)]
    expect(twice).toEqual(once)
    expect(S.habitLog).toEqual(PROD_LOG())
  })

  it('keeps every old day through the first edit of the new kind (rename, archive)', () => {
    let m = withHabit(PROD_LOG(), 'alcohol', { name: 'Wine' }, { now: 1760000000100 })
    m = withHabit(m, 'alcohol', { archived: true }, { now: 1760000000101 })
    for (const [k, v] of Object.entries(PROD_LOG())) expect(m[k]).toEqual(v)
    expect(Object.keys(m)).toHaveLength(Object.keys(PROD_LOG()).length + 1)   // only alcohol|def added
    expect(habitOf({ habitLog: m }, 'alcohol')).toMatchObject({ name: 'Wine', archived: true })
  })

  it('a profile with no log at all, or junk in its place, is Alcohol with nothing logged', () => {
    for (const habitLog of [undefined, null, 'x', [1], {}]) {
      expect(habitList({ habitLog }).map(h => h.id)).toEqual(['alcohol'])
      expect(habitStats({ habitLog }, 'alcohol', T).current).toBe(0)
    }
  })
})

describe('making a habit', () => {
  it('gets a stable id of its own and a definition entry in the log; days are untouched', () => {
    const { map, id } = make(PROD_LOG(), { name: '  Read   10 pages ', icon: 'note', color: 'blue', kind: 'do' }, 500, 'hread')
    expect(id).toBe('hread')
    expect(map[defKey(id)]).toEqual({ name: 'Read 10 pages', icon: 'note', color: 'blue', kind: 'do', at: 500, _ts: 500 })
    expect(habitOf({ habitLog: map }, id)).toMatchObject({ id, builtin: false, name: 'Read 10 pages', kind: 'do', good: 'good', bad: 'bad', count: false, archived: false })
    for (const [k, v] of Object.entries(PROD_LOG())) expect(map[k]).toEqual(v)
  })

  it('several are independent, listed Alcohol first and then in the order they were made', () => {
    let m = {}
    ;({ map: m } = make(m, { name: 'Stretch', kind: 'do' }, 300, 'hb'))
    ;({ map: m } = make(m, { name: 'Phone in bed', kind: 'avoid' }, 200, 'ha'))
    expect(habitList({ habitLog: m }).map(h => h.id)).toEqual(['alcohol', 'ha', 'hb'])
  })

  it('needs a name; an unknown icon, colour or kind falls back to the defaults', () => {
    expect(make({}, { name: '   ' }, 1).id).toBeNull()
    expect(make({}, {}, 1).id).toBeNull()
    const { map, id } = make({}, { name: 'X', icon: 'nope', color: '#f00', kind: 'maybe' }, 1, 'hx')
    expect(habitOf({ habitLog: map }, id)).toMatchObject({ icon: 'star', color: 'teal', kind: 'do' })
    expect(habitOf({ habitLog: make({}, { name: 'y'.repeat(200) }, 1, 'hy').map }, 'hy').name).toHaveLength(NAME_MAX)
  })

  it('refuses an id that is taken, is Alcohol\'s, or cannot be one', () => {
    const { map } = make({}, { name: 'A' }, 1, 'ha')
    expect(make(map, { name: 'B' }, 2, 'ha').id).toBeNull()
    expect(make(map, { name: 'B' }, 2, 'alcohol').id).toBeNull()
    for (const bad of ['', 'A B', 'x|y', '-x', 'é', 'a'.repeat(41)]) expect(make({}, { name: 'B' }, 2, bad).id).toBeNull()
  })

  it(`stops at ${HABIT_MAX} of your own, archived ones included`, () => {
    let m = {}
    for (let i = 0; i < HABIT_MAX; i++) m = make(m, { name: 'H' + i }, i + 1, 'h' + i).map
    m = withHabit(m, 'h0', { archived: true }, { now: 999 })
    expect(make(m, { name: 'One more' }, 1000, 'hmore').id).toBeNull()
  })

  it('new ids are ids, never hold the key separator, and differ', () => {
    const a = newHabitId(1760000000000, () => 0.1), b = newHabitId(1760000000000, () => 0.2)
    for (const id of [a, b, newHabitId()]) { expect(isHabitId(id)).toBe(true); expect(id).not.toContain('|') }
    expect(a).not.toBe(b)
  })
})

describe('editing, archiving and bringing back', () => {
  const base = () => {
    let { map } = make({}, { name: 'Read', icon: 'note', color: 'blue', kind: 'do' }, 10, 'hr')
    return logDays(map, 'hr', { '2026-10-19': 'good', '2026-10-20': 'good', '2026-10-21': 'bad', '2026-10-22': 'good' })
  }

  it('a rename, a new icon or colour keeps every day', () => {
    const before = base()
    const m = withHabit(before, 'hr', { name: 'Read a book', icon: 'lightbulb', color: 'purple' }, { now: 900 })
    expect(habitOf({ habitLog: m }, 'hr')).toMatchObject({ name: 'Read a book', icon: 'lightbulb', color: 'purple', at: 10 })
    for (const [k, v] of Object.entries(before)) if (k !== defKey('hr')) expect(m[k]).toEqual(v)
    expect(habitStats({ habitLog: m }, 'hr', T)).toEqual(habitStats({ habitLog: before }, 'hr', T))
  })

  it('an empty name is refused for your own habit, and takes Alcohol back to its own', () => {
    const m = base()
    expect(withHabit(m, 'hr', { name: '' }, { now: 900 })).toBe(m)
    const a = withHabit(withHabit({}, 'alcohol', { name: 'Beer' }, { now: 1 }), 'alcohol', { name: '' }, { now: 2 })
    expect(habitOf({ habitLog: a }, 'alcohol').name).toBeNull()
  })

  it('changing the kind keeps what each day meant: a good day stays good', () => {
    const before = base()
    const m = withHabit(before, 'hr', { kind: 'avoid' }, { now: 900 })
    expect(habitOf({ habitLog: m }, 'hr').kind).toBe('avoid')
    expect(habitStats({ habitLog: m }, 'hr', T)).toEqual(habitStats({ habitLog: before }, 'hr', T))
  })

  it('Alcohol\'s kind cannot change', () => {
    const m = withHabit(PROD_LOG(), 'alcohol', { kind: 'do' }, { now: 1 })
    expect(habitOf({ habitLog: m }, 'alcohol').kind).toBe('avoid')
    expect(m[defKey('alcohol')].kind).toBeUndefined()
  })

  it('archiving hides it from the active list and keeps every day; unarchiving brings it back as it was', () => {
    const before = base()
    const off = withHabit(before, 'hr', { archived: true }, { now: 900 })
    expect(habitList({ habitLog: off }).map(h => h.id)).toEqual(['alcohol'])
    expect(habitList({ habitLog: off }, { archived: true }).map(h => h.id)).toEqual(['hr'])
    expect(habitStats({ habitLog: off }, 'hr', T)).toEqual(habitStats({ habitLog: before }, 'hr', T))
    const on = withHabit(off, 'hr', { archived: false }, { now: 901 })
    expect(habitList({ habitLog: on }).map(h => h.id)).toEqual(['alcohol', 'hr'])
    expect(on[defKey('hr')].archived).toBeUndefined()
  })

  it('Alcohol can be archived and brought back too, its days kept', () => {
    const off = withHabit(PROD_LOG(), 'alcohol', { archived: true }, { now: 1 })
    expect(habitList({ habitLog: off })).toEqual([])
    expect(habitStats({ habitLog: off }, 'alcohol', T).best).toBe(3)
    expect(habitList({ habitLog: withHabit(off, 'alcohol', { archived: false }, { now: 2 }) }).map(h => h.id)).toEqual(['alcohol'])
  })

  it('keeps the fields of a definition or a day that a newer build wrote', () => {
    const m0 = base()
    const withFuture = { ...m0, [defKey('hr')]: { ...m0[defKey('hr')], remind: '08:00' }, [habitKey('hr', '2026-10-20')]: { ...m0[habitKey('hr', '2026-10-20')], mood: 4 } }
    const m1 = withHabit(withFuture, 'hr', { name: 'Read more' }, { now: 900 })
    expect(m1[defKey('hr')].remind).toBe('08:00')
    const m2 = withEntry(m1, 'hr', '2026-10-20', { note: 'x' }, { now: 901, ...at })
    expect(m2[habitKey('hr', '2026-10-20')]).toMatchObject({ mood: 4, s: 'good', note: 'x' })
  })
})

describe('days of your own habits', () => {
  it('each habit has its own days, streaks and counts', () => {
    let m = make({}, { name: 'Read', kind: 'do' }, 1, 'hr').map
    m = make(m, { name: 'Sugar', kind: 'avoid' }, 2, 'hs').map
    m = logDays(m, 'hr', { '2026-10-21': 'good', '2026-10-22': 'good' })
    m = logDays(m, 'hs', { '2026-10-22': 'bad' })
    m = logDays(m, 'alcohol', { '2026-10-22': 'free' })
    const S = { habitLog: m }
    expect(habitStats(S, 'hr', T)).toMatchObject({ current: 2, best: 2 })
    expect(habitStats(S, 'hs', T)).toMatchObject({ current: 0, best: 0 })
    expect(habitStats(S, 'hs', T).d30).toMatchObject({ free: 0, drank: 1 })
    expect(habitStats(S, 'alcohol', T)).toMatchObject({ current: 1 })
    expect(statusOn(S, 'hr', T, T)).toBe('good')
    expect(statusOn(S, 'hs', T, T)).toBe('bad')
  })

  it('both kinds store good and bad; a word that is not the habit\'s own counts for nothing', () => {
    let m = make({}, { name: 'Read', kind: 'do' }, 1, 'hr').map
    m = withEntry(m, 'hr', T, { status: 'free' }, { now: 5, ...at })   // Alcohol's word on another habit
    expect(entryOf({ habitLog: m }, 'hr', T)).toBeNull()
    m = { ...m, [habitKey('hr', '2026-10-21')]: { s: 'free', _ts: 6 }, [habitKey('alcohol', '2026-10-21')]: { s: 'good', _ts: 6 } }
    expect(habitStats({ habitLog: m }, 'hr', T).d30.logged).toBe(0)
    expect(habitStats({ habitLog: m }, 'alcohol', T).d30.logged).toBe(0)
    expect(rulesOf('hr')).toBe(CUSTOM)
    expect(rulesOf('alcohol')).toBe(ALCOHOL)
    expect(rulesOf('x|y')).toBeNull()
  })

  it('never counts an unlogged day as a good one: a gap ends the streak, today unlogged is pending', () => {
    let m = make({}, { name: 'Walk', kind: 'do' }, 1, 'hw').map
    m = logDays(m, 'hw', { '2026-10-17': 'good', '2026-10-18': 'good', '2026-10-20': 'good', '2026-10-21': 'good' })
    const st = habitStats({ habitLog: m }, 'hw', T)
    expect(st).toMatchObject({ current: 2, since: '2026-10-20', pending: true, best: 2 })
    expect(st.d30).toMatchObject({ free: 4, drank: 0, unlogged: 26 })
    expect(lastDays({ habitLog: m }, 'hw', 4, T).map(d => d.status)).toEqual([null, 'good', 'good', null])
    // a day taken back to Not logged stops counting
    m = withEntry(m, 'hw', '2026-10-21', { status: null }, { now: 50, ...at })
    expect(habitStats({ habitLog: m }, 'hw', T)).toMatchObject({ current: 0, best: 2 })
    expect(m[habitKey('hw', '2026-10-21')]).toEqual({ _ts: 50 })
  })

  it('a past day can be corrected and carry a private note; a future day cannot be written', () => {
    let m = make({}, { name: 'Walk' }, 1, 'hw').map
    m = withEntry(m, 'hw', '2026-09-01', { status: 'bad', note: 'Sick' }, { now: 5, ...at })
    m = withEntry(m, 'hw', '2026-09-01', { status: 'good' }, { now: 6, ...at })
    expect(entryOf({ habitLog: m }, 'hw', '2026-09-01')).toMatchObject({ status: 'good', note: 'Sick', count: null })
    expect(withEntry(m, 'hw', '2026-10-23', { status: 'good' }, { now: 7, ...at })).toBe(m)
    // and a count is Alcohol's alone
    expect(withEntry(m, 'hw', '2026-09-02', { status: 'bad', count: 3 }, { now: 8, ...at })[habitKey('hw', '2026-09-02')].n).toBeUndefined()
  })

  it('a day of a habit that does not exist (no definition) is not written', () => {
    expect(withEntry({}, 'hghost', T, { status: 'good' }, { now: 1, ...at })).toEqual({})
  })

  it('the calendar names each day\'s role, so any habit draws green and orange the same way', () => {
    let m = make({}, { name: 'Read' }, 1, 'hr').map
    m = logDays(m, 'hr', { '2026-10-21': 'bad', '2026-10-22': 'good' })
    const cells = calendarRows({ habitLog: m }, 'hr', 7, 1, T).flat().filter(c => !c.out)
    expect(cells.find(c => c.iso === '2026-10-21').role).toBe('bad')
    expect(cells.find(c => c.iso === '2026-10-22').role).toBe('good')
    expect(cells.find(c => c.iso === '2026-10-20').role).toBeNull()
  })
})

describe('time zones and the calendar', () => {
  it('a streak across a daylight-saving change counts each calendar day once', () => {
    let m = make({}, { name: 'Read' }, 1, 'hr').map
    // Europe moves its clocks on 2026-03-29, the US on 2026-03-08
    m = logDays(m, 'hr', { '2026-03-06': 'good', '2026-03-07': 'good', '2026-03-08': 'good', '2026-03-09': 'good' })
    m = logDays(m, 'hr', { '2026-03-28': 'good', '2026-03-29': 'good', '2026-03-30': 'good' }, 200)
    expect(habitStats({ habitLog: m }, 'hr', '2026-03-09')).toMatchObject({ current: 4 })
    expect(habitStats({ habitLog: m }, 'hr', '2026-03-30')).toMatchObject({ current: 3, best: 4 })
  })

  it('a day logged further east is held back until this device reaches it, for any habit', () => {
    let m = make({}, { name: 'Read' }, 1, 'hr').map
    m = withEntry(m, 'hr', '2026-10-23', { status: 'good' }, { now: 5, today: '2026-10-23', tz: 'Pacific/Auckland' })
    expect(habitStats({ habitLog: m }, 'hr', T)).toMatchObject({ current: 0, ahead: 1 })
    expect(habitStats({ habitLog: m }, 'hr', '2026-10-23')).toMatchObject({ current: 1, ahead: 0 })
    expect(entryOf({ habitLog: m }, 'hr', '2026-10-23').tz).toBe('Pacific/Auckland')
  })

  it('the definition entry is never read as a day', () => {
    const m = make({}, { name: 'Read' }, 1, 'hr').map
    expect(habitStats({ habitLog: m }, 'hr', T).d90.logged).toBe(0)
    expect(calendarRows({ habitLog: m }, 'hr', 90, 1, T).flat().some(c => c.status)).toBe(false)
  })
})

describe('reading a log with junk in it', () => {
  it('lists only habits whose definition can be read', () => {
    const log = {
      '|def': { name: 'x', _ts: 1 }, 'Bad Id|def': { name: 'x', _ts: 1 }, 'x|y|def': { name: 'x', _ts: 1 },
      'hok|def': { name: 'Fine', _ts: 1, at: 5 }, 'hnoname|def': { icon: 'star', _ts: 1 }, 'hcleared|def': { _ts: 2 },
      'hstr|def': 'Read', 'hnum|def': { name: 42, _ts: 1 },
    }
    expect(habitList({ habitLog: clone(log) }, { archived: null }).map(h => h.id)).toEqual(['alcohol', 'hok'])
  })
})
