// @vitest-environment happy-dom
// The Habits list (/habits) and the habit editor: Add habit, the two kinds and their words, a
// rename that keeps every day, Archive and Unarchive, and a habit's own screen for one of your own.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { createHabit, withEntry, withHabit, habitOf, habitList, entryOf, statusOn } from '../lib/habits.js'
import { habitEditSheet } from '../components/HabitEditor.jsx'
import Habits from './Habits.jsx'
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
const list = () => mount(<MemoryRouter><Habits /></MemoryRouter>)
const detail = id => mount(<MemoryRouter initialEntries={['/habits/' + id]}>
  <Routes><Route path="/habits/:id" element={<HabitDetail />} /><Route path="/habits" element={<div id="the-list" />} /></Routes>
</MemoryRouter>)
const sheetHost = () => { const sh = useUI.getState().sheets.at(-1); return mount(sh.render(() => useUI.getState().closeSheet(sh.id))) }
const click = el => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const btn = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const type = (input, value) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const names = host => [...host.querySelectorAll('.habit-row .habit-name')].map(e => e.textContent)
const withHabits = (...defs) => {
  let m = {}
  defs.forEach(([id, fields], i) => { m = createHabit(m, fields, { now: 10 + i, id }).map })
  useStore.setState({ S: { ...S(), habitLog: m } })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-22T12:00:00'))
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear(); document.body.innerHTML = ''
  useUI.setState({ sheets: [], toasts: [] })
  useStore.setState({ S: { ...clone(DEF), _ts: 1 }, user: null })
})
afterEach(() => { act(() => { mounted.splice(0).forEach(r => r.unmount()) }); vi.useRealTimers() })

describe('the Habits list', () => {
  it('shows Alcohol, as before, with today one tap away, and an Add habit button', () => {
    const host = list()
    expect(names(host)).toEqual(['Alcohol'])
    expect(btn(host, 'Add habit')).toBeTruthy()
    click(btn(host, 'No alcohol'))
    expect(entryOf(S(), 'alcohol', T).status).toBe('free')
    expect(host.textContent).toContain('Alcohol-free streak (days): 1')
  })

  it('Add habit makes a habit with the name, kind, icon and colour chosen', () => {
    const host = list()
    click(btn(host, 'Add habit'))
    const sheet = sheetHost()
    expect(btn(sheet, 'Add habit').disabled).toBe(true)          // no name, no habit
    type(sheet.querySelector('input'), 'No sugar')
    click(btn(sheet, 'Avoid a habit'))
    expect(sheet.textContent).toContain('Each day: Avoided, Did it or Not logged.')
    click(sheet.querySelector('[aria-label="Icon 3"]'))
    click(sheet.querySelector('[aria-label="Red"]'))
    expect(sheet.querySelector('[aria-label="Red"]').getAttribute('aria-checked')).toBe('true')
    click(btn(sheet, 'Add habit'))
    const made = habitList(S()).find(h => h.name === 'No sugar')
    expect(made).toMatchObject({ kind: 'avoid', icon: 'flame', color: 'red', archived: false })
    expect(names(host)).toEqual(['Alcohol', 'No sugar'])
  })

  it('each kind answers in its own words, and a tap logs that habit alone', () => {
    withHabits(['hread', { name: 'Read', kind: 'do' }], ['hsugar', { name: 'Sugar', kind: 'avoid' }])
    const host = list()
    const rows = [...host.querySelectorAll('.habit-row')]
    const words = r => [...r.querySelectorAll('.habit-btn')].map(b => b.textContent)
    expect(words(rows[0])).toEqual(['No alcohol', 'Drank alcohol', 'Not logged'])
    expect(words(rows[1])).toEqual(['Done', 'Not done', 'Not logged'])
    expect(words(rows[2])).toEqual(['Avoided', 'Did it', 'Not logged'])
    click(btn(rows[2], 'Avoided'))
    expect(statusOn(S(), 'hsugar', T, T)).toBe('good')
    expect(statusOn(S(), 'hread', T, T)).toBeNull()
    expect(statusOn(S(), 'alcohol', T, T)).toBeNull()
    expect(rows[2].textContent).toContain('Streak (days): 1')
    expect(rows[1].textContent).toContain('No streak yet')
  })

  it('a rename keeps every day', () => {
    withHabits(['hread', { name: 'Read', kind: 'do' }])
    useStore.setState({ S: { ...S(), habitLog: withEntry(S().habitLog, 'hread', '2026-10-21', { status: 'good', note: 'n' }, { now: 50, today: T }) } })
    const host = list()
    habitEditSheet('hread')
    const sheet = sheetHost()
    expect(sheet.querySelector('input').value).toBe('Read')
    type(sheet.querySelector('input'), 'Read a book')
    click(btn(sheet, 'Save'))
    expect(habitOf(S(), 'hread').name).toBe('Read a book')
    expect(entryOf(S(), 'hread', '2026-10-21')).toMatchObject({ status: 'good', note: 'n' })
    expect(names(host)).toEqual(['Alcohol', 'Read a book'])
  })

  it('Archive takes a habit off the list into Archived, its days kept; Unarchive brings it back', () => {
    withHabits(['hread', { name: 'Read', kind: 'do' }])
    useStore.setState({ S: { ...S(), habitLog: withEntry(S().habitLog, 'hread', '2026-10-21', { status: 'good' }, { now: 50, today: T }) } })
    const host = list()
    habitEditSheet('hread')
    click(btn(sheetHost(), 'Archive'))
    expect(habitOf(S(), 'hread').archived).toBe(true)
    expect(names(host)).toEqual(['Alcohol'])
    expect(host.textContent).toContain('Archived')
    expect(host.querySelector('.habit-archived').textContent).toContain('Read')
    expect(statusOn(S(), 'hread', '2026-10-21', T)).toBe('good')
    click(btn(host.querySelector('.habit-archived'), 'Unarchive'))
    expect(names(host)).toEqual(['Alcohol', 'Read'])
    expect(host.querySelector('.habit-archived')).toBeNull()
  })

  it('with every habit archived it says so, and Alcohol can be brought back too', () => {
    useStore.setState({ S: { ...S(), habitLog: withHabit({}, 'alcohol', { archived: true }, { now: 5 }) } })
    const host = list()
    expect(names(host)).toEqual([])
    expect(host.textContent).toContain('No active habits')
    click(btn(host.querySelector('.habit-archived'), 'Unarchive'))
    expect(names(host)).toEqual(['Alcohol'])
  })

  it('Alcohol can be renamed but not given another kind', () => {
    list()
    habitEditSheet('alcohol')
    const sheet = sheetHost()
    expect(btn(sheet, 'Avoid a habit')).toBeUndefined()
    type(sheet.querySelector('input'), 'Wine')
    click(btn(sheet, 'Save'))
    expect(habitOf(S(), 'alcohol')).toMatchObject({ name: 'Wine', kind: 'avoid', good: 'free' })
  })
})

