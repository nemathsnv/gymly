// @vitest-environment happy-dom
// A stepmill is set by level, not speed (lib/machine-level.js): its set rows ask for Duration and
// Level, store the level as `level` (never as km/h), and log one segment per set, so 5 min at
// level 5 then 5 min at level 8 is two rows, added with Add set and edited one by one.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Workout from './Workout.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { buildCompletedWorkout } from '../lib/finish-workout.js'
import { setLabel } from '../lib/history.js'

vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const STEPMILL = '2311'    // walking on stepmill
const TREADMILL = '2259'   // walking on treadmill
let root, container

function mount(id, sets, more = {}) {
  if (root) unmount()
  const S = JSON.parse(JSON.stringify(DEF))
  S.active = {
    id: 'level-test', d: '2026-11-10', start: Date.now(), routineId: null, name: 'Lower Body A', bw: null, cur: 0, ...more,
    entries: [{ id, target: { sets: 1, min: 5, speed: 8 }, sets }],
  }
  useStore.setState({ S, user: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>))
}
function unmount() {
  act(() => root.unmount())
  container.remove()
  root = null
}
afterEach(() => { if (root) unmount() })

const rows = () => [...container.querySelectorAll('.setrow')]
const sets = () => useStore.getState().S.active.entries[0].sets
const heads = () => [...container.querySelectorAll('.sethead span')].map(s => s.textContent).filter(Boolean)
const inputsOf = row => [...row.querySelectorAll('.stp input')]
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text)
function type(input, value) {
  act(() => {
    Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('a stepmill’s set rows', () => {
  it('ask for duration and level, never speed', () => {
    mount(STEPMILL, [{ min: 5, speed: 0, done: false }])
    expect(heads()).toEqual(['Duration (min)', 'Level', 'Incline (%)'])
    expect(heads()).not.toContain('Speed (km/h)')
    // No level set yet: an empty field, not a level nobody chose.
    expect(inputsOf(rows()[0])[1].value).toBe('')
  })

  it('logs 5 min at level 5, then 5 min at level 8, as two sets', () => {
    mount(STEPMILL, [{ min: 5, speed: 0, done: false }])
    type(inputsOf(rows()[0])[1], '5')
    expect(sets()[0]).toEqual({ min: 5, speed: 0, level: 5, done: false })
    act(() => rows()[0].querySelector('[role="checkbox"]').click())
    expect(sets()[0].done).toBe(true)

    act(() => button('Add set').click())
    expect(sets()).toHaveLength(2)
    // The new segment starts from the last one: its minutes and level, and still no speed.
    expect(sets()[1]).toEqual({ min: 5, speed: 0, level: 5, done: false })
    type(inputsOf(rows()[1])[1], '8')
    act(() => rows()[1].querySelector('[role="checkbox"]').click())
    expect(sets()[0]).toMatchObject({ min: 5, level: 5, done: true })
    expect(sets()[1]).toMatchObject({ min: 5, level: 8, done: true })

    // The finished segment stays editable, without un-ticking it.
    type(inputsOf(rows()[0])[0], '6')
    expect(sets()[0]).toMatchObject({ min: 6, level: 5, done: true })

    // And the saved workout keeps both segments, read back as levels.
    const w = buildCompletedWorkout(useStore.getState().S.active)
    const e = w.entries.find(x => x.id === STEPMILL)
    expect(e.sets.map(s => setLabel(e.id, s, e.target))).toEqual(['6 min · Level 5', '5 min · Level 8'])
    expect(e.sets.every(s => s.speed === 0)).toBe(true)
  })

  it('clamps a typed level to a whole number and drops a cleared one', () => {
    mount(STEPMILL, [{ min: 5, speed: 0, done: false }])
    const level = () => inputsOf(rows()[0])[1]
    act(() => rows()[0].querySelectorAll('.stp')[1].querySelector('button[aria-label="Increase"]').click())
    expect(sets()[0].level).toBe(1)
    type(level(), '99')
    expect(sets()[0].level).toBe(50)
    type(level(), '')
    expect('level' in sets()[0]).toBe(false)
  })

  it('leaves a treadmill on speed', () => {
    mount(TREADMILL, [{ min: 20, speed: 5, done: false }])
    expect(heads()).toEqual(['Duration (min)', 'Speed (km/h)', 'Incline (%)'])
    act(() => button('Add set').click())
    expect(sets()[1]).toEqual({ min: 20, speed: 5, done: false })
  })
})
