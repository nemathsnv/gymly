// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* Settings → Data & backup → Oura: what each connection state shows, and what each control
   calls. The routes themselves are tested on the API side (api/test/oura-routes.test.js). */
const m = vi.hoisted(() => ({ status: null, toasts: [], navs: [], confirms: [], sheets: [], connectUrl: 'https://cloud.ouraring.com/oauth/authorize?x=1', disconnect: { ok: true, revoked: true }, sync: null, diag: null }))
vi.mock('../lib/oura-api.js', async importOriginal => {
  const real = await importOriginal()
  return {
    ...real,
    ouraStatus: vi.fn(async () => m.status),
    ouraConnectUrl: vi.fn(async () => m.connectUrl),
    ouraSync: vi.fn(async () => m.sync),
    ouraDisconnect: vi.fn(async () => m.disconnect),
    ouraDiagnostics: vi.fn(async () => m.diag),
  }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: msg => m.toasts.push(msg), openSheet: render => { m.sheets.push(render); return {} } })
  const useUI = sel => (sel ? sel(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('../sheets.jsx', () => ({ confirmSheet: opts => m.confirms.push(opts) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => (...a) => m.navs.push(a) }))

const api = await import('../lib/oura-api.js')
const { default: OuraCard } = await import('./OuraCard.jsx')

let host, root
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
async function mount() {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root.render(<OuraCard />))
  await settle()
}
const titles = () => [...host.querySelectorAll('.lrow-t')].map(e => e.textContent)
const row = title => [...host.querySelectorAll('.lrow')].find(r => r.querySelector('.lrow-t')?.textContent === title)

beforeEach(() => { m.toasts = []; m.navs = []; m.confirms = []; m.sheets = []; window.location.hash = '#/settings/data'; vi.clearAllMocks() })
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('OuraCard', () => {
  it('not set up on the server: says so, no Connect', async () => {
    m.status = { configured: false, connected: false, stale: false }
    await mount()
    expect(titles()).toEqual(['Oura'])
    expect(host.textContent).toContain('Not set up on this server')
  })

  it('set up, not connected: Connect sends the browser to Oura\'s consent page', async () => {
    m.status = { configured: true, connected: false }
    const assign = vi.fn()
    const orig = window.location.assign
    Object.defineProperty(window.location, 'assign', { value: assign, configurable: true })
    await mount()
    expect(titles()).toEqual(['Connect Oura'])
    expect(host.textContent).toContain('never saved, synced, exported, or sent to the AI Coach or AI assistants')
    await act(async () => row('Connect Oura').click())
    await settle()
    expect(api.ouraConnectUrl).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith(m.connectUrl)
    Object.defineProperty(window.location, 'assign', { value: orig, configurable: true })
  })

  it('connected: status with auto-sync, Training & recovery, Sync now, Check connection, Disconnect', async () => {
    m.status = { configured: true, connected: true, connectedAt: Date.now() - 3600e3, lastSync: Date.now() - 60e3, autoSync: { active: true } }
    m.sync = { days: 14, workouts: [1, 2, 3] }
    await mount()
    expect(titles()).toEqual(['Oura connected', 'Training & recovery', 'Sync now', 'Check connection', 'Disconnect Oura'])
    expect(host.textContent).toMatch(/Last synced/)
    expect(host.textContent).toMatch(/auto-sync on/)
    await act(async () => row('Training & recovery').click())
    expect(m.navs.at(-1)).toEqual(['/oura'])
    await act(async () => row('Sync now').click())
    await settle()
    expect(api.ouraSync).toHaveBeenCalledTimes(1)
    expect(m.toasts.at(-1)).toBe('Oura synced')
  })

  it('Disconnect asks first, then revokes and deletes; the message says what happens', async () => {
    m.status = { configured: true, connected: true, connectedAt: 1, lastSync: null }
    await mount()
    await act(async () => row('Disconnect Oura').click())
    expect(m.confirms).toHaveLength(1)
    expect(m.confirms[0].message).toMatch(/revokes its access at Oura and deletes the stored tokens and any Oura data it holds/)
    expect(api.ouraDisconnect).not.toHaveBeenCalled()
    m.status = { configured: true, connected: false }
    await act(async () => m.confirms[0].onConfirm())
    await settle()
    expect(api.ouraDisconnect).toHaveBeenCalledTimes(1)
    expect(m.toasts.at(-1)).toBe('Oura disconnected')
    expect(titles()).toEqual(['Connect Oura'])
  })

  it('back from Oura: the result is said once and the parameter dropped', async () => {
    m.status = { configured: true, connected: true, connectedAt: 1 }
    window.location.hash = '#/settings/data?oura=connected'
    await mount()
    expect(m.toasts).toEqual(['Oura connected'])
    expect(m.navs[0]).toEqual(['/settings/data', { replace: true }])
    window.location.hash = '#/settings/data?oura=denied'
    act(() => root.unmount()); host.remove()
    await mount()
    expect(m.toasts.at(-1)).toBe('Oura access was not granted')
  })

  it('a failed last sync shows its code; Check connection lists each data type without a value', async () => {
    m.status = { configured: true, connected: true, connectedAt: 1, lastSync: 2, lastError: 'rate', autoSync: { active: false } }
    m.diag = { refresh: 'ok', syncError: null, types: { daily_readiness: { status: 'ok', records: true }, daily_spo2: { status: 'not-shared', records: false }, vO2_max: { status: 'ok', records: false } } }
    await mount()
    expect(host.textContent).toMatch(/last sync failed \(rate\)/)
    expect(host.textContent).toMatch(/auto-sync starts when you open Training & recovery/)
    await act(async () => row('Check connection').click())
    expect(m.sheets).toHaveLength(1)
    const sheet = document.createElement('div'); document.body.appendChild(sheet)
    const r2 = createRoot(sheet)
    await act(async () => r2.render(m.sheets[0](() => {})))
    await settle()
    expect(api.ouraDiagnostics).toHaveBeenCalledWith(true)
    const line = k => sheet.querySelector(`[data-type="${k}"]`).textContent
    expect(line('daily_readiness')).toMatch(/shared, receiving data/)
    expect(line('daily_spo2')).toMatch(/not shared/)
    expect(line('vO2_max')).toMatch(/shared, no records yet/)
    expect(sheet.textContent).toMatch(/Token refresh: works/)
    act(() => r2.unmount()); sheet.remove()
  })

  it('a server that cannot be asked shows nothing rather than a broken card', async () => {
    api.ouraStatus.mockRejectedValueOnce(new Error('offline'))
    await mount()
    expect(host.textContent).toBe('')
  })
})
