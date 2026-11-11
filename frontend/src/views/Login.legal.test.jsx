// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Login from './Login.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* The sign-in screen links the Privacy Policy and Terms of Service: the one screen everybody sees
   before creating a profile, and the place an OAuth reviewer looks for them. Whatever the
   browser can do, the links are there. */
const mocks = vi.hoisted(() => {
  const state = { webauthn: true, config: null, sheets: [] }
  state.snapshot = () => ({
    config: state.config, S: {},
    setUser: vi.fn(), adoptProfile: vi.fn(), setGuest: vi.fn(), loadConfig: vi.fn(async () => state.config),
    pushState: vi.fn(), pullState: vi.fn(),
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: render => { mocks.sheets.push(render); return {} } })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  webauthnOK: () => mocks.webauthn, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), BIO: 'your fingerprint', bio: () => 'your fingerprint',
  api: vi.fn(), passkeyAssertion: vi.fn(), passwordLogin: vi.fn(), passwordRegister: vi.fn(), passwordResetRedeem: vi.fn(),
}))
vi.mock('../lib/demo.js', () => ({ DEMO: false, REPO: 'https://example.invalid' }))
vi.mock('../sheets.jsx', () => ({ askAddDeviceData: vi.fn(), confirmSheet: vi.fn() }))

const mounted = []
function mount(el) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(el))
  return host
}

beforeEach(() => { mocks.webauthn = true; mocks.config = null; mocks.sheets.length = 0 })
afterEach(() => { act(() => { mounted.splice(0).forEach(({ root, host }) => { root.unmount(); host.remove() }) }) })

const legal = host => [...host.querySelectorAll('nav[aria-label="Legal"] a')]
  .map(a => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])

describe('Login legal links', () => {
  it('links the Privacy Policy and Terms next to the app, in a new tab', () => {
    expect(legal(mount(<Login />))).toEqual([
      ['Privacy Policy', '/privacy', '_blank', 'noopener'],
      ['Terms of Service', '/terms', '_blank', 'noopener'],
    ])
  })

  it('keeps them on a browser without passkeys, with or without password sign-in', () => {
    mocks.webauthn = false
    expect(legal(mount(<Login />))).toHaveLength(2)
    mocks.config = { password_login: true, allow_guest: false }
    expect(legal(mount(<Login />))).toHaveLength(2)
  })
})
