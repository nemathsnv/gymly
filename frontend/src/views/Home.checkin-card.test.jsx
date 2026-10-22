// @vitest-environment happy-dom
// Settings → On Home → "At the gym / Check in": the switch takes the check-in card off Home and
// puts it back. It is a profile setting (S.checkIn), so it survives a reload and reaches the other
// devices like any other; a profile that never chose shows the card. The check-in screen, its route
// and the saved cards are not the switch's business, and the Habits switch is a separate one.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { DEF, useStore } from '../store/useStore.js'
import { mergeStates, stampChange } from '../lib/sync-merge.js'
import Home from './Home.jsx'

const nav = vi.fn()
vi.mock('react-router-dom', () => ({ useNavigate: () => nav }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), bwSheet: vi.fn(), goalSheet: vi.fn(), dayOverrideSheet: vi.fn(),
  calendarSheet: vi.fn(), startFlow: vi.fn(), bwDeltaColor: () => '', weighInsSheet: vi.fn(), confirmSheet: vi.fn(),
}))

const clone = v => JSON.parse(JSON.stringify(v))
let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  nav.mockReset()
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear() })

const mountWith = over => {
  useStore.setState({ S: { ...clone(DEF), routines: [], workouts: [], ...over }, user: null, ready: true })
  act(() => root.render(<Home />))
}
const card = () => [...host.querySelectorAll('.card')].find(c => c.textContent.includes('At the gym'))
const click = el => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

describe('Home "At the gym / Check in" card', () => {
  it('is shown by default: a new profile, and an older one that never had the setting', () => {
    mountWith({})
    expect(card()).toBeTruthy()
    const old = clone(DEF); delete old.checkIn
    useStore.setState({ S: old })
    act(() => root.render(<Home />))
    expect(card()).toBeTruthy()
    expect(card().textContent).toContain('Check in')
  })

  it('is gone when switched off, and back when switched on again', () => {
    mountWith({ checkIn: false })
    expect(card()).toBeUndefined()
    act(() => useStore.getState().update(s => { s.checkIn = true }))
    expect(card()).toBeTruthy()
  })

  it('still opens the check-in screen when shown', () => {
    mountWith({ checkIn: true })
    click(card())
    expect(nav).toHaveBeenCalledWith('/checkin')
  })

  it('is independent of the Habits card, both ways', () => {
    mountWith({ checkIn: false, habitsOn: true })
    expect(card()).toBeUndefined()
    expect(host.querySelector('.habit-btns')).toBeTruthy()
    mountWith({ checkIn: true, habitsOn: false })
    expect(card()).toBeTruthy()
    expect(host.querySelector('.habit-btns')).toBeNull()
  })

  it('switching it off leaves the gym cards untouched', () => {
    const gymCards = [{ id: 'g1', name: 'Gym', code: '123', _ts: 1 }]
    mountWith({ checkIn: true, gymCards })
    act(() => useStore.getState().update(s => { s.checkIn = false }))
    expect(useStore.getState().S.gymCards).toEqual(gymCards)
  })
})

describe('the setting persists', () => {
  it('is written to the saved copy, which is what a reload or an app restart reads', () => {
    mountWith({ checkIn: true })
    act(() => useStore.getState().update(s => { s.checkIn = false }))
    const saved = JSON.parse(localStorage.getItem('gym_state_v1'))
    expect(saved.checkIn).toBe(false)
    // a reload: the store comes back from the saved copy
    act(() => root.unmount())
    root = createRoot(host)
    useStore.setState({ S: Object.assign(clone(DEF), saved) })
    act(() => root.render(<Home />))
    expect(card()).toBeUndefined()
  })

  it('reaches another device: the later choice wins the merge, either way round', () => {
    const base = { ...clone(DEF), _ts: 1000 }
    const off = clone(base); off.checkIn = false; off._ts = stampChange(base, off, 2000)
    // the other device changed something else later, without touching the switch
    const other = clone(base); other.restSec = 120; other._ts = stampChange(base, other, 3000)
    expect(mergeStates(other, off).checkIn).toBe(false)
    expect(mergeStates(off, other).checkIn).toBe(false)
    // and switching it back on later on the other device wins over the earlier off
    const on = clone(off); on.checkIn = true; on._ts = stampChange(off, on, 4000)
    expect(mergeStates(off, on).checkIn).toBe(true)
  })
})
