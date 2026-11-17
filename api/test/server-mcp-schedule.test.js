/* One-time rescheduling through the hosted MCP, end to end with the real server.js in a child:
   get_schedule names the missed session, preview_schedule_changes shows the shift and saves
   nothing, apply_schedule_changes writes date overrides only (the weekly plan, routines and logged
   workouts untouched), the write is stamped so a device keeps it, undo puts the dates back, and a
   preview goes stale when one of its dates is trained or changed meanwhile.

   Dates are computed from the real clock in the profile's time zone, so the test means the same
   thing on any day it runs. */
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
const ORIGIN = 'http://localhost:8080';
const RESOURCE = ORIGIN + '/api/mcp';
const REDIRECT = 'http://127.0.0.1:53682/callback';
const TZ = 'Asia/Makassar';

const todayIn = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wd = iso => new Date(iso + 'T12:00:00Z').getUTCDay();

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const cookie = uid => ({ Cookie: `gymsid=${mintSession(uid)}` });

// Every weekday trains, in a fixed cycle, so whatever day this runs on, yesterday was planned and
// missed, and the shift has days to move through.
const TODAY = todayIn(TZ);
const YESTERDAY = addDays(TODAY, -1);
const ROUTINES = ['ua', 'la', 'cc', 'ub', 'lb', 'cc2', 'mob'].map((id, i) => ({ id, name: ['Upper A', 'Lower A', 'Cardio', 'Upper B', 'Lower B', 'Cardio 2', 'Mobility'][i], ex: [{ id: '0025', sets: 3, reps: 5, weight: 50 + i }] }));
const WEEK = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, [ROUTINES[d].id]]));
const STATE = {
  unit: 'kg', _rev: 5, _wid: 'wid-5', _ts: 1,
  reminder: { on: false, time: '16:00', tz: TZ },
  weekStart: 1,
  routines: ROUTINES, week: WEEK, dayPlan: {},
  workouts: [{ id: 'w-old', d: addDays(TODAY, -2), start: 1, end: 3600001, name: ROUTINES[wd(addDays(TODAY, -2))].name, routineIds: [ROUTINES[wd(addDays(TODAY, -2))].id], entries: [] }],
};

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mcps-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: 'u_one', name: 'One', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }));
  fs.writeFileSync(path.join(dataDir, 'state-u_one.json'), JSON.stringify(STATE));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', MCP_OAUTH_USERS: 'u_one' }
  });
  const h = { log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.fetch = (p, opts = {}) => fetch(`http://127.0.0.1:${h.port}` + p, { redirect: 'manual', ...opts });
  h.form = (p, fields, headers = {}) => h.fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
  h.state = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'state-u_one.json'), 'utf8'));
  let id = 0;
  h.call = async (token, name, args = {}) => {
    const r = await h.fetch('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
    });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    return body.result;
  };
  h.list = async token => (await (await h.fetch('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} })
  })).json()).result.tools;
  return h;
}

async function connect(h) {
  const reg = await h.fetch('/api/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Test', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) });
  const client = await reg.json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', scope: 'gymly:read gymly:write', resource: RESOURCE });
  const html = await (await h.fetch('/api/oauth/authorize?' + q, { headers: cookie('u_one') })).text();
  const reqId = /name="request_id" value="([^"]+)"/.exec(html)[1];
  const r = await h.form('/api/oauth/authorize', { request_id: reqId, decision: 'allow', allow_write: '1' }, { ...cookie('u_one'), 'Sec-Fetch-Site': 'same-origin' });
  const code = new URL(r.headers.get('location')).searchParams.get('code');
  const tok = await h.form('/api/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: RESOURCE });
  return (await tok.json()).access_token;
}

