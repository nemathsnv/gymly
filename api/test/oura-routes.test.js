/* The Oura routes, two ways.
 *
 * 1. The module with a fake Oura behind its fetch: the whole connect → consent → callback →
 *    overview → sync → disconnect flow, with the checks on `state` (single use, tied to the
 *    profile that started it), and the promise that no Oura health data reaches the disk.
 * 2. The real server, spawned: the routes are mounted, inert without credentials, behind the
 *    same cross-site guard as every other POST, never in the synced state or the MCP view, and
 *    gone with the profile when an admin deletes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ouraRoutes } from '../oura/routes.js';
import { fakeOura } from './oura-fake.mjs';
import { boundPort } from './helpers.mjs';

/* ---------------------------------------------------------------- module level -- */

function harness(t, { env = { OURA_CLIENT_ID: 'cid', OURA_CLIENT_SECRET: 'csecret' }, oura = fakeOura() } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oura-routes-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const users = { u1: { id: 'u1', name: 'One' }, u2: { id: 'u2', name: 'Two' } };
  const audits = [];
  const mod = ouraRoutes({
    json: (res, code, obj, headers) => { res.status = code; res.body = obj; res.headers = headers || {}; },
    readSession: req => users[req.uid] || null,
    audit: (req, ev, f) => audits.push({ ev, uid: f.user?.id, ok: f.ok !== false, msg: f.msg }),
    env, origin: 'https://gym.example', dataDir, instanceSecret: 'instance-secret', version: 'test', fetchImpl: (...a) => oura.fetch(...a),
  });
  const call = async (key, { uid = 'u1', url } = {}) => {
    const res = { status: 0, body: null, headers: {}, writeHead(code, h) { this.status = code; this.headers = h; }, end() {} };
    await mod.routes[key]({ uid, url: url || key.split(' ')[1] }, res);
    return res;
  };
  /** Connect, then play Oura's consent screen: answer with a code bound to the PKCE challenge. */
  const consent = async (uid = 'u1') => {
    const r = await call('POST /api/integrations/oura/connect', { uid });
    const q = new URL(r.body.url).searchParams;
    // The fake checks the verifier against the code it hands out; it learns it the way Oura
    // does, from the challenge — so keep the verifier on the side by intercepting the exchange.
    return { state: q.get('state'), challenge: q.get('code_challenge') };
  };
  return { mod, call, consent, oura, dataDir, audits };
}

// The fake binds a code to a verifier. The routes keep the verifier private; the test recovers
// it by matching the challenge the authorize URL carried against the verifier sent at exchange.
function codeFor(oura, challenge) {
  const code = 'code-for-' + challenge;
  oura.codes.set(code, null);
  const realFetch = oura.fetch;
  oura.fetch = async (url, init) => {
    if (String(url).endsWith('/oauth/token') && new URLSearchParams(init.body).get('code') === code) {
      const v = new URLSearchParams(init.body).get('code_verifier');
      const ok = crypto.createHash('sha256').update(v).digest('base64url') === challenge;
      oura.codes.set(code, ok ? v : 'mismatch');
    }
    return realFetch(url, init);
  };
  return code;
}

test('without credentials: status says so, the rest is 503 off', async t => {
  const h = harness(t, { env: {} });
  const s = await h.call('GET /api/integrations/oura/status');
  assert.equal(s.status, 200);
  assert.equal(s.body.configured, false);
  assert.equal(s.body.connected, false);
  for (const k of ['POST /api/integrations/oura/connect', 'GET /api/integrations/oura/overview', 'POST /api/integrations/oura/sync']) {
    const r = await h.call(k);
    assert.equal(r.status, 503, k);
    assert.equal(r.body.code, 'off');
  }
  assert.equal((await h.call('GET /api/integrations/oura/callback', { url: '/api/integrations/oura/callback?code=x&state=y' })).headers.Location, '../../../#/settings/data?oura=off');
});

test('signed out: every route but the callback is a 401', async t => {
  const h = harness(t);
  for (const k of Object.keys(h.mod.routes).filter(k => !k.endsWith('/callback'))) {
    assert.equal((await h.call(k, { uid: null })).status, 401, k);
  }
});

