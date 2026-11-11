// @vitest-environment happy-dom
// Settings → Account → Webhooks (ported from upstream openGym's Integrations.test.jsx, b397ab84b):
// the row only where the server offers webhooks, and the add / test / retry / disconnect flow
// against a mocked API. The secret is shown once and never put in the store.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ user: null, config: null, sheets: [], toast: null, calls: [], answers: {}, confirm: null, demo: false }))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ S: {}, user: mocks.user, config: mocks.config })
  const useStore = selector => (selector ? selector(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast, openSheet: render => { mocks.sheets.push(render); return { close: vi.fn() } } })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('../lib/api.js', () => ({
  api: vi.fn(async (path, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null
    mocks.calls.push([path.split('?')[0], body])
    const a = mocks.answers[path.split('?')[0]]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? a(body) : a ?? {}
  }),
}))
vi.mock('../lib/demo.js', () => ({ get DEMO() { return mocks.demo }, REPO: 'https://github.com/nemathsnv/gymly' }))
vi.mock('../lib/clipboard.js', () => ({ copyText: vi.fn(async () => true) }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: o => { mocks.confirm = o } }))

import { WebhooksRow } from './Webhooks.jsx'
import { copyText } from '../lib/clipboard.js'

let host, root, sheetHost, sheetRoot
beforeEach(() => {
  Object.assign(mocks, { user: null, config: null, sheets: [], calls: [], answers: {}, confirm: null, demo: false, toast: vi.fn() })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  sheetHost = document.createElement('div'); document.body.appendChild(sheetHost); sheetRoot = createRoot(sheetHost)
})
afterEach(() => {
  act(() => { root.unmount(); sheetRoot.unmount() })
  host.remove(); sheetHost.remove()
})

