// @vitest-environment happy-dom
// Settings → Look & Home → On Home: the "At the gym / Check in" switch shows and hides the Home
// check-in card (S.checkIn) and nothing else; the Habits switch beside it is its own setting.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'
import { bindUI } from '../components/ui.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state = { S: null, MOBILE: false, user: null }
  state.snapshot = () => ({
    S: state.S,
    user: state.user,
    update: mut => {
      const next = structuredClone(state.S)
      mut(next)
      state.S = next
    },
    replaceState: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(),
    signOut: vi.fn(), signOutAll: vi.fn(), resetDemo: vi.fn(), disconnectServer: vi.fn(),
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: vi.fn() })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(), webauthnOK: () => false, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), IS_ANDROID: false,
}))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn() }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
vi.mock('../lib/mobile.js', () => ({ get MOBILE() { return mocks.MOBILE }, isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), syncReminder: vi.fn() }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  loadStarterPlan: vi.fn(), starterPlanSheet: vi.fn(), confirmSheet: vi.fn(), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(),
}))

// The Settings view reads the build-time version constant at render time.
globalThis.__APP_VERSION__ ??= 'test'

// SelectRow opens its choices through the bound UI store; capture the sheet to render it here.
let sheet = null
bindUI({ getState: () => ({ openSheet: render => { sheet = render; return { close: () => {} } } }) })

let host, root
beforeEach(() => {
  sheet = null
  mocks.S = {
    unit: 'kg', restSec: 90, restPauseSec: 15, sound: false, effort: 'none',
    gifSize: 'full', workouts: [], routines: [], exWeights: {},
  }
  mocks.MOBILE = false
  mocks.user = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = () => act(() => root.render(<Settings page="look" />))
const row = title => [...host.querySelectorAll('.lrow')].find(r => r.querySelector('.lrow-t')?.textContent === title)
const sw = title => row(title).querySelector('[role="switch"]')

describe('On Home → At the gym / Check in', () => {
  it('is on by default, for a profile that never chose', () => {
    mount()
    expect(row('At the gym / Check in')).toBeTruthy()
    expect(sw('At the gym / Check in').getAttribute('aria-checked')).toBe('true')
  })

  it('has an accessible name', () => {
    mount()
    expect(sw('At the gym / Check in').getAttribute('aria-label')).toBe('At the gym / Check in')
  })

  it('switches the card off and on, and leaves the gym cards alone', () => {
    const gymCards = [{ id: 'g1', name: 'Gym', code: '1' }]
    mocks.S = { ...mocks.S, gymCards }
    mount()
    act(() => { sw('At the gym / Check in').click() })
    expect(mocks.S.checkIn).toBe(false)
    expect(mocks.S.gymCards).toEqual(gymCards)
    mount()
    expect(sw('At the gym / Check in').getAttribute('aria-checked')).toBe('false')
    act(() => { sw('At the gym / Check in').click() })
    expect(mocks.S.checkIn).toBe(true)
  })

  it('does not move the Habits switch, nor the Habits switch it', () => {
    mount()
    act(() => { sw('At the gym / Check in').click() })
    expect(mocks.S.checkIn).toBe(false)
    expect(mocks.S.habitsOn).toBeUndefined()
    mount()
    act(() => { sw('Habits').click() })
    expect(mocks.S.habitsOn).toBe(false)
    expect(mocks.S.checkIn).toBe(false)
  })

  it('is found by Settings search under its own name and under "gym check-in"', async () => {
    const { searchSettings } = await import('./settings-pages.js')
    const ctx = { demo: false, mobile: false, android: false, signedIn: false }
    expect(searchSettings('at the gym', ctx).some(h => h.title === 'At the gym / Check in')).toBe(true)
    expect(searchSettings('gym check-in', ctx).some(h => h.title === 'At the gym / Check in')).toBe(true)
  })
})
