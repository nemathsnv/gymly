// @vitest-environment happy-dom
// Home's Your week card (lib/recap.js, components/Recap.jsx): on the profile's first weekday, under
// the today card and above the other Home cards; Settings → On Home → Week and month recap hides it.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import Home from './Home.jsx'

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), bwSheet: vi.fn(), goalSheet: vi.fn(), dayOverrideSheet: vi.fn(),
  calendarSheet: vi.fn(), startFlow: vi.fn(), bwDeltaColor: () => '', weighInsSheet: vi.fn(), confirmSheet: vi.fn(),
}))

const BENCH = '0025'
const wk = d => ({ id: 'w' + d, d, start: new Date(d + 'T10:00:00').getTime(), end: new Date(d + 'T11:00:00').getTime(), entries: [{ id: BENCH, sets: [{ w: 60, r: 8, done: true }] }] })
let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers({ toFake: ['Date'] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

const mountOn = (now, extra = {}) => {
  vi.setSystemTime(new Date(now))
  useStore.setState(s => ({
    S: { ...s.S, routines: [], workouts: [wk('2026-10-21')], bodyweight: [], dayPlan: {}, week: {}, active: null, weekStart: 1, checkIn: true, ...extra },
    user: null,
  }))
  // A fresh Home each time: today is read when Home mounts (lib/use-today.js).
  act(() => root.unmount())
  root = createRoot(host)
  act(() => root.render(<Home />))
}
const card = () => host.querySelector('.recap-card')

describe('Home recap card', () => {
  it('shows on the week’s first day, between the today card and the check-in card', () => {
    mountOn('2026-10-26T08:00:00')
    expect(card()).not.toBeNull()
    expect(card().querySelector('.ttl').textContent).toBe('Your week')
    const cards = [...host.querySelectorAll('.card')]
    const at = cards.indexOf(card())
    expect(at).toBeGreaterThan(0)
    expect(cards[at + 1].textContent).toContain('Check in')
  })

  it('follows the week start: with Sunday first it shows on Sunday, not Monday', () => {
    mountOn('2026-10-26T08:00:00', { weekStart: 0 })
    expect(card()).toBeNull()
    mountOn('2026-10-25T08:00:00', { weekStart: 0 })
    expect(card()).not.toBeNull()
  })

  it('is gone when switched off, and the × puts it away', () => {
    mountOn('2026-10-26T08:00:00', { recap: false })
    expect(card()).toBeNull()
    mountOn('2026-10-26T08:00:00', { recap: true })
    act(() => card().querySelector('[aria-label="Put it away"]').click())
    expect(useStore.getState().S.recapSeen).toBe('w:2026-10-19')
    expect(card()).toBeNull()
  })
})
