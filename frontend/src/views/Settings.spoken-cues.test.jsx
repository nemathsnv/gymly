// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Spoken cues (lib/spoken-cues.js) in Settings → Timer alerts: a switch, off by default, then
// the speaking rate and a Try it that says what a rest would announce, in the profile's unit.
const mocks = vi.hoisted(() => {
  const state = { S: null, MOBILE: false, android: false }
  state.snapshot = () => ({
    S: state.S,
    user: null,
    update: mut => {
      const next = structuredClone(state.S)
      mut(next)
      state.S = next
    },
    replaceState: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(),
    signOut: vi.fn(), signOutAll: vi.fn(), resetDemo: vi.fn(), disconnectServer: vi.fn(),
  })
  state.checkForUpdate = vi.fn(() => Promise.resolve({ hasUpdate: true, latestVersion: '9.9.9', apkUrl: 'https://x/opengym.apk', hashUrl: null }))
  state.confirmSheet = vi.fn()
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
// MOBILE is read at render time through a getter so one module mock serves both builds.
vi.mock('../lib/mobile.js', () => ({
  get MOBILE() { return mocks.MOBILE },
  isAndroid: () => Promise.resolve(mocks.android),
  shareExport: vi.fn(), syncReminder: vi.fn(),
}))
vi.mock('../lib/update.js', () => ({
  checkForUpdate: (...a) => mocks.checkForUpdate(...a),
  downloadAndInstall: vi.fn(),
}))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: (...a) => mocks.confirmSheet(...a), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: vi.fn(),
}))

globalThis.__APP_VERSION__ ??= 'test'

// The page reads the voice through lib/speech.js: whether this browser can talk, and the line it
// says when tried.
vi.mock('../lib/speech.js', () => ({
  speak: (...a) => mocks.speak(...a),
  speechSupported: () => mocks.canSpeak,
  SPEECH_RATES: { slow: 0.8, normal: 1, fast: 1.25 },
  speechRateOf: S => (['slow', 'normal', 'fast'].includes(S?.speechRate) ? S.speechRate : 'normal'),
}))

let host, root
beforeEach(() => {
  mocks.S = { unit: 'kg', restSec: 90, sound: false, workouts: [], routines: [], exWeights: {} }
  mocks.speak = vi.fn(() => Promise.resolve(true))
  mocks.canSpeak = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = async () => {
  await act(async () => { root.render(<Settings page="alerts" />) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const remount = async () => { act(() => root.unmount()); root = createRoot(host); await mount() }
const rowTitled = title => [...host.querySelectorAll('.lrow')].find(r => r.querySelector('.lrow-t')?.textContent === title)
const switchIn = row => row.querySelector('[role="switch"]') || row.querySelector('input[type="checkbox"]') || row.querySelector('button')

describe('Settings → Timer alerts → Spoken cues (upstream openGym 499d589d2, 62a90e6d2)', () => {
  it('off until switched on, and says the sample once it is', async () => {
    await mount()
    const row = rowTitled('Spoken cues')
    expect(row).toBeTruthy()
    expect(row.querySelector('.lrow-s').textContent).toBe('Says your next set, “10 seconds” and “Rest is over”, and counts holds down.')
    expect(switchIn(row).getAttribute('aria-checked')).toBe('false')
    expect(rowTitled('Speaking rate')).toBeUndefined()
    expect(rowTitled('Try it')).toBeUndefined()
    act(() => { switchIn(row).click() })
    expect(mocks.S.spokenCues).toBe(true)
    expect(mocks.speak).toHaveBeenCalledWith('Set 3, 80 kilos, 8 reps', { rate: 1 })
  })

  it('on: the speaking rate and Try it, which is an action without a chevron', async () => {
    mocks.S.spokenCues = true
    mocks.S.unit = 'lb'
    await mount()
    const rate = rowTitled('Speaking rate')
    expect([...rate.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Slow', 'Normal', 'Fast'])
    act(() => { [...rate.querySelectorAll('button')].find(b => b.textContent === 'Fast').click() })
    expect(mocks.S.speechRate).toBe('fast')
    expect(mocks.speak).toHaveBeenLastCalledWith('Set 3, 185 pounds, 8 reps', { rate: 1.25, queue: false })
    await remount()
    const tryIt = rowTitled('Try it')
    expect(tryIt.tagName).toBe('BUTTON')
    expect(tryIt.querySelector('.lrow-c')).toBe(null)
    act(() => { tryIt.click() })
    expect(mocks.speak).toHaveBeenLastCalledWith('Set 3, 185 pounds, 8 reps', { rate: 1.25, queue: false })
    // No group title repeating the switch's own.
    expect([...host.querySelectorAll('.sect-t')].map(h => h.textContent)).not.toContain('Spoken cues')
    expect(host.textContent).toContain('Only while the app is on screen. Music turns down for a moment, it never stops.')
  })

  it('a browser that cannot talk greys the switch out and says so', async () => {
    mocks.canSpeak = false
    await mount()
    const row = rowTitled('Spoken cues')
    expect(row.className).toMatch(/\bdis\b/)
    expect(switchIn(row).disabled).toBe(true)
    expect(host.textContent).toContain('This browser can’t speak. Try another one.')
  })
})
