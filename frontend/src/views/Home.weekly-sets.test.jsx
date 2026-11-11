// @vitest-environment happy-dom
// Settings → Look & Home → Weekly sets on Home: one line under the streak, the muscle with the
// most room left this week. Off by default; a button of its own, not one inside the streak's tap
// area (which opens the calendar).
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { todayISO } from '../lib/format.js'
import Home from './Home.jsx'

const mocks = vi.hoisted(() => ({ nav: null, calendarSheet: null }))
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.nav }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), bwSheet: vi.fn(), goalSheet: vi.fn(), dayOverrideSheet: vi.fn(),
  calendarSheet: (...a) => mocks.calendarSheet(...a), startFlow: vi.fn(), bwDeltaColor: () => '', weighInsSheet: vi.fn(), confirmSheet: vi.fn(),
}))

const BENCH = '0025'
let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mocks.nav = vi.fn()
  mocks.calendarSheet = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const bench = { id: 'w1', d: todayISO(), start: Date.now(), entries: [{ id: BENCH, sets: [{ w: 60, r: 8, done: true }, { w: 60, r: 8, done: true }] }] }
const mountWith = extra => {
  useStore.setState(s => ({
    S: { ...s.S, routines: [], workouts: [bench], bodyweight: [], dayPlan: {}, week: {}, active: null, ...extra },
    user: null,
  }))
  act(() => root.render(<Home />))
}
const line = () => host.querySelector('.wsets-home')

describe('Home weekly sets line', () => {
  it('is off unless switched on', () => {
    mountWith({})
    expect(line()).toBeNull()
    mountWith({ homeMuscleSets: false })
    expect(line()).toBeNull()
  })

  it('sits under the streak, names the muscle with the most room and opens its Stats card', () => {
    mountWith({ homeMuscleSets: true })
    expect(line().textContent).toMatch(/^Most room this week: .+, 0 of \d+–\d+ sets$/)
    expect(line().closest('.streak-card')).not.toBeNull()
    act(() => line().click())
    expect(mocks.nav).toHaveBeenCalledWith('/stats?focus=weekly-sets')
    expect(mocks.calendarSheet).not.toHaveBeenCalled()
  })

  it('is never inside the streak’s tap area, which still opens the calendar', () => {
    mountWith({ homeMuscleSets: true })
    expect(line().closest('[role="button"]')).toBeNull()
    act(() => host.querySelector('.streak-tap').click())
    expect(mocks.calendarSheet).toHaveBeenCalled()
  })
})
