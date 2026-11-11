/* HTTP surface of the Oura integration. Off until OURA_CLIENT_ID and OURA_CLIENT_SECRET are set:
 * every route but status answers 503 { code: 'off' } then, and status says configured: false.
 *
 *   GET  /api/integrations/oura/status      connection facts, no health data
 *   POST /api/integrations/oura/connect     → { url } of Oura's consent page (PKCE + state)
 *   GET  /api/integrations/oura/callback    Oura's redirect back; the registered redirect URI
 *   GET  /api/integrations/oura/overview    recovery overview for the last ?days= (1–30) days
 *   POST /api/integrations/oura/sync        the same, fetched fresh from Oura now
 *   POST /api/integrations/oura/disconnect  revoke at Oura, delete tokens and anything held
 *
 * Oura API and MCP Agreement (8 June 2026), what that means here:
 *  - §3(m)/§4(c) minimisation: health data is summarised (summarize.js) and held only in this
 *    process's memory, for OVERVIEW_TTL_MS, per profile. It is never written to disk, so it is
 *    not in state-<uid>.json, not in exports, not in the MCP or Coach views of the state, and not
 *    in backups. A restart forgets it.
 *  - §5(f) revocation and deletion: disconnect revokes the token at Oura, deletes the stored
 *    tokens and drops the held summary at once. Deleting the profile (admin) does the same.
 *  - §4(d)/§6(g) no AI: nothing here hands Oura data to the Coach or to MCP. Those read the
 *    state file, which never contains it (test/oura-routes.test.js checks both).
 */
import path from 'node:path';
import { OuraError, ouraConfig, pkcePair, newState, authorizeUrl, exchangeCode, revokeToken } from './oauth.js';
import { createOuraStore, deriveKey } from './store.js';
import { createOuraClient, offsetOf } from './client.js';
import { summarize } from './summarize.js';

const STATE_TTL_MS = 10 * 60000;
const MAX_PENDING = 1000;
export const OVERVIEW_TTL_MS = 10 * 60000;
const SYNC_MIN_GAP_MS = 30000;
const DEFAULT_DAYS = 14;
const MAX_DAYS = 30;

// Where the callback sends the browser back to: Settings → Data & backup, relative to the
// callback's own path, so a subpath deployment lands inside its own prefix.
const BACK = '../../../#/settings/data?oura=';

