// @vitest-environment happy-dom
// The measurement pinned to Home: the card shows only when one is pinned, and its Log button
// writes that one field into today's check-in without disturbing the rest of it.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { todayISO } from '../lib/format.js'
import { HomeMeasurementCard } from './Measurements.jsx'

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: vi.fn() }))

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useUI.setState({ sheets: [] })
})
afterEach(() => { act(() => root.unmount()); host.remove(); useUI.setState({ sheets: [] }) })

const setS = patch => useStore.setState(s => ({ S: { ...s.S, unit: 'kg', measurements: [], customMeasurements: [], ...patch } }))
const Card = () => <HomeMeasurementCard S={useStore(s => s.S)} onOpen={() => {}} />
// The card and whatever sheet is open, rendered side by side the way Modals.jsx would.
const Harness = () => {
  const sheets = useUI(s => s.sheets)
  return <><Card />{sheets.map(sh => <div key={sh.id} className="sheet">{sh.render(() => useUI.getState().closeSheet(sh.id))}</div>)}</>
}
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)

describe('Home measurement card', () => {
  it('is absent until a measurement is pinned', () => {
    setS({ homeMeasurement: null })
    act(() => root.render(<Card />))
    expect(host.querySelector('.card')).toBeNull()
  })

  it('shows the pinned measurement with its latest reading and the change since the one before', () => {
    setS({ homeMeasurement: 'abdomen', measurements: [
      { d: '2026-11-09', t: 1, abdomen: 94 },
      { d: '2026-11-10', t: 2, waist: 80 },
      { d: '2026-11-11', t: 3, abdomen: 93.2 },
    ] })
    act(() => root.render(<Card />))
    expect(host.querySelector('h2').textContent).toBe('Abdomen')
    expect(host.querySelector('.big').textContent).toContain('93.2')
    expect(host.textContent).toContain('0.8')
  })

  it('logs today from the quick sheet, keeping the other measurements of the day', () => {
    setS({ homeMeasurement: 'abdomen', measurements: [{ d: todayISO(), t: 1, waist: 84 }, { d: '2020-01-01', t: 0, abdomen: 95 }] })
    act(() => root.render(<Harness />))
    act(() => button('Log').click())
    const sheet = host.querySelector('.sheet')
    expect(sheet.querySelector('h3').textContent).toBe('Log Abdomen')
    // starts from the last reading, so the morning change is a nudge
    expect(sheet.querySelector('input').value).toBe('95')
    act(() => [...sheet.querySelectorAll('button')].find(b => b.textContent === '−1').click())
    act(() => button('Save').click())
    const today = useStore.getState().S.measurements.find(e => e.d === todayISO())
    expect(today).toMatchObject({ waist: 84, abdomen: 94 })
    expect(host.querySelector('.sheet')).toBeNull()
  })
})
