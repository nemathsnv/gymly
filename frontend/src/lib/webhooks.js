// Settings → Account → Webhooks: the pure rules the sheet draws from, so they are tested here and
// components/Webhooks.jsx only draws. Ported from upstream openGym's lib/integrations.js
// (b397ab84b), the webhook part only: Gymly has no Integrations directory, just this one row.
//
// Webhooks are sent by the server (api/integrations), so the row is there only for a signed-in
// profile on a server that offers them: GET /api/config carries `integrations.providers` with
// 'webhook' for a session when the server runs with INTEGRATIONS=webhook, and nothing otherwise.

// Webhook events, in the order the form offers them. Labels are English keys for t().
export const WEBHOOK_EVENTS = [
  { id: 'workout.finished', label: 'Workout finished', icon: 'flag', tint: 'var(--green)' },
  { id: 'workout.pr', label: 'New personal record', icon: 'trophy', tint: 'var(--orange)' },
  { id: 'weighin.logged', label: 'Weigh-in logged', icon: 'scale', tint: 'var(--teal)' },
]

// The status pill, in the words the sheet shows.
export const PILL = {
  connected: 'Connected',
  off: 'Off',
  attention: 'Needs attention',
}

/** Whether this profile, on this server, can have webhooks at all. */
export function webhooksOffered(config, { user = null, demo = false } = {}) {
  if (!user || demo) return false
  const offered = config?.integrations?.providers
  return Array.isArray(offered) && offered.includes('webhook')
}

/** Whether the server lets webhooks reach the home network (INTEGRATIONS_ALLOW_LAN=1). */
export const lanAllowed = config => config?.integrations?.lan === true

/** A webhook's pill: needs attention, paused (off) or connected. */
export const webhookStatus = c => (c?.status === 'attention' ? 'attention' : c?.paused ? 'off' : 'connected')

/** The webhooks among the server's connections for this profile. */
export const webhooksOf = data => (Array.isArray(data?.connections) ? data.connections.filter(c => c && c.provider === 'webhook') : [])

/** How many webhooks a profile may have, as the server says. */
export const webhookMax = data => (Array.isArray(data?.providers) ? data.providers.find(p => p?.id === 'webhook')?.max : null) || 10

/** The client's own check of a webhook URL before it asks the server, which has the last word. */
export function webhookUrlProblem(raw, { lan = false } = {}) {
  const s = String(raw || '').trim()
  if (!s) return 'Paste the URL your tool gave you.'
  let u
  try { u = new URL(s) } catch { return 'That does not look like a URL.' }
  if (u.protocol === 'https:') return null
  if (u.protocol === 'http:' && lan) return null
  return lan ? 'It has to start with https:// or http://.' : 'It has to start with https://.'
}

/** The events with one switched on or off; null when that would leave none. */
export function toggleEvent(events, id, on) {
  const cur = Array.isArray(events) ? events : []
  const next = on ? [...new Set([...cur, id])] : cur.filter(x => x !== id)
  return next.length ? WEBHOOK_EVENTS.map(e => e.id).filter(x => next.includes(x)) : null
}
