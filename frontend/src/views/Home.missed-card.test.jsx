// @vitest-environment happy-dom
// The missed-workout card on Home (components/MissedCard.jsx, lib/reschedule.js): it names the
// scheduled sessions that went by without a workout and changes nothing until one of Reschedule,
// Skip or Keep schedule is picked. After a reschedule, the Today row shows the moved session.
import React, { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { DEF, useStore } from '../store/useStore.js'
import { planReschedule, applyReschedule } from '../lib/reschedule.js'
import { rescheduleSheet } from '../sheets.jsx'
import Home from './Home.jsx'

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), bwSheet: vi.fn(), goalSheet: vi.fn(), dayOverrideSheet: vi.fn(),
  calendarSheet: vi.fn(), startFlow: vi.fn(), bwDeltaColor: () => '', weighInsSheet: vi.fn(), confirmSheet: vi.fn(),
  rescheduleSheet: vi.fn(),
}))

const clone = v => JSON.parse(JSON.stringify(v))
const ex = n => Array.from({ length: n }, (_, i) => ({ id: String(198 + i).padStart(4, '0'), sets: 3 }))
const routines = [
  { id: 'ua', name: 'Upper Body A', ex: ex(3) }, { id: 'la', name: 'Lower Body A', ex: ex(3) },
  { id: 'cc', name: 'Cardio + Core', ex: ex(2) }, { id: 'ub', name: 'Upper Body B', ex: ex(3) },
  { id: 'lb', name: 'Lower Body B', ex: ex(3) },
]
const week = { 1: ['ua'], 2: ['la'], 3: ['cc'], 4: ['ub'], 5: ['lb'], 6: ['cc'] }
const workouts = [{ id: 'w1', d: '2026-11-14', name: 'Cardio + Core', routineId: 'cc', routineIds: ['cc'], start: 1, end: 2, entries: [] }]

let host, root
beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 17, 10, 0)) })
afterAll(() => vi.useRealTimers())
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.mocked(rescheduleSheet).mockReset()
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear() })

const mountWith = over => {
  useStore.setState({ S: { ...clone(DEF), routines: clone(routines), week: clone(week), workouts: clone(workouts), dayPlan: {}, ...over }, user: null, ready: true })
  act(() => root.render(<Home />))
}
const card = () => [...host.querySelectorAll('.card')].find(c => /Missed workout/.test(c.querySelector('h2')?.textContent || ''))
const button = label => [...card().querySelectorAll('button')].find(b => b.textContent === label)
const click = el => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const todayRow = () => host.querySelector('.today-row .ttl').textContent

describe('Home missed-workout card', () => {
  it('names the session missed on Monday and leaves today as planned until asked', () => {
    mountWith({})
    expect(card().textContent).toContain('Upper Body A')
    expect(todayRow()).toBe('Lower Body A')
  })

  it('Reschedule opens the preview for the missed days and changes nothing by itself', () => {
    mountWith({})
    click(button('Reschedule'))
    expect(rescheduleSheet).toHaveBeenCalledWith(['2026-11-16'])
    expect(useStore.getState().S.dayPlan).toEqual({})
  })

  it('with several missed days, a row reschedules just that day and the button all of them', () => {
    mountWith({ dayPlan: { '2026-11-15': 'lb' } })
    const rows = card().querySelectorAll('.item')
    expect(rows).toHaveLength(2)
    click(rows[1])
    expect(rescheduleSheet).toHaveBeenLastCalledWith(['2026-11-16'])
    click(button('Reschedule all'))
    expect(rescheduleSheet).toHaveBeenLastCalledWith(['2026-11-15', '2026-11-16'])
  })

  it('after the reschedule is applied, today shows Upper Body A and the card is gone', () => {
    mountWith({})
    act(() => useStore.getState().update(s => { applyReschedule(s, planReschedule(s, { missed: ['2026-11-16'], today: '2026-11-17' })) }))
    expect(todayRow()).toBe('Upper Body A · rescheduled')
    expect(card()).toBeUndefined()
    expect(useStore.getState().S.week).toEqual(week)
  })

  it('Skip lets it go without shifting anything', () => {
    mountWith({})
    click(button('Skip'))
    expect(card()).toBeUndefined()
    expect(useStore.getState().S.missedDays['2026-11-16']).toMatchObject({ act: 'skipped' })
    expect(useStore.getState().S.dayPlan).toEqual({})
    expect(todayRow()).toBe('Lower Body A')
  })

  it('Keep schedule changes nothing and stops asking', () => {
    mountWith({})
    click(button('Keep schedule'))
    expect(card()).toBeUndefined()
    expect(useStore.getState().S.missedDays['2026-11-16']).toMatchObject({ act: 'kept' })
    expect(useStore.getState().S.dayPlan).toEqual({})
  })

  it('is not shown during a workout, or when the session was logged', () => {
    mountWith({ active: { id: 'a', name: 'x', start: Date.now(), entries: [] } })
    expect(card()).toBeUndefined()
    mountWith({ workouts: [...workouts, { id: 'w2', d: '2026-11-16', name: 'Upper Body A', routineId: 'ua', routineIds: ['ua'], start: 3, end: 4, entries: [] }] })
    expect(card()).toBeUndefined()
  })
})
