/* Reading a profile's Oura data: tokens from the store, refreshed when due, and the v2
 * usercollection endpoints the overview needs.
 *
 * Refresh tokens are single-use. Two requests that both find the access token expired and both
 * refresh would send the same refresh token twice; the second is refused and the connection is
 * lost. So every token decision for a profile runs through one queue (`withLock`), and a request
 * that got a 401 refreshes only if the token it used is still the stored one — if another request
 * already refreshed, it simply takes the new token.
 *
 * Nothing fetched here is written anywhere. The caller (routes.js) summarises it and holds the
 * summary in memory for a few minutes; disk never sees Oura health data.
 */
import { API_BASE, OuraError, refreshTokens } from './oauth.js';

const TIMEOUT_MS = 20000;
const MAX_PAGES = 10;
const EARLY_MS = 60000;          // refresh a minute before the stated expiry

/** The data types the overview reads, by endpoint name. */
export const DAILY_TYPES = ['daily_readiness', 'daily_sleep', 'sleep', 'daily_activity', 'daily_stress', 'daily_spo2', 'daily_cardiovascular_age', 'vO2_max', 'workout'];
export const HEART_RATE_DAYS = 7;   // the heart-rate series is large; only the last week is read

const ymd = t => new Date(t).toISOString().slice(0, 10);

export function createOuraClient({ cfg, store, fetchImpl = globalThis.fetch, now = Date.now }) {
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

  async function request(url, access) {
    try {
      return await fetchImpl(url, {
        headers: { Authorization: 'Bearer ' + access, Accept: 'application/json', 'User-Agent': cfg.userAgent },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new OuraError('network', 'Oura could not be reached' + (e?.name === 'TimeoutError' ? ' in time' : ''));
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

  /**
   * The raw documents the overview is built from, for the last `days` days (today included).
   * Types are read one after another: about ten small requests, well inside Oura's limits, and a
   * rate limit stops the rest instead of firing them all at once.
   */
  async function fetchWindow(uid, days) {
    const t = now();
    const startDate = ymd(t - (days - 1) * 86400000);
    // end_date one day ahead: the newest day's documents carry today's local date, which can be
    // ahead of the server's UTC date for someone east of Greenwich.
    const endDate = ymd(t + 86400000);
    const raw = {};
    for (const type of DAILY_TYPES) raw[type] = await collection(uid, type, { start_date: startDate, end_date: endDate });
    const hrFrom = new Date(t - Math.min(days, HEART_RATE_DAYS) * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
    raw.heartrate = await collection(uid, 'heartrate', { start_datetime: hrFrom, end_datetime: new Date(t).toISOString().replace(/\.\d+Z$/, 'Z') });
    return raw;
  }

  return { accessToken, collection, fetchWindow };
}

/** The UTC offset in minutes a localized Oura timestamp ("…T07:12:00+01:00") carries, or 0. */
export function offsetOf(localized) {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(String(localized || ''));
  return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
}
