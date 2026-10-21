/* Remote mode: the profile comes from a Gymly server over HTTPS instead of a ./data folder on
   this machine. For the common case where Gymly runs on a server somewhere and the LLM client on
   a laptop — the data directory is not on the laptop, and must not be copied there.

   The credential is a read-only MCP token the owner makes in Gymly → Settings → AI assistant
   access (api/mcp-access.js). It opens GET /api/mcp/v1/state for that one profile and nothing
   else: not the sync route, not the account, not the admin dashboard. This file's whole job is to
   carry it there and back without it leaking anywhere on the way:

     - read from a file (GYMLY_MCP_TOKEN_FILE) that only its owner can read, or from the
       environment (GYMLY_MCP_TOKEN); never from a command-line argument, which `ps` shows;
     - sent only to the configured origin, only over HTTPS (plain http only to this machine),
       never across a redirect;
     - never in an error message, a log line or a tool result — every message below is built from
       fixed text and status codes, and the token is checked for shape without echoing it. */
import fs from 'node:fs'

export const TOKEN_RE = /^gymly_mcp_[A-Za-z0-9_-]{43}$/
// Kept in step with MCP_WITHHELD in api/mcp-access.js, which is what actually decides. Applied
// again here so a server from before that list existed still sends the assistant none of it.
export const WITHHELD = Object.freeze(['gymCards', 'lastGymCardId', 'coach', 'reminder', 'hints', '_unstamped', '_prior', '_wids', '_wid'])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
export const DEFAULT_TTL_MS = 15000
const TIMEOUT_MS = 15000

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// → { base, host, token, ttlMs } when GYMLY_URL is set, null when it is not (local mode). Throws a
// coded error, with a message safe to show anyone, when the configuration is wrong.
export function remoteConfig(env = process.env, fsImpl = fs) {
  const raw = (env.GYMLY_URL || '').trim()
  if (!raw) return null
  let url
  try { url = new URL(raw) } catch { throw fail('EINVAL', 'GYMLY_URL is not a URL (expected e.g. https://gymly.example.com)') }
  if (url.username || url.password) throw fail('EINVAL', 'GYMLY_URL must not carry a user name or password')
  if (url.search || url.hash) throw fail('EINVAL', 'GYMLY_URL must not carry a query string or fragment')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw fail('EINVAL', 'GYMLY_URL must be https:// (plain http:// is accepted only for localhost), so the token never crosses a network in clear text')
  }
  // A base path (an instance under BASE_PATH) is kept; the trailing slash is not.
  const base = url.origin + url.pathname.replace(/\/+$/, '')

  let token = ''
  const file = (env.GYMLY_MCP_TOKEN_FILE || '').trim()
  if (file) {
    let st
    try { st = fsImpl.statSync(file) } catch (e) { throw fail('EINVAL', `GYMLY_MCP_TOKEN_FILE cannot be read (${e.code || 'error'})`) }
    if (!st.isFile()) throw fail('EINVAL', 'GYMLY_MCP_TOKEN_FILE is not a regular file')
    // The same rule ssh applies to a private key: a token anyone else on the machine can read is
    // a token they have. Not checked on Windows, where the mode bits mean nothing.
    if (process.platform !== 'win32' && (st.mode & 0o077)) {
      throw fail('EPERM', 'GYMLY_MCP_TOKEN_FILE can be read by other users of this machine — run: chmod 600 <the file>')
    }
    try { token = fsImpl.readFileSync(file, 'utf8').trim() } catch (e) { throw fail('EINVAL', `GYMLY_MCP_TOKEN_FILE cannot be read (${e.code || 'error'})`) }
  } else {
    token = (env.GYMLY_MCP_TOKEN || '').trim()
  }
  if (!token) throw fail('EINVAL', 'GYMLY_URL is set but no token is: set GYMLY_MCP_TOKEN_FILE (recommended) or GYMLY_MCP_TOKEN')
  // Not echoed: a session token or an API key of something else pasted here by mistake is still
  // a secret, and this message lands in the client's log.
  if (!TOKEN_RE.test(token)) throw fail('EINVAL', 'the configured token is not a Gymly MCP token (they start with gymly_mcp_; make one in Gymly → Settings → AI assistant access)')
  // How long one fetch answers tool calls before the next revalidates (a 304 when nothing moved).
  // Also how long a revoked token can keep answering from what it already fetched.
  let ttlMs = DEFAULT_TTL_MS
  const cache = (env.GYMLY_MCP_CACHE_SECONDS ?? '').trim()
  if (cache) {
    const sec = Number(cache)
    if (!Number.isInteger(sec) || sec < 0 || sec > 300) throw fail('EINVAL', 'GYMLY_MCP_CACHE_SECONDS must be a whole number from 0 to 300')
    ttlMs = sec * 1000
  }
  return { base, host: url.host, token, ttlMs }
}

