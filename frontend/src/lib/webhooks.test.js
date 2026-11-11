import { describe, expect, it } from 'vitest'
import { WEBHOOK_EVENTS, webhooksOffered, lanAllowed, webhookStatus, webhooksOf, webhookMax, webhookUrlProblem, toggleEvent } from './webhooks.js'

describe('webhooks: when the row shows', () => {
  const on = { integrations: { providers: ['webhook'] } }
  it('only for a signed-in profile on a server that offers them', () => {
    expect(webhooksOffered(on, { user: { id: 'u' } })).toBe(true)
    expect(webhooksOffered(on, { user: null })).toBe(false)
    expect(webhooksOffered(on, { user: { id: 'u' }, demo: true })).toBe(false)
    // INTEGRATIONS unset: /api/config has no block at all.
    expect(webhooksOffered({ invite_only: false }, { user: { id: 'u' } })).toBe(false)
    expect(webhooksOffered(null, { user: { id: 'u' } })).toBe(false)
    expect(webhooksOffered({ integrations: { providers: ['other'] } }, { user: { id: 'u' } })).toBe(false)
    expect(webhooksOffered({ integrations: { providers: 'webhook' } }, { user: { id: 'u' } })).toBe(false)
  })
  it('the home network only when the server says so', () => {
    expect(lanAllowed({ integrations: { providers: ['webhook'], lan: true } })).toBe(true)
    expect(lanAllowed(on)).toBe(false)
    expect(lanAllowed(null)).toBe(false)
  })
})

describe('webhooks: what the sheet shows', () => {
  it('a status pill per webhook', () => {
    expect(webhookStatus({ status: 'connected', paused: false })).toBe('connected')
    expect(webhookStatus({ status: 'paused', paused: true })).toBe('off')
    expect(webhookStatus({ status: 'attention', paused: true })).toBe('attention')
  })
  it('only the webhooks, and the server\'s limit', () => {
    const data = { providers: [{ id: 'webhook', max: 7 }], connections: [{ id: 'a', provider: 'webhook' }, { id: 'b', provider: 'other' }, null] }
    expect(webhooksOf(data).map(c => c.id)).toEqual(['a'])
    expect(webhooksOf(null)).toEqual([])
    expect(webhookMax(data)).toBe(7)
    expect(webhookMax({})).toBe(10)
  })
  it('the URL is checked here first: https, or http when the home network is open', () => {
    expect(webhookUrlProblem('')).toBe('Paste the URL your tool gave you.')
    expect(webhookUrlProblem('ha.local')).toBe('That does not look like a URL.')
    expect(webhookUrlProblem('https://ha.example.com/api/webhook/x')).toBeNull()
    expect(webhookUrlProblem('http://192.168.1.5:8123/x')).toBe('It has to start with https://.')
    expect(webhookUrlProblem('http://192.168.1.5:8123/x', { lan: true })).toBeNull()
    expect(webhookUrlProblem('ftp://x.example', { lan: true })).toBe('It has to start with https:// or http://.')
  })
  it('switching events keeps the form\'s order and never leaves none', () => {
    expect(WEBHOOK_EVENTS.map(e => e.id)).toEqual(['workout.finished', 'workout.pr', 'weighin.logged'])
    expect(toggleEvent(['weighin.logged'], 'workout.finished', true)).toEqual(['workout.finished', 'weighin.logged'])
    expect(toggleEvent(['workout.finished', 'workout.pr'], 'workout.pr', false)).toEqual(['workout.finished'])
    expect(toggleEvent(['workout.finished'], 'workout.finished', false)).toBeNull()
  })
})
