// @vitest-environment happy-dom
// The weight + and − on the workout screen (lib/weight-step.js): the exercise's own step in every
// layout, off-grid weights kept, a tap back undoing a tap, each exercise on its own step, and
// nothing else on the screen — finished sets, warm-ups, effort, the rest timer, history — moved.
// The editor behind the ⋯ menu writes S.exEquip, which outlives a reload and reaches a new device.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Workout from './Workout.jsx'
import { DEF, restoredStateFor, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { weightStepSheet } from '../sheets.jsx'
import { withExEquip, weightStepper } from '../lib/weight-step.js'
import { EXIDX } from '../lib/exercises.js'

vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn(), alertBuzz: vi.fn(), unlock: vi.fn(), restOver: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = value => JSON.parse(JSON.stringify(value))

const ROW = '0292'        // dumbbell one arm bent-over row: back, so 5 kg by default
const CABLE_ROW = '0861'  // cable seated row
const LEG_EXT = '0585'    // lever leg extension

const work = (w, extra = {}) => ({ w, r: 8, done: false, ...extra })
const entry = (id, sets, target = {}) => ({ id, target: { sets: sets.length, reps: 8, mode: 'reps', ...target }, sets })
const steps = (over = {}) => Object.entries(over).reduce((S, [id, step]) => ({ ...S, exEquip: withExEquip(S, id, { step }, 1) }), { unit: 'kg', exEquip: {} }).exEquip

let root, container, sheetRoot, sheetHost
beforeEach(() => {
  localStorage.clear()
  useUI.setState({ sheets: [], toastMsg: '', timer: null, work: null })
})
afterEach(() => {
  if (sheetRoot) act(() => sheetRoot.unmount())
  if (sheetHost) sheetHost.remove()
  if (root) act(() => root.unmount())
  if (container) container.remove()
  root = container = sheetRoot = sheetHost = null
  localStorage.clear()
})

function mount(entries, patch = {}, view = 'list') {
  const S = clone(DEF)
  S.unit = 'kg'
  S.workoutView = view
  Object.assign(S, patch)
  S.active = { id: 'step-test', d: '2026-10-23', start: Date.now(), routineId: null, name: 'Steps', bw: null, cur: 0, entries, workoutView: view }
  useStore.setState({ S, user: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>))
}
const S = () => useStore.getState().S
const setOf = (e, i) => S().active.entries[e].sets[i]
const weightSteppers = () => [...container.querySelectorAll('.setrow .stp.w')]
const tap = (el, label) => act(() => el.querySelector(`button[aria-label="${label}"]`).click())
const up = (i = 0) => tap(weightSteppers()[i], 'Increase')
const down = (i = 0) => tap(weightSteppers()[i], 'Decrease')
const setWeight = (e, i, w) => act(() => useStore.setState(st => { const next = clone(st.S); next.active.entries[e].sets[i].w = w; return { S: next } }))

function openSheet(open) {
  act(() => open())
  const sheet = useUI.getState().sheets.at(-1)
  sheetHost = document.createElement('div')
  document.body.appendChild(sheetHost)
  sheetRoot = createRoot(sheetHost)
  act(() => sheetRoot.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return sheetHost
}
const chip = (host, text) => [...host.querySelectorAll('.chip')].find(b => b.textContent === text)

describe('the exercises used here', () => {
  it('are what the test assumes', () => {
    expect([EXIDX[ROW].eq, EXIDX[ROW].bp]).toEqual(['dumbbell', 'back'])
    expect(EXIDX[CABLE_ROW].eq).toBe('cable')
    expect(EXIDX[LEG_EXT].eq).toBe('leverage machine')
  })
})

describe('+ and − with a step of the exercise\'s own', () => {
  it.each(['list', 'cards', 'compact'])('walk 10 → 12.5 → 15 and back in %s view', view => {
    mount([entry(ROW, [work(10)])], { exEquip: steps({ [ROW]: 2.5 }) }, view)
    up(); expect(setOf(0, 0).w).toBe(12.5)
    up(); expect(setOf(0, 0).w).toBe(15)
    down(); down(); expect(setOf(0, 0).w).toBe(10)
  })

  it('without one, the dumbbell row keeps its 5 kg default', () => {
    mount([entry(ROW, [work(10)])])
    up(); expect(setOf(0, 0).w).toBe(15)
  })

  it('a typed weight off the grid stays off it: 11.5 → 14 → 11.5', () => {
    mount([entry(ROW, [work(10)])], { exEquip: steps({ [ROW]: 2.5 }) })
    setWeight(0, 0, 11.5)
    up(); expect(setOf(0, 0).w).toBe(14)
    down(); expect(setOf(0, 0).w).toBe(11.5)
    down(); expect(setOf(0, 0).w).toBe(9)
    up(); expect(setOf(0, 0).w).toBe(11.5)
  })

  it('many taps of a fractional step add up exactly and come back exactly', () => {
    mount([entry(CABLE_ROW, [work(20)])], { exEquip: steps({ [CABLE_ROW]: 1.25 }) })
    for (let i = 0; i < 9; i++) up()
    expect(setOf(0, 0).w).toBe(31.25)
    for (let i = 0; i < 9; i++) down()
    expect(setOf(0, 0).w).toBe(20)
  })

  it('each exercise steps by its own, in the same session', () => {
    mount([entry(CABLE_ROW, [work(40)]), entry(LEG_EXT, [work(40)]), entry(ROW, [work(10)])],
      { exEquip: steps({ [CABLE_ROW]: 5, [LEG_EXT]: 2.5 }) })
    up(0); up(1); up(2)
    expect([setOf(0, 0).w, setOf(1, 0).w, setOf(2, 0).w]).toEqual([45, 42.5, 15])
  })

  it('wins over the plan\'s progression step, which itself stays as the plan has it', () => {
    mount([entry(ROW, [work(10)], { inc: 5 })], { exEquip: steps({ [ROW]: 2.5 }) })
    up(); expect(setOf(0, 0).w).toBe(12.5)
    expect(S().active.entries[0].target.inc).toBe(5)
  })

  it('steps a unilateral side and a drop by the same step', () => {
    mount([
      entry(ROW, [{ w: 10, r: 16, done: false, sides: { L: work(10), R: work(10) } }], { side: true }),
      entry(CABLE_ROW, [work(50, { type: 'dropset', drops: [{ w: 40, r: 8 }] })]),
    ], { exEquip: steps({ [ROW]: 2.5, [CABLE_ROW]: 2.5 }) })
    const side = container.querySelector('.sideset .stp.w') || weightSteppers()[0]
    tap(side, 'Increase')
    const s = setOf(0, 0)
    expect([s.sides.L.w, s.sides.R.w].sort()).toEqual([10, 12.5])
    tap(container.querySelector('.subrow .stp'), 'Increase')
    expect(setOf(1, 0).drops[0].w).toBe(42.5)
  })
})

describe('what the buttons leave alone', () => {
  it('finished sets, warm-ups, effort, the rest timer and history', () => {
    const history = [{ id: 'old', d: '2026-10-20', start: 1, end: 2, entries: [entry(ROW, [{ w: 12.5, r: 8, done: true }])] }]
    const timer = { endsAt: Date.now() + 60_000, total: 90, label: 'rest' }
    mount([entry(ROW, [
      { w: 6, r: 10, done: true, phase: 'warmup' },
      { w: 10, r: 8, done: true, rir: 2 },
      { w: 10, r: 8, done: false, rir: 1 },
    ])], { exEquip: steps({ [ROW]: 2.5 }), effort: 'rir', workouts: history })
    act(() => useUI.setState({ timer }))
    const before = clone(S().active.entries[0].sets)
    const open = weightSteppers().at(-1)
    tap(open, 'Increase'); tap(open, 'Increase'); tap(open, 'Decrease')
    const after = S().active.entries[0].sets
    // the open set's weight moves (and is marked as chosen by hand, as any tap marks it), its RIR stays
    expect(after[2]).toEqual({ ...before[2], w: 12.5, weightOrigin: 'manual' })
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2))
    expect(S().workouts).toEqual(history)
    expect(useUI.getState().timer).toEqual(timer)
  })
})

