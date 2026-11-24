/* What the hosted MCP's get_sleep may read of the Oura summary (oura/routes.js sleepFor): the
   caller's own profile only, the main sleep's fields only, nothing without a connection. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouraRoutes } from '../oura/routes.js';
import { exchangeCode } from '../oura/oauth.js';
import { createOuraStore, deriveKey } from '../oura/store.js';
import { localDay, addDays } from '../oura/summarize.js';
import { fakeOura, fixtures, CFG, day } from './oura-fake.mjs';

async function harness(t, env = { OURA_CLIENT_ID: 'cid', OURA_CLIENT_SECRET: 'csecret' }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oura-mcp-sleep-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const oura = fakeOura();
  const mod = ouraRoutes({
    json: () => {}, readSession: () => null, env, origin: 'https://gym.example', dataDir, instanceSecret: 'instance-secret',
    version: 'test', fetchImpl: (...a) => oura.fetch(...a), autoSync: false, sleep: async () => {},
  });
  /** A profile connected the way the callback leaves it. */
  const connect = async uid => {
    const tokens = await exchangeCode(CFG, { code: oura.issueCode('v'), verifier: 'v' }, oura.fetch);
    createOuraStore({ dir: path.join(dataDir, 'oura'), key: deriveKey('instance-secret', 'csecret') })
      .put(uid, { tokens, connectedAt: Date.now(), scopes: tokens.scope });
  };
  return { mod, oura, connect };
}

test('sleepFor: the connected profile\'s nights, main sleep only, and nothing for another profile', async t => {
  const h = await harness(t);
  await h.connect('u1');
  const a = await h.mod.sleepFor('u1', { tz: 'Europe/Berlin' });
  assert.equal(a.configured, true);
  assert.equal(a.connected, true);
  assert.ok(a.lastSync > 0, 'a first read backfills');
  assert.equal(a.tz, 'Europe/Berlin');
  assert.deepEqual(a.nights, [{
    day: day(0),
    sleep: { totalSec: 27000, efficiency: 91, score: 85, averageHrv: 48, lowestHeartRate: 47, bedtimeStart: day(-1) + 'T23:05:00+01:00', bedtimeEnd: day(0) + 'T07:10:00+01:00', type: 'long_sleep' },
  }]);
  // Nothing but the sleep fields: no readiness, activity, stress, heart rate or workouts.
  assert.doesNotMatch(JSON.stringify(a), /readiness|steps|stress|spo2|vo2|strength_training|"heartRate"|averageHeartRate/i);

  // Another profile, not connected, gets nothing of u1's — and no Oura call is made for it.
  const calls = h.oura.calls.length;
  const b = await h.mod.sleepFor('u2');
  assert.deepEqual(b, { configured: true, connected: false, lastSync: null, lastError: null, tz: null, nights: [] });
  assert.equal(h.oura.calls.length, calls);

  // A second read within the hour answers from memory.
  await h.mod.sleepFor('u1');
  assert.equal(h.oura.calls.length, calls);
  // A bad profile id is no connection, never a throw.
  assert.equal((await h.mod.sleepFor('../u1')).connected, false);
  h.mod.stop();
});

