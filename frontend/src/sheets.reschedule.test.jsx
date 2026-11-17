// @vitest-environment happy-dom
// The Reschedule sheet (sheets.jsx, lib/reschedule.js): a preview of every date the shift changes
// and what no longer fits, nothing written until Apply, and only the dates' overrides written then.
import React, { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { effectiveRoutine } from './lib/history.js'
import { rescheduleSheet } from './sheets.jsx'

const clone = v => JSON.parse(JSON.stringify(v))
const ex = n => Array.from({ length: n }, (_, i) => ({ id: String(198 + i).padStart(4, '0'), sets: 3 }))
const routines = [
  { id: 'ua', name: 'Upper Body A', ex: ex(3) }, { id: 'la', name: 'Lower Body A', ex: ex(3) },
  { id: 'cc', name: 'Cardio + Core', ex: ex(2) }, { id: 'ub', name: 'Upper Body B', ex: ex(3) },
  { id: 'lb', name: 'Lower Body B', ex: ex(3) },
]
const week = { 1: ['ua'], 2: ['la'], 3: ['cc'], 4: ['ub'], 5: ['lb'], 6: ['cc'] }
const mounted = []
const renderTop = () => {
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}
const buttonIn = (host, label) => [...host.querySelectorAll('button')].find(b => b.textContent === label)

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 17, 10, 0)) })
afterAll(() => vi.useRealTimers())
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  useUI.setState({ sheets: [] })
  useStore.setState({ S: { ...clone(DEF), routines: clone(routines), week: clone(week), dayPlan: {},
    workouts: [{ id: 'w1', d: '2026-11-14', name: 'Cardio + Core', routineId: 'cc', routineIds: ['cc'], start: 1, end: 2, entries: [] }] }, user: null, ready: true })
})
afterEach(() => { act(() => { mounted.splice(0).forEach(r => r.unmount()) }); document.body.innerHTML = '' })

describe('Reschedule sheet', () => {
  it('previews the shift, names what is not made up, and writes nothing before Apply', () => {
    rescheduleSheet(['2026-11-16'])
    const host = renderTop()
    expect(host.textContent).toContain('Upper Body A')
    expect(host.textContent).toContain('was Lower Body A')
    expect(host.textContent).toMatch(/Cardio \+ Core doesn’t fit before/)
    expect(useStore.getState().S.dayPlan).toEqual({})
    act(() => buttonIn(host, 'Cancel').click())
    expect(useStore.getState().S.dayPlan).toEqual({})
  })

  it('Apply writes the one-time overrides: today is Upper Body A, the weekly plan unchanged', () => {
    rescheduleSheet(['2026-11-16'])
    const host = renderTop()
    act(() => buttonIn(host, 'Apply this schedule').click())
    const S = useStore.getState().S
    expect(effectiveRoutine(S, '2026-11-17').name).toBe('Upper Body A')
    expect(effectiveRoutine(S, '2026-11-21').name).toBe('Lower Body B')
    expect(effectiveRoutine(S, '2026-11-22')).toBe(null)
    expect(effectiveRoutine(S, '2026-11-23').name).toBe('Upper Body A')
    expect(S.week).toEqual(week)
    expect(S.missedDays['2026-11-16']).toMatchObject({ act: 'moved', to: '2026-11-17' })
    // Stamped per plan day like any other edit, so another device keeps it.
    expect(S.edited['dayPlan.2026-11-17']).toBeGreaterThan(0)
  })

  it('a refused plan explains itself and offers no Apply', () => {
    rescheduleSheet(['2026-11-14'])
    const host = renderTop()
    expect(host.textContent).toMatch(/already has a workout logged/)
    expect(buttonIn(host, 'Apply this schedule')).toBeUndefined()
  })
})
