/* HTTP surface of the Oura integration. Off until OURA_CLIENT_ID and OURA_CLIENT_SECRET are set:
 * every route but status answers 503 { code: 'off' } then, and status says configured: false.
 *
 *   GET  /api/integrations/oura/status       connection facts and sync state, no health data
 *   POST /api/integrations/oura/connect      → { url } of Oura's consent page (PKCE + state)
 *   GET  /api/integrations/oura/callback     Oura's redirect back; the registered redirect URI
 *   GET  /api/integrations/oura/overview     the held summary for the last ?days= (1–90) days
 *   POST /api/integrations/oura/sync         an incremental sync now, then the same answer
 *   GET  /api/integrations/oura/diagnostics  per data type: shared or not, records or not —
 *                                            never a value (?refresh=1 also tests a token refresh)
 *   POST /api/integrations/oura/disconnect   revoke at Oura, delete tokens and anything held
 *
 * Oura API and MCP Agreement (8 June 2026), what that means here:
 *  - §3(m)/§4(c) minimisation: health data is summarised (summarize.js) and held only in this
 *    process's memory (sync.js): at most 90 days, only while the overview is used, dropped after
 *    14 days without a look. It is never written to disk, so it is not in state-<uid>.json, not in
 *    exports or webhooks, not in the MCP or Coach views of the state, and not in backups.
 *  - §5(f) revocation and deletion: disconnect revokes the token at Oura, deletes the stored
 *    tokens and drops the held summary at once. Deleting the profile (admin) does the same.
 *  - §4(d)/§6(g) no AI: nothing here hands Oura data to the Coach or to MCP. Those read the
 *    state file, which never contains it (test/oura-routes.test.js checks both).
 */
import path from 'node:path';
import { OuraError, ouraConfig, pkcePair, newState, authorizeUrl, exchangeCode, revokeToken } from './oauth.js';
import { createOuraStore, deriveKey } from './store.js';
import { createOuraClient } from './client.js';
import { createSync, WINDOW_DAYS } from './sync.js';
import { validTz } from './summarize.js';

const STATE_TTL_MS = 10 * 60000;
const MAX_PENDING = 1000;
const SYNC_MIN_GAP_MS = 30000;
// A look at the overview syncs first when what is held is older than this; auto-sync (sync.js)
// keeps it fresher than that for anyone using the screen.
const VIEW_STALE_MS = 60 * 60000;
const DEFAULT_DAYS = 14;
const MAX_DAYS = WINDOW_DAYS;

// Where the callback sends the browser back to: Settings → Data & backup, relative to the
// callback's own path, so a subpath deployment lands inside its own prefix.
const BACK = '../../../#/settings/data?oura=';