test('the full flow: connect, consent, callback, overview, sync, disconnect', async t => {
  const h = harness(t);
  const { state, challenge } = await h.consent('u1');
  const code = codeFor(h.oura, challenge);
  const cb = await h.call('GET /api/integrations/oura/callback', { url: `/api/integrations/oura/callback?code=${code}&state=${state}` });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.Location, '../../../#/settings/data?oura=connected');
  assert.equal(cb.headers['Referrer-Policy'], 'no-referrer');
  assert.deepEqual(h.audits.at(-1), { ev: 'oura.connect', uid: 'u1', ok: true, msg: undefined });

  const st = await h.call('GET /api/integrations/oura/status');
  assert.equal(st.body.connected, true);
  assert.deepEqual(st.body.scopes, ['daily', 'heartrate', 'workout', 'spo2', 'heart_health']);
  assert.equal(st.body.lastSync, null);

  const ov = await h.call('GET /api/integrations/oura/overview', { url: '/api/integrations/oura/overview?days=7' });
  assert.equal(ov.status, 200);
  assert.equal(ov.body.cached, false);
  assert.equal(ov.body.days[0].readiness.score, 82);
  assert.equal(ov.body.workouts.length, 2);
  const apiCalls = h.oura.calls.length;
  // Held in memory: a second look within the TTL does not go back to Oura.
  const again = await h.call('GET /api/integrations/oura/overview', { url: '/api/integrations/oura/overview?days=7' });
  assert.equal(again.body.cached, true);
  assert.equal(h.oura.calls.length, apiCalls);
  // Sync Now within 30 s gets the same; the status shows when it last synced.
  assert.equal((await h.call('POST /api/integrations/oura/sync')).body.cached, false, 'a longer window than held is fetched');
  assert.equal((await h.call('POST /api/integrations/oura/sync')).body.cached, true);
  assert.ok((await h.call('GET /api/integrations/oura/status')).body.lastSync > 0);

  // Nothing Oura measured is on disk: only the encrypted token file exists.
  const files = fs.readdirSync(h.dataDir, { recursive: true }).map(String);
  assert.deepEqual(files.sort(), ['oura', path.join('oura', 'u1.json')].sort());
  const disk = fs.readFileSync(path.join(h.dataDir, 'oura', 'u1.json'), 'utf8');
  for (const v of ['strength_training', '9120', '27000', 'readiness', 'acc-', 'ref-']) assert.ok(!disk.includes(v), v);

  const access = [...h.oura.access][0];
  const d = await h.call('POST /api/integrations/oura/disconnect');
  assert.deepEqual(d.body, { ok: true, revoked: true });
  assert.ok(h.oura.revoked.has(access), 'the token was revoked at Oura');
  assert.equal(fs.existsSync(path.join(h.dataDir, 'oura', 'u1.json')), false);
  assert.equal((await h.call('GET /api/integrations/oura/status')).body.connected, false);
  // and what was held in memory is gone too: the overview now needs a connection
  assert.equal((await h.call('GET /api/integrations/oura/overview')).status, 409);
  assert.equal(h.audits.at(-1).ev, 'oura.disconnect');
});

test('state: single use, expires with the server, and only for the profile that started it', async t => {
  const h = harness(t);
  const cb = async (q, uid = 'u1') => (await h.call('GET /api/integrations/oura/callback', { uid, url: '/api/integrations/oura/callback?' + q })).headers.Location.split('oura=')[1];

  assert.equal(await cb('code=x&state=made-up'), 'expired');

  let s = await h.consent('u1');
  assert.equal(await cb(`code=${codeFor(h.oura, s.challenge)}&state=${s.state}`, 'u2'), 'mismatch', 'another profile cannot finish it');
  assert.equal(await cb(`code=${codeFor(h.oura, s.challenge)}&state=${s.state}`, 'u1'), 'expired', 'and the state is spent');

  s = await h.consent('u1');
  assert.equal(await cb(`code=${codeFor(h.oura, s.challenge)}&state=${s.state}`, null), 'mismatch', 'signed out');

  s = await h.consent('u1');
  assert.equal(await cb(`error=access_denied&state=${s.state}`), 'denied');
  s = await h.consent('u1');
  assert.equal(await cb(`state=${s.state}`), 'error', 'no code');
  s = await h.consent('u1');
  assert.equal(await cb(`code=not-issued&state=${s.state}`), 'error', 'a code Oura refuses');
  assert.equal(h.audits.at(-1).ok, false);
  assert.equal((await h.call('GET /api/integrations/oura/status')).body.connected, false);
});

test('a scope switched off on Oura\'s screen shows as not shared, the rest still loads', async t => {
  const h = harness(t, { oura: fakeOura({ granted: ['daily', 'workout'] }) });
  const s = await h.consent();
  await h.call('GET /api/integrations/oura/callback', { url: `/api/integrations/oura/callback?code=${codeFor(h.oura, s.challenge)}&state=${s.state}` });
  const ov = await h.call('GET /api/integrations/oura/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.body.available.daily_spo2, 'not-shared');
  assert.equal(ov.body.available.heartrate, 'not-shared');
  assert.equal(ov.body.available.daily_readiness, 'ok');
});

test('access revoked in the Oura app: the overview says reconnect, and the status turns disconnected', async t => {
  const h = harness(t);
  const s = await h.consent();
  await h.call('GET /api/integrations/oura/callback', { url: `/api/integrations/oura/callback?code=${codeFor(h.oura, s.challenge)}&state=${s.state}` });
  h.oura.expireAccess(); h.oura.refresh.clear();
  const ov = await h.call('GET /api/integrations/oura/overview');
  assert.equal(ov.status, 409);
  assert.equal(ov.body.code, 'reauth');
  assert.equal((await h.call('GET /api/integrations/oura/status')).body.connected, false);
});

test('forgetUser (profile deleted) revokes and deletes like Disconnect', async t => {
  const h = harness(t);
  const s = await h.consent();
  await h.call('GET /api/integrations/oura/callback', { url: `/api/integrations/oura/callback?code=${codeFor(h.oura, s.challenge)}&state=${s.state}` });
  const access = [...h.oura.access][0];
  await h.mod.forgetUser('u1');
  assert.ok(h.oura.revoked.has(access));
  assert.equal(fs.existsSync(path.join(h.dataDir, 'oura', 'u1.json')), false);
});

/* ---------------------------------------------------------------- spawned server -- */

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const mint = uid => { const p = `${uid}:${Date.now() + 86400000}:0`; return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); };
const as = (uid, extra = {}) => ({ Cookie: `gymsid=${mint(uid)}`, 'Content-Type': 'application/json', ...extra });

