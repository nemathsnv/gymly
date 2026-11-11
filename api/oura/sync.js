/* Keeping a profile's Oura summary current — in memory only, bounded, and only while it is used.
 *
 * What is held per connected profile: the minimised per-day fields of summarize.js for at most
 * WINDOW_DAYS days, heart rate for HEART_RATE_DAYS, Oura's workouts in the same window, and per
 * data type whether Oura shared it. Never written to disk: not in the data folder, not in backups,
 * not in the synced state, so not in exports, webhooks, the Coach or MCP.
 *
 * - First look: a backfill of the whole window.
 * - After that, incremental: from REFETCH_DAYS before the last synced day up to tomorrow, each data
 *   type's days in that range replaced wholesale. A revised score replaces the old one, and a
 *   document deleted in Oura disappears. A document is keyed by day (or by id for workouts), so
 *   fetching a day twice never doubles it.
 * - Automatic: every AUTO_EVERY_MS for a profile whose overview was opened in the last IDLE_MS.
 *   A profile nobody looks at is not synced, and what is held for it is dropped after IDLE_MS. A
 *   restart forgets everything, and the next look backfills again.
 * - Failures: a rate limit waits for Oura's Retry-After; other failures back off 15 min, 30, 60…
 *   up to 6 h. A data type that fails alone keeps its previous days and is marked. A refused
 *   grant (revoked in the Oura app) disconnects.
 * - lastSync (and the last error's code, no data) is written to the connection file, so the
 *   status survives a restart.
 */
import { OuraError } from './oauth.js';
import { DAILY_TYPES, HEART_RATE_DAYS } from './client.js';
import { partials, assemble, statusOf, localDay, addDays, validTz } from './summarize.js';

export const WINDOW_DAYS = 90;
export const REFETCH_DAYS = 3;
export const AUTO_EVERY_MS = 3 * 3600e3;
export const IDLE_MS = 14 * 86400e3;
export const TICK_MS = 15 * 60e3;
const BACKOFF_BASE_MS = 15 * 60e3;
const BACKOFF_MAX_MS = 6 * 3600e3;

