/* The hosted server's stand-in for state.js: the same getState()/getUser() the tools read, but
   answering for whichever profile the current call belongs to rather than for one profile the
   process was started for.

   The hosted MCP endpoint (api/mcp-remote) serves every connected profile from one process. Its
   bundle (scripts/build-mcp-hosted.mjs) swaps this file in for state.js, so tools.js runs
   unchanged. That is safe because every tool handler is synchronous: withState sets the profile,
   runs the handler and clears it with nothing awaited in between, so no other call can read the
   profile one call set. A handler that ever becomes async has to stop using this. */

import { dropPrivate } from './private-keys.js'

let _current = null

// Same defaults state.js merges in, so a document saved before a field existed reads the same here.
function defaultsShape() {
  return {
    unit: 'kg', restSec: 90, sound: true, lang: 'en',
    theme: 'dark', accent: 'lime', body: 'male', targetW: null,
    bodyweight: [], routines: [], week: {}, dayPlan: {},
    exWeights: {}, workouts: [], customEx: [], gifSize: 'full',
    reminder: { on: false, time: '08:00', tz: null }
  }
}

/** Runs `fn` with `S` (the profile's document, or null for one never synced) and `user` current. */
export function withState(S, user, fn) {
  if (_current) throw new Error('withState is not re-entrant')
  _current = {
    state: S ? Object.assign({}, defaultsShape(), dropPrivate(S)) : null,
    user: { id: user.id, name: user.name, created: user.created || null }
  }
  try {
    const out = fn()
    if (out && typeof out.then === 'function') throw new Error('a hosted tool handler must be synchronous')
    return out
  } finally {
    _current = null
  }
}

function current() {
  if (!_current) throw new Error('no profile is current — call through withState')
  return _current
}

export const getState = () => current().state
export const getUser = () => ({ ...current().user })