export function withhold(S) {
  if (!S || typeof S !== 'object' || Array.isArray(S)) return null
  const out = {}
  for (const [k, v] of Object.entries(S)) if (!WITHHELD.includes(k)) out[k] = v
  return out
}

// The profile behind one token, fetched when a tool needs it and at most once per `ttlMs`. A
// re-fetch is conditional (ETag), so an unchanged profile costs a 304 and no body.
export function createRemoteSource({ base, token, fetchImpl = globalThis.fetch, ttlMs = DEFAULT_TTL_MS, timeoutMs = TIMEOUT_MS, now = () => Date.now() }) {
  let cache = null          // { user, state, etag, at }
  const url = base + '/api/mcp/v1/state'

  async function refresh({ force = false } = {}) {
    if (cache && !force && now() - cache.at < ttlMs) return cache
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    if (cache?.etag) headers['If-None-Match'] = cache.etag
    let res
    try {
      res = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      // Whatever the cause (DNS, refused, TLS, timeout, a redirect), say which. The token is only
      // ever in a header, never in the URL, so the runtime's short reason ("bad port", "redirect
      // mode is set to error") is safe to pass on; a long one is not worth the risk of a surprise.
      const short = typeof e?.cause?.message === 'string' && e.cause.message.length <= 60 ? e.cause.message : null
      const why = e?.name === 'TimeoutError' ? 'timed out' : (e?.cause?.code || short || e?.name || 'failed')
      throw fail('NETWORK', `could not reach Gymly at ${new URL(base).host} (${why})`)
    }
    if (res.status === 304 && cache) { cache.at = now(); return cache }
    if (res.status === 401 || res.status === 403) {
      // A revoked token must stop answering at once, not keep serving its last copy.
      cache = null
      throw fail('UNAUTHORIZED', 'Gymly refused the MCP token: it is wrong, expired or revoked, or the account signed out everywhere. Make a new one in Gymly → Settings → AI assistant access and update the token file.')
    }
    if (res.status === 429) throw fail('RATE_LIMITED', `Gymly is rate-limiting this address; try again in ${res.headers.get('retry-after') || 'a few'} seconds`)
    if (res.status === 404) throw fail('UPSTREAM', 'this Gymly server has no MCP access route — it is older than this MCP server, or GYMLY_URL points somewhere else')
    if (res.status !== 200) throw fail('UPSTREAM', `Gymly answered ${res.status}`)
    let body
    try { body = await res.json() } catch { throw fail('UPSTREAM', 'Gymly answered with something that is not JSON') }
    if (!body || typeof body !== 'object' || !body.user || typeof body.user.id !== 'string' || !('state' in body)) {
      throw fail('UPSTREAM', 'Gymly answered in a shape this MCP server does not know')
    }
    cache = {
      user: { id: body.user.id, name: String(body.user.name || 'Profile'), created: body.user.created || null },
      state: withhold(body.state),
      etag: res.headers.get('etag') || null,
      at: now()
    }
    return cache
  }

  return {
    refresh,
    get loaded() { return !!cache },
    get user() { return cache?.user || null },
    get state() { return cache ? cache.state : undefined },
    describe: () => new URL(base).host
  }
}