export function ouraRoutes({ json, readSession, audit = () => {}, env = process.env, origin, dataDir, instanceSecret, version = 'dev', fetchImpl = globalThis.fetch, now = Date.now, sleep, autoSync = true, log = () => {} }) {
  const cfg = ouraConfig(env, { origin, version });
  const store = createOuraStore({ dir: path.join(dataDir, 'oura'), key: cfg ? deriveKey(instanceSecret, cfg.clientSecret) : null });
  const client = cfg ? createOuraClient({ cfg, store, fetchImpl, now, ...(sleep ? { sleep } : {}) }) : null;
  const sync = client ? createSync({ client, store, now, log }) : null;
  if (sync && autoSync) sync.start();
  const pending = new Map();              // state -> { uid, verifier, exp }

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
  // The zone the person's device is in (Intl), so heart-rate samples fall on their own days.
  const tzOf = url => { const tz = url.searchParams.get('tz'); return validTz(tz) ? tz : undefined; };

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

  /** The answer of overview and sync: what is held for the window, and the sync state. */
  function answer(uid, n, extra = {}) {
    const v = sync.view(uid, n) || { days: [], workouts: [], available: {}, lastSync: null };
    const e = sync.entry(uid);
    return { days: n, ...v, fetchedAt: v.lastSync, lastError: e?.lastError || null, retryAt: e?.backoffUntil || null, ...extra };
  }
  /** Disconnect: revoke at Oura (best effort), delete the tokens, forget what is held. */
  async function forget(uid) {
    const rec = store.get(uid);
    const revoked = rec && cfg ? await revokeToken(cfg, rec.tokens.access, fetchImpl) : false;
    store.remove(uid);
    sync?.forget(uid);
    for (const [k, v] of pending) if (v.uid === uid) pending.delete(k);
    return { hadConnection: !!rec || revoked, revoked };
  }

  const routes = {
    'GET /api/integrations/oura/status': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      const meta = store.meta(user.id);
      // Without the key a leftover file cannot be used; it still shows, so it can be removed.
      const connected = !!(cfg && meta && store.get(user.id));
      const e = connected ? sync.entry(user.id) : null;
      json(res, 200, {
        configured: !!cfg,
        connected,
        stale: !!meta && !connected,
        connectedAt: connected ? meta.connectedAt : null,
        lastSync: connected ? meta.lastSync : null,
        lastError: connected ? meta.lastError || null : null,
        scopes: connected ? meta.scopes : null,
        requestedScopes: cfg ? cfg.scopes : null,
        redirectUri: cfg ? cfg.redirectUri : null,
        // Automatic sync runs for a profile whose overview was opened in the last 14 days.
        autoSync: connected ? { active: !!e, retryAt: e?.backoffUntil || null } : null,
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
      sync.forget(user.id);
      audit(req, 'oura.connect', { user });
      back('connected');
    },

    'GET /api/integrations/oura/overview': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      if (!configured(res)) return;
      if (!store.meta(user.id)) { sync.forget(user.id); return json(res, 409, { error: 'Oura is not connected', code: 'reauth' }); }
      const url = urlOf(req);
      const n = days(url);
      const e = sync.entry(user.id);
      sync.touchViewed(user.id);
      // Nothing held yet (first look, or after a restart): backfill. Held but older than an hour
      // and not backing off: an incremental sync first. Otherwise what is held, at once.
      if (!e || (now() - (e.lastSync || 0) > VIEW_STALE_MS && !(e.backoffUntil > now()))) {
        try { await sync.syncNow(user.id, { reason: e ? 'view' : 'backfill', tz: tzOf(url) }); }
        catch (err) { if (!sync.entry(user.id)) return failure(res, err); }    // held days still answer
      }
      json(res, 200, answer(user.id, n));
    },

    'POST /api/integrations/oura/sync': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      if (!configured(res)) return;
      const url = urlOf(req);
      const n = days(url);
      const e = sync.entry(user.id);
      // A second tap within half a minute gets what the first one fetched.
      if (e && now() - (e.lastSync || 0) < SYNC_MIN_GAP_MS) { sync.touchViewed(user.id); return json(res, 200, answer(user.id, n, { cached: true })); }
      try { await sync.syncNow(user.id, { reason: 'manual', tz: tzOf(url) }); }
      catch (err) { return failure(res, err); }
      json(res, 200, answer(user.id, n, { cached: false }));
    },

    /* Is the connection working, data type by data type — without a single value. Made for checking
       the integration (by the person, or by someone helping them) without reading their health data:
       the answer says per type whether Oura shared it and whether any records came back in the held
       window, nothing about what they are. ?refresh=1 also spends a refresh token to prove the
       refresh works (the new pair is stored as usual). */
    'GET /api/integrations/oura/diagnostics': async (req, res) => {
      const user = signedIn(req, res); if (!user) return;
      if (!configured(res)) return;
      const rec = store.get(user.id);
      if (!rec) return json(res, 409, { error: 'Oura is not connected', code: 'reauth' });
      const url = urlOf(req);
      let refresh = null;
      if (url.searchParams.get('refresh') === '1') {
        try { const before = store.get(user.id).tokens.access; await client.accessToken(user.id, before); refresh = store.get(user.id)?.tokens.access !== before ? 'ok' : 'unchanged'; }
        catch (err) { refresh = err instanceof OuraError ? err.code : 'error'; }
      }
      let syncError = null;
      try { await sync.syncNow(user.id, { reason: 'diagnostics', tz: tzOf(url) }); }
      catch (err) { syncError = err instanceof OuraError ? err.code : 'error'; }
      const e = sync.entry(user.id);
      const types = {};
      for (const [type, st] of Object.entries(e?.status || {})) {
        const held = type === 'workout' ? e.workouts.size : (e.byType[type]?.size || 0);
        types[type] = { status: st, records: held > 0 };
      }
      const t = store.get(user.id)?.tokens;
      json(res, 200, {
        connected: !!t,
        grantedScopes: store.meta(user.id)?.scopes || null,
        token: t ? { expiresInMin: Math.round((t.exp - now()) / 60000) } : null,
        refresh, syncError, lastSync: e?.lastSync || null, types,
      });
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
    forgetUser: uid => forget(uid).catch(() => { store.remove(uid); sync?.forget(uid); }),
    stop: () => sync?.stop(),
    configured: !!cfg,
  };
}
