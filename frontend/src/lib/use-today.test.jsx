// @vitest-environment happy-dom
// A screen that logs "today" stays right when it is left open across midnight, resumed the next
// morning, or carried into another time zone — and the day a tap writes is the day the screen says.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { DEF, useStore } from '../store/useStore.js'
import { useToday } from './use-today.js'
import Habits from '../views/Habits.jsx'

const mounted = []
const mount = el => {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host); mounted.push(root)
  act(() => root.render(el))
  return host
}
function Probe() { return <span id="t">{useToday()}</span> }
const realTZ = process.env.TZ

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'setTimeout', 'clearInterval'] })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  document.body.innerHTML = ''
  localStorage.clear()
  useStore.setState({ S: { ...JSON.parse(JSON.stringify(DEF)), _ts: 1 }, user: null })
})
afterEach(() => {
  act(() => { mounted.splice(0).forEach(r => r.unmount()) })
  vi.useRealTimers()
  if (realTZ === undefined) delete process.env.TZ; else process.env.TZ = realTZ
})
const advance = async ms => { await act(async () => { vi.advanceTimersByTime(ms) }) }

describe('useToday', () => {
  it('moves to the next date after midnight without a reload', async () => {
    vi.setSystemTime(new Date('2026-10-22T23:58:00'))
    const host = mount(<Probe />)
    expect(host.textContent).toBe('2026-10-22')
    vi.setSystemTime(new Date('2026-10-23T00:01:00'))
    await advance(31000)
    expect(host.textContent).toBe('2026-10-23')
  })

  it('catches up when the app is brought back to the foreground after a long sleep', async () => {
    vi.setSystemTime(new Date('2026-10-22T22:00:00'))
    const host = mount(<Probe />)
    vi.setSystemTime(new Date('2026-10-23T07:30:00'))   // timers did not run while the phone slept
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(host.textContent).toBe('2026-10-23')
  })

  it('follows a change of time zone', async () => {
    process.env.TZ = 'Europe/Lisbon'
    vi.setSystemTime(new Date('2026-10-22T22:30:00Z'))
    const host = mount(<Probe />)
    expect(host.textContent).toBe('2026-10-22')
    process.env.TZ = 'Pacific/Auckland'
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(host.textContent).toBe('2026-10-23')
  })

  it('stops looking when the screen goes away', async () => {
    vi.setSystemTime(new Date('2026-10-22T12:00:00'))
    mount(<Probe />)
    act(() => { mounted.splice(0).forEach(r => r.unmount()) })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Habits left open across midnight', () => {
  it('says the new date, and a tap on No alcohol logs the new day, not the one before', async () => {
    vi.setSystemTime(new Date('2026-10-22T23:58:00'))
    const host = mount(<MemoryRouter><Habits /></MemoryRouter>)
    expect(host.querySelector('.card .lbl2').textContent).toContain('22 Oct')
    vi.setSystemTime(new Date('2026-10-23T00:03:00'))
    await advance(31000)
    expect(host.querySelector('.card .lbl2').textContent).toContain('23 Oct')
    act(() => { [...host.querySelectorAll('.habit-btn')].find(b => b.textContent === 'No alcohol').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(Object.keys(useStore.getState().S.habitLog)).toEqual(['alcohol|2026-10-23'])
    expect(host.querySelector('.habit-cell.today.free')).toBeTruthy()
  })
})
