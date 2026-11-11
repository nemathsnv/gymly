// @vitest-environment happy-dom
// An exercise's own warm-ups (#156, #525, components/WarmupConfig.jsx): Default, Auto, My own,
// a number of ramp sets or None, saved on the routine slot only when picked.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { EXDB } from './lib/exercises.js'
import { useStore } from './store/useStore.js'
import { useUI } from './store/useUI.js'
import { exConfigSheet } from './sheets.jsx'
import { bindUI } from './components/ui.jsx'
import { warmupChoiceOf, withWarmupChoice } from './components/WarmupConfig.jsx'

const BENCH = EXDB.find(e => e.id === '0025')
const mounted = []

function render(sheet) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push([root, host])
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}
const warmRow = host => [...host.querySelectorAll('.lrow')].find(r => r.querySelector('.lrow-t')?.textContent === 'Warm-ups')
const save = host => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save').click()
const pick = (host, label) => {
  act(() => warmRow(host).click())
  const list = render(useUI.getState().sheets.at(-1))
  act(() => [...list.querySelectorAll('button.lrow')].find(b => b.querySelector('.lrow-t')?.textContent === label).click())
}

describe('exercise settings: warm-ups', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    bindUI(useUI)
    useUI.setState({ sheets: [] })
    useStore.setState(s => ({ S: { ...s.S, unit: 'kg', warmupAuto: 'off', plates: {}, exWeights: {} } }))
    document.body.innerHTML = ''
  })
  afterEach(() => { act(() => { mounted.splice(0).forEach(([root, host]) => { root.unmount(); host.remove() }) }) })

  it('reads the choice a slot made, and the older count as a number of ramp sets', () => {
    expect(warmupChoiceOf({})).toBe('default')
    expect(warmupChoiceOf({ warmupSets: 2 })).toBe('count')
    expect(warmupChoiceOf({ warmup: 'own', warmupSets: 2 })).toBe('own')
    expect(withWarmupChoice({ warmup: 'own', warmupRows: [{ wp: 50, r: 5 }], warmupSets: 2, reps: 5 }, 'default')).toEqual({ reps: 5 })
    expect(withWarmupChoice({ reps: 5 }, 'count')).toEqual({ reps: 5, warmupSets: 2 })
    expect(withWarmupChoice({ reps: 5 }, 'own', [{ wb: true, r: 10 }])).toEqual({ reps: 5, warmup: 'own', warmupRows: [{ wb: true, r: 10 }] })
  })

  it('a slot that never chose saves without any warm-up key, and follows Settings', () => {
    const onSave = vi.fn()
    exConfigSheet(BENCH, { sets: 3, reps: 5, weight: 100, mode: 'reps' }, onSave)
    const host = render(useUI.getState().sheets.at(-1))
    expect(warmRow(host).querySelector('.lrow-v').textContent).toBe('Default (none)')
    act(() => save(host))
    const out = onSave.mock.calls[0][0]
    expect(out.warmup).toBeUndefined()
    expect(out.warmupRows).toBeUndefined()
    expect(out.warmupSets).toBeUndefined()
  })

  it('Auto shows today\'s ramp and saves the choice', () => {
    const onSave = vi.fn()
    exConfigSheet(BENCH, { sets: 3, reps: 5, weight: 100, mode: 'reps' }, onSave)
    const host = render(useUI.getState().sheets.at(-1))
    pick(host, 'Auto')
    expect(host.textContent).toContain('With 100 kg today: 20 × 10 · 40 × 5 · 60 × 3 · 80 × 1')
    act(() => save(host))
    expect(onSave.mock.calls[0][0]).toMatchObject({ warmup: 'auto' })
    expect(onSave.mock.calls[0][0].warmupSets).toBeUndefined()
  })

  it('My own starts from the ramp, the bar row says Bar, and the rows are saved as shares', () => {
    const onSave = vi.fn()
    exConfigSheet(BENCH, { sets: 3, reps: 5, weight: 100, mode: 'reps', warmupSets: 2 }, onSave)
    const host = render(useUI.getState().sheets.at(-1))
    pick(host, 'My own')
    expect(host.querySelector('.warmup-rows .stp-word').textContent).toBe('Bar')
    act(() => save(host))
    const out = onSave.mock.calls[0][0]
    expect(out.warmup).toBe('own')
    expect(out.warmupRows).toEqual([{ wb: true, r: 10 }, { wp: 40, r: 5 }, { wp: 60, r: 3 }, { wp: 80, r: 1 }])
    expect(out.warmupSets).toBeUndefined()
  })

  it('None saves none, and the older number of ramp sets still saves a count', () => {
    const onSave = vi.fn()
    exConfigSheet(BENCH, { sets: 3, reps: 5, weight: 100, mode: 'reps', warmupSets: 3 }, onSave)
    const host = render(useUI.getState().sheets.at(-1))
    expect(warmRow(host).querySelector('.lrow-v').textContent).toBe('A number of ramp sets')
    act(() => save(host))
    expect(onSave.mock.calls[0][0].warmupSets).toBe(3)
    const host2 = render((exConfigSheet(BENCH, { sets: 3, reps: 5, weight: 100, mode: 'reps', warmupSets: 3 }, onSave), useUI.getState().sheets.at(-1)))
    pick(host2, 'None')
    act(() => save(host2))
    expect(onSave.mock.calls[1][0]).toMatchObject({ warmup: 'none' })
    expect(onSave.mock.calls[1][0].warmupSets).toBeUndefined()
  })
})
