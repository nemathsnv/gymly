// The Oura integration's routes (api/oura/routes.js). The server does the OAuth exchange and holds
// the tokens; the app only ever sees the consent URL, connection facts and the overview. Nothing
// returned here is written into the store: the overview stays in the screen's own memory.
import { api } from './api.js'
import { localTZ } from './format.js'

const BASE = '/api/integrations/oura'
// A first look backfills 90 days: about eleven requests to Oura, one after another.
const SLOW_MS = 90000

export const ouraStatus = () => api(BASE + '/status')
export const ouraConnectUrl = () => api(BASE + '/connect', { method: 'POST', body: '{}' }).then(r => r.url)
// The device's zone goes along, so Oura's heart-rate samples fall on the person's own days.
const tz = () => encodeURIComponent(localTZ())
export const ouraOverview = (days = 14) => api(`${BASE}/overview?days=${days}&tz=${tz()}`, { timeout: SLOW_MS })
export const ouraSync = (days = 14) => api(`${BASE}/sync?days=${days}&tz=${tz()}`, { method: 'POST', body: '{}', timeout: SLOW_MS })
// Per data type: shared or not, records or not — never a value (api/oura/routes.js).
export const ouraDiagnostics = (refresh = false) => api(`${BASE}/diagnostics?tz=${tz()}${refresh ? '&refresh=1' : ''}`, { timeout: SLOW_MS })
export const ouraDisconnect = () => api(BASE + '/disconnect', { method: 'POST', body: '{}' })

/** What the callback's ?oura= result means, for a toast. Null for nothing to say. */
export function connectResultMessage(code, t) {
  switch (code) {
    case 'connected': return t('Oura connected')
    case 'denied': return t('Oura access was not granted')
    case 'expired': return t('The Oura sign-in took too long. Try again.')
    case 'mismatch': return t('Sign in to Gymly with the same profile, then connect Oura again.')
    case 'config': return t('Oura refused this server’s app credentials. Check OURA_CLIENT_ID and OURA_CLIENT_SECRET.')
    case 'off': return t('Oura is not set up on this server')
    case 'error': return t('Could not connect Oura. Try again.')
    default: return null
  }
}

/** An overview failure, for a toast or the screen's empty state. */
export function overviewErrorMessage(e, t) {
  const code = e?.data?.code
  if (code === 'reauth') return t('Oura needs to be connected again.')
  if (code === 'rate') return t('Oura is busy. Try again in a few minutes.')
  if (code === 'off') return t('Oura is not set up on this server')
  if (code === 'network' || code === 'http') return t('Oura could not be reached.')
  return t('Could not load your Oura data.')
}