test('sleepFor: two connected profiles each get their own nights, and a disconnect ends it at once', async t => {
  const other = { ...fixtures(), sleep: [{ id: 'p-two', day: day(0), type: 'long_sleep', total_sleep_duration: 18000, efficiency: 70, bedtime_start: day(0) + 'T01:00:00+01:00', bedtime_end: day(0) + 'T06:00:00+01:00' }] };
  const h = await harness(t);
  await h.connect('u1');
  await h.connect('u2');
  // The fake answers every token with the same documents; give u2's tokens their own.
  const real = h.oura.fetch;
  const u2Tokens = new Set([...h.oura.access].slice(-1));
  h.oura.fetch = async (url, init = {}) => {
    const tok = String(init.headers?.Authorization || '').replace(/^Bearer /, '');
    if (u2Tokens.has(tok) && /\/v2\/usercollection\/sleep$/.test(new URL(url).pathname)) {
      return new Response(JSON.stringify({ data: other.sleep, next_token: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return real(url, init);
  };
  const a = await h.mod.sleepFor('u1');
  const b = await h.mod.sleepFor('u2');
  assert.equal(a.nights[0].sleep.totalSec, 27000);
  assert.equal(b.nights[0].sleep.totalSec, 18000);
  assert.ok(!JSON.stringify(b).includes('T23:05:00'), 'none of u1\'s nights in u2\'s answer');
  // Disconnecting (as the Settings button does) leaves nothing for the next call.
  await h.mod.forgetUser('u1');
  assert.deepEqual((await h.mod.sleepFor('u1')).nights, []);
  assert.equal((await h.mod.sleepFor('u1')).connected, false);
  h.mod.stop();
});

test('after a restart, with no reminder zone, a night stays on the day it ended where the person is', async t => {
  const TZ = 'Asia/Makassar';                                   // UTC+8, no daylight saving
  const today = localDay(Date.now(), TZ);
  const data = {
    // Woke at 07:00 in Makassar today: 23:00 UTC yesterday.
    sleep: [{ id: 'p-mks', day: today, type: 'long_sleep', total_sleep_duration: 25200, efficiency: 90, average_hrv: 50, lowest_heart_rate: 48,
      bedtime_start: addDays(today, -1) + 'T23:00:00+08:00', bedtime_end: today + 'T07:00:00+08:00' }],
    daily_sleep: [{ id: 's-mks', day: today, score: 81 }],
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oura-mcp-restart-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const oura = fakeOura({ data });
  const env = { OURA_CLIENT_ID: 'cid', OURA_CLIENT_SECRET: 'csecret' };
  const boot = () => ouraRoutes({
    json: () => {}, readSession: req => (req.uid ? { id: req.uid, name: 'One' } : null), env, origin: 'https://gym.example', dataDir, instanceSecret: 'instance-secret',
    version: 'test', fetchImpl: (...a) => oura.fetch(...a), autoSync: false, sleep: async () => {},
  });
  const tokens = await exchangeCode(CFG, { code: oura.issueCode('v'), verifier: 'v' }, oura.fetch);
  createOuraStore({ dir: path.join(dataDir, 'oura'), key: deriveKey('instance-secret', 'csecret') })
    .put('u1', { tokens, connectedAt: Date.now(), scopes: tokens.scope });

  // Before the restart: the app's Training & recovery screen synced with the device's zone.
  const first = boot();
  await first.routes['GET /api/integrations/oura/overview']({ uid: 'u1', url: '/api/integrations/oura/overview?days=7&tz=' + TZ }, { writeHead() {}, end() {} });
  first.stop();

  // The restart: nothing held. An assistant asks, and the profile has no reminder zone.
  const second = boot();
  const snap = await second.sleepFor('u1', { tz: null });
  assert.equal(snap.tz, TZ, 'the zone the last sync recorded, not UTC');
  assert.equal(createOuraStore({ dir: path.join(dataDir, 'oura'), key: null }).meta('u1').tz, TZ, 'and the backfill did not write UTC over it');

  const { runReadTool } = await import('../mcp-remote/read-tools.gen.js');
  const S = { unit: 'kg', reminder: { on: false, time: '08:00', tz: null } };
  const r = runReadTool('get_sleep', {}, S, { id: 'u1', name: 'One' }, { oura: snap });
  assert.equal(r.to, today, 'the default range ends today where the person is');
  assert.equal(r.from, addDays(today, -6));
  assert.equal(r.time_zone, TZ);
  assert.deepEqual(r.nights.map(n => n.date), [today]);
  assert.deepEqual(r.latest, {
    date: today, bedtimeStart: addDays(today, -1) + 'T23:00:00+08:00', bedtimeEnd: today + 'T07:00:00+08:00',
    totalSleepMin: 420, efficiency: 90, score: 81, averageHrv: 50, lowestHeartRate: 48,
  });
  second.stop();
});

test('sleepFor: without Oura credentials, not configured', async t => {
  const h = await harness(t, {});
  assert.deepEqual(await h.mod.sleepFor('u1'), { configured: false, connected: false, lastSync: null, lastError: null, tz: null, nights: [] });
});