test('get_schedule → preview → apply → sync → undo, one-time overrides only', async t => {
  const h = await startServer(t);
  const at = await connect(h);
  const names = (await h.list(at)).map(x => x.name);
  for (const n of ['get_schedule', 'preview_schedule_changes', 'apply_schedule_changes']) assert.ok(names.includes(n), n);

  const sched = await h.call(at, 'get_schedule');
  assert.ok(!sched.isError, JSON.stringify(sched));
  assert.equal(sched.structuredContent.today, TODAY);
  assert.deepEqual(sched.structuredContent.missed, [{ date: YESTERDAY, routines: [{ id: ROUTINES[wd(YESTERDAY)].id, name: ROUTINES[wd(YESTERDAY)].name }] }]);
  const yRow = sched.structuredContent.days.find(d => d.date === YESTERDAY);
  assert.equal(yRow.status, 'missed');

  const pv = await h.call(at, 'preview_schedule_changes', { reschedule_missed: { missed_dates: [YESTERDAY] } });
  assert.ok(!pv.isError, JSON.stringify(pv));
  assert.ok(pv.structuredContent.will_change.length >= 1);
  assert.equal(h.state()._rev, 5, 'a preview saves nothing');

  const ap = await h.call(at, 'apply_schedule_changes', { preview_id: pv.structuredContent.preview_id });
  assert.ok(!ap.isError, JSON.stringify(ap));
  const after = h.state();
  // Today now trains yesterday's missed session; the weekly plan, routines and history are as they were.
  assert.equal(after.dayPlan[TODAY], ROUTINES[wd(YESTERDAY)].id);
  assert.deepEqual(after.week, WEEK);
  assert.deepEqual(after.routines, ROUTINES);
  assert.deepEqual(after.workouts, STATE.workouts);
  assert.equal(after.missedDays[YESTERDAY].act, 'moved');
  assert.equal(after.missedDays[YESTERDAY].to, TODAY);
  assert.ok(after.missedDays[YESTERDAY]._ts > 0, 'the answer carries its own stamp');
  // Stamped by the commit like any writer's plan day, so a device merging later keeps it.
  assert.ok(after.edited?.['dayPlan.' + TODAY] > 0);
  const pulled = await (await h.fetch('/api/data', { headers: cookie('u_one') })).json();
  assert.equal(pulled.state.dayPlan[TODAY], ROUTINES[wd(YESTERDAY)].id);

  const view = await h.call(at, 'get_schedule');
  assert.deepEqual(view.structuredContent.missed, []);
  const tRow = view.structuredContent.days.find(d => d.date === TODAY);
  assert.equal(tRow.planned[0].id, ROUTINES[wd(YESTERDAY)].id);
  assert.equal(tRow.weekly[0].id, ROUTINES[wd(TODAY)].id);
  assert.equal(tRow.override, ROUTINES[wd(YESTERDAY)].id);

  const again = await h.call(at, 'apply_schedule_changes', { preview_id: pv.structuredContent.preview_id });
  assert.equal(again.structuredContent.replayed, true);

  const undo = await h.call(at, 'undo_change', { change_id: ap.structuredContent.change_id });
  assert.ok(!undo.isError, JSON.stringify(undo));
  const back = h.state();
  assert.deepEqual(back.dayPlan, {});
  assert.equal(back.missedDays[YESTERDAY].act, undefined, 'the answer is cleared (a stamped empty entry)');
  assert.deepEqual(back.week, WEEK);
});

test('explicit assignments, and every way they must not work', async t => {
  const h = await startServer(t);
  const at = await connect(h);
  const tomorrow = addDays(TODAY, 1);

  // The past and a made-up routine are refused, with nothing saved.
  const past = await h.call(at, 'preview_schedule_changes', { assignments: [{ date: YESTERDAY, routine_id: 'ua' }] });
  assert.equal(past.isError, true);
  assert.match(past.content[0].text, /past/);
  const unknown = await h.call(at, 'preview_schedule_changes', { assignments: [{ date: tomorrow, routine_id: 'nope' }] });
  assert.equal(unknown.isError, true);
  const both = await h.call(at, 'preview_schedule_changes', { reschedule_missed: {}, assignments: [{ date: tomorrow, routine_id: 'rest' }] });
  assert.equal(both.isError, true);

  const pv = await h.call(at, 'preview_schedule_changes', { assignments: [{ date: TODAY, routine_id: 'rest' }, { date: tomorrow, routine_id: 'mob' }], answers: [{ date: YESTERDAY, act: 'skipped' }] });
  assert.ok(!pv.isError, JSON.stringify(pv));

  // A workout logged today on a device before the apply makes the preview stale.
  const cur = h.state();
  const put = await h.fetch('/api/data', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...cookie('u_one'), 'Sec-Fetch-Site': 'same-origin', Origin: ORIGIN },
    body: JSON.stringify({ state: { ...cur, workouts: [...cur.workouts, { id: 'w-today', d: TODAY, start: Date.now() - 3600000, end: Date.now(), name: 'Quick one', routineIds: [], entries: [] }] }, baseRev: cur._rev })
  });
  assert.equal(put.status, 200, await put.clone().text());
  const stale = await h.call(at, 'apply_schedule_changes', { preview_id: pv.structuredContent.preview_id });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error, 'stale');
  assert.equal(h.state().dayPlan[tomorrow], undefined);

  // Today is now trained: it can no longer be reassigned; tomorrow and the answer still can.
  const trained = await h.call(at, 'preview_schedule_changes', { assignments: [{ date: TODAY, routine_id: 'rest' }] });
  assert.equal(trained.isError, true);
  assert.match(trained.content[0].text, /workout logged/);
  const pv2 = await h.call(at, 'preview_schedule_changes', { assignments: [{ date: tomorrow, routine_id: 'mob' }], answers: [{ date: YESTERDAY, act: 'skipped' }] });
  const ap = await h.call(at, 'apply_schedule_changes', { preview_id: pv2.structuredContent.preview_id });
  assert.ok(!ap.isError, JSON.stringify(ap));
  const s = h.state();
  assert.equal(s.dayPlan[tomorrow], 'mob');
  assert.equal(s.missedDays[YESTERDAY].act, 'skipped');
  assert.equal(s.workouts.filter(w => w.d === TODAY).length, 1, 'the logged workout is untouched');
  assert.deepEqual(s.week, WEEK);
});