describe('Focus view', () => {
  it('+ and − use the exercise\'s own step, exactly', () => {
    mount([entry(ROW, [work(11.5)])], { exEquip: steps({ [ROW]: 2.5 }) }, 'focus')
    const load = () => container.querySelector('button[aria-label="Increase load"]').closest('.stp')
    tap(load(), 'Increase load'); expect(setOf(0, 0).w).toBe(14)
    tap(load(), 'Decrease load'); expect(setOf(0, 0).w).toBe(11.5)
  })
})

describe('the Weight step editor', () => {
  it('picks a step, saves it to the profile, and the buttons use it at once', () => {
    mount([entry(ROW, [work(10)])])
    const host = openSheet(() => weightStepSheet(ROW, { id: ROW, mode: 'reps' }))
    expect(chip(host, 'Default (5 kg)').classList.contains('on')).toBe(true)
    act(() => chip(host, '2.5 kg').click())
    expect(S().exEquip[ROW].step).toEqual({ kg: 2.5 })
    expect(chip(host, '2.5 kg').classList.contains('on')).toBe(true)
    up(); expect(setOf(0, 0).w).toBe(12.5)
  })

  it('takes a typed step, a 0 on the way to 0.5 included', () => {
    mount([entry(ROW, [work(10)])])
    const host = openSheet(() => weightStepSheet(ROW, { id: ROW, mode: 'reps' }))
    const field = [...host.querySelectorAll('.stp-w')].find(w => w.textContent.startsWith('Each tap')).querySelector('input')
    const type = v => act(() => {
      Object.getOwnPropertyDescriptor(field.constructor.prototype, 'value').set.call(field, v)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    type('0'); expect(field.value).toBe('0'); expect(S().exEquip?.[ROW]).toBeUndefined()
    type('0.'); type('0.5')
    expect(S().exEquip[ROW].step).toEqual({ kg: 0.5 })
    expect(field.value).toBe('0.5')
    up(); expect(setOf(0, 0).w).toBe(10.5)
  })

  it('the Default chip clears the step and + goes back to the plan\'s', () => {
    mount([entry(ROW, [work(10)])], { exEquip: steps({ [ROW]: 2.5 }) })
    const host = openSheet(() => weightStepSheet(ROW, { id: ROW, mode: 'reps' }))
    act(() => chip(host, 'Default (5 kg)').click())
    expect(S().exEquip[ROW].step).toEqual({})
    up(); expect(setOf(0, 0).w).toBe(15)
  })

  it('offers a pulley ratio on a cable, as a note that changes no number', () => {
    mount([entry(CABLE_ROW, [work(50)])])
    const host = openSheet(() => weightStepSheet(CABLE_ROW, { id: CABLE_ROW, mode: 'reps' }))
    const ratio = [...host.querySelectorAll('.seg button')].find(b => b.textContent === '2:1')
    act(() => ratio.click())
    expect(S().exEquip[CABLE_ROW].pulley).toBe('2:1')
    up(); expect(setOf(0, 0).w).toBe(55)   // the cable row's own default step, 2:1 or not
    expect(host.textContent).toContain('You log the weight the machine shows')
  })

  it('no pulley question for dumbbells', () => {
    mount([entry(ROW, [work(10)])])
    const host = openSheet(() => weightStepSheet(ROW, { id: ROW, mode: 'reps' }))
    expect(host.textContent).not.toContain('Pulley')
  })

  it('survives a reload and reaches another device with the profile', () => {
    mount([entry(ROW, [work(10)])])
    const host = openSheet(() => weightStepSheet(ROW, { id: ROW, mode: 'reps' }))
    act(() => chip(host, '2.5 kg').click())
    // this device: what a reload reads back
    const saved = JSON.parse(localStorage.getItem('gym_state_v1'))
    expect(saved.exEquip[ROW].step).toEqual({ kg: 2.5 })
    // another device: a fresh copy that pulls the profile from the server
    const other = restoredStateFor({ ...clone(DEF), _ts: 0 }, saved)
    expect(weightStepper(other, { id: ROW, mode: 'reps' })).toMatchObject({ step: 2.5, source: 'exercise' })
  })
})