export function ouraRoutes({ json, readSession, audit = () => {}, env = process.env, origin, dataDir, instanceSecret, version = 'dev', fetchImpl = globalThis.fetch, now = Date.now }) {
  const cfg = ouraConfig(env, { origin, version });
  const store = createOuraStore({ dir: path.join(dataDir, 'oura'), key: cfg ? deriveKey(instanceSecret, cfg.clientSecret) : null });
  const client = cfg ? createOuraClient({ cfg, store, fetchImpl, now }) : null;
  const pending = new Map();              // state -> { uid, verifier, exp }
  const held = new Map();                 // uid -> { at, days, overview }

  const sweep = () => { const t = now(); for (const [k, v] of pending) if (v.exp < t) pending.delete(k); };
  const signedIn = (req, res) => {
    const user = readSession(req);
    if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
    return user;
  };
  const configured = res => {
    if (cfg) return true;
    json(res, 503, { error: 'Oura is not set up on this server', code: 'off' });
    return false;
  };
  const days = url => {
    const n = Math.round(+(url.searchParams.get('days') || DEFAULT_DAYS));
    return Number.isFinite(n) ? Math.min(MAX_DAYS, Math.max(1, n)) : DEFAULT_DAYS;
  };
  const urlOf = req => new URL(req.url, 'http://x');

  function failure(res, e) {
    if (e instanceof OuraError) {
      if (e.code === 'reauth') return json(res, 409, { error: 'Oura needs to be connected again', code: 'reauth' });
      if (e.code === 'rate') return json(res, 429, { error: 'Oura is busy, try again later', code: 'rate', retryAfter: e.retryAfter || null }, e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : undefined);
      if (e.code === 'network') return json(res, 502, { error: 'Oura could not be reached', code: 'network' });
      if (e.code === 'config') return json(res, 503, { error: 'The Oura app credentials were refused', code: 'config' });
      return json(res, 502, { error: 'Oura answered with an error', code: 'http' });
    }
    throw e;
  }

  async function build(uid, n) {
    const raw = await client.fetchWindow(uid, n);
    const tz = offsetOf((raw.daily_readiness?.[0] || raw.sleep?.[0] || {}).timestamp || (raw.sleep?.[0] || {}).bedtime_end);
    const overview = summarize(raw, { tzOffsetMin: tz });
    const at = now();
    held.set(uid, { at, days: n, overview });
    store.touch(uid, { lastSync: at });
    return { fetchedAt: at, days: n, ...overview };
  }

  /** Disconnect: revoke at Oura (best effort), delete the tokens, forget what is held. */
  async function forget(uid) {
    const rec = store.get(uid);
    const revoked = rec && cfg ? await revokeToken(cfg, rec.tokens.access, fetchImpl) : false;
    store.remove(uid);
    held.delete(uid);
    for (const [k, v] of pending) if (v.uid === uid) pending.delete(k);
    return { hadConnection: !!rec || revoked, revoked };
  }

  const routes = {
    'GET /api/integrations/oura/status': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      const meta = store.meta(user.id);
      // Without the key a leftover file cannot be used; it still shows, so it can be removed.
      const connected = !!(cfg && meta && store.get(user.id));
      json(res, 200, {
        configured: !!cfg,
        connected,
        stale: !!meta && !connected,
        connectedAt: connected ? meta.connectedAt : null,
        lastSync: connected ? meta.lastSync : null,
        scopes: connected ? meta.scopes : null,
        requestedScopes: cfg ? cfg.scopes : null,
        redirectUri: cfg ? cfg.redirectUri : null,
      });
    },

    'POST /api/integrations/oura/connect': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      if (!configured(res)) return;
      sweep();
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
      const { verifier, challenge } = pkcePair();
      const state = newState();
      pending.set(state, { uid: user.id, verifier, exp: now() + STATE_TTL_MS });
      json(res, 200, { url: authorizeUrl(cfg, { state, challenge }) });
    },

    'GET /api/integrations/oura/callback': async (req, res) => {
      const back = code => {
        // no-referrer: this URL carries the authorization code; nothing it links to may see it.
        res.writeHead(302, { Location: BACK + code, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end();
      };
      if (!cfg) return back('off');
      const q = urlOf(req).searchParams;
      sweep();
      const state = q.get('state') || '';
      const p = pending.get(state);
      pending.delete(state);                              // single use, whatever happens next
      if (!p) return back('expired');
      // The state names the profile that started the flow. The browser coming back has to be
      // signed in as that same profile: a code delivered into somebody else's session is refused.
      const user = readSession(req);
      if (!user || user.id !== p.uid) return back('mismatch');
      if (q.get('error')) return back(q.get('error') === 'access_denied' ? 'denied' : 'error');
      const code = q.get('code');
      if (!code) return back('error');
      let tokens;
      try { tokens = await exchangeCode(cfg, { code, verifier: p.verifier }, fetchImpl, now); }
      catch (e) {
        audit(req, 'oura.connect', { ok: false, user, msg: e instanceof OuraError ? e.code : 'error' });
        return back(e instanceof OuraError && e.code === 'config' ? 'config' : 'error');
      }
      store.put(user.id, { tokens, connectedAt: now(), scopes: tokens.scope || cfg.scopes, lastSync: null });
      held.delete(user.id);
      audit(req, 'oura.connect', { user });
      back('connected');
    },

    'GET /api/integrations/oura/overview': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      if (!configured(res)) return;
      const n = days(urlOf(req));
      const h = held.get(user.id);
      if (h && now() - h.at < OVERVIEW_TTL_MS && h.days >= n && store.meta(user.id)) {
        return json(res, 200, { fetchedAt: h.at, days: h.days, cached: true, ...h.overview });
      }
      try { json(res, 200, { ...(await build(user.id, n)), cached: false }); }
      catch (e) { failure(res, e); }
    },

    'POST /api/integrations/oura/sync': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      if (!configured(res)) return;
      const n = days(urlOf(req));
      const h = held.get(user.id);
      // A second tap within half a minute gets what the first one fetched.
      if (h && now() - h.at < SYNC_MIN_GAP_MS && h.days >= n) {
        return json(res, 200, { fetchedAt: h.at, days: h.days, cached: true, ...h.overview });
      }
      try { json(res, 200, { ...(await build(user.id, n)), cached: false }); }
      catch (e) { failure(res, e); }
    },

    'POST /api/integrations/oura/disconnect': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      const r = await forget(user.id);
      if (r.hadConnection) audit(req, 'oura.disconnect', { user, msg: r.revoked ? 'revoked' : 'deleted' });
      json(res, 200, { ok: true, revoked: r.revoked });
    },
  };

  return {
    routes,
    /** Deleting a profile: the same as its own Disconnect. Never throws. */
    forgetUser: uid => forget(uid).catch(() => { store.remove(uid); held.delete(uid); }),
    configured: !!cfg,
  };
}
