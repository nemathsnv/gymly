/* Reading Oura data: token refresh (single-use rotation, never twice at once), a revoked grant,
   scopes that were not shared, pagination, and the summary the overview is made of. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exchangeCode } from '../oura/oauth.js';
import { createOuraStore, deriveKey } from '../oura/store.js';
import { createOuraClient, offsetOf } from '../oura/client.js';
import { summarize, heartRateByDay } from '../oura/summarize.js';
import { fakeOura, fixtures, CFG, day } from './oura-fake.mjs';

async function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oura-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oura = fakeOura(opts);
  const store = createOuraStore({ dir, key: deriveKey('s', CFG.clientSecret) });
  const tokens = await exchangeCode(CFG, { code: oura.issueCode('v'), verifier: 'v' }, oura.fetch);
  store.put('u1', { tokens, connectedAt: 1, scopes: tokens.scope });
  let clock = Date.now();
  const client = createOuraClient({ cfg: CFG, store, fetchImpl: oura.fetch, now: () => clock });
  return { oura, store, client, tokens, advance: ms => { clock += ms; } };
}

test('every API request carries the bearer token and a User-Agent', async t => {
  const { oura, client, tokens } = await setup(t);
  await client.collection('u1', 'daily_readiness', { start_date: day(-1), end_date: day(1) });
  const api = oura.calls.filter(c => c.url.includes('/v2/'));
  assert.ok(api.length > 0);
  for (const c of api) {
    assert.equal(c.headers.Authorization, 'Bearer ' + tokens.access);
    assert.match(c.headers['User-Agent'], /^Gymly\//);
  }
});

test('pagination: every page is followed through next_token', async t => {
  const { oura, client } = await setup(t, { pageSize: 1 });
  const docs = await client.collection('u1', 'workout', { start_date: day(-3), end_date: day(1) });
  assert.deepEqual(docs.map(d => d.id), ['w-run', 'w-str']);
  assert.equal(oura.calls.filter(c => c.url.includes('/workout')).length, 2);
});

test('an expired access token is refreshed before use, and the new pair is stored at once', async t => {
  const { oura, store, client, tokens, advance } = await setup(t, { ttl: 3600 });
  advance(3600 * 1000);                                     // past expiry
  await client.collection('u1', 'daily_sleep', {});
  assert.equal(oura.refreshes, 1);
  const now = store.get('u1').tokens;
  assert.notEqual(now.refresh, tokens.refresh, 'rotated refresh token stored');
  assert.ok(!oura.refresh.has(tokens.refresh), 'the old refresh token is spent');
});

test('ten requests that find the token expired refresh it once, not ten times', async t => {
  const { oura, client, advance } = await setup(t, { ttl: 600 });
  advance(700 * 1000);
  const results = await Promise.all(Array.from({ length: 10 }, () => client.collection('u1', 'daily_sleep', {})));
  assert.equal(oura.refreshes, 1);
  for (const r of results) assert.ok(Array.isArray(r));
});

test('a 401 on a token that looked valid: one refresh, then the request succeeds', async t => {
  const { oura, client } = await setup(t);
  oura.expireAccess();                                       // Oura dropped it early
  const docs = await client.collection('u1', 'daily_activity', {});
  assert.equal(docs.length, 1);
  assert.equal(oura.refreshes, 1);
});

test('a refused refresh (access revoked in the Oura app) disconnects the profile', async t => {
  const { oura, store, client } = await setup(t);
  oura.expireAccess();
  oura.refresh.clear();
  await assert.rejects(client.collection('u1', 'daily_sleep', {}), e => e.code === 'reauth');
  assert.equal(store.get('u1'), null, 'the useless tokens are deleted');
  await assert.rejects(client.collection('u1', 'daily_sleep', {}), e => e.code === 'reauth');
});

test('a scope that was not shared answers "forbidden" for that type only', async t => {
  const { client } = await setup(t, { granted: ['daily', 'workout'] });
  assert.deepEqual(await client.collection('u1', 'daily_spo2', {}), { error: 'forbidden' });
  assert.equal((await client.collection('u1', 'daily_readiness', {})).length, 2);
});

test('fetchWindow reads each type over the window, heart rate over the last 7 days at most', async t => {
  const { oura, client } = await setup(t);
  const raw = await client.fetchWindow('u1', 30);
  assert.deepEqual(Object.keys(raw).sort(), ['daily_activity', 'daily_cardiovascular_age', 'daily_readiness', 'daily_sleep', 'daily_spo2', 'daily_stress', 'heartrate', 'sleep', 'vO2_max', 'workout'].sort());
  const hr = oura.calls.find(c => c.url.includes('/heartrate'));
  const from = Date.parse(new URL(hr.url).searchParams.get('start_datetime'));
  assert.ok(Date.now() - from <= 7 * 86400000 + 5000);
  const daily = new URL(oura.calls.find(c => c.url.includes('/daily_readiness')).url).searchParams;
  assert.equal(daily.get('start_date'), day(-29));
  assert.equal(daily.get('end_date'), day(1));
});

test('summary: one row per day, main sleep over the nap, only the fields on screen', () => {
  const s = summarize(fixtures(), { tzOffsetMin: 60 });
  const today = s.days[0];
  assert.equal(today.day, day(0));
  assert.deepEqual(today.readiness, { score: 82, temperatureDeviation: -0.1, hrvBalance: 77, restingHeartRate: 90 });
  assert.deepEqual(today.sleep, { score: 85, totalSec: 27000, efficiency: 91, averageHrv: 48, lowestHeartRate: 47, averageHeartRate: 53 });
  assert.deepEqual(today.activity, { score: 76, steps: 9120, activeCalories: 410 });
  assert.deepEqual(today.stress, { stressHighSec: 3600, recoveryHighSec: 5400, summary: 'normal' });
  assert.deepEqual(today.spo2, { average: 97.2, breathingDisturbanceIndex: 3 });
  assert.deepEqual(today.cardio, { vascularAge: 31, vo2Max: 47 });
  assert.deepEqual(today.heartRate, { min: 52, avg: 87, max: 140, n: 3 });
  assert.equal(s.days[1].readiness.score, 64);
  // minimisation: no series, hypnograms, MET or 5-minute classes survive
  const text = JSON.stringify(s);
  for (const k of ['sleep_phase_5_min', 'heart_rate', 'items', 'met', 'class_5_min', 'pulse_wave_velocity', 'timestamp']) assert.ok(!text.includes(k), k);
  assert.equal(s.workouts.length, 2);
  assert.deepEqual(s.workouts[0], {
    id: 'w-str', day: day(0), activity: 'strength_training', label: 'Gym',
    start: Date.parse(day(0) + 'T17:05:00+01:00'), end: Date.parse(day(0) + 'T18:02:00+01:00'),
    calories: 230, distance: null, intensity: 'moderate', source: 'confirmed',
  });
  assert.deepEqual(Object.values(s.available), Array(10).fill('ok'));
});

test('summary: a type that was not shared or failed is marked, and a doubled workout counts once', () => {
  const f = fixtures();
  const s = summarize({ ...f, daily_spo2: { error: 'forbidden' }, vO2_max: { error: 'http' }, workout: [...f.workout, f.workout[0]] });
  assert.equal(s.available.daily_spo2, 'not-shared');
  assert.equal(s.available.vO2_max, 'error');
  assert.equal(s.workouts.length, 2);
  assert.equal(s.days[0].spo2, undefined);
});

test('heart rate per local day, and the offset read off a localized timestamp', () => {
  assert.equal(offsetOf('2026-11-10T07:00:00+01:00'), 60);
  assert.equal(offsetOf('2026-11-10T07:00:00-05:30'), -330);
  assert.equal(offsetOf('nonsense'), 0);
  // 23:30 UTC is already the next day at UTC+1
  const byDay = heartRateByDay([{ bpm: 60, timestamp: '2026-11-10T23:30:00+00:00' }], 60);
  assert.deepEqual(Object.keys(byDay), ['2026-11-11']);
});
