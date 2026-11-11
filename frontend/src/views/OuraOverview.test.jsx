// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The recovery overview: Oura's numbers by day next to Gymly's sessions, one workout list where a
   session both logged and detected shows once, and none of it written into the store. */
const TODAY = '2026-11-10', YDAY = '2026-11-09'
const T = Date.parse(TODAY + 'T17:00:00+01:00')
const m = vi.hoisted(() => ({ overview: null, err: null, navs: [], toasts: [], S: null, writes: 0 }))
vi.mock('../lib/oura-api.js', async importOriginal => {
  const real = await importOriginal()
  return {
    ...real,
    ouraOverview: vi.fn(async () => { if (m.err) throw m.err; return m.overview }),
    ouraSync: vi.fn(async () => ({ ...m.overview, cached: false })),
  }
})
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

beforeEach(() => {
  m.err = null; m.navs = []; m.toasts = []; m.writes = 0
  m.S = { workouts: [
    { id: 'g-push', d: TODAY, start: T, end: T + 55 * 60000, name: 'Push day' },
    { id: 'g-legs', d: YDAY, start: T - 86400000 - 3 * 3600e3, end: T - 86400000 - 2 * 3600e3, name: 'Leg day' },
  ] }
  m.overview = {
    fetchedAt: Date.now(), days: 14, cached: false,
    days: [
      { day: TODAY, readiness: { score: 86 }, sleep: { score: 74, totalSec: 26100, averageHrv: 51, lowestHeartRate: 48 }, activity: { score: 66, steps: 10234 }, stress: { summary: 'restored' }, spo2: { average: 96.8 }, cardio: { vascularAge: 30, vo2Max: 46 } },
      { day: YDAY, readiness: { score: 62 }, sleep: { score: 68, totalSec: 21000 } },
    ],
    workouts: [
      { id: 'o-str', day: TODAY, activity: 'strength_training', start: T + 6 * 60000, end: T + 50 * 60000, calories: 240, intensity: 'moderate' },
      { id: 'o-run', day: YDAY, activity: 'running', start: T - 86400000 + 3600e3, end: T - 86400000 + 5400e3, calories: 380, intensity: 'hard' },
    ],
    available: { daily_readiness: 'ok', daily_spo2: 'ok', heartrate: 'not-shared', vO2_max: 'ok' },
  }
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('OuraOverview', () => {
  it('today\'s scores with Oura\'s bands, sleep, HRV, heart rate, stress, SpO2, cardio', async () => {
    await mount()
    const today = host.querySelector('[data-oura-today]').textContent
    expect(today).toContain('86'); expect(today).toContain('Optimal')
    expect(today).toContain('Slept 7h 15m')
    expect(today).toContain('HRV 51 ms')
    expect(today).toContain('Lowest heart rate 48 bpm')
    expect(today).toContain('Stress: Restored')
    expect(today).toContain('SpO2 96.8%')
    expect(today).toContain('Cardiovascular age 30 · VO2 max 46')
  })

  it('the day table counts the Gymly sessions of each day', async () => {
    await mount()
    const rows = [...host.querySelectorAll('[data-oura-days] tbody tr')]
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('1 session(s)')
    expect(rows[0].textContent).toContain('10,234')
  })

  it('a session logged in Gymly and detected by Oura is one entry; a run only Oura saw stays Oura\'s', async () => {
    await mount()
    const entries = [...host.querySelectorAll('[data-oura-workouts] [data-kind]')]
    expect(entries.map(e => e.dataset.kind)).toEqual(['both', 'oura', 'gymly'])
    expect(entries[0].textContent).toContain('Push day')
    expect(entries[0].textContent).toContain('Gymly + Oura')
    expect(entries[0].textContent).toContain('Oura: Strength training')
    expect(entries[1].textContent).toContain('Running')
    expect(entries[2].textContent).toContain('Leg day')
  })

  it('names what Oura did not share', async () => {
    await mount()
    expect(host.querySelector('[data-oura-not-shared]').textContent).toContain('Heart rate')
  })

  it('never writes Oura data into the store', async () => {
    await mount()
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Sync now').click())
    await settle()
    expect(api.ouraSync).toHaveBeenCalledWith(14)
    expect(m.writes).toBe(0)
    expect(JSON.stringify(m.S)).not.toMatch(/o-str|readiness|strength_training/)
  })

  it('a connection that is gone asks to connect again', async () => {
    m.err = Object.assign(new Error('x'), { status: 409, data: { code: 'reauth' } })
    await mount()
    expect(host.querySelector('[data-oura-error]').textContent).toBe('Oura needs to be connected again.')
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Connect Oura again').click())
    expect(m.navs.at(-1)).toEqual(['/settings/data'])
  })
})
