// @vitest-environment happy-dom
// Your week / Your month (from openGym 4ba2a9757): the Home card on the first day of a week, its
// sheet with the numbers and Share as image, and the ×.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { RecapHomeCard } from './Recap.jsx'

const BENCH = '0025'
const mounted = []
const render = el => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(el))
  return host
}
const wk = d => ({ id: 'w' + d, d, start: new Date(d + 'T10:00:00').getTime(), end: new Date(d + 'T11:00:00').getTime(), prs: [BENCH], entries: [{ id: BENCH, target: { mode: 'reps' }, sets: [{ w: 100, r: 5, done: true }] }] })
const MONDAY = '2026-10-26'
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useUI.setState({ sheets: [] })
  useStore.setState({ S: { ...structuredClone(DEF), weekStart: 1, workouts: [wk('2026-10-20'), wk('2026-10-22')] }, user: null })
})
afterEach(() => { act(() => { mounted.splice(0).forEach(r => r.unmount()) }) })

describe('Your week on Home', () => {
  it('shows last week on a Monday, opens the sheet with its numbers, and the × puts it away', () => {
    const host = render(<RecapHomeCard S={useStore.getState().S} today={MONDAY} />)
    expect(host.querySelector('.ttl').textContent).toBe('Your week')
    expect(host.querySelector('.ss').textContent).toBe('2 workouts · 1,000 kg · 2 new bests')
    expect(host.querySelector('.recap-card').getAttribute('role')).toBe('button')
    act(() => host.querySelector('.recap-card').click())
    const sheet = useUI.getState().sheets.at(-1)
    const sh = render(sheet.render(() => {}))
    expect(sh.querySelector('h3').textContent).toBe('Your week')
    expect([...sh.querySelectorAll('.recap-v')].map(e => e.textContent)).toEqual(['2', '1,000 kg', '2', '1'])
    expect(sh.querySelector('.recap-most').textContent).toBe('Most work: Chest, 2 sets')
    // No performance report in Gymly, so no Save as PDF.
    expect([...sh.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Share as image', 'Done'])
    act(() => host.querySelector('[aria-label="Put it away"]').click())
    expect(useStore.getState().S.recapSeen).toBe('w:2026-10-19')
    // The × did not open the sheet a second time.
    expect(useUI.getState().sheets).toHaveLength(1)
  })

  it('Share as image opens the picture sheet: story or square, dark or light', async () => {
    const host = render(<RecapHomeCard S={useStore.getState().S} today={MONDAY} />)
    act(() => host.querySelector('.recap-card').click())
    const sh = render(useUI.getState().sheets.at(-1).render(() => {}))
    act(() => [...sh.querySelectorAll('button')].find(b => b.textContent === 'Share as image').click())
    const share = useUI.getState().sheets.at(-1)
    const pic = render(share.render(() => {}))
    await act(async () => {})
    expect(pic.querySelector('h3').textContent).toBe('Your week')
    expect([...pic.querySelectorAll('.share-opts button')].map(b => b.textContent)).toEqual(['Story 9:16', 'Square 1:1', 'Dark', 'Light'])
    expect(pic.querySelector('.share-card').className).toMatch(/share-(story|square)/)
  })

  it('the 1st shows Your month', () => {
    useStore.setState(s => ({ S: { ...s.S, workouts: [wk('2026-10-20')] } }))
    const host = render(<RecapHomeCard S={useStore.getState().S} today="2026-11-01" />)
    expect(host.querySelector('.recap-card').dataset.recap).toBe('month')
    expect(host.querySelector('.ttl').textContent).toBe('Your month')
    expect(host.querySelector('.ss').textContent).toBe('1 workout · 500 kg · 1 new best')
  })

  it('switched off, put away, or any other day: no card', () => {
    expect(render(<RecapHomeCard S={useStore.getState().S} today="2026-10-27" />).textContent).toBe('')
    useStore.setState(s => ({ S: { ...s.S, recapSeen: 'w:2026-10-19' } }))
    expect(render(<RecapHomeCard S={useStore.getState().S} today={MONDAY} />).textContent).toBe('')
    useStore.setState(s => ({ S: { ...s.S, recapSeen: undefined, recap: false } }))
    expect(render(<RecapHomeCard S={useStore.getState().S} today={MONDAY} />).textContent).toBe('')
  })
})
