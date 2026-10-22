// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { entryOf } from '../lib/habits.js'
import Home from './Home.jsx'

const nav = vi.fn()
vi.mock('react-router-dom', () => ({ useNavigate: () => nav }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), bwSheet: vi.fn(), goalSheet: vi.fn(), dayOverrideSheet: vi.fn(),
  calendarSheet: vi.fn(), startFlow: vi.fn(), bwDeltaColor: () => '',
}))

let host, root
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-22T12:00:00'))
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  nav.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

const mountWith = (habitsOn, habitLog = {}) => {
  useStore.setState(s => ({
    S: { ...s.S, routines: [], workouts: [], bodyweight: [], dayPlan: {}, week: {}, active: null, habitsOn, habitLog },
    user: null,
  }))
  act(() => root.render(<Home />))
}
const click = el => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

describe('Home habits card', () => {
  it('is there for a profile that never chose, and for one that switched it on', () => {
    mountWith(undefined)
    expect(host.querySelector('.habit-btns')).toBeTruthy()
    mountWith(true)
    expect(host.querySelector('.habit-btns')).toBeTruthy()
  })

  it('is gone when switched off, and the log is untouched', () => {
    const log = { 'alcohol|2026-10-21': { s: 'free', _ts: 1 } }
    mountWith(false, log)
    expect(host.querySelector('.habit-btns')).toBeNull()
    expect(useStore.getState().S.habitLog).toEqual(log)
  })

  it('logs today in one tap and opens the Habits screen from the card', () => {
    mountWith(true)
    click([...host.querySelectorAll('.habit-btn')].find(b => b.textContent === 'No alcohol'))
    expect(entryOf(useStore.getState().S, 'alcohol', '2026-10-22').status).toBe('free')
    expect(host.textContent).toContain('Alcohol-free streak (days): 1')
    click(host.querySelector('.habit-btns').closest('.card').querySelector('.row.between'))
    expect(nav).toHaveBeenCalledWith('/habits')
  })
})
