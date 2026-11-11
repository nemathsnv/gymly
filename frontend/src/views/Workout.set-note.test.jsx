// @vitest-environment happy-dom
// A note on one set (openGym 765dd3018): set menu → Note writes it on the row, a quiet line under
// the row shows it, and a tap on that line edits it.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Workout from './Workout.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'

vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn(), restOver: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})) }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = value => JSON.parse(JSON.stringify(value))
const BENCH = '0025'
const mounted = []
let root, container
beforeEach(() => { useUI.setState({ sheets: [], toastMsg: '', timer: null, work: null }) })
afterEach(() => {
  act(() => { mounted.splice(0).forEach(r => r.unmount()) })
  if (root) act(() => root.unmount()); container?.remove(); root = container = null
})
function mount(sets, entry = {}) {
  const S = clone(DEF)
  Object.assign(S, { unit: 'kg', workoutView: 'list' })
  S.active = { id: 'a', d: '2026-10-09', start: Date.now(), routineId: null, name: 'Push', bw: null, cur: 0, workoutView: 'list', entries: [{ id: BENCH, target: { mode: 'reps', sets: 2, reps: 8 }, sets, ...entry }] }
  useStore.setState({ S, user: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>))
}
const renderTop = () => {
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const r = createRoot(host)
  mounted.push(r)
  act(() => r.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}
const typeInto = (input, v) => act(() => {
  Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set.call(input, v)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('a note on one set', () => {
  it('is written from the set menu and shown under its row', () => {
    mount([{ w: 80, r: 8, done: true }, { w: 80, r: 8, done: false }])
    expect(container.querySelector('.setnote-line')).toBeNull()
    act(() => container.querySelectorAll('.setrow .n')[1].click())
    const menu = renderTop()
    const item = [...menu.querySelectorAll('button, [role="button"], .menu-item')].find(el => el.textContent.includes('A word about this set'))
    act(() => item.click())
    const sheet = renderTop()
    expect(sheet.querySelector('h3').textContent).toBe('Set 2')
    typeInto(sheet.querySelector('textarea'), 'grip slipped')
    act(() => [...sheet.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').click())
    expect(useStore.getState().S.active.entries[0].sets[1].note).toBe('grip slipped')
    expect(container.querySelector('.setnote-line').textContent).toBe('grip slipped')
  })
  it('the menu says Edit note, with the note, once there is one', () => {
    mount([{ w: 80, r: 8, done: true, note: 'felt easy' }])
    act(() => container.querySelector('.setrow .n').click())
    const menu = renderTop()
    expect([...menu.querySelectorAll('button, [role="button"], .menu-item')].some(el => /Edit note/.test(el.textContent) && /felt easy/.test(el.textContent))).toBe(true)
  })
  it('an empty note removes it', () => {
    mount([{ w: 80, r: 8, done: true, note: 'old' }])
    act(() => container.querySelector('.setnote-line').click())
    const sheet = renderTop()
    act(() => [...sheet.querySelectorAll('button')].find(b => b.textContent.trim() === 'Remove note').click())
    expect('note' in useStore.getState().S.active.entries[0].sets[0]).toBe(false)
    expect(container.querySelector('.setnote-line')).toBeNull()
  })
})
