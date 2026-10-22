/* The OAuth 2.1 authorization server behind the hosted MCP endpoint (/api/mcp).
 *
 * An assistant (ChatGPT, Claude, Claude Code, any MCP client) gets a token for one Gymly profile
 * by sending its owner through Gymly's own sign-in and a consent screen, never by being handed a
 * password or a session. What it gets is narrower than a session on every axis, like the V1 MCP
 * token (mcp-access.js):
 *
 *   - two scopes, `gymly:read` and `gymly:write`; only /api/mcp honours them, and sessionOf()
 *     refuses every token minted here, so /api/data, the account and admin routes stay shut;
 *   - one profile and one resource: the token names its grant, the grant its user, and both are
 *     bound to https://<origin>/api/mcp (RFC 8707) — a token is refused anywhere else;
 *   - opaque random values, stored only as SHA-256 hashes: a copy of db.json opens nothing;
 *   - access tokens live an hour; refresh tokens rotate on every use, and a spent one presented
 *     again after a one-minute grace (a retry that lost its answer) ends the whole connection,
 *     since it means two parties hold it;
 *   - a grant dies with the account's sessions (it carries the session version, like a cookie),
 *     with a disable or a delete, when the owner disconnects it in Settings, when the user is
 *     taken off MCP_OAUTH_USERS, and after MAX_GRANT_DAYS whatever happens;
 *   - only listed users can authorize at all (MCP_OAUTH_USERS); with the list empty, nobody can.
 *
 * Clients identify themselves with a Client ID Metadata Document (an https client_id whose URL
 * serves its metadata — ChatGPT and Claude Code do) or register dynamically (RFC 7591, Claude and
 * most SDK clients). Registration is open, so nothing about a client is trusted until the person
 * at the consent screen approves it: errors before then are shown on Gymly's page and never
 * redirected (RFC 9700 §4.11.2), and the consent screen shows where the answer will be sent.
 *
 * Pure bookkeeping: storage is `db.mcpClients` / `db.mcpGrants` (saved by the caller through
 * `save`) plus two in-memory maps for the minutes-long authorization requests and codes. HTTP,
 * HTML and the audit log are server.js's and consent.js's. */
import crypto from 'node:crypto';

export const SCOPES = Object.freeze(['gymly:read', 'gymly:write']);
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_MS = 30 * 86400000;
export const MAX_GRANT_DAYS = 180;
export const REQUEST_TTL_MS = 10 * 60000;
export const CODE_TTL_MS = 5 * 60000;
export const REUSE_GRACE_MS = 60000;
// A registration nobody has completed a connection with lives in memory only, for an hour: open
// registration must not be a way to grow db.json, which every sign-in rewrites.
export const DCR_UNUSED_MS = 3600000;
export const MAX_PENDING_CLIENTS = 1000;
export const REDIRECT_URI_MAX = 512;
export const DCR_USED_MS = 180 * 86400000;
export const MAX_GRANTS_PER_USER = 10;
export const MAX_CLIENTS = 500;
export const MAX_REQUESTS = 2000;

const PREFIX = { access: 'gymly_oat_', refresh: 'gymly_ort_', code: 'gymly_oac_', secret: 'gymly_ocs_' };
export const OAUTH_TOKEN_PREFIX = 'gymly_o';
const TOKEN_RE = /^gymly_o(at|rt|ac|cs)_[A-Za-z0-9_-]{43}$/;
const sha = v => crypto.createHash('sha256').update('gymly-oauth:' + v).digest('hex');
const mint = kind => PREFIX[kind] + crypto.randomBytes(32).toString('base64url');
const shaped = (v, kind) => typeof v === 'string' && TOKEN_RE.test(v) && v.startsWith(PREFIX[kind]);
const eq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const DAY = 86400000;

// Display text from a client: no control, bidi or separator characters, bounded.
export const cleanText = (v, n = 100) => String(v == null ? '' : v)
  .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2028\u2029\ufeff]/g, '').trim().slice(0, n);

/* ---------- redirect URIs ---------- */

