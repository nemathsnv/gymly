// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { entryOf, createHabit, withHabit, statusOn } from '../lib/habits.js'
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
const manageButton = () => [...host.querySelectorAll('.habits-card button')].find(b => b.textContent === 'Manage habits')
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
    expect(nav).not.toHaveBeenCalled()   // a check-in tap never navigates
    click(manageButton())
    expect(nav).toHaveBeenCalledWith('/habits')
    click(host.querySelector('.habit-row .row.between'))
    expect(nav).toHaveBeenCalledWith('/habits/alcohol')
  })

  it('has a labelled "Manage habits" button in the header instead of a header chevron', () => {
    mountWith(true)
    const header = host.querySelector('.habits-card-hdr')
    expect(header.querySelector('h2').textContent).toBe('Habits')
    expect(manageButton().tagName).toBe('BUTTON')
    expect(manageButton().textContent).toBe('Manage habits')
    expect(header.querySelector('.chev')).toBeNull()
    expect(header.getAttribute('role')).toBeNull()
    // the habit rows keep their chevron
    expect(host.querySelectorAll('.habit-row .row.between .chev').length).toBe(1)
  })

  it('keeps the card, the title and the check-in buttons from navigating on their own', () => {
    mountWith(true)
    click(host.querySelector('.habits-card'))
    click(host.querySelector('.habits-card-hdr h2'))
    click(host.querySelector('.habit-btn'))
    expect(nav).not.toHaveBeenCalled()
    click(host.querySelector('.habit-name'))
    expect(nav).toHaveBeenCalledTimes(1)
    expect(nav).toHaveBeenCalledWith('/habits/alcohol')
  })

  it('has no interactive element inside another one', () => {
    mountWith(true)
    const sel = 'button, a[href], [role="button"], [tabindex]'
    const targets = [...host.querySelectorAll('.habits-card')].flatMap(c => [...c.querySelectorAll(sel)])
    expect(targets.length).toBeGreaterThan(3)
    for (const el of targets) expect(el.parentElement.closest(sel)).toBeNull()
  })

  it('shows every active habit with its own check-in, and none of the archived ones', () => {
    let log = createHabit({}, { name: 'Read', kind: 'do' }, { now: 1, id: 'hread' }).map
    log = createHabit(log, { name: 'Old habit', kind: 'avoid' }, { now: 2, id: 'hold' }).map
    log = withHabit(log, 'hold', { archived: true }, { now: 3 })
    mountWith(true, log)
    const rows = [...host.querySelectorAll('.habit-row')]
    expect(rows.map(r => r.querySelector('.habit-name').textContent)).toEqual(['Alcohol', 'Read'])
    click([...rows[1].querySelectorAll('.habit-btn')].find(b => b.textContent === 'Done'))
    expect(statusOn(useStore.getState().S, 'hread', '2026-10-22', '2026-10-22')).toBe('good')
    expect(statusOn(useStore.getState().S, 'alcohol', '2026-10-22', '2026-10-22')).toBeNull()
    click(rows[1].querySelector('.row.between'))
    expect(nav).toHaveBeenCalledWith('/habits/hread')
  })

  it('with every habit archived, says so instead of showing buttons', () => {
    mountWith(true, withHabit({}, 'alcohol', { archived: true }, { now: 1 }))
    expect(host.querySelector('.habit-btns')).toBeNull()
    expect(host.textContent).toContain('No active habits')
  })
})
