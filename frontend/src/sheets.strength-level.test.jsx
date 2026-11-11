// @vitest-environment happy-dom
// Strength level in an exercise's details (lib/strength-level.js): there for a graded lift once
// there is a weigh-in and an estimated 1RM, absent otherwise.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { EXIDX } from './lib/exercises.js'
import { DEF, useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { exerciseDetailSheet } from './sheets.jsx'

const BENCH = '0025'
const mounted = []
function renderTop() {
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}
const seed = extra => useStore.setState({
  S: { ...structuredClone(DEF), bodyweight: [{ d: '2026-10-01', w: 80 }], workouts: [{ id: 'w', d: '2026-10-02', start: 1, entries: [{ id: BENCH, target: { mode: 'reps' }, sets: [{ w: 100, r: 1, done: true }] }] }], ...extra },
  user: null,
})

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useUI.setState({ sheets: [], toastMsg: '' })
  document.body.innerHTML = ''
})
afterEach(() => { act(() => { mounted.splice(0).forEach(root => root.unmount()) }) })

describe('exercise details: strength level', () => {
  it('shows the level and what the next one takes for a graded lift', () => {
    seed()
    exerciseDetailSheet(EXIDX[BENCH])
    const block = renderTop().querySelector('[data-strength-level]')
    expect(block.querySelector('.slevel-name').textContent).toBe('Intermediate lifter')
    expect(block.textContent).toContain('Advanced lifter from an estimated 1RM of 120 kg')
  })
  it('stays out of the details before a weigh-in', () => {
    seed({ bodyweight: [] })
    exerciseDetailSheet(EXIDX[BENCH])
    expect(renderTop().querySelector('[data-strength-level]')).toBeNull()
  })
})
