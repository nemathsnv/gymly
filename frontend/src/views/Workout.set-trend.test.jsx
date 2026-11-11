// @vitest-environment happy-dom
// openGym #907 in a running workout: a finished set wears a small arrow against the same set last
// time, said in words on its number button; a set not done yet and a warm-up wear none. Gymly's
// stepmill sets compare by minutes, then their machine level.
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
const STEPMILL = '2311'    // walking on stepmill

let root, container
beforeEach(() => { useUI.setState({ sheets: [], toastMsg: '', timer: null, work: null }) })
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); root = container = null })

function mount(patch = {}, { past, today } = {}) {
  const S = clone(DEF)
  Object.assign(S, { unit: 'kg', workoutView: 'list' }, patch)
  S.workouts = [{ id: 'old', d: '2026-10-01', start: new Date('2026-10-01T17:00:00').getTime(), name: 'Push', entries: [
    past || { id: BENCH, target: { mode: 'reps', sets: 3, reps: 8 }, sets: [{ w: 77.5, r: 8, done: true }, { w: 80, r: 8, done: true }, { w: 80, r: 8, done: true }] },
  ] }]
  S.active = { id: 'a', d: '2026-10-09', start: Date.now(), routineId: null, name: 'Push', bw: null, cur: 0, workoutView: 'list', entries: [
    today || { id: BENCH, target: { mode: 'reps', sets: 3, reps: 8 }, sets: [
      { w: 40, r: 5, done: true, phase: 'warmup' }, { w: 80, r: 8, done: true }, { w: 80, r: 6, done: true }, { w: 80, r: 8, done: false },
    ] },
  ] }
  useStore.setState({ S, user: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<MemoryRouter><Workout /></MemoryRouter>))
}

describe('set vs last time in the workout (#907)', () => {
  it('marks the finished work sets only, with a spoken label', () => {
    mount()
    const nums = [...container.querySelectorAll('.setrow .n')]
    expect(nums.map(n => n.querySelector('.settrend')?.textContent || '')).toEqual(['', '↑', '↓', ''])
    expect(nums[1].getAttribute('aria-label')).toBe('Set 1, 2.5 kg more than last time')
    expect(nums[2].getAttribute('aria-label')).toBe('Set 2, 2 reps fewer than last time')
  })
  it('the switch in Settings hides them', () => {
    mount({ setTrend: false })
    expect(container.querySelectorAll('.settrend')).toHaveLength(0)
  })
  it('a stepmill set held for as long goes by its level', () => {
    mount({}, {
      past: { id: STEPMILL, target: { sets: 2, min: 5 }, sets: [{ min: 5, speed: 0, level: 6, done: true }, { min: 5, speed: 0, level: 8, done: true }] },
      today: { id: STEPMILL, target: { sets: 2, min: 5 }, sets: [{ min: 5, speed: 0, level: 7, done: true }, { min: 5, speed: 0, level: 8, done: true }] },
    })
    const nums = [...container.querySelectorAll('.setrow .n')]
    expect(nums.map(n => n.querySelector('.settrend')?.textContent || '')).toEqual(['↑', '='])
    expect(nums[0].getAttribute('aria-label')).toBe('Set 1, Higher level than last time')
  })
})
