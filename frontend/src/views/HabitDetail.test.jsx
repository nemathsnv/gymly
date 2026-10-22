// @vitest-environment happy-dom
// A habit's screen (/habits/:id), here the built-in Alcohol one: one tap sets today, the calendar
// draws each status differently, a past day opens its details, a future day cannot be tapped, and
// nothing unlogged is shown as a good day.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { withEntry, entryOf } from '../lib/habits.js'
import HabitDetail from './HabitDetail.jsx'

const clone = v => JSON.parse(JSON.stringify(v))
const S = () => useStore.getState().S
const T = '2026-10-22'
const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(el))
  return host
}
const page = () => mount(<MemoryRouter><HabitDetail id="alcohol" /></MemoryRouter>)
const sheetHost = () => { const sh = useUI.getState().sheets.at(-1); return mount(sh.render(() => useUI.getState().closeSheet(sh.id))) }
const click = el => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const btn = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const log = days => Object.entries(days).reduce((m, [iso, s]) => withEntry(m, 'alcohol', iso, { status: s }, { now: 1, today: T, tz: 'UTC' }), {})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-22T12:00:00'))   // a Thursday
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear(); document.body.innerHTML = ''
  useUI.setState({ sheets: [], toasts: [] })
  useStore.setState({ S: { ...clone(DEF), _ts: 1 }, user: null })
})
afterEach(() => { act(() => { mounted.splice(0).forEach(r => r.unmount()) }); vi.useRealTimers() })

describe('Habits screen', () => {
  it('starts with nothing logged: no streak, and today is not assumed alcohol-free', () => {
    const host = page()
    expect(host.textContent).toContain('Current streak')
    expect(host.querySelector('.habit-stat .big').textContent).toContain('0')
    expect(host.querySelectorAll('.habit-cell.free')).toHaveLength(0)
    expect(host.querySelectorAll('.habit-cell.drank')).toHaveLength(0)
    expect(host.querySelector('.habit-btn.on.none')).toBeTruthy()   // "Not logged" is what is selected
  })

  it('one tap on No alcohol logs today, and the calendar and streak follow', () => {
    const host = page()
    click(btn(host, 'No alcohol'))
    expect(entryOf(S(), 'alcohol', T).status).toBe('free')
    expect(host.querySelector('.habit-cell.today.free')).toBeTruthy()
    expect(host.querySelector('.habit-stat .big').textContent).toContain('1')
  })

  it('Drank alcohol and back to Not logged', () => {
    const host = page()
    click(btn(host, 'Drank alcohol'))
    expect(host.querySelector('.habit-cell.today.drank')).toBeTruthy()
    click(btn(host, 'Not logged'))
    expect(entryOf(S(), 'alcohol', T)).toBeNull()
    expect(host.querySelector('.habit-cell.today.none')).toBeTruthy()
  })

  it('draws each status differently, and future days are faint and cannot be tapped', () => {
    useStore.setState({ S: { ...S(), habitLog: log({ '2026-10-20': 'free', '2026-10-21': 'drank' }) } })
    const host = page()
    expect(host.querySelectorAll('.habit-cell.free')).toHaveLength(1)
    expect(host.querySelectorAll('.habit-cell.drank')).toHaveLength(1)
    expect(host.querySelectorAll('.habit-cell.none').length).toBeGreaterThan(20)
    const future = [...host.querySelectorAll('.habit-cell.future')]
    expect(future.length).toBe(3)
    expect(future.every(c => c.disabled)).toBe(true)
    // the status is in the accessible name too, not only the colour
    expect(host.querySelector('.habit-cell.free').getAttribute('aria-label')).toMatch(/No alcohol/)
    expect(host.querySelector('.habit-cell.drank').getAttribute('aria-label')).toMatch(/Drank alcohol/)
    expect(host.querySelector('.habit-cell.free svg, .habit-cell.free .icn')).toBeTruthy()
  })

  it('shows the last 30 or 90 days', () => {
    const host = page()
    const real = () => [...host.querySelectorAll('.habit-cell:not(.out):not(.future)')].length
    expect(real()).toBe(30)
    click(btn(host, '90 days'))
    expect(real()).toBe(90)
  })

  it('tapping a past day opens its sheet; saving a drink count and a private note edits that day', () => {
    useStore.setState({ S: { ...S(), habitLog: log({ '2026-10-15': 'free' }) } })
    const host = page()
    click([...host.querySelectorAll('.habit-cell:not(.out)')].find(c => c.getAttribute('aria-label').includes('15')))
    const sheet = sheetHost()
    click(btn(sheet, 'Drank alcohol'))
    expect(entryOf(S(), 'alcohol', '2026-10-15').status).toBe('drank')
    const ta = sheet.querySelector('textarea')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Birthday dinner')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(sheet.querySelector('.stp button:last-of-type'))
    click(sheet.querySelector('.stp button:last-of-type'))
    click(btn(sheet, 'Save'))
    act(() => { mounted.splice(0).forEach(r => r.unmount()) })   // the sheet closing writes the details
    expect(entryOf(S(), 'alcohol', '2026-10-15')).toMatchObject({ status: 'drank', note: 'Birthday dinner' })
    expect(entryOf(S(), 'alcohol', '2026-10-15').count).toBe(2)
  })

  it('a day logged on another time zone is labelled, not moved', () => {
    const habitLog = withEntry({}, 'alcohol', '2026-10-20', { status: 'free' }, { now: 1, today: T, tz: 'Pacific/Auckland' })
    useStore.setState({ S: { ...S(), habitLog } })
    const host = page()
    click([...host.querySelectorAll('.habit-cell:not(.out)')].find(c => c.getAttribute('aria-label').includes('20')))
    const sheet = sheetHost()
    expect(sheet.textContent).toContain('Pacific/Auckland')
    expect(entryOf(S(), 'alcohol', '2026-10-20').status).toBe('free')
  })

  it('says so when entries are dated ahead of this device\'s date', () => {
    const habitLog = withEntry({}, 'alcohol', '2026-10-23', { status: 'free' }, { now: 1, today: '2026-10-23', tz: 'Pacific/Auckland' })
    useStore.setState({ S: { ...S(), habitLog } })
    const host = page()
    expect(host.textContent).toContain('another time zone')
    expect(host.querySelectorAll('.habit-cell.free')).toHaveLength(0)
  })

  it('states that the log is private', () => {
    expect(page().textContent).toContain('never shared with AI assistants')
  })
})

describe('Habits screen robustness', () => {
  it.each([['a string', 'oops'], ['an array', [1, 2]], ['null', null], ['entries that are not objects', { 'alcohol|2026-10-20': 'free', 'alcohol|nonsense': { s: 'free' }, 'alcohol|2026-02-30': { s: 'free', _ts: 1 }, 'smoking|2026-10-20': { s: 'free' } }]])(
    'renders with a habit log that is %s, counting none of it', (_, habitLog) => {
      useStore.setState({ S: { ...S(), habitLog } })
      const host = page()
      expect(host.querySelectorAll('.habit-cell.free')).toHaveLength(0)
      expect(host.querySelector('.habit-stat .big').textContent).toContain('0')
    })
})
