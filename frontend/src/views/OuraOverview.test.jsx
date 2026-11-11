// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* Training & recovery: the Gymly log beside Oura's readings — each reading with its date, trends,
   weekly load, planned vs done, one workout list without doubles — with the provenance and sync
   state said, nothing written into the store, and no plan changed by a score. */
const TODAY = '2026-11-11'
const iso = n => new Date(Date.parse(TODAY + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10)
const T = Date.parse(TODAY + 'T17:00:00')
const m = vi.hoisted(() => ({ overview: null, err: null, navs: [], toasts: [], S: null, writes: 0, calls: [] }))
vi.mock('../lib/oura-api.js', async importOriginal => {
  const real = await importOriginal()
  return {
    ...real,
    ouraOverview: vi.fn(async days => { m.calls.push(['overview', days]); if (m.err) throw m.err; return m.overview }),
    ouraSync: vi.fn(async days => { m.calls.push(['sync', days]); return m.overview }),
  }
})
vi.mock('../lib/format.js', async importOriginal => ({ ...(await importOriginal()), todayISO: () => TODAY }))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ S: m.S, update: () => { m.writes++ } })
  const useStore = sel => (sel ? sel(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: msg => m.toasts.push(msg) })
  const useUI = sel => (sel ? sel(snap()) : snap())
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => (...a) => m.navs.push(a) }))

const api = await import('../lib/oura-api.js')
const { default: OuraOverview } = await import('./OuraOverview.jsx')

let host, root
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
async function mount() {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<OuraOverview />))
  await settle()
}
const q = sel => host.querySelector(sel)

beforeEach(() => {
  m.err = null; m.navs = []; m.toasts = []; m.writes = 0; m.calls = []
  m.S = {
    unit: 'kg', weekStart: 1, dayPlan: {},
    routines: [{ id: 'r-push', name: 'Push day' }, { id: 'r-legs', name: 'Leg day' }],
    week: { 1: 'r-push', 3: 'r-legs' },
    workouts: [
      { id: 'g-legs', d: TODAY, start: T, end: T + 55 * 60000, name: 'Leg day', entries: [{ id: '1', sets: [{ w: 100, r: 5, rir: 2, done: true }, { w: 100, r: 5, rir: 1, done: true }] }] },
    ],
  }
  // Today has no sleep yet (the ring has not synced the night): the latest sleep is yesterday's.
  const days = Array.from({ length: 40 }, (_, i) => ({
    day: iso(i),
    readiness: { score: i === 0 ? 86 : 75 },
    ...(i === 0 ? {} : { sleep: { score: 80, totalSec: 27000, averageHrv: i < 7 ? 45 : 55, lowestHeartRate: i < 7 ? 52 : 48 } }),
    activity: { steps: 8000 + i },
    ...(i === 1 ? { stress: { summary: 'stressful' }, spo2: { average: 96.5 }, cardio: { vascularAge: 31, vo2Max: 46 } } : {}),
  }))
  m.overview = {
    days, lastSync: Date.parse(TODAY + 'T08:15:00'), lastError: null, tz: 'Europe/Berlin',
    workouts: [
      { id: 'o-str', day: TODAY, activity: 'strength_training', start: T + 6 * 60000, end: T + 50 * 60000, calories: 240, intensity: 'moderate' },
      { id: 'o-run', day: iso(1), activity: 'running', start: T - 86400000 + 3600e3, end: T - 86400000 + 5400e3, calories: 380, distance: 6000, intensity: 'hard' },
    ],
    available: { daily_readiness: 'ok', heartrate: 'not-shared' },
  }
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('Training & recovery', () => {
  it('says where each side comes from, when Oura last synced, and that scores never change the plan', async () => {
    await mount()
    const p = q('[data-oura-provenance]').textContent
    expect(p).toMatch(/from your Gymly log/)
    expect(p).toMatch(/from Oura, read-only/)
    expect(p).toMatch(/Synced/)
    expect(p).toMatch(/never changes your plan or weights because of an Oura score/)
  })

  it('every latest reading carries the day it was measured; a missing one is not a zero', async () => {
    await mount()
    const reading = label => q(`[data-reading="${label}"]`).textContent
    expect(reading('Readiness')).toMatch(/86/)
    // no sleep yet today: the sleep figures are yesterday's, and say so
    const yd = q(`[data-oura-days] tr[data-day="${iso(1)}"] th`).textContent
    expect(reading('HRV')).toContain('45 ms')
    expect(reading('HRV')).toContain(yd)
    expect(reading('Lowest heart rate')).toContain('52 bpm')
    expect(q('[data-oura-today]').textContent).toMatch(/Stress: Stressful/)
  })

  it('HRV and lowest heart rate: last 7 days against the 30 before', async () => {
    await mount()
    const hrv = q('[data-trend="HRV"]').textContent
    expect(hrv).toContain('45 ms')
    expect(hrv).toMatch(/↓10 ms vs the 30 days before \(55 ms\)/)
    expect(q('[data-trend="Lowest heart rate"]').textContent).toMatch(/↑4 bpm vs the 30 days before \(48 bpm\)/)
  })

  it('weekly load from the Gymly log, with that week\'s Oura averages beside it', async () => {
    await mount()
    const first = q('[data-oura-load] tbody tr').textContent
    expect(first).toContain('2')         // sets
    expect(first).toContain('1,000 kg')  // volume
    expect(first).toContain('1.5')       // average RIR
  })

  it('day by day: planned by the schedule, done from the log, not-done said plainly', async () => {
    await mount()
    const today = q(`[data-oura-days] tr[data-day="${TODAY}"]`).textContent
    expect(today).toContain('Leg day')
    expect(today).toContain('2 · 1.5')
    const monday = q(`[data-oura-days] tr[data-day="${iso(2)}"]`).textContent   // 2026-11-09, Push planned
    expect(monday).toContain('Push day')
    expect(monday).toContain('not done')
  })

  it('one workout list: a session both logged and detected once, a run only Oura saw stays Oura\'s', async () => {
    await mount()
    const kinds = [...host.querySelectorAll('[data-oura-workouts] [data-kind]')].map(e => e.dataset.kind)
    expect(kinds).toEqual(['both', 'oura'])
    expect(q('[data-oura-workouts]').textContent).toMatch(/1 cardio or other activities recorded by Oura/)
    expect(q('[data-oura-workouts]').textContent).toContain('6 km')
  })

  it('asks for enough days for the trends, names what Oura did not share, and writes nothing to the store', async () => {
    await mount()
    expect(m.calls[0]).toEqual(['overview', 37])
    expect(q('[data-oura-not-shared]').textContent).toContain('Heart rate')
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Sync now').click())
    await settle()
    expect(api.ouraSync).toHaveBeenCalledWith(37)
    expect(m.writes).toBe(0)
    expect(JSON.stringify(m.S)).not.toMatch(/o-str|readiness|strength_training/)
  })

  it('a failed last sync is said, and what was synced before still shows', async () => {
    m.overview.lastError = 'rate'
    await mount()
    expect(q('[data-oura-provenance]').textContent).toMatch(/the last sync failed \(rate\)/)
    expect(q('[data-reading="Readiness"]').textContent).toMatch(/86/)
  })

  it('a connection that is gone asks to connect again', async () => {
    m.err = Object.assign(new Error('x'), { status: 409, data: { code: 'reauth' } })
    await mount()
    expect(q('[data-oura-error]').textContent).toBe('Oura needs to be connected again.')
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Connect Oura again').click())
    expect(m.navs.at(-1)).toEqual(['/settings/data'])
  })
})
