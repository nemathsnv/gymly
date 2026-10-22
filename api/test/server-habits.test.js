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

// --- habits of the user's own (frontend/src/lib/habits.js `habit|def`), and the server's guard
// on the log (sync-stamps.js keepHabitLog) ---

const HABIT_NAME = 'MY-PRIVATE-HABIT-NAME-4410';
const custom = (extra = {}) => log(NOTE_ONE, {
  'hread|def': { name: HABIT_NAME, icon: 'note', color: 'blue', kind: 'do', at: 30, _ts: 30 },
  'hread|2026-10-21': { s: 'good', note: 'Chapter 3', tz: 'Europe/Lisbon', _ts: 31 },
  'alcohol|def': { name: 'Wine', _ts: 32 },
  ...extra
});
const put = async (h, body) => {
  const r = await h.req('PUT', '/api/data', session('u_one'), body);
  return { status: r.status, body: await r.json() };
};
const stored = h => JSON.parse(h.file('u_one'));

test('habits of the user\'s own are stored and come back with their days', async t => {
  const h = await start(t);
  assert.equal((await put(h, { state: { unit: 'kg', routines: [], workouts: [], habitLog: custom() }, stamped: true })).status, 200);
  const got = await (await h.req('GET', '/api/data', session('u_one'))).json();
  assert.deepEqual(got.state.habitLog, custom());
});

test('an app from before habits, pushing over the current revision without the log, takes nothing away', async t => {
  const h = await start(t);
  const first = await put(h, { state: { unit: 'kg', routines: [], workouts: [], habitLog: custom() }, stamped: true });
  // a pre-habits build that stamps its own changes: it has no habitLog at all
  const old = await put(h, { state: { unit: 'kg', routines: [], workouts: [], restSec: 120 }, baseRev: first.body.rev, stamped: true });
  assert.equal(old.status, 200);
  assert.deepEqual(stored(h).habitLog, custom());
  assert.equal(stored(h).restSec, 120, 'its own change goes through');
  // the stored copy is not the one it sent: it is a revision further, so its next push is a
  // conflict, and the merge it then makes starts from the copy with the log
  assert.equal(stored(h)._rev, old.body.rev + 1);
  const next = await h.req('PUT', '/api/data', session('u_one'), { state: { unit: 'kg', routines: [], workouts: [] }, baseRev: old.body.rev, stamped: true });
  assert.equal(next.status, 409);
  assert.deepEqual((await next.json()).state.habitLog, custom());
});

test('an older copy of the log cannot set newer days or habits back, nor drop them', async t => {
  const h = await start(t);
  const now = custom({ 'hread|2026-10-22': { s: 'good', _ts: 40 } });
  const first = await put(h, { state: { unit: 'kg', routines: [], workouts: [], habitLog: now }, stamped: true });
  // the copy an older app kept whole from before: an older version of a day, a habit missing,
  // Alcohol's name missing — and one change of its own that is genuinely later
  const stale = {
    'alcohol|2026-10-20': { s: 'drank', tz: 'Europe/Lisbon', _ts: 5 },
    'alcohol|2026-10-21': { s: 'drank', n: 3, note: NOTE_ONE, tz: 'Europe/Lisbon', _ts: 11 },
    'alcohol|2026-10-19': { s: 'free', tz: 'Europe/Lisbon', _ts: 50 }
  };
  assert.equal((await put(h, { state: { unit: 'kg', routines: [], workouts: [], habitLog: stale }, baseRev: first.body.rev, stamped: true })).status, 200);
  assert.deepEqual(stored(h).habitLog, { ...now, 'alcohol|2026-10-19': stale['alcohol|2026-10-19'] });
});

test('so can a writer that does not stamp (v1.3.9) or an API script', async t => {
  const h = await start(t);
  const first = await put(h, { state: { unit: 'kg', routines: [], workouts: [], habitLog: custom() }, stamped: true });
  assert.equal((await put(h, { state: { unit: 'kg', routines: [], workouts: [], habitLog: {} }, baseRev: first.body.rev })).status, 200);
  assert.deepEqual(stored(h).habitLog, custom());
  assert.equal((await put(h, { state: { unit: 'kg', routines: [], workouts: [] } })).status, 200);
  assert.deepEqual(stored(h).habitLog, custom());
});

test('"Not logged" and an archived habit, written as stamped entries, are kept as written', async t => {
  const h = await start(t);
  const first = await put(h, { state: { unit: 'kg', routines: [], workouts: [], habitLog: custom() }, stamped: true });
  const next = custom({ 'hread|2026-10-21': { _ts: 60 }, 'hread|def': { name: HABIT_NAME, icon: 'note', color: 'blue', kind: 'do', at: 30, archived: true, _ts: 61 } });
  assert.equal((await put(h, { state: { unit: 'kg', routines: [], workouts: [], habitLog: next }, baseRev: first.body.rev, stamped: true })).status, 200);
  assert.deepEqual(stored(h).habitLog, next);
});

test('"Reset everything" starts the log over', async t => {
  const h = await start(t);
  const first = await put(h, { state: { unit: 'kg', routines: [], workouts: [], habitLog: custom() }, stamped: true });
  const r = await put(h, { state: { unit: 'kg', routines: [], workouts: [], habitLog: {}, resetAt: Date.now(), resetIds: { habitLog: Object.keys(custom()) } }, baseRev: first.body.rev, stamped: true });
  assert.equal(r.status, 200);
  assert.deepEqual(stored(h).habitLog, {});
});

test('a habit\'s name is withheld from the read-only MCP token like its days, and stays out of the other profile', async t => {
  const h = await start(t);
  await put(h, { state: { unit: 'kg', routines: [{ id: 'r1', name: 'A', ex: [] }], workouts: [], habitLog: custom() }, stamped: true });
  const made = await (await h.req('POST', '/api/account/mcp-tokens', session('u_one'), { name: 'Claude Code' })).json();
  const text = await (await h.req('GET', '/api/mcp/v1/state', { Authorization: 'Bearer ' + made.token })).text();
  assert.ok(text.includes('"routines"'));
  assert.ok(!text.includes(HABIT_NAME) && !text.includes('hread') && !text.includes('Chapter 3') && !text.includes('Wine'), 'a habit leaked into the MCP view');
  const two = await (await h.req('GET', '/api/data', session('u_two'))).text();
  assert.ok(!two.includes(HABIT_NAME) && !h.file('u_two').includes(HABIT_NAME));
});
