/* The Oura sync (oura/sync.js): backfill, incremental refetch with replacement (revisions and
   deletions in Oura propagate, nothing doubles), the bounded window, automatic sync only for a
   profile in use, idle eviction, back-off on rate limits and failures, a refused grant, and the
   rule that none of it is ever written to disk. Against the fake Oura, on a hand-moved clock. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exchangeCode } from '../oura/oauth.js';
import { createOuraStore, deriveKey } from '../oura/store.js';
import { createOuraClient } from '../oura/client.js';
import { createSync, WINDOW_DAYS, AUTO_EVERY_MS, IDLE_MS, REFETCH_DAYS } from '../oura/sync.js';
import { fakeOura, CFG } from './oura-fake.mjs';

const DAY = 86400000;
const TZ = 'Europe/Berlin';
const ymd = t => new Date(t).toISOString().slice(0, 10);

async function setup(t, { data, granted } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oura-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-11T09:00:00Z');
  const oura = fakeOura({ data: data || { daily_readiness: [], workout: [] }, granted, pageSize: 50, ttl: 30 * 86400 });
  const store = createOuraStore({ dir, key: deriveKey('s', CFG.clientSecret) });
  const tokens = await exchangeCode(CFG, { code: oura.issueCode('v'), verifier: 'v' }, oura.fetch, () => clock);
  store.put('u1', { tokens, connectedAt: clock, scopes: tokens.scope });
  const client = createOuraClient({ cfg: CFG, store, fetchImpl: (...a) => oura.fetch(...a), now: () => clock, sleep: async () => {} });
  const sync = createSync({ client, store, now: () => clock });
  return { oura, store, sync, dir, now: () => clock, advance: ms => { clock += ms; }, setClock: v => { clock = v; } };
}
const readiness = (day, score) => ({ id: 'r-' + day, day, score, timestamp: day + 'T00:00:00+01:00', contributors: { hrv_balance: 70, resting_heart_rate: 80 } });
const apiCalls = (oura, type) => oura.calls.filter(c => c.url.includes('/v2/usercollection/' + type + '?'));

test('first sync backfills the whole window; the next one asks only for the last few days', async t => {
  const h = await setup(t);
  await h.sync.syncNow('u1', { tz: TZ });
  const first = new URL(apiCalls(h.oura, 'daily_readiness')[0].url).searchParams;
  assert.equal(first.get('start_date'), ymd(h.now() - (WINDOW_DAYS - 1) * DAY));
  assert.equal(first.get('end_date'), ymd(h.now() + DAY));
  h.advance(2 * DAY);
  await h.sync.syncNow('u1', { tz: TZ });
  const second = new URL(apiCalls(h.oura, 'daily_readiness')[1].url).searchParams;
  assert.equal(second.get('start_date'), ymd(h.now() - (2 + REFETCH_DAYS) * DAY), 'from a few days before the last synced day');
});

test('incremental: a revised score replaces the old, a deleted document disappears, nothing doubles', async t => {
  const today = '2026-11-11', y = '2026-11-10';
  const data = { daily_readiness: [readiness(y, 60), readiness(today, 70)], workout: [
    { id: 'w1', day: y, activity: 'running', start_datetime: y + 'T18:00:00+01:00', end_datetime: y + 'T18:30:00+01:00', intensity: 'hard', source: 'autodetected' },
  ] };
  const h = await setup(t, { data });
  await h.sync.syncNow('u1', { tz: TZ });
  await h.sync.syncNow('u1', { tz: TZ });                                    // the same days twice
  let v = h.sync.view('u1', 14);
  assert.deepEqual(v.days.map(d => [d.day, d.readiness.score]), [[today, 70], [y, 60]]);
  assert.equal(v.workouts.length, 1, 'one workout, however often it is read');
  data.daily_readiness[1] = readiness(today, 74);                            // Oura revised today
  data.workout.length = 0;                                                    // and the run was deleted
  h.advance(3600e3);
  await h.sync.syncNow('u1', { tz: TZ });
  v = h.sync.view('u1', 14);
  assert.equal(v.days[0].readiness.score, 74);
  assert.equal(v.workouts.length, 0);
});

test('the window is bounded: days older than 90 are dropped, heart rate older than 7', async t => {
  const now = Date.parse('2026-11-11T09:00:00Z');
  const old = ymd(now - (WINDOW_DAYS + 5) * DAY);
  const data = { daily_readiness: [readiness(old, 50), readiness('2026-11-11', 80)],
    heartrate: [{ bpm: 55, timestamp: ymd(now - 10 * DAY) + 'T10:00:00Z' }, { bpm: 60, timestamp: '2026-11-11T07:00:00Z' }] };
  const h = await setup(t, { data });
  await h.sync.syncNow('u1', { tz: TZ });
  const v = h.sync.view('u1', 90);
  assert.ok(v.days.every(d => d.day >= ymd(now - (WINDOW_DAYS - 1) * DAY)));
  assert.deepEqual(v.days.filter(d => d.heartRate).map(d => d.day), ['2026-11-11']);
});

test('automatic sync: only for a profile in use, every few hours, and dropped after two idle weeks', async t => {
  const h = await setup(t, { data: { daily_readiness: [readiness('2026-11-11', 80)] } });
  await h.sync.tick();
  assert.equal(apiCalls(h.oura, 'daily_readiness').length, 0, 'nothing held, nothing synced: no one has looked');
  await h.sync.syncNow('u1', { tz: TZ });
  h.sync.view('u1', 14);
  h.advance(AUTO_EVERY_MS - 60000);
  await h.sync.tick();
  assert.equal(apiCalls(h.oura, 'daily_readiness').length, 1, 'not yet due');
  h.advance(120000);
  await h.sync.tick();
  assert.equal(apiCalls(h.oura, 'daily_readiness').length, 2, 'due: synced');
  h.advance(IDLE_MS + 1000);
  await h.sync.tick();
  assert.equal(h.sync.entry('u1'), null, 'two weeks without a look: dropped');
  assert.equal(h.sync.size(), 0);
});

test('a rate limit waits for Oura\'s Retry-After; other failures back off; held days stay', async t => {
  const h = await setup(t, { data: { daily_readiness: [readiness('2026-11-11', 80)] } });
  await h.sync.syncNow('u1', { tz: TZ });
  h.sync.view('u1', 14);
  const real = h.oura.fetch;
  h.oura.fetch = async (url, init) => (String(url).includes('/v2/') ? new Response('{}', { status: 429, headers: { 'retry-after': '120' } }) : real(url, init));
  h.advance(AUTO_EVERY_MS + 1);
  await h.sync.tick();
  const e = h.sync.entry('u1');
  assert.equal(e.lastError, 'rate');
  assert.equal(e.backoffUntil, h.now() + 120000);
  assert.equal(h.sync.view('u1', 14).days[0].readiness.score, 80, 'what was held still answers');
  const calls = h.oura.calls.length;
  h.advance(60000);
  await h.sync.tick();
  assert.equal(h.oura.calls.length, calls, 'no request while backing off');
  assert.equal(h.store.meta('u1').lastError, 'rate', 'the error code (no data) is on the connection file');

  h.oura.fetch = async (url, init) => (String(url).includes('/v2/') ? Promise.reject(new TypeError('down')) : real(url, init));
  h.advance(120000);
  await h.sync.tick();
  const first = h.sync.entry('u1').backoffUntil - h.now();
  h.advance(first + 1);
  await h.sync.tick();
  const second = h.sync.entry('u1').backoffUntil - h.now();
  assert.ok(second > first, 'the back-off grows');

  h.oura.fetch = real;
  h.advance(second + 1);
  await h.sync.tick();
  assert.equal(h.sync.entry('u1').lastError, null, 'recovered');
  assert.equal(h.store.meta('u1').lastError, null);
});

test('a type no longer shared shows nothing; one that fails alone keeps its days', async t => {
  const data = { daily_readiness: [readiness('2026-11-11', 80)], daily_spo2: [{ id: 's', day: '2026-11-11', spo2_percentage: { average: 97 } }] };
  const h = await setup(t, { data });
  await h.sync.syncNow('u1', { tz: TZ });
  assert.equal(h.sync.view('u1', 14).days[0].spo2.average, 97);
  const real = h.oura.fetch;
  h.oura.fetch = async (url, init) => (String(url).includes('/daily_readiness') ? new Response('{}', { status: 500 }) : String(url).includes('/daily_spo2') ? new Response('{}', { status: 403 }) : real(url, init));
  h.advance(3600e3);
  await h.sync.syncNow('u1', { tz: TZ });
  const v = h.sync.view('u1', 14);
  assert.equal(v.available.daily_readiness, 'error');
  assert.equal(v.days[0].readiness.score, 80, 'kept from the last good read');
  assert.equal(v.available.daily_spo2, 'not-shared');
  assert.equal(v.days[0].spo2, undefined, 'withdrawn: gone');
});

test('a refused grant disconnects and drops everything held', async t => {
  const h = await setup(t, { data: { daily_readiness: [readiness('2026-11-11', 80)] } });
  await h.sync.syncNow('u1', { tz: TZ });
  h.oura.expireAccess(); h.oura.refresh.clear();
  h.advance(3600e3);
  await assert.rejects(h.sync.syncNow('u1', { tz: TZ }), e => e.code === 'reauth');
  assert.equal(h.sync.entry('u1'), null);
  assert.equal(h.store.get('u1'), null);
});

test('two syncs at once share one run; and nothing Oura measured is ever on disk', async t => {
  const h = await setup(t, { data: { daily_readiness: [readiness('2026-11-11', 83)] } });
  await Promise.all([h.sync.syncNow('u1', { tz: TZ }), h.sync.syncNow('u1', { tz: TZ })]);
  assert.equal(apiCalls(h.oura, 'daily_readiness').length, 1);
  const disk = fs.readdirSync(h.dir).map(f => fs.readFileSync(path.join(h.dir, f), 'utf8')).join('\n');
  assert.ok(!/readiness|daily_|"day"/.test(disk));
  assert.equal(JSON.parse(disk).tz, TZ, 'the time zone name is kept with the connection, nothing else');
});
