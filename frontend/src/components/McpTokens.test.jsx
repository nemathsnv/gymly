// @vitest-environment happy-dom
// Settings → AI assistant access: the connected-assistants section appears only when the server
// lets this profile connect assistants (or some are still connected), shows the address to give
// one, and disconnects one. Without the feature the sheet is the read-only token sheet it was.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const m = vi.hoisted(() => ({ conn: null, calls: [], toast: vi.fn(), confirm: null }))
vi.mock('../lib/api.js', () => ({
  api: async (path, opts = {}) => {
    m.calls.push([opts.method || 'GET', path])
    if (path.startsWith('/api/account/mcp-tokens')) return { tokens: [], max: 10 }
    if (path === '/api/account/mcp-connections') return m.conn
    if (path.startsWith('/api/account/mcp-connections?id=')) return { ok: true, connections: [] }
    throw new Error('unexpected ' + path)
  }
}))
vi.mock('../store/useUI.js', () => ({ useUI: { getState: () => ({ toast: m.toast }) } }))
vi.mock('../sheets.jsx', () => ({ confirmSheet: o => { m.confirm = o } }))
vi.mock('../lib/clipboard.js', () => ({ copyText: async () => true }))

const { McpTokensSheet } = await import('./McpTokens.jsx')

let host, root
beforeEach(() => {
  m.calls = []; m.confirm = null; m.toast.mockClear()
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })
const mount = async () => { await act(async () => { root.render(<McpTokensSheet close={() => {}} />) }) }

describe('McpTokensSheet — connected assistants', () => {
  it('stays the token sheet it was when the server has no hosted MCP for this profile', async () => {
    m.conn = { enabled: false, connections: [] }
    await mount()
    expect(host.textContent).not.toContain('Connected assistants')
    expect(host.textContent).not.toContain('Read-only tokens')
    expect(host.textContent).toContain('Create token')
  })

  it('shows the address and the connections, and disconnects one after confirming', async () => {
    m.conn = { enabled: true, endpoint: 'https://gym.example/api/mcp', connections: [{ id: 'g1', client: 'ChatGPT', scopes: ['gymly:read', 'gymly:write'], created: Date.now(), lastUsed: null }] }
    await mount()
    expect(host.textContent).toContain('Connected assistants')
    expect(host.textContent).toContain('https://gym.example/api/mcp')
    expect(host.textContent).toContain('ChatGPT')
    expect(host.textContent).toContain('Can read and change your plan')
    expect(host.textContent).toContain('Read-only tokens')
    const row = [...host.querySelectorAll('.lrow')].find(r => r.textContent.includes('ChatGPT'))
    await act(async () => { row.click() })
    expect(m.confirm.title).toBe('Disconnect this assistant?')
    await act(async () => { await m.confirm.onConfirm() })
    expect(m.calls).toContainEqual(['DELETE', '/api/account/mcp-connections?id=g1'])
    expect(host.textContent).toContain('No assistants connected yet.')
  })
})