export function createSync({ client, store, now = Date.now, log = () => {} }) {
  const held = new Map();        // uid -> entry
  const running = new Map();     // uid -> promise of the sync in progress

  const fresh = tz => ({ byType: {}, workouts: new Map(), status: {}, lastSync: null, syncedDay: null, lastViewed: 0, tz: validTz(tz) ? tz : 'UTC', backoffUntil: 0, failures: 0, lastError: null });
  const entry = uid => held.get(uid) || null;

  function prune(e, today) {
    const oldest = addDays(today, -(WINDOW_DAYS - 1));
    for (const m of Object.values(e.byType)) for (const d of [...m.keys()]) if (d < oldest) m.delete(d);
    const hrOldest = addDays(today, -(HEART_RATE_DAYS - 1));
    for (const d of [...(e.byType.heartrate?.keys() || [])]) if (d < hrOldest) e.byType.heartrate.delete(d);
    for (const [id, w] of [...e.workouts]) if (w.day < oldest) e.workouts.delete(id);
  }

  /** Replace a data type's days from `from` on with what was just read. */
  function replace(e, type, from, map) {
    if (type === 'workout') {
      for (const [id, w] of [...e.workouts]) if (w.day >= from) e.workouts.delete(id);
      for (const [id, w] of map) e.workouts.set(id, w);
      return;
    }
    const m = e.byType[type] || (e.byType[type] = new Map());
    for (const d of [...m.keys()]) if (d >= from) m.delete(d);
    for (const [d, v] of map) m.set(d, v);
  }

  async function run(uid, { reason, tz }) {
    const e = held.get(uid) || fresh(tz);
    if (validTz(tz)) e.tz = tz;
    const t = now();
    const today = localDay(t, e.tz);
    const windowStart = addDays(today, -(WINDOW_DAYS - 1));
    const from = e.syncedDay ? [addDays(e.syncedDay, -REFETCH_DAYS), windowStart].sort().pop() : windowStart;
    const to = addDays(today, 1);
    const hrFrom = [from, addDays(today, -(HEART_RATE_DAYS - 1))].sort().pop();
    const status = { ...e.status };
    try {
      for (const type of [...DAILY_TYPES, 'heartrate']) {
        const params = type === 'heartrate'
          // Wide enough on both sides that every sample of the person's days is in it.
          ? { start_datetime: new Date(Date.parse(hrFrom + 'T00:00:00Z') - 86400e3).toISOString().replace(/\.\d+Z$/, 'Z'), end_datetime: new Date(t).toISOString().replace(/\.\d+Z$/, 'Z') }
          : { start_date: from, end_date: to };
        const docs = await client.collection(uid, type, params);
        status[type] = statusOf(docs);
        if (Array.isArray(docs)) replace(e, type, type === 'heartrate' ? hrFrom : from, partials(type, docs, { tz: e.tz }));
        // A type that failed alone keeps the days it had; one no longer shared shows nothing.
        else if (status[type] === 'not-shared') replace(e, type, '0000-00-00', new Map());
      }
    } catch (err) {
      e.failures++;
      const code = err instanceof OuraError ? err.code : 'error';
      e.lastError = code;
      if (code === 'reauth') { held.delete(uid); store.touch?.(uid, { lastError: code }); throw err; }
      const wait = code === 'rate' && err.retryAfter ? err.retryAfter * 1000 : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (e.failures - 1));
      e.backoffUntil = now() + wait;
      if (e.lastSync) held.set(uid, e);                // keep what was held; it is still current enough
      store.touch?.(uid, { lastError: code });
      log(`oura: ${reason} sync failed for a profile (${code}), next try in ${Math.round(wait / 60000)} min`);
      throw err;
    }
    e.status = status;
    e.lastSync = now();
    e.syncedDay = today;
    e.failures = 0; e.backoffUntil = 0; e.lastError = null;
    prune(e, today);
    held.set(uid, e);
    store.touch?.(uid, { lastSync: e.lastSync, lastError: null, tz: e.tz });
    return e;
  }

  /** Sync one profile now. Concurrent calls share the one in progress. */
  function syncNow(uid, { reason = 'manual', tz } = {}) {
    if (running.has(uid)) return running.get(uid);
    const p = run(uid, { reason, tz }).finally(() => running.delete(uid));
    running.set(uid, p);
    return p;
  }

  /** The screen's view of what is held, for the last `days` days. Marks the profile as in use. */
  function view(uid, days) {
    const e = held.get(uid);
    if (!e) return null;
    e.lastViewed = now();
    const today = localDay(now(), e.tz);
    const from = addDays(today, -(Math.min(days, WINDOW_DAYS) - 1));
    return { ...assemble(e, { from }), lastSync: e.lastSync, tz: e.tz, today };
  }

  function touchViewed(uid) { const e = held.get(uid); if (e) e.lastViewed = now(); }

  /** One pass of the automatic sync. Profiles one after another: a handful of requests each. */
  async function tick() {
    const t = now();
    for (const [uid, e] of [...held]) {
      if (t - e.lastViewed > IDLE_MS) { held.delete(uid); continue; }   // unused: drop, stop syncing
      if (!store.meta(uid)) { held.delete(uid); continue; }            // disconnected meanwhile
      if (e.backoffUntil > t || (e.lastSync && t - e.lastSync < AUTO_EVERY_MS) || running.has(uid)) continue;
      try { await syncNow(uid, { reason: 'auto' }); } catch { /* recorded on the entry */ }
    }
  }

  let timer = null;
  return {
    entry, syncNow, view, touchViewed, tick,
    forget: uid => { held.delete(uid); running.delete(uid); },
    start() { if (!timer) { timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
    /** How many profiles are held (for the status line; no data). */
    size: () => held.size,
  };
}
