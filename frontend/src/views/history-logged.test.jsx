// @vitest-environment happy-dom
// A workout an assistant logged through the hosted MCP (lib/log-workout.js) is an ordinary entry
// of S.workouts: History lists it, with its name and sets, and opens it like any other.
import React, { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import History, { historyRows } from './History.jsx'
import { buildLoggedWorkout, appendLoggedWorkout } from '../lib/log-workout.js'

const NOW = new Date('2026-09-16T19:30:00').getTime()
const mounted = []
const mount = el => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(el))
  return host
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  useUI.setState({ sheets: [], toasts: [] })
  document.body.innerHTML = ''
})
afterEach(() => {
  act(() => { mounted.splice(0).forEach(root => root.unmount()) })
  vi.useRealTimers()
})

it('History lists a logged workout and opens it', () => {
  const st = JSON.parse(JSON.stringify(DEF))
  Object.assign(st, { active: null, workouts: [], weighIn: false })
  const built = buildLoggedWorkout(st, {
    date: '2026-09-15', name: 'Arms',
    exercises: [{ exercise: 'dumbbell curl', sets: [{ reps: 12, weight: 12 }, { reps: 12, weight: 12 }, { reps: 10, weight: 12 }] }],
  }, { now: NOW })
  expect(built.problems).toBeUndefined()
  appendLoggedWorkout(st, built, { now: NOW })
  useStore.setState({ S: st, user: null })
  expect(historyRows(st).map(r => r.w?.id)).toEqual([built.workout.id])
  const host = mount(<MemoryRouter><History /></MemoryRouter>)
  expect(host.textContent).toContain('Arms')
  const row = [...host.querySelectorAll('.list > *')].find(el => el.textContent.includes('Arms'))
  act(() => { row.click() })
  expect(useUI.getState().sheets).toHaveLength(1)
})
