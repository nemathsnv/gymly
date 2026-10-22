// @vitest-environment happy-dom
// The Home switch for the check-in card hides the card only: the check-in screen stays reachable
// at its route whether the card is shown or not.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.jsx'
import { DEF, useStore } from './store/useStore.js'

vi.mock('./lib/sound.js', () => ({ setPlayOnSilent: vi.fn(), setVibrate: vi.fn(), setAlarmBuzzer: vi.fn() }))
vi.mock('./lib/api.js', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, api: vi.fn(() => Promise.resolve({})), beacon: vi.fn() }
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host, root, original
beforeEach(() => {
  original = useStore.getState()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  window.scrollTo = vi.fn()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useStore.setState({ S: original.S, user: original.user, ready: original.ready })
  window.location.hash = ''
})

describe('the check-in route', () => {
  for (const checkIn of [true, false]) {
    it(`opens the check-in screen with the Home card ${checkIn ? 'shown' : 'hidden'}`, async () => {
      window.location.hash = '#/checkin'
      useStore.setState({ S: { ...JSON.parse(JSON.stringify(DEF)), checkIn }, user: { id: 'u1', name: 'A' }, ready: true })
      await act(async () => { root.render(<App />) })
      expect(host.querySelector('h1')?.textContent).toBe('Check in')
    })
  }
})