const BAD_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:', 'http:', 'https:']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export function validRedirectUri(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > REDIRECT_URI_MAX) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash || u.username || u.password || raw.includes('#')) return false;
  if (u.protocol === 'https:') return !!u.hostname;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  // A native app's private-use scheme (RFC 8252 §7.1): com.example.app:/callback.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !BAD_SCHEMES.has(u.protocol);
}
/** Exact match, except a loopback http redirect may use any port (RFC 8252 §7.3). */
export function redirectUriMatches(registered, presented) {
  if (typeof presented !== 'string') return false;
  return (registered || []).some(r => {
    if (r === presented) return true;
    let a, b;
    try { a = new URL(r); b = new URL(presented); } catch { return false; }
    return a.protocol === 'http:' && b.protocol === 'http:' && LOOPBACK.has(a.hostname) && a.hostname === b.hostname
      && a.pathname === b.pathname && a.search === b.search;
  });
}
// "Verified" on the consent screen means: the code can only go to that service. Decided by exact
// redirect targets (and exact metadata-document URLs), never by host suffix: any page some user
// can publish under a big domain could otherwise serve a document calling itself ChatGPT.
const KNOWN_CLIENT_IDS = new Set(['https://chatgpt.com/oauth/client.json', 'https://claude.ai/oauth/claude-code-client-metadata']);
const KNOWN_CLIENT_ID_RE = /^https:\/\/chatgpt\.com\/oauth\/[A-Za-z0-9_-]{1,64}\/client\.json$/;
const KNOWN_REDIRECTS = new Set(['https://chatgpt.com/connector_platform_oauth_redirect', 'https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']);
const KNOWN_REDIRECT_RE = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,64}$/;
export const knownRedirect = u => KNOWN_REDIRECTS.has(u) || KNOWN_REDIRECT_RE.test(u);
export const knownClientId = id => KNOWN_CLIENT_IDS.has(id) || KNOWN_CLIENT_ID_RE.test(id);
/** Where an answer goes, as a person reads it on the consent screen. */
export function describeRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return u.host;
    if (u.protocol === 'http:') return `an app on this computer (${u.host})`;
    return uri.slice(0, 200);
  } catch { return 'an unknown address'; }
}

/* ---------- Client ID Metadata Documents ---------- */

export function validMetadataUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 512) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.port) return false;
  if (!u.pathname || u.pathname === '/') return false;
  // An IP literal names no organisation, and is the shape an SSRF probe takes.
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.startsWith('[')) return false;
  return true;
}

/* ---------- the store ---------- */

/**
 * `deps`:
 *   getDb()               the live db object (db.json); `save()` writes it
 *   findUser(id)          the user record or null
 *   allowed(user)         whether the user may connect assistants (MCP_OAUTH_USERS)
 *   sessionVersion(user)  the account's session version
 *   fetchMetadata(url)    → Promise<object> of a client metadata document (SSRF-guarded by server.js)
 *   config                { issuer, resource }
 *   now()                 clock (tests)
 */
