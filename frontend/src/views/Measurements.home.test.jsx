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

  // #699: a custom measurement has its own unit, and the card and the quick log keep it on
  // either profile instead of reading every value as a circumference.
  describe('with a custom unit', () => {
    const lean = { id: 'lean', name: 'Lean mass', unit: 'kg', enabled: true }
    const ratio = { id: 'ratio', name: 'Muscle ratio', unit: '%', enabled: true }
    const visc = { id: 'visc', name: 'Visceral fat', unit: 'none', enabled: true }
    const fat = { id: 'fat', name: 'Fat mass', unit: 'lb', enabled: true }
    const sheet = () => host.querySelector('.sheet')
    const chip = text => [...sheet().querySelectorAll('button')].find(b => b.textContent === text)
    const todays = id => useStore.getState().S.measurements.find(e => e.d === todayISO())?.other.find(o => o.id === id)
    const type = (input, value) => act(() => {
      Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    beforeEach(() => useUI.setState({ toast: vi.fn() }))

    it('shows and logs a kg field in kg on a pounds profile, not in inches', () => {
      setS({ unit: 'lb', homeMeasurement: 'other:lean', customMeasurements: [lean], measurements: [
        { d: '2020-01-01', t: 0, other: [{ id: 'lean', value: 60, unit: 'kg' }] },
      ] })
      act(() => root.render(<Harness />))
      expect(host.querySelector('.big').textContent).toBe('60 kg')
      act(() => button('Log').click())
      expect(sheet().querySelector('.u').textContent.trim()).toBe('kg')
      expect(sheet().querySelector('input').value).toBe('60')
      act(() => chip('+0.5').click())
      act(() => button('Save').click())
      expect(todays('lean')).toMatchObject({ value: 60.5, unit: 'kg' })
    })

    it('converts a pounds field to and from its kg storage on a kg profile', () => {
      setS({ unit: 'kg', homeMeasurement: 'other:fat', customMeasurements: [fat], measurements: [
        { d: '2020-01-01', t: 0, other: [{ id: 'fat', value: 13.744, unit: 'lb' }] },
      ] })
      act(() => root.render(<Harness />))
      expect(host.querySelector('.big').textContent).toBe('30.3 lb')
      act(() => button('Log').click())
      expect(sheet().querySelector('input').value).toBe('30.3')
      act(() => chip('−1').click())
      act(() => button('Save').click())
      expect(todays('fat').value).toBeCloseTo(29.3 / 2.2046226218, 3)
      expect(todays('fat').unit).toBe('lb')
    })

    it('shows a unitless score bare, and logs a zero', () => {
      setS({ homeMeasurement: 'other:visc', customMeasurements: [visc], measurements: [
        { d: '2020-01-01', t: 0, other: [{ id: 'visc', value: 9, unit: 'none' }] },
        { d: '2020-01-02', t: 1, other: [{ id: 'visc', value: 8, unit: 'none' }] },
      ] })
      act(() => root.render(<Harness />))
      expect(host.querySelector('.big').textContent).toBe('8')
      act(() => button('Log').click())
      expect(sheet().querySelector('.u')).toBeNull()
      expect([...sheet().querySelectorAll('.lrow b')].map(b => b.textContent)).toEqual(['8', '9'])
      type(sheet().querySelector('input'), '0')
      act(() => button('Save').click())
      expect(todays('visc')).toMatchObject({ value: 0, unit: 'none' })
    })

    it('keeps a custom percentage within 0–100%', () => {
      setS({ unit: 'lb', homeMeasurement: 'other:ratio', customMeasurements: [ratio], measurements: [
        { d: '2020-01-01', t: 0, other: [{ id: 'ratio', value: 99.8, unit: '%' }] },
      ] })
      act(() => root.render(<Harness />))
      expect(host.querySelector('.big').textContent).toBe('99.8 %')
      act(() => button('Log').click())
      expect(sheet().querySelector('.u').textContent.trim()).toBe('%')
      act(() => chip('+1').click())
      expect(sheet().querySelector('input').value).toBe('100')
      type(sheet().querySelector('input'), '101')
      act(() => button('Save').click())
      expect(useUI.getState().toast).toHaveBeenCalledWith('Muscle ratio must be between 0 and 100%.')
      expect(todays('ratio')).toBeUndefined()
    })

    it('still treats a legacy custom field as a circumference, in inches on a pounds profile', () => {
      setS({ unit: 'lb', homeMeasurement: 'other:knee', customMeasurements: [{ id: 'knee', name: 'Knee', enabled: true }], measurements: [
        { d: '2020-01-01', t: 0, other: [{ id: 'knee', value: 38.1 }] },
      ] })
      act(() => root.render(<Harness />))
      expect(host.querySelector('.big').textContent).toBe('15 in')
      act(() => button('Log').click())
      type(sheet().querySelector('input'), '2000')
      act(() => button('Save').click())
      expect(useUI.getState().toast).toHaveBeenCalledWith('That number looks too big. Check it and try again.')
      type(sheet().querySelector('input'), '15.5')
      act(() => button('Save').click())
      expect(todays('knee')).toEqual({ id: 'knee', name: 'Knee', value: 39.4 })
    })
  })
})

