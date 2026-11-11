/* Oura API v2 — the OAuth 2.0 authorization-code flow with PKCE, server side.
 *
 * https://cloud.ouraring.com/docs/authentication. The browser only ever sees the authorize URL
 * and the callback; the code is exchanged here, with the client secret, and the tokens never
 * leave the server. Refresh tokens are single-use: every refresh returns a new pair, and the old
 * refresh token is dead the moment it has been sent (client.js serialises refreshes for that).
 *
 * Pure functions plus an injected fetch, so the tests drive the whole exchange without a network.
 * Nothing here logs: an error carries the HTTP status and Oura's own short `error` code, never a
 * token, a code, a verifier or the secret.
 */
import crypto from 'node:crypto';

export const AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
export const TOKEN_URL = 'https://api.ouraring.com/oauth/token';
export const REVOKE_URL = 'https://api.ouraring.com/oauth/revoke';
export const API_BASE = 'https://api.ouraring.com/v2/usercollection/';
export const CALLBACK_PATH = '/api/integrations/oura/callback';

/* The scopes the overview reads, and nothing else (Oura asks apps to request only what they
   use; the API Agreement's data minimisation, §4(c)). No `email`, no `personal`. `heart_health`
   carries cardiovascular age and VO2 max. The person can still switch any of them off on Oura's
   consent screen; a refused scope shows as "not shared" in the overview, not as an error. */
export const DEFAULT_SCOPES = ['daily', 'heartrate', 'workout', 'spo2', 'heart_health'];
const KNOWN_SCOPES = new Set(['email', 'personal', 'daily', 'heartrate', 'workout', 'tag', 'session', 'spo2', 'heart_health']);

const TIMEOUT_MS = 15000;

export class OuraError extends Error {
  /** code: 'config' | 'denied' | 'reauth' | 'rate' | 'http' | 'network' */
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/**
 * The integration's settings, read from the environment, or null when it is not set up. Both
 * credentials have to be there: half a configuration is no configuration. The redirect URI is the
 * instance's own ORIGIN plus the callback path unless OURA_REDIRECT_URI says otherwise (a subpath
 * deployment); it has to match one registered with the Oura application exactly.
 */
export function ouraConfig(env = process.env, { origin, version = 'dev' } = {}) {
  const clientId = (env.OURA_CLIENT_ID || '').trim();
  const clientSecret = (env.OURA_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const scopes = (env.OURA_SCOPES || '').trim()
    ? env.OURA_SCOPES.trim().split(/[\s,]+/).filter(s => KNOWN_SCOPES.has(s))
    : DEFAULT_SCOPES;
  const redirectUri = (env.OURA_REDIRECT_URI || '').trim() || String(origin || '').replace(/\/+$/, '') + CALLBACK_PATH;
  return { clientId, clientSecret, scopes, redirectUri, userAgent: `Gymly/${version} (+${String(origin || '').replace(/\/+$/, '')})` };
}

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 7636: a 64-character verifier from the unreserved set, and its S256 challenge. */
export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(48));               // 64 chars
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** An unguessable state value: 256 bits, URL-safe. */
export const newState = () => b64url(crypto.randomBytes(32));

export function authorizeUrl(cfg, { state, challenge }) {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('scope', cfg.scopes.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

async function call(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new OuraError('network', 'Oura could not be reached' + (e?.name === 'TimeoutError' ? ' in time' : ''));
  }
}

/** A token answer, checked and reduced to what is kept. `now` is when the request was sent. */
export function parseTokenResponse(body, now = Date.now()) {
  if (!body || typeof body.access_token !== 'string' || !body.access_token || typeof body.refresh_token !== 'string' || !body.refresh_token) {
    throw new OuraError('http', 'Oura answered without a token pair');
  }
  const ttl = Number(body.expires_in);
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    // Without a usable lifetime the token is treated as already due, so the first use refreshes.
    exp: now + (Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 0),
    scope: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : null,
  };
}

async function tokenRequest(cfg, params, fetchImpl, clock = Date.now) {
  const now = clock();
  const res = await call(fetchImpl, TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': cfg.userAgent },
    body: new URLSearchParams({ ...params, client_id: cfg.clientId, client_secret: cfg.clientSecret }).toString(),
  });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = typeof body?.error === 'string' ? body.error.slice(0, 60) : '';
    // invalid_grant: the code was used or expired, or the refresh token was used, revoked or
    // belongs to a disconnected grant. Either way only a new authorization helps.
    if (res.status === 400 || res.status === 401) {
      throw new OuraError(err === 'invalid_client' ? 'config' : 'reauth', `Oura refused the token request (${res.status}${err ? ' ' + err : ''})`, { status: res.status });
    }
    if (res.status === 429) throw new OuraError('rate', 'Oura is rate limiting this app', { status: 429, retryAfter: +res.headers.get('retry-after') || null });
    throw new OuraError('http', `Oura token request failed (${res.status})`, { status: res.status });
  }
  return parseTokenResponse(body, now);
}

export function exchangeCode(cfg, { code, verifier }, fetchImpl = globalThis.fetch, clock = Date.now) {
  return tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri, code_verifier: verifier }, fetchImpl, clock);
}

export function refreshTokens(cfg, refresh, fetchImpl = globalThis.fetch, clock = Date.now) {
  return tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refresh }, fetchImpl, clock);
}

/**
 * Revoke a token at Oura (https://api.ouraring.com/oauth/revoke?access_token=…). Best effort:
 * true when Oura confirmed, false otherwise — disconnecting never depends on it, because the
 * tokens are deleted here either way. The docs give the URL and no method; POST first, and GET
 * when the endpoint says the method is not allowed.
 */
export async function revokeToken(cfg, accessToken, fetchImpl = globalThis.fetch) {
  if (!accessToken) return false;
  const url = REVOKE_URL + '?access_token=' + encodeURIComponent(accessToken);
  const headers = { 'User-Agent': cfg.userAgent, Accept: 'application/json' };
  try {
    let res = await call(fetchImpl, url, { method: 'POST', headers });
    if (res.status === 405) res = await call(fetchImpl, url, { method: 'GET', headers });
    return res.ok;
  } catch {
    return false;
  }
}