export function createOAuth(deps) {
  const now = deps.now || Date.now;
  const { issuer, resource } = deps.config;
  const requests = new Map();   // request id -> pending consent
  const codes = new Map();      // sha(code) -> issued code
  const cimd = new Map();       // client_id url -> { client, fresh } | { fail, exp }
  const pending = new Map();    // client_id -> a registration not yet used for a connection
  const budget = { at: 0, all: 0, host: new Map() };

  const db = () => {
    const d = deps.getDb();
    if (!Array.isArray(d.mcpClients)) d.mcpClients = [];
    if (!Array.isArray(d.mcpGrants)) d.mcpGrants = [];
    return d;
  };

  function sweep() {
    const t = now();
    for (const [k, v] of requests) if (v.exp < t) requests.delete(k);
    for (const [k, v] of codes) if (v.exp < t) codes.delete(k);
    for (const [k, v] of cimd) if (v.fail && v.exp < t) cimd.delete(k);
    for (const [k, v] of pending) if (v.exp < t) pending.delete(k);
    const d = db();
    const before = d.mcpClients.length + d.mcpGrants.length;
    d.mcpClients = d.mcpClients.filter(c => c && c.exp > t);
    d.mcpGrants = d.mcpGrants.filter(g => g && g.exp > t && g.rt && g.rt.exp > t);
    return d.mcpClients.length + d.mcpGrants.length !== before;
  }

  /* ----- clients ----- */

  // Fetches of metadata documents an anonymous authorize link can ask for: at most 10 per host and
  // 120 in all per 10 minutes. A document once read good is kept and served even when it cannot be
  // fetched again (budget spent, the host down), so nobody can lock ChatGPT or Claude Code out by
  // spending the budget on hosts of their own.
  function mayFetch(clientId) {
    const t = now();
    if (t - budget.at > 600000) { budget.at = t; budget.all = 0; budget.host.clear(); }
    let host = '';
    try { host = new URL(clientId).hostname; } catch { return false; }
    const n = (budget.host.get(host) || 0) + 1;
    if (n > 10 || budget.all >= 120) return false;
    budget.host.set(host, n);
    budget.all++;
    return true;
  }

  async function clientFor(clientId) {
    if (typeof clientId !== 'string' || !clientId || clientId.length > 512) return null;
    if (clientId.startsWith('https://')) {
      if (!validMetadataUrl(clientId)) return null;
      const hit = cimd.get(clientId);
      if (hit?.client && hit.fresh > now()) return hit.client;
      if (hit?.fail && hit.exp > now()) return null;
      if (!mayFetch(clientId)) return hit?.client || null;
      let doc;
      try { doc = await deps.fetchMetadata(clientId); } catch { doc = null; }
      const client = metadataClient(clientId, doc);
      if (client) {
        cimd.set(clientId, { client, fresh: now() + 3600000 });
        // Good documents are few; bounded all the same.
        if (cimd.size > 500) for (const [k, v] of cimd) { if (v.fail) cimd.delete(k); if (cimd.size <= 400) break; }
        return client;
      }
      if (hit?.client) return hit.client;
      cimd.set(clientId, { fail: true, exp: now() + 300000 });
      return null;
    }
    const c = db().mcpClients.find(x => x.client_id === clientId && x.exp > now()) || pending.get(clientId);
    return c && c.exp > now() ? { ...c, cimd: false, verified: c.redirect_uris.every(knownRedirect) } : null;
  }

  function metadataClient(clientId, doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    if (doc.client_id !== clientId) return null;
    const name = cleanText(doc.client_name);
    const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [];
    if (!name || !uris.length || uris.length > 10 || !uris.every(validRedirectUri)) return null;
    // A metadata document is public; such a client authenticates with PKCE alone.
    return { client_id: clientId, client_name: name, redirect_uris: uris, auth_method: 'none', cimd: true, verified: knownClientId(clientId) };
  }

  /** RFC 7591. → { status, body }. */
  function register(body) {
    sweep();
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
      return { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris must list 1-10 https, loopback http or app-scheme URIs without a fragment' } };
    }
    const method = b.token_endpoint_auth_method == null ? 'client_secret_basic' : b.token_endpoint_auth_method;
    if (!['none', 'client_secret_basic', 'client_secret_post'].includes(method)) return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'unsupported token_endpoint_auth_method' } };
    const grants = b.grant_types == null ? ['authorization_code', 'refresh_token'] : b.grant_types;
    if (!Array.isArray(grants) || !grants.length || grants.some(g => !['authorization_code', 'refresh_token'].includes(g))) return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'grant_types may only be authorization_code and refresh_token' } };
    const responses = b.response_types == null ? ['code'] : b.response_types;
    if (!Array.isArray(responses) || responses.some(r => r !== 'code')) return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'response_types may only be code' } };
    const d = db();
    if (d.mcpClients.length >= MAX_CLIENTS) return { status: 503, body: { error: 'temporarily_unavailable', error_description: 'too many registered clients; try again later' } };
    while (pending.size >= MAX_PENDING_CLIENTS) pending.delete(pending.keys().next().value);
    const t = now();
    const client = {
      client_id: crypto.randomBytes(18).toString('base64url'),
      client_name: cleanText(b.client_name) || 'Unnamed MCP client',
      redirect_uris: uris.slice(),
      auth_method: method,
      created: t, lastUsed: null, exp: t + DCR_UNUSED_MS
    };
    let secret = null;
    if (method !== 'none') { secret = mint('secret'); client.secretHash = sha(secret); }
    pending.set(client.client_id, client);
    return {
      status: 201,
      body: {
        client_id: client.client_id, client_id_issued_at: Math.floor(t / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_name: client.client_name, redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: method, grant_types: grants, response_types: ['code']
      }
    };
  }

  /* ----- authorization ----- */

  function resourceOk(v) {
    if (v == null || v === '') return true;
    const s = String(v).replace(/\/+$/, '');
    return s === resource || s === issuer;
  }
  function parseScopes(raw) {
    const asked = String(raw || '').split(/\s+/).filter(Boolean).filter(s => SCOPES.includes(s));
    return asked.length ? [...new Set(asked)] : [...SCOPES];
  }

  /**
   * Checks an /authorize request. → { ok:true, client, params } or { ok:false, page, reason }
   * (shown on Gymly's own page, never redirected) or { ok:false, redirect } (an error the client
   * may hear about: its redirect URI is already known to be its own).
   */
  async function checkAuthorize(q) {
    const one = k => { const v = q.getAll(k); return v.length > 1 ? undefined : (v[0] ?? null); };
    const clientId = one('client_id');
    const client = await clientFor(clientId);
    if (!client) return { ok: false, page: 'unknown_client' };
    const redirectUri = one('redirect_uri');
    if (!redirectUriMatches(client.redirect_uris, redirectUri)) return { ok: false, page: 'bad_redirect' };
    const state = one('state');
    if (state === undefined || (state && state.length > 1024)) return { ok: false, page: 'bad_request' };
    // Shown here, not redirected: registration is open, so until the person approves on the
    // consent screen the redirect URI is the requester's own choice, and an automatic redirect
    // would make this endpoint an open redirector (RFC 9700 §4.11.2).
    const back = (error, description) => ({ ok: false, page: 'bad_request', error, description });
    if (one('response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code');
    if (one('code_challenge_method') !== 'S256') return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    const challenge = one('code_challenge');
    if (!challenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) return back('invalid_request', 'code_challenge is missing or malformed');
    const res = one('resource');
    if (res === undefined || !resourceOk(res)) return back('invalid_target', 'resource must be ' + resource);
    return { ok: true, client, params: { clientId: client.client_id, redirectUri, state: state || null, challenge, scopes: parseScopes(one('scope')) } };
  }

  function errorRedirect(redirectUri, state, error, description) {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    if (description) u.searchParams.set('error_description', description);
    if (state) u.searchParams.set('state', state);
    u.searchParams.set('iss', issuer);
    return u.toString();
  }

  /** A consent screen shown to `user`: its single-use id. */
  function openRequest(user, client, params) {
    sweep();
    while (requests.size >= MAX_REQUESTS) requests.delete(requests.keys().next().value);
    const id = crypto.randomBytes(24).toString('base64url');
    requests.set(id, { userId: user.id, client: { client_id: client.client_id, client_name: client.client_name, verified: !!client.verified, cimd: !!client.cimd }, ...params, exp: now() + REQUEST_TTL_MS });
    return id;
  }
  const peekRequest = (id, user) => {
    const r = typeof id === 'string' ? requests.get(id) : null;
    return r && r.exp > now() && r.userId === user.id ? r : null;
  };

  /**
   * The answer to a consent screen. → { redirect } or { page: reason }.
   * Only the user who was shown the screen can answer it, and only once.
   */
  function decide(user, id, { allow, allowWrite }) {
    const r = peekRequest(id, user);
    if (!r) return { page: 'expired' };
    if (!deps.allowed(user)) return { page: 'not_available' };
    requests.delete(id);
    if (!allow) return { redirect: errorRedirect(r.redirectUri, r.state, 'access_denied', 'The user declined'), denied: true, request: r };
    const scopes = r.scopes.filter(s => s === 'gymly:read' || (s === 'gymly:write' && allowWrite));
    if (!scopes.includes('gymly:read')) scopes.unshift('gymly:read');
    const code = mint('code');
    codes.set(sha(code), { userId: user.id, sv: deps.sessionVersion(user), clientId: r.clientId, clientName: r.client.client_name, redirectUri: r.redirectUri, challenge: r.challenge, scopes, resource, exp: now() + CODE_TTL_MS });
    const u = new URL(r.redirectUri);
    u.searchParams.set('code', code);
    if (r.state) u.searchParams.set('state', r.state);
    u.searchParams.set('iss', issuer);
    return { redirect: u.toString(), scopes, request: r };
  }

  /* ----- token endpoint ----- */

  const oauthError = (status, error, description, headers) => ({ status, body: { error, ...(description ? { error_description: description } : {}) }, headers });

  /** Client authentication at the token and revocation endpoints. → { client } | { error } */
  async function authenticate(form, authorization) {
    let id = form.get('client_id'), secret = form.get('client_secret'), basic = false;
    if (typeof authorization === 'string' && /^Basic\s+/i.test(authorization)) {
      basic = true;
      let pair;
      try { pair = Buffer.from(authorization.replace(/^Basic\s+/i, ''), 'base64').toString('utf8'); } catch { pair = ''; }
      const i = pair.indexOf(':');
      if (i < 0) return { error: oauthError(401, 'invalid_client', 'malformed Basic credentials', { 'WWW-Authenticate': 'Basic' }) };
      let bid, bsecret;
      try { bid = decodeURIComponent(pair.slice(0, i)); bsecret = decodeURIComponent(pair.slice(i + 1)); } catch { return { error: oauthError(401, 'invalid_client', null, { 'WWW-Authenticate': 'Basic' }) }; }
      if (id && id !== bid) return { error: oauthError(401, 'invalid_client', 'client_id disagrees with the Basic credentials', { 'WWW-Authenticate': 'Basic' }) };
      id = bid; secret = bsecret;
    }
    // A metadata-document client is public by definition (it authenticates with PKCE, or with the
    // refresh token bound to it), so the token and revocation endpoints need not fetch its document:
    // they must keep working for a connected client whatever happens to that fetch.
    const client = typeof id === 'string' && id.startsWith('https://')
      ? (validMetadataUrl(id) ? { client_id: id, auth_method: 'none', cimd: true } : null)
      : await clientFor(id);
    const fail = oauthError(401, 'invalid_client', 'unknown client or bad credentials', basic ? { 'WWW-Authenticate': 'Basic' } : undefined);
    if (!client) return { error: fail };
    if (client.auth_method === 'none') {
      if (secret) return { error: fail };
      return { client };
    }
    if (!secret || !shaped(secret, 'secret') || !client.secretHash || !eq(sha(secret), client.secretHash)) return { error: fail };
    return { client };
  }

  function pkceOk(verifier, challenge) {
    if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
    return eq(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);
  }

  function grantLive(g, t = now()) {
    if (!g || g.exp <= t) return null;
    const user = deps.findUser(g.userId);
    if (!user || user.disabled || !deps.allowed(user) || (g.sv || 0) !== deps.sessionVersion(user)) return null;
    return user;
  }

  function issue(g) {
    const t = now();
    const access = mint('access'), refresh = mint('refresh');
    g.at = [...(g.at || []).filter(a => a.exp > t), { h: sha(access), exp: t + ACCESS_TTL_S * 1000 }].slice(-3);
    if (g.rt) g.rtUsed = [...(g.rtUsed || []), { h: g.rt.h, at: t }].slice(-5);
    g.rt = { h: sha(refresh), exp: Math.min(t + REFRESH_TTL_MS, g.exp) };
    g.refreshed = t;
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: g.scopes.join(' ') };
  }

  /** POST /token. → { status, body, headers?, event? } */
  async function token(form, authorization) {
    sweep();
    const grantType = form.get('grant_type');
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') return oauthError(400, 'unsupported_grant_type');
    const auth = await authenticate(form, authorization);
    if (auth.error) return auth.error;
    const client = auth.client;
    if (form.getAll('resource').length > 1 || !resourceOk(form.get('resource'))) return oauthError(400, 'invalid_target', 'resource must be ' + resource);
    const d = db();
    const t = now();

    if (grantType === 'authorization_code') {
      const raw = form.get('code');
      // Taken before anything else is checked: a code is spent by any attempt, so a wrong
      // verifier cannot be retried against it.
      const c = shaped(raw, 'code') ? codes.get(sha(raw)) : null;
      if (c) codes.delete(sha(raw));
      if (!c || c.exp < t) return oauthError(400, 'invalid_grant', 'the code is invalid, used or expired');
      if (c.clientId !== client.client_id) return oauthError(400, 'invalid_grant', 'the code was issued to another client');
      if (form.get('redirect_uri') !== c.redirectUri) return oauthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
      if (!pkceOk(form.get('code_verifier'), c.challenge)) return oauthError(400, 'invalid_grant', 'PKCE verification failed');
      const user = deps.findUser(c.userId);
      if (!user || user.disabled || !deps.allowed(user) || deps.sessionVersion(user) !== c.sv) return oauthError(400, 'invalid_grant', 'the account can no longer authorize this connection');
      // The oldest grant of the user goes when the cap is reached, as the oldest sign-in would.
      const mine = d.mcpGrants.filter(g => g.userId === user.id).sort((a, b) => a.created - b.created);
      if (mine.length >= MAX_GRANTS_PER_USER) {
        const drop = new Set(mine.slice(0, mine.length - MAX_GRANTS_PER_USER + 1).map(g => g.id));
        d.mcpGrants = d.mcpGrants.filter(g => !drop.has(g.id));
      }
      const g = {
        id: crypto.randomBytes(12).toString('base64url'),
        userId: user.id, sv: c.sv, clientId: client.client_id, clientName: c.clientName,
        scopes: c.scopes, resource: c.resource, created: t, refreshed: t, lastUsed: null,
        exp: t + MAX_GRANT_DAYS * DAY
      };
      const body = issue(g);
      d.mcpGrants.push(g);
      if (!client.cimd) {
        // A registration that has now been used for a connection is kept, in db.json.
        let reg = d.mcpClients.find(x => x.client_id === client.client_id);
        if (!reg && pending.has(client.client_id)) { reg = pending.get(client.client_id); pending.delete(client.client_id); d.mcpClients.push(reg); }
        if (reg) { reg.lastUsed = t; reg.exp = t + DCR_USED_MS; }
      }
      deps.save();
      return { status: 200, body, event: { kind: 'grant', grant: g, user } };
    }

    // refresh_token
    const raw = form.get('refresh_token');
    if (!shaped(raw, 'refresh')) return oauthError(400, 'invalid_grant', 'the refresh token is invalid');
    const h = sha(raw);
    const live = d.mcpGrants.find(g => g.rt && eq(g.rt.h, h));
    if (!live) {
      const spent = d.mcpGrants.find(g => (g.rtUsed || []).some(u => eq(u.h, h)));
      if (spent) {
        const used = spent.rtUsed.find(u => eq(u.h, h));
        if (t - used.at > REUSE_GRACE_MS) {
          d.mcpGrants = d.mcpGrants.filter(g => g !== spent);
          deps.save();
          return { ...oauthError(400, 'invalid_grant', 'the refresh token was already used; the connection has been revoked'), event: { kind: 'reuse', grant: spent } };
        }
      }
      return oauthError(400, 'invalid_grant', 'the refresh token is invalid, used or expired');
    }
    if (live.rt.exp < t) return oauthError(400, 'invalid_grant', 'the refresh token expired');
    if (live.clientId !== client.client_id) {
      d.mcpGrants = d.mcpGrants.filter(g => g !== live);
      deps.save();
      return { ...oauthError(400, 'invalid_grant', 'the refresh token belongs to another client; the connection has been revoked'), event: { kind: 'reuse', grant: live } };
    }
    const user = grantLive(live, t);
    if (!user) {
      d.mcpGrants = d.mcpGrants.filter(g => g !== live);
      deps.save();
      return oauthError(400, 'invalid_grant', 'the connection is no longer valid');
    }
    const asked = String(form.get('scope') || '').split(/\s+/).filter(Boolean);
    if (asked.some(s => !live.scopes.includes(s))) return oauthError(400, 'invalid_scope', 'a refresh cannot add scopes');
    const body = issue(live);
    deps.save();
    return { status: 200, body };
  }

  /** RFC 7009. Always 200 for an authenticated client; ends the whole connection. */
  async function revoke(form, authorization) {
    const auth = await authenticate(form, authorization);
    if (auth.error) return auth.error;
    const tok = form.get('token');
    if (!tok) return oauthError(400, 'invalid_request', 'token is required');
    const d = db();
    const h = typeof tok === 'string' ? sha(tok) : '';
    const g = d.mcpGrants.find(x => (x.at || []).some(a => eq(a.h, h)) || (x.rt && eq(x.rt.h, h)) || (x.rtUsed || []).some(u => eq(u.h, h)));
    if (g && g.clientId === auth.client.client_id) {
      d.mcpGrants = d.mcpGrants.filter(x => x !== g);
      deps.save();
      return { status: 200, body: {}, event: { kind: 'revoke', grant: g } };
    }
    return { status: 200, body: {} };
  }

  /* ----- the resource server's side ----- */

  /** A bearer token presented at /api/mcp. → { grant, user, scopes } | { error: 'invalid_token' } */
  function resolve(tokenValue) {
    if (!shaped(tokenValue, 'access')) return { error: 'invalid_token' };
    const t = now();
    const h = sha(tokenValue);
    const d = db();
    const g = d.mcpGrants.find(x => (x.at || []).some(a => a.exp > t && eq(a.h, h)));
    if (!g || g.resource !== resource) return { error: 'invalid_token' };
    const user = grantLive(g, t);
    if (!user) {
      // Dead for good (signed out everywhere, disabled, off the list): cleared now rather than
      // left listed as connected until it expires.
      d.mcpGrants = d.mcpGrants.filter(x => x !== g);
      deps.save();
      return { error: 'invalid_token' };
    }
    if (!g.lastUsed || t - g.lastUsed > 10 * 60000) { g.lastUsed = t; deps.save(); }
    return { grant: g, user, scopes: g.scopes.slice() };
  }

  /* ----- the owner's view ----- */

  const view = g => ({ id: g.id, client: g.clientName, scopes: g.scopes, created: g.created, lastUsed: g.lastUsed, refreshed: g.refreshed, expires: g.rt ? Math.min(g.rt.exp, g.exp) : g.exp });
  function listGrants(userId) {
    if (sweep()) deps.save();
    return db().mcpGrants.filter(g => g.userId === userId).sort((a, b) => b.created - a.created).map(view);
  }
  function revokeGrant(userId, id) {
    const d = db();
    const g = typeof id === 'string' ? d.mcpGrants.find(x => x.id === id && x.userId === userId) : null;
    if (!g) return null;
    d.mcpGrants = d.mcpGrants.filter(x => x !== g);
    deps.save();
    return g;
  }
  /** Every grant of a user, for the moments its sessions end. Says whether anything went. */
  function dropGrants(userId) {
    const d = db();
    const n = d.mcpGrants.length;
    d.mcpGrants = d.mcpGrants.filter(g => g.userId !== userId);
    for (const [k, v] of codes) if (v.userId === userId) codes.delete(k);
    for (const [k, v] of requests) if (v.userId === userId) requests.delete(k);
    return d.mcpGrants.length !== n;
  }

  return {
    register, checkAuthorize, openRequest, peekRequest, decide, token, revoke, resolve,
    listGrants, revokeGrant, dropGrants, sweep, clientFor,
    _codes: codes, _requests: requests, _pending: pending
  };
}

/* ---------- discovery documents ---------- */

export function protectedResourceMetadata({ issuer, resource }) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Gymly',
    resource_documentation: 'https://github.com/nemathsnv/gymly/blob/main/docs/MCP.md'
  };
}

export function authorizationServerMetadata({ issuer }) {
  return {
    issuer,
    authorization_endpoint: issuer + '/api/oauth/authorize',
    token_endpoint: issuer + '/api/oauth/token',
    registration_endpoint: issuer + '/api/oauth/register',
    revocation_endpoint: issuer + '/api/oauth/revoke',
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: [...SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true
  };
}

export const protectedResourceMetadataUrl = ({ issuer }) => issuer + '/.well-known/oauth-protected-resource/api/mcp';

/** The WWW-Authenticate challenge of a 401 (or 403) from /api/mcp (RFC 6750, RFC 9728). */
export function bearerChallenge(cfg, error, description) {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl(cfg)}"`, `scope="${SCOPES.join(' ')}"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${String(description).replace(/["\\]/g, '')}"`);
  return 'Bearer ' + parts.join(', ');
}