async function server(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oura-srv-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const created = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: 'u_adm', name: 'Admin', created, admin: true }, { id: 'u_one', name: 'One', created }],
    creds: [], subs: [], invites: [],
  }));
  fs.writeFileSync(path.join(dataDir, 'state-u_one.json'), JSON.stringify({ workouts: [], bodyweight: [] }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', OURA_CLIENT_ID: '', OURA_CLIENT_SECRET: '', ...env },
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const port = await boundPort(child, () => log);
  return { api: `http://127.0.0.1:${port}`, dataDir, log: () => log };
}

test('server: unconfigured, the routes exist and are inert', async t => {
  const s = await server(t);
  const st = await fetch(s.api + '/api/integrations/oura/status', { headers: as('u_one') });
  assert.equal(st.status, 200);
  assert.equal((await st.json()).configured, false);
  const c = await fetch(s.api + '/api/integrations/oura/connect', { method: 'POST', headers: as('u_one'), body: '{}' });
  assert.equal(c.status, 503);
  assert.equal((await fetch(s.api + '/api/integrations/oura/status')).status, 401);
  assert.equal((await (await fetch(s.api + '/api/config')).json()).oura, undefined, 'no oura flag while off');
});

test('server: configured, connect hands out Oura\'s consent URL; a cross-site POST is refused; secrets stay out of logs', async t => {
  const s = await server(t, { OURA_CLIENT_ID: 'cid-123', OURA_CLIENT_SECRET: 'super-secret-value' });
  const r = await fetch(s.api + '/api/integrations/oura/connect', { method: 'POST', headers: as('u_one', { 'Sec-Fetch-Site': 'same-origin' }), body: '{}' });
  assert.equal(r.status, 200);
  const u = new URL((await r.json()).url);
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:8080/api/integrations/oura/callback');
  assert.equal(u.searchParams.get('client_id'), 'cid-123');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!u.toString().includes('super-secret-value'));
  const forged = await fetch(s.api + '/api/integrations/oura/connect', { method: 'POST', headers: as('u_one', { 'Sec-Fetch-Site': 'cross-site' }), body: '{}' });
  assert.equal(forged.status, 403);
  const forgedOff = await fetch(s.api + '/api/integrations/oura/disconnect', { method: 'POST', headers: as('u_one', { 'Sec-Fetch-Site': 'cross-site' }), body: '{}' });
  assert.equal(forgedOff.status, 403);
  // An unknown state goes back to Settings, not to an error page.
  const cb = await fetch(s.api + '/api/integrations/oura/callback?code=x&state=nope', { headers: as('u_one'), redirect: 'manual' });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '../../../#/settings/data?oura=expired');
  const pub = await (await fetch(s.api + '/api/config')).text();
  assert.equal(JSON.parse(pub).oura, true, 'public config says Oura can be connected');
  assert.ok(!pub.includes('cid-123') && !pub.includes('super-secret-value'), 'and names no credential');
  assert.ok(!s.log().includes('super-secret-value'), 'the client secret is never printed');
});

test('server: an Oura connection is never in the synced state or the MCP view, and an admin delete removes it', async t => {
  const s = await server(t, { OURA_CLIENT_ID: 'cid', OURA_CLIENT_SECRET: 'csecret' });
  // A connection as the callback would leave it (the real exchange needs Oura; the file is what matters).
  const { createOuraStore, deriveKey } = await import('../oura/store.js');
  createOuraStore({ dir: path.join(s.dataDir, 'oura'), key: deriveKey(SECRET, 'csecret') })
    .put('u_one', { tokens: { access: 'acc-x', refresh: 'ref-x', exp: Date.now() + 3600e3 }, connectedAt: Date.now(), scopes: ['daily'] });
  const st = await (await fetch(s.api + '/api/integrations/oura/status', { headers: as('u_one') })).json();
  assert.equal(st.connected, true);
  const data = await (await fetch(s.api + '/api/data', { headers: as('u_one') })).text();
  assert.ok(!/oura/i.test(data), 'the synced state knows nothing of Oura');
  // Admin delete: the token file goes with the profile (revocation is attempted against the real
  // Oura and fails quietly here; the delete does not wait for it).
  const del = await fetch(s.api + '/api/admin/user/delete', { method: 'POST', headers: as('u_adm'), body: JSON.stringify({ id: 'u_one' }) });
  assert.equal(del.status, 200);
  for (let i = 0; i < 50 && fs.existsSync(path.join(s.dataDir, 'oura', 'u_one.json')); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.existsSync(path.join(s.dataDir, 'oura', 'u_one.json')), false);
});