describe('a habit of your own, on its screen', () => {
  it('uses its own name and words, with no drinks, and a past day can be corrected with a note', () => {
    withHabits(['hread', { name: 'Read', kind: 'do' }])
    const host = detail('hread')
    expect(host.querySelector('h1').textContent).toBe('Read')
    expect(host.textContent).toContain('Done, last 30 days')
    expect(host.querySelector('.habit-legend').textContent).toBe('DoneNot doneNot logged')
    click(btn(host, 'Not done'))                                       // today
    expect(host.textContent).toContain('Starts with the next successful day you log')
    expect(host.querySelector('.habit-cell.today.drank')).toBeTruthy()
    expect(host.textContent).not.toContain('alcohol')
    click([...host.querySelectorAll('.habit-cell:not(.out)')].find(c => c.getAttribute('aria-label').includes('15')))
    const sheet = sheetHost()
    click(btn(sheet, 'Not done'))
    expect(sheet.querySelector('.stp')).toBeNull()                     // no drink count
    const ta = sheet.querySelector('textarea')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Too tired')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(btn(sheet, 'Done'))
    click(btn(sheet, 'Save'))
    act(() => { mounted.splice(0).forEach(r => r.unmount()) })
    expect(entryOf(S(), 'hread', '2026-10-15')).toMatchObject({ status: 'good', note: 'Too tired', count: null })
  })

  it('an unlogged day is never drawn or counted as a good one', () => {
    withHabits(['hread', { name: 'Read', kind: 'do' }])
    const host = detail('hread')
    expect(host.querySelectorAll('.habit-cell.free')).toHaveLength(0)
    expect(host.querySelector('.habit-stat .big').textContent).toBe('0')
    expect(host.querySelector('.habit-btn.on.none')).toBeTruthy()
  })

  it('an archived one says so and can be brought back from its screen', () => {
    withHabits(['hread', { name: 'Read', kind: 'do' }])
    useStore.setState({ S: { ...S(), habitLog: withHabit(S().habitLog, 'hread', { archived: true }, { now: 99 }) } })
    const host = detail('hread')
    expect(host.textContent).toContain('Archived. Its history is kept')
    click(btn(host, 'Unarchive'))
    expect(habitOf(S(), 'hread').archived).toBe(false)
  })

  it('a habit that does not exist goes back to the list', () => {
    const host = detail('hgone')
    expect(host.querySelector('#the-list')).toBeTruthy()
  })
})
