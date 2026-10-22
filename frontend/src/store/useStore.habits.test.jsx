// @vitest-environment happy-dom

/* The habit log through the store: it is written to this device's saved copy, pushed to the
   server with the profile, merged with another device's on a 409, restored by a backup, taken by
   "Reset everything", and never carried from one account to another. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn() }) } }))

import { api } from '../lib/api.js'
import { DEF, useStore } from './useStore.js'
import { setHabitStatus } from '../components/HabitButtons.jsx'
import { withEntry, statusOn, entryOf, createHabit, withHabit, habitOf, habitList } from '../lib/habits.js'
import { todayISO } from '../lib/format.js'
import { mergeStates } from '../lib/sync-merge.js'

const clone = v => JSON.parse(JSON.stringify(v))
const puts = () => api.mock.calls.filter(([, o]) => o?.method === 'PUT').map(([, o]) => JSON.parse(o.body))
const S = () => useStore.getState().S
const httpError = (status, data) => Object.assign(new Error('HTTP ' + status), { status, data })
const T = '2026-10-22'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-22T12:00:00'))
  localStorage.clear(); api.mockReset()
  useStore.setState({ S: { ...clone(DEF), _ts: 1 }, user: null, ready: true })
})
afterEach(() => { vi.useRealTimers(); localStorage.clear(); useStore.setState({ S: clone(DEF), user: null, ready: false }) })

describe('writing a day', () => {
  it('a tap writes the entry into the state and the saved copy on this device', () => {
    setHabitStatus('alcohol', todayISO(), { status: 'free' })
    expect(S().habitLog['alcohol|' + T]).toMatchObject({ s: 'free' })
    expect(JSON.parse(localStorage.getItem('gym_state_v1')).habitLog['alcohol|' + T].s).toBe('free')
  })

  it('a past day can be edited, and a future day cannot be written', () => {
    setHabitStatus('alcohol', '2026-10-10', { status: 'drank', count: 4, note: 'Wedding' })
    expect(entryOf(S(), 'alcohol', '2026-10-10')).toMatchObject({ status: 'drank', count: 4, note: 'Wedding' })
    setHabitStatus('alcohol', '2026-10-10', { status: 'free' })
    expect(entryOf(S(), 'alcohol', '2026-10-10')).toMatchObject({ status: 'free', count: null, note: 'Wedding' })
    setHabitStatus('alcohol', '2026-10-23', { status: 'free' })
    expect(S().habitLog['alcohol|2026-10-23']).toBeUndefined()
  })

  it('does not touch workouts, routines or the plan', () => {
    useStore.getState().update(s => { s.routines = [{ id: 'r1', name: 'A', ex: [] }]; s.week = { 1: 'r1' }; s.workouts = [{ id: 'w1', d: '2026-10-20', start: 1, entries: [] }] })
    const before = clone(S())
    setHabitStatus('alcohol', T, { status: 'drank' })
    const after = S()
    for (const k of ['routines', 'week', 'workouts', 'dayPlan', 'dayNotes', 'bodyweight', 'active']) expect(after[k]).toEqual(before[k])
  })
})

describe('sync', () => {
  const signedIn = state => useStore.setState({ S: state, user: { id: 'u1' }, ready: true })

  it('the log goes to the server with the rest of the profile', async () => {
    signedIn({ ...clone(DEF), _ts: 1 })
    localStorage.setItem('gym_sync', JSON.stringify({ rev: 1, ts: 1 }))
    api.mockImplementation(async (p, o) => (o?.method === 'PUT' ? { ok: true, rev: 2 } : { state: {}, rev: 1 }))
    setHabitStatus('alcohol', T, { status: 'free', note: 'Private line' })
    await useStore.getState().pushState()
    expect(puts().at(-1).state.habitLog['alcohol|' + T]).toMatchObject({ s: 'free', note: 'Private line' })
  })

  it('a 409 merges the other device\'s days with this one\'s', async () => {
    signedIn({ ...clone(DEF), _ts: 1 })
    localStorage.setItem('gym_sync', JSON.stringify({ rev: 1, ts: 1 }))
    // the phone logged the 20th while this desktop logged the 21st
    const phone = { ...clone(DEF), _ts: Date.now(), habitLog: withEntry({}, 'alcohol', '2026-10-20', { status: 'drank' }, { now: Date.now(), today: T, tz: 'UTC' }), _rev: 2 }
    let doc = phone
    api.mockImplementation(async (p, o) => {
      if (o?.method !== 'PUT') return { state: clone(doc), rev: doc._rev }
      const body = JSON.parse(o.body)
      if (body.baseRev != null && body.baseRev !== doc._rev) throw httpError(409, { error: 'conflict', rev: doc._rev, state: clone(doc) })
      doc = { ...body.state, _rev: doc._rev + 1 }
      return { ok: true, rev: doc._rev }
    })
    setHabitStatus('alcohol', '2026-10-21', { status: 'free' })
    await useStore.getState().pushState()
    await useStore.getState().pushState()
    for (const copy of [S(), doc]) {
      expect(statusOn(copy, 'alcohol', '2026-10-20', T)).toBe('drank')
      expect(statusOn(copy, 'alcohol', '2026-10-21', T)).toBe('free')
    }
  })
})

describe('backup and reset', () => {
  it('the exported backup holds the log, and importing it brings every day back', () => {
    setHabitStatus('alcohol', '2026-10-19', { status: 'free' })
    setHabitStatus('alcohol', '2026-10-20', { status: 'drank', count: 2, note: 'Birthday' })
    const backup = JSON.parse(JSON.stringify(useStore.getState().S, null, 2))   // what Settings → Export writes
    expect(backup.habitLog['alcohol|2026-10-20']).toMatchObject({ s: 'drank', n: 2, note: 'Birthday' })
    useStore.setState({ S: { ...clone(DEF), _ts: 1 } })
    expect(S().habitLog).toEqual({})
    useStore.getState().importBackup(backup)
    expect(entryOf(S(), 'alcohol', '2026-10-19').status).toBe('free')
    expect(entryOf(S(), 'alcohol', '2026-10-20')).toMatchObject({ status: 'drank', count: 2, note: 'Birthday' })
  })

  it('a backup from before habits existed imports with an empty log', () => {
    const old = clone(DEF); delete old.habitLog; delete old.habitsOn
    useStore.getState().importBackup(old)
    expect(S().habitLog).toEqual({})
    expect(S().habitsOn).toBe(true)
  })

  it('"Reset everything" empties the log', async () => {
    setHabitStatus('alcohol', T, { status: 'free' })
    await useStore.getState().resetEverything()
    expect(S().habitLog).toEqual({})
  })

  it('switching the Habits switch off keeps the log', () => {
    setHabitStatus('alcohol', T, { status: 'free' })
    useStore.getState().update(s => { s.habitsOn = false })
    expect(S().habitsOn).toBe(false)
    expect(statusOn(S(), 'alcohol', T, T)).toBe('free')
  })
})

describe('one account\'s log is not another\'s', () => {
  it('account B signing in on a device last used by account A neither inherits nor pushes A\'s log', async () => {
    // The device's copy belongs to A (gym_owner); the sign-in machinery sets it aside for A
    // (keepForPrevious) rather than letting B's pull or push touch it.
    setHabitStatus('alcohol', T, { status: 'drank', note: 'A-PRIVATE' })
    localStorage.setItem('gym_owner', 'A')
    const serverB = { ...clone(DEF), _ts: 5, habitLog: {}, workouts: [], _rev: 3 }
    api.mockImplementation(async (p, o) => (o?.method === 'PUT' ? { ok: true, rev: 4 } : { state: clone(serverB), rev: 3 }))
    useStore.getState().setUser({ id: 'B', name: 'B' })
    await useStore.getState().pullState().catch(() => {})
    await useStore.getState().pushState().catch(() => {})
    expect(JSON.stringify(puts())).not.toContain('A-PRIVATE')
    expect(JSON.stringify(S().habitLog)).not.toContain('A-PRIVATE')
  })

  it('the same account\'s two devices keep both devices\' notes', () => {
    const a = { ...clone(DEF), _ts: 2, habitLog: withEntry({}, 'alcohol', '2026-10-20', { note: 'x' }, { now: 2, today: T }) }
    const b = { ...clone(DEF), _ts: 3, habitLog: withEntry({}, 'alcohol', '2026-10-21', { note: 'y' }, { now: 3, today: T }) }
    expect(Object.keys(mergeStates(a, b).habitLog)).toHaveLength(2)
  })
})

// --- habits of the user's own ---
describe('habits of your own, through the store', () => {
  const addHabit = (fields, id) => { useStore.getState().update(s => { s.habitLog = createHabit(s.habitLog, fields, { id }).map }) }

  it('a habit made on this device is in the saved copy (a reload or restart reads it) and its days with it', () => {
    addHabit({ name: 'Read', kind: 'do', icon: 'note', color: 'blue' }, 'hread')
    setHabitStatus('hread', T, { status: 'good', note: 'Chapter 3' })
    const saved = JSON.parse(localStorage.getItem('gym_state_v1'))
    const reloaded = Object.assign(clone(DEF), saved)
    expect(habitOf(reloaded, 'hread')).toMatchObject({ name: 'Read', kind: 'do', icon: 'note', color: 'blue' })
    expect(entryOf(reloaded, 'hread', T)).toMatchObject({ status: 'good', note: 'Chapter 3' })
  })

  it('goes to the server with the profile, and a 409 merges both devices\' habits', async () => {
    useStore.setState({ S: { ...clone(DEF), _ts: 1 }, user: { id: 'u1' }, ready: true })
    localStorage.setItem('gym_sync', JSON.stringify({ rev: 1, ts: 1 }))
    const phone = { ...clone(DEF), _ts: Date.now(), habitLog: createHabit({}, { name: 'Walk' }, { now: Date.now(), id: 'hwalk' }).map, _rev: 2 }
    let doc = phone
    api.mockImplementation(async (p, o) => {
      if (o?.method !== 'PUT') return { state: clone(doc), rev: doc._rev }
      const body = JSON.parse(o.body)
      if (body.baseRev != null && body.baseRev !== doc._rev) throw httpError(409, { error: 'conflict', rev: doc._rev, state: clone(doc) })
      doc = { ...body.state, _rev: doc._rev + 1 }
      return { ok: true, rev: doc._rev }
    })
    addHabit({ name: 'Read' }, 'hread')
    setHabitStatus('hread', T, { status: 'good' })
    await useStore.getState().pushState()
    await useStore.getState().pushState()
    for (const copy of [S(), doc]) {
      expect(habitList(copy).map(h => h.id)).toEqual(['alcohol', 'hread', 'hwalk'])
      expect(statusOn(copy, 'hread', T, T)).toBe('good')
    }
  })

  it('a backup restores every habit with its days, and replacing the profile with an older one takes away the habits it does not hold', () => {
    addHabit({ name: 'Read' }, 'hread')
    setHabitStatus('hread', '2026-10-20', { status: 'good' })
    const backup = JSON.parse(JSON.stringify(S()))
    addHabit({ name: 'Made after the backup' }, 'hlater')
    useStore.getState().importBackup(backup)
    expect(habitList(S()).map(h => h.id)).toEqual(['alcohol', 'hread'])
    expect(statusOn(S(), 'hread', '2026-10-20', T)).toBe('good')
    // …and the habit it did not hold is cleared, not dropped, so another device's copy cannot bring it back
    expect(S().habitLog['hlater|def']).toEqual({ _ts: expect.any(Number) })
  })

  it('"Reset everything" takes the habits away with their days', async () => {
    addHabit({ name: 'Read' }, 'hread')
    setHabitStatus('hread', T, { status: 'good' })
    await useStore.getState().resetEverything()
    expect(habitList(S(), { archived: null }).map(h => h.id)).toEqual(['alcohol'])
    expect(S().habitLog).toEqual({})
  })

  it('archiving keeps the days in the saved copy', () => {
    addHabit({ name: 'Read' }, 'hread')
    setHabitStatus('hread', T, { status: 'good' })
    useStore.getState().update(s => { s.habitLog = withHabit(s.habitLog, 'hread', { archived: true }) })
    const saved = JSON.parse(localStorage.getItem('gym_state_v1'))
    expect(habitOf(saved, 'hread').archived).toBe(true)
    expect(statusOn(saved, 'hread', T, T)).toBe('good')
  })

  it('account B signing in on a device last used by account A neither inherits nor pushes A\'s habits', async () => {
    addHabit({ name: 'A-PRIVATE-HABIT' }, 'hpriv')
    setHabitStatus('hpriv', T, { status: 'bad', note: 'A-PRIVATE-NOTE' })
    localStorage.setItem('gym_owner', 'A')
    const serverB = { ...clone(DEF), _ts: 5, habitLog: {}, workouts: [], _rev: 3 }
    api.mockImplementation(async (p, o) => (o?.method === 'PUT' ? { ok: true, rev: 4 } : { state: clone(serverB), rev: 3 }))
    useStore.getState().setUser({ id: 'B', name: 'B' })
    await useStore.getState().pullState().catch(() => {})
    await useStore.getState().pushState().catch(() => {})
    expect(JSON.stringify(puts())).not.toMatch(/A-PRIVATE|hpriv/)
    expect(JSON.stringify(S().habitLog)).not.toMatch(/A-PRIVATE|hpriv/)
    expect(habitList(S()).map(h => h.id)).toEqual(['alcohol'])
  })
})
