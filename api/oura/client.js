/* Reading a profile's Oura data: tokens from the store, refreshed when due, and the v2
 * usercollection endpoints the overview needs.
 *
 * Refresh tokens are single-use. Two requests that both find the access token expired and both
 * refresh would send the same refresh token twice; the second is refused and the connection is
 * lost. So every token decision for a profile runs through one queue (`withLock`), and a request
 * that got a 401 refreshes only if the token it used is still the stored one — if another request
 * already refreshed, it simply takes the new token.
 *
 * Nothing fetched here is written anywhere. The caller (sync.js) summarises it and holds the
 * summary in memory; disk never sees Oura health data.
 */
import { API_BASE, OuraError, refreshTokens } from './oauth.js';

const TIMEOUT_MS = 20000;
const MAX_PAGES = 50;
const RETRY_PAUSE_MS = 2000;
const EARLY_MS = 60000;          // refresh a minute before the stated expiry

/** The data types the overview reads, by endpoint name. */
export const DAILY_TYPES = ['daily_readiness', 'daily_sleep', 'sleep', 'daily_activity', 'daily_stress', 'daily_spo2', 'daily_cardiovascular_age', 'vO2_max', 'workout'];
export const HEART_RATE_DAYS = 7;   // the heart-rate series is large; only the last week is read


export function createOuraClient({ cfg, store, fetchImpl = globalThis.fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const queues = new Map();
  function withLock(uid, fn) {
    const prev = queues.get(uid) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    queues.set(uid, tail);
    tail.then(() => { if (queues.get(uid) === tail) queues.delete(uid); });
    return run;
  }

  /** A usable access token. `failed`: the token a request was just refused with. */
  function accessToken(uid, failed = null) {
    return withLock(uid, async () => {
      const rec = store.get(uid);
      if (!rec) throw new OuraError('reauth', 'Oura is not connected');
      const t = rec.tokens;
      const due = t.exp - EARLY_MS <= now();
      if (failed ? t.access !== failed : !due) return t.access;     // someone else refreshed already
      let fresh;
      try {
        fresh = await refreshTokens(cfg, t.refresh, fetchImpl, now);
      } catch (e) {
        // A refused refresh means the grant is gone (revoked in the Oura app, or the refresh token
        // already spent). The stored tokens are useless from here on: drop them, so the profile
        // reads as disconnected and is asked to connect again.
        if (e instanceof OuraError && (e.code === 'reauth' || e.code === 'config')) store.remove(uid);
        throw e;
      }
      // Stored before it is used: the old refresh token is already spent.
      store.put(uid, { tokens: fresh, connectedAt: rec.connectedAt, scopes: fresh.scope || rec.scopes, lastSync: rec.lastSync });
      return fresh.access;
    });
  }

  // One retry for what is usually passing (a dropped connection, a 502/503/504 from Oura's edge),
  // after a short pause. Anything that fails twice is the caller's to report and back off from.
  async function request(url, access) {
    for (let attempt = 0; ; attempt++) {
      let res = null, failure = null;
      try {
        res = await fetchImpl(url, {
          headers: { Authorization: 'Bearer ' + access, Accept: 'application/json', 'User-Agent': cfg.userAgent },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        failure = new OuraError('network', 'Oura could not be reached' + (e?.name === 'TimeoutError' ? ' in time' : ''));
      }
      const transient = failure || [502, 503, 504].includes(res.status);
      if (!transient || attempt >= 1) { if (failure) throw failure; return res; }
      await sleep(RETRY_PAUSE_MS);
    }
  }

  /**
   * Every document of one data type in a window, following next_token. Answers the documents, or
   * { error: 'forbidden' } when the scope was not shared (403 — or the membership lapsed), or
   * { error: 'http' } for another failure of this type alone. A refused token or a rate limit
   * throws: those concern the whole connection, not one type.
   */
  async function collection(uid, type, params) {
    let access = await accessToken(uid);
    const out = [];
    let next = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams(params);
      if (next) qs.set('next_token', next);
      const url = API_BASE + type + '?' + qs.toString();
      let res = await request(url, access);
      if (res.status === 401) {
        access = await accessToken(uid, access);
        res = await request(url, access);
        if (res.status === 401) { store.remove(uid); throw new OuraError('reauth', 'Oura no longer accepts this connection'); }
      }
      if (res.status === 403) return { error: 'forbidden' };
      if (res.status === 429) throw new OuraError('rate', 'Oura is rate limiting this app', { status: 429, retryAfter: +res.headers.get('retry-after') || null });
      if (!res.ok) return { error: 'http', status: res.status };
      let body;
      try { body = await res.json(); } catch { return { error: 'http', status: res.status }; }
      if (Array.isArray(body?.data)) out.push(...body.data);
      next = typeof body?.next_token === 'string' && body.next_token ? body.next_token : null;
      if (!next) break;
    }
    return out;
  }

  return { accessToken, collection };
}