const mount = async () => {
  await act(async () => { root.render(<WebhooksRow />) })
}
const closeSheet = vi.fn()
const showSheet = async () => {
  // Keyed by the sheet, so each opened sheet mounts afresh as it does in the app.
  await act(async () => { sheetRoot.render(<React.Fragment key={mocks.sheets.length}>{mocks.sheets.at(-1)(closeSheet)}</React.Fragment>) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const sheetBtn = text => [...sheetHost.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const sheetRow = text => [...sheetHost.querySelectorAll('.lrow')].find(r => r.textContent.includes(text))
const type = (input, v) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, v)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const conn = over => ({ id: 'c_1', provider: 'webhook', label: 'Home Assistant', events: ['workout.finished'], paused: false, status: 'connected', info: { url: 'https://ha.example.com/api/webhook/…7f3a' }, lastOk: Date.now() - 3600_000, lastError: null, failed: 0, ...over })

describe('the row', () => {
  it('is not there for a guest, in the demo, or on a server without INTEGRATIONS', async () => {
    await mount()
    expect(host.textContent).toBe('')
    mocks.user = { id: 'u1' }
    mocks.config = { invite_only: false, coach: null }
    await mount()
    expect(host.textContent).toBe('')
    mocks.config = { integrations: { providers: ['webhook'] } }
    mocks.demo = true
    await mount()
    expect(host.textContent).toBe('')
  })

  it('is there, signed in, when the server offers webhooks, and opens the list', async () => {
    mocks.user = { id: 'u1' }
    mocks.config = { integrations: { providers: ['webhook'] } }
    mocks.answers['/api/integrations'] = { providers: [{ id: 'webhook', max: 10 }], connections: [] }
    await mount()
    expect(host.querySelector('.lrow-t').textContent).toBe('Webhooks')
    act(() => host.querySelector('.lrow').click())
    await showSheet()
    expect(mocks.calls[0][0]).toBe('/api/integrations')
    expect(sheetHost.textContent).toContain('Your server sends a signed message to each of these when something happens.')
    expect(sheetBtn('Add a webhook')).toBeTruthy()
  })
})

describe('webhooks', () => {
  beforeEach(() => {
    mocks.user = { id: 'u1', name: 'Dana' }
    mocks.config = { integrations: { providers: ['webhook'] } }
  })
  const openList = async () => {
    await mount()
    act(() => host.querySelector('.lrow').click())
    await showSheet()
  }

  it('add: the URL is checked here first, then the server answers with the secret, shown once', async () => {
    mocks.answers['/api/integrations'] = { providers: [{ id: 'webhook', max: 10 }], connections: [] }
    mocks.answers['/api/integrations/connect'] = { connection: conn(), reveal: { secret: 'ogwh_abc123' } }
    await openList()
    act(() => sheetBtn('Add a webhook').click())
    await showSheet()
    expect(sheetHost.textContent).toContain('Paste the HTTPS URL from Home Assistant, n8n, ntfy or similar.')
    const [url, name] = sheetHost.querySelectorAll('input')
    await type(url, 'http://192.168.1.5:8123/api/webhook/x')
    await act(async () => { sheetBtn('Add webhook').click() })
    expect(sheetHost.querySelector('[role="alert"]').textContent).toBe('It has to start with https://.')
    expect(mocks.calls.some(c => c[0] === '/api/integrations/connect')).toBe(false)
    await type(url, 'https://ha.example.com/api/webhook/gymly-7f3a')
    await type(name, 'Home Assistant')
    // Records too, on top of the default.
    act(() => sheetRow('New personal record').querySelector('[role="switch"]').click())
    await act(async () => { sheetBtn('Add webhook').click() })
    const sent = mocks.calls.find(c => c[0] === '/api/integrations/connect')[1]
    expect(sent).toEqual({ provider: 'webhook', url: 'https://ha.example.com/api/webhook/gymly-7f3a', label: 'Home Assistant', events: ['workout.finished', 'workout.pr'] })
    expect(sheetHost.querySelector('.intg-secret').textContent).toBe('ogwh_abc123')
    expect(sheetHost.textContent).toContain('You will see it only now')
    await act(async () => { sheetBtn('Copy secret').click() })
    expect(copyText).toHaveBeenCalledWith('ogwh_abc123')
    expect(mocks.toast).toHaveBeenCalledWith('Copied')
  })

  it('with the home network open, http is fine here and the server has the last word', async () => {
    mocks.config = { integrations: { providers: ['webhook'], lan: true } }
    mocks.answers['/api/integrations'] = { providers: [{ id: 'webhook', max: 10, lan: true }], connections: [] }
    mocks.answers['/api/integrations/connect'] = Object.assign(new Error('url points at an address Gymly never calls'), { status: 400, code: 'url' })
    await openList()
    act(() => sheetBtn('Add a webhook').click())
    await showSheet()
    expect(sheetHost.textContent).toContain('Your home network works too.')
    await type(sheetHost.querySelector('input'), 'http://127.0.0.1:8123/x')
    await act(async () => { sheetBtn('Add webhook').click() })
    expect(mocks.calls.find(c => c[0] === '/api/integrations/connect')[1].url).toBe('http://127.0.0.1:8123/x')
    expect(sheetHost.querySelector('[role="alert"]').textContent).toBe('Your server said no to that URL: url points at an address Gymly never calls')
  })

  it('a webhook that needs attention: retry, test and disconnect from its sheet', async () => {
    const broken = conn({ status: 'attention', failed: 2, lastError: { at: Date.now() - 60000, msg: 'The receiver answered 503.' } })
    mocks.answers['/api/integrations'] = { providers: [{ id: 'webhook', max: 10 }], connections: [broken] }
    mocks.answers['/api/integrations/retry'] = { requeued: 2, connection: conn() }
    mocks.answers['/api/integrations/test'] = { ok: true, status: 204, connection: conn() }
    mocks.answers['/api/integrations/disconnect'] = { ok: true }
    await openList()
    expect(sheetHost.textContent).toContain('ha.example.com/api/webhook/…7f3a')
    expect(sheetHost.querySelector('.intg-pill').textContent).toBe('Needs attention')
    act(() => sheetRow('Home Assistant').click())
    await showSheet()
    expect(sheetHost.textContent).toContain('The receiver answered 503.')
    await act(async () => { sheetBtn('Retry').click() })
    expect(mocks.calls.find(c => c[0] === '/api/integrations/retry')[1]).toEqual({ id: 'c_1' })
    expect(mocks.toast).toHaveBeenCalledWith('Sending again')
    expect(sheetHost.textContent).not.toContain('The receiver answered 503.')
    await act(async () => { sheetBtn('Send test event').click() })
    expect(mocks.toast).toHaveBeenCalledWith('Test event delivered')
    act(() => sheetBtn('Disconnect').click())
    expect(mocks.confirm.title).toBe('Disconnect this webhook?')
    await act(async () => { await mocks.confirm.onConfirm() })
    expect(mocks.calls.find(c => c[0] === '/api/integrations/disconnect')[1]).toEqual({ id: 'c_1' })
    expect(mocks.toast).toHaveBeenCalledWith('Webhook removed')
  })

  it('pause, events and the activity log', async () => {
    mocks.answers['/api/integrations'] = { providers: [{ id: 'webhook', max: 10 }], connections: [conn()] }
    mocks.answers['/api/integrations/update'] = body => ({ connection: conn({ ...('paused' in body ? { paused: body.paused, status: body.paused ? 'paused' : 'connected' } : {}), ...(body.events ? { events: body.events } : {}) }) })
    mocks.answers['/api/integrations/log'] = { log: [{ at: Date.now() - 1000, ev: 'weighin.logged', ok: true, status: 200 }, { at: Date.now() - 5000, ev: 'test', ok: false, status: 500, msg: 'The receiver answered 500.' }] }
    await openList()
    act(() => sheetRow('Home Assistant').click())
    await showSheet()
    // Switching the last event off is refused here, before it reaches the server.
    act(() => sheetRow('Workout finished').querySelector('[role="switch"]').click())
    expect(mocks.toast).toHaveBeenCalledWith('Pick at least one thing to send.')
    expect(mocks.calls.some(c => c[0] === '/api/integrations/update')).toBe(false)
    await act(async () => { sheetRow('Weigh-in logged').querySelector('[role="switch"]').click() })
    expect(mocks.calls.find(c => c[0] === '/api/integrations/update')[1]).toEqual({ id: 'c_1', events: ['workout.finished', 'weighin.logged'] })
    await act(async () => { sheetRow('Sending').querySelector('[role="switch"]').click() })
    expect(mocks.calls.filter(c => c[0] === '/api/integrations/update').at(-1)[1]).toEqual({ id: 'c_1', paused: true })
    expect(sheetHost.querySelector('.intg-pill').textContent).toBe('Off')
    expect(sheetHost.textContent).toContain('Paused. Nothing is sent until you switch it back on.')
    await act(async () => { sheetBtn('Show activity').click() })
    await act(async () => { await Promise.resolve() })
    expect(sheetHost.textContent).toContain('Weigh-in logged · 200')
    expect(sheetHost.textContent).toContain('Test event · 500')
    expect(sheetHost.textContent).toContain('The receiver answered 500.')
  })

  it('the list offers no Add at the server\'s limit, and says when the server cannot be reached', async () => {
    mocks.answers['/api/integrations'] = { providers: [{ id: 'webhook', max: 1 }], connections: [conn()] }
    await openList()
    expect(sheetBtn('Add a webhook')).toBeUndefined()
    mocks.answers['/api/integrations'] = new Error('offline')
    await openList()
    expect(sheetHost.textContent).toContain('Could not reach your server')
  })
})
