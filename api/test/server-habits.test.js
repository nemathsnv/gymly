/* The daily habit log (frontend/src/lib/habits.js) on the server, real server.js in a child: it is
   stored with the profile and comes back on the next pull, a stale push is refused with the copy
   to merge, one profile never sees another's, nobody without the session sees any, and neither the
   read-only MCP token nor the hosted MCP endpoint's profile view carries it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const session = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return { Cookie: `gymsid=${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')}` };
};
const now = new Date().toISOString();
const NOTE_ONE = 'ONE-HABIT-NOTE-7731';
const NOTE_TWO = 'TWO-HABIT-NOTE-9154';
const log = (note, extra = {}) => ({
  'alcohol|2026-10-20': { s: 'free', tz: 'Europe/Lisbon', _ts: 10 },
  'alcohol|2026-10-21': { s: 'drank', n: 3, note, tz: 'Europe/Lisbon', _ts: 11 },
  ...extra
});

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-habits-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: 'u_one', name: 'One', created: now }, { id: 'u_two', name: 'Two', created: now }], creds: [], subs: [], invites: []
  }));
  fs.writeFileSync(path.join(dataDir, 'state-u_two.json'), JSON.stringify({ unit: 'kg', routines: [], workouts: [], habitLog: log(NOTE_TWO), _rev: 1 }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  const h = { log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.req = (method, p, headers = {}, body) => fetch(`http://127.0.0.1:${h.port}${p}`, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  h.file = uid => fs.readFileSync(path.join(dataDir, `state-${uid}.json`), 'utf8');
  return h;
}

test('the log is stored with the profile and comes back on the next pull', async t => {
  const h = await start(t);
  const put = await h.req('PUT', '/api/data', session('u_one'), { state: { unit: 'kg', routines: [], workouts: [], habitLog: log(NOTE_ONE), habitsOn: true } });
  assert.equal(put.status, 200, await put.clone().text());
  assert.deepEqual(JSON.parse(h.file('u_one')).habitLog, log(NOTE_ONE));
  const got = await (await h.req('GET', '/api/data', session('u_one'))).json();
  assert.deepEqual(got.state.habitLog, log(NOTE_ONE));
  assert.equal(got.state.habitsOn, true);
});

test('a push over a document the device never saw is refused with the copy to merge, habit log included', async t => {
  const h = await start(t);
  const first = await (await h.req('PUT', '/api/data', session('u_one'), { state: { unit: 'kg', routines: [], workouts: [], habitLog: log(NOTE_ONE) } })).json();
  // another device writes a new day…
  const next = log(NOTE_ONE, { 'alcohol|2026-10-22': { s: 'free', _ts: 20 } });
  assert.equal((await h.req('PUT', '/api/data', session('u_one'), { state: { unit: 'kg', routines: [], workouts: [], habitLog: next }, baseRev: first.rev })).status, 200);
  // …and a stale device is told so, and handed the document that has it
  const stale = await h.req('PUT', '/api/data', session('u_one'), { state: { unit: 'kg', routines: [], workouts: [], habitLog: log(NOTE_ONE) }, baseRev: first.rev });
  assert.equal(stale.status, 409);
  assert.deepEqual((await stale.json()).state.habitLog, next);
});

test('one profile never sees another\'s log, and nobody without a session sees any', async t => {
  const h = await start(t);
  await h.req('PUT', '/api/data', session('u_one'), { state: { unit: 'kg', routines: [], workouts: [], habitLog: log(NOTE_ONE) } });
  const one = await (await h.req('GET', '/api/data', session('u_one'))).text();
  const two = await (await h.req('GET', '/api/data', session('u_two'))).text();
  assert.ok(one.includes(NOTE_ONE) && !one.includes(NOTE_TWO));
  assert.ok(two.includes(NOTE_TWO) && !two.includes(NOTE_ONE));
  // a write by one profile does not touch the other's file
  assert.ok(!h.file('u_two').includes(NOTE_ONE));
  assert.ok(h.file('u_two').includes(NOTE_TWO));
  // no session, no data; nor on the revision route, nor with a forged cookie
  for (const p of ['/api/data', '/api/data/rev']) assert.equal((await h.req('GET', p)).status, 401, p);
  assert.equal((await h.req('GET', '/api/data', { Cookie: 'gymsid=u_one:9999999999999:0.forged' })).status, 401);
  assert.equal((await h.req('PUT', '/api/data', {}, { state: { habitLog: {} } })).status, 401);
});

test('the read-only MCP token\'s view of the profile has no habit log', async t => {
  const h = await start(t);
  await h.req('PUT', '/api/data', session('u_one'), { state: { unit: 'kg', routines: [{ id: 'r1', name: 'A', ex: [] }], workouts: [], habitLog: log(NOTE_ONE) } });
  const made = await (await h.req('POST', '/api/account/mcp-tokens', session('u_one'), { name: 'Claude Code' })).json();
  const r = await h.req('GET', '/api/mcp/v1/state', { Authorization: 'Bearer ' + made.token });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.includes('"routines"'), 'the token still reads the training record');
  assert.ok(!text.includes(NOTE_ONE) && !text.includes('habitLog') && !text.includes('alcohol'), 'habit log leaked into the MCP view');
  // the token is not a session: it cannot pull the document that does hold the log
  assert.equal((await h.req('GET', '/api/data', { Authorization: 'Bearer ' + made.token })).status, 401);
});
