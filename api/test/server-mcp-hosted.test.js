/* The hosted MCP endpoint end to end, real server.js in a child: discovery, dynamic registration,
   Gymly's consent screen, PKCE, the token endpoint, MCP over Streamable HTTP, a preview and an
   applied change landing in the profile through the same commit as a device's sync, undo,
   refresh rotation and reuse, revocation — and every way it must not work: off by default, a
   profile not on the list, another profile's data, a read-only connection writing, a stale
   preview, a spent code, an oversized or batched body, a foreign Origin, sign-out-everywhere.
   Tokens are written nowhere in clear: not db.json, not the audit log, not the server's output. */
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

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const cookie = (uid, sv) => ({ Cookie: `gymsid=${mintSession(uid, sv)}` });

const now = new Date().toISOString();
const USERS = [
  { id: 'u_one', name: 'One', created: now },
  { id: 'u_two', name: 'Two', created: now },
  { id: 'u_off', name: 'Off', created: now }
];
const STATE_ONE = {
  unit: 'kg', _rev: 3, _wid: 'wid-3', _ts: 1,
  routines: [
    { id: 'r1', name: 'Push Day', ex: [{ id: '0025', sets: 3, reps: 5, weight: 55 }, { id: '0289', sets: 3, reps: 10 }] },
    { id: 'r2', name: 'Legs', ex: [{ id: '0043', sets: 3, reps: 5, weight: 80 }] }
  ],
  week: { 1: ['r1'], 3: ['r2'] }, dayPlan: {},
  workouts: [{ id: 'w1', d: '2026-10-01', start: 1, end: 3600001, name: 'Push Day', routineIds: ['r1'], entries: [{ id: '0025', sets: [{ w: 55, r: 5, done: true }] }] }],
  bodyweight: [{ d: '2026-10-01', w: 80.4 }],
  gymCards: [{ id: 'card1', name: 'My gym', code: 'MEMBER-998877' }],
  coach: { pending: { summary: 'COACH-PRIVATE' } },
  habitLog: { 'alcohol|2026-10-01': { s: 'drank', n: 3, note: 'HABIT-PRIVATE', tz: 'Europe/Lisbon', _ts: 5 } }
};
const STATE_TWO = { unit: 'lb', _rev: 1, routines: [{ id: 'rz', name: 'TWO-SECRET-ROUTINE', ex: [] }], workouts: [] };

async function startServer(t, env = { MCP_OAUTH_USERS: 'u_one,u_two' }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mcph-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: structuredClone(USERS), creds: [], subs: [], invites: [] }));
  fs.writeFileSync(path.join(dataDir, 'state-u_one.json'), JSON.stringify(STATE_ONE));
  fs.writeFileSync(path.join(dataDir, 'state-u_two.json'), JSON.stringify(STATE_TWO));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', AUDIT_LOG: '1', ...env }
  });
  const h = { log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  h.fetch = (p, opts = {}) => fetch(h.api + p, { redirect: 'manual', ...opts });
  h.form = (p, fields, headers = {}) => h.fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
  h.json = (p, body, headers = {}) => h.fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  h.state = uid => JSON.parse(fs.readFileSync(path.join(dataDir, `state-${uid}.json`), 'utf8'));
  h.db = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  h.files = () => ['db.json', 'db.json.bak', 'audit.log', 'mcp-journal-u_one.json'].map(f => { try { return fs.readFileSync(path.join(dataDir, f), 'utf8'); } catch { return ''; } }).join('\n');
  let id = 0;
  h.rpc = async (token, method, params = {}, headers = {}) => {
    const r = await h.fetch('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
    });
    return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
  };
  h.call = async (token, name, args = {}) => {
    const r = await h.rpc(token, 'tools/call', { name, arguments: args });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.result;
  };
  return h;
}

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

async function register(h, extra = {}) {
  const r = await h.json('/api/oauth/register', { client_name: 'Test Client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...extra });
  assert.equal(r.status, 201, await r.clone().text());
  return r.json();
}

/** The whole browser leg: authorize → consent screen → decision. Returns the redirect URL. */
async function consent(h, client, { uid = 'u_one', scope = 'gymly:read gymly:write', allowWrite = true, decision = 'allow', p = pkce(), state = 'st-1' } = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', state, scope, resource: RESOURCE });
  const page = await h.fetch('/api/oauth/authorize?' + q, { headers: cookie(uid) });
  const html = await page.text();
  assert.equal(page.status, 200, html);
  const reqId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(reqId, 'consent screen with a request id');
  const r = await h.form('/api/oauth/authorize', { request_id: reqId, decision, ...(allowWrite ? { allow_write: '1' } : {}) }, { ...cookie(uid), 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(r.status, 303, await r.clone().text());
  return { location: new URL(r.headers.get('location')), p, html };
}

async function connect(h, opts = {}) {
  const client = opts.client || await register(h);
  const { location, p } = await consent(h, client, opts);
  const code = location.searchParams.get('code');
  assert.ok(code, location.toString());
  const r = await h.form('/api/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: p.verifier, resource: RESOURCE });
  assert.equal(r.status, 200, await r.clone().text());
  return { client, tokens: await r.json() };
}

test('off by default: no MCP_OAUTH_USERS, every hosted route is a 404', async t => {
  const h = await startServer(t, {});
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-authorization-server']) {
    assert.equal((await h.fetch(p)).status, 404, p);
  }
  assert.equal((await h.rpc('x', 'initialize')).status, 404);
  assert.equal((await h.json('/api/oauth/register', { redirect_uris: [REDIRECT] })).status, 404);
  assert.equal((await h.form('/api/oauth/token', { grant_type: 'authorization_code' })).status, 404);
  assert.equal((await h.fetch('/api/oauth/authorize?client_id=x')).status, 404);
});

test('discovery documents and the 401 challenge that starts an MCP client\'s OAuth flow', async t => {
  const h = await startServer(t);
  const prm = await (await h.fetch('/.well-known/oauth-protected-resource/api/mcp')).json();
  assert.deepEqual(prm.authorization_servers, [ORIGIN]);
  assert.equal(prm.resource, RESOURCE);
  assert.deepEqual(prm.scopes_supported, ['gymly:read', 'gymly:write']);
  assert.deepEqual(await (await h.fetch('/.well-known/oauth-protected-resource')).json(), prm);
  const as = await (await h.fetch('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.issuer, ORIGIN);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.equal(as.token_endpoint, ORIGIN + '/api/oauth/token');

  const r = await h.rpc(null, 'initialize');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /^Bearer resource_metadata="http:\/\/localhost:8080\/\.well-known\/oauth-protected-resource\/api\/mcp", scope="gymly:read gymly:write"$/);
  const bad = await h.rpc('gymly_oat_' + 'A'.repeat(43), 'initialize');
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('www-authenticate'), /error="invalid_token"/);
  // A session cookie is not a bearer for MCP, and an MCP token is not a session.
  assert.equal((await h.rpc(mintSession('u_one'), 'initialize')).status, 401);
  assert.equal((await h.fetch('/api/mcp')).status, 405);
});

test('connect, read, preview, apply, sync, undo — and the change is a real, mergeable write', async t => {
  const h = await startServer(t);
  const { tokens } = await connect(h);
  assert.match(tokens.access_token, /^gymly_oat_/);
  assert.match(tokens.refresh_token, /^gymly_ort_/);
  assert.equal(tokens.scope, 'gymly:read gymly:write');
  assert.equal(tokens.expires_in, 3600);
  const at = tokens.access_token;

  const init = await h.rpc(at, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'gymly');
  assert.equal(init.headers.get('mcp-session-id'), null);
  assert.match(init.body.result.instructions, /Never confirm on the user's behalf/);

  const list = await h.rpc(at, 'tools/list');
  const names = list.body.result.tools.map(x => x.name);
  for (const n of ['list_routines', 'get_routine', 'list_workouts', 'get_workout', 'get_training_progress', 'get_week_plan', 'search_exercises',
    'preview_routine_changes', 'create_routine', 'apply_routine_changes', 'apply_destructive_routine_changes', 'preview_workout_log', 'log_workout', 'undo_change', 'list_recent_changes']) {
    assert.ok(names.includes(n), n);
  }
  for (const tool of list.body.result.tools) {
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    assert.ok(tool.title, tool.name);
    assert.ok(tool._meta.securitySchemes[0].scopes[0].startsWith('gymly:'), tool.name);
  }
  assert.equal(list.body.result.tools.find(x => x.name === 'apply_destructive_routine_changes').annotations.destructiveHint, true);
  assert.equal(list.body.result.tools.find(x => x.name === 'apply_routine_changes').annotations.readOnlyHint, false);

  const routines = await h.call(at, 'list_routines');
  assert.deepEqual(routines.structuredContent.routines.map(r => r.name), ['Push Day', 'Legs']);
  const workout = await h.call(at, 'get_workout', { workout_id: 'w1' });
  assert.equal(workout.structuredContent.entries[0].sets[0].w, 55);
  const progress = await h.call(at, 'get_training_progress', { weeks: 52 });
  assert.equal(progress.structuredContent.lifts[0].id, '0025');
  // Withheld from every answer: gym cards and the Coach record.
  assert.doesNotMatch(JSON.stringify([routines, workout, progress]), /MEMBER-998877|COACH-PRIVATE|HABIT-PRIVATE|alcohol/);
  // …and the habit log (alcohol, drink counts, private notes) is in no read tool's answer, nor any tool's listing.
  const week = await h.call(at, 'get_week_plan');
  const recent = await h.call(at, 'list_workouts');
  assert.doesNotMatch(JSON.stringify([week, recent, list.body.result]), /HABIT-PRIVATE|habitLog|alcohol|drank/i);

  // "Change bench press to 4 sets of 8 at 60 kg."
  const pv = await h.call(at, 'preview_routine_changes', { operations: [{ op: 'update_exercise', routine_id: 'r1', exercise_id: '0025', sets: 4, reps: 8, weight: 60 }] });
  assert.ok(!pv.isError, JSON.stringify(pv));
  assert.equal(pv.structuredContent.tier, 'ordinary');
  assert.deepEqual(pv.structuredContent.will_change, ['“Push Day” · Barbell Bench Press: 3 × 5 · 55 kg → 4 × 8 · 60 kg']);
  // Nothing saved by a preview.
  assert.equal(h.state('u_one')._rev, 3);

  const ap = await h.call(at, 'apply_routine_changes', { preview_id: pv.structuredContent.preview_id });
  assert.ok(!ap.isError, JSON.stringify(ap));
  const after = h.state('u_one');
  assert.deepEqual(after.routines[0].ex[0], { ...after.routines[0].ex[0], id: '0025', sets: 4, reps: 8, weight: 60 });
  assert.equal(after._rev >= 4, true);
  assert.notEqual(after._wid, 'wid-3');
  assert.ok(after._wids.includes('wid-3'));
  // Stamped like any other writer's edit, so a device merging later keeps it (sync-stamps.js).
  assert.ok(after.routines[0]._ts > 0);
  // Everything else untouched.
  assert.deepEqual(after.workouts, STATE_ONE.workouts);
  assert.deepEqual(after.gymCards, STATE_ONE.gymCards);
  // An assistant's change to a routine leaves the habit log as it was.
  assert.deepEqual(after.habitLog, STATE_ONE.habitLog);
  // A device sees it on its next pull.
  const pulled = await (await h.fetch('/api/data', { headers: cookie('u_one') })).json();
  assert.equal(pulled.rev, after._rev);
  assert.equal(pulled.state.routines[0].ex[0].weight, 60);

  // Idempotent: the same preview again does nothing more.
  const again = await h.call(at, 'apply_routine_changes', { preview_id: pv.structuredContent.preview_id });
  assert.equal(again.structuredContent.replayed, true);
  assert.equal(h.state('u_one')._rev, after._rev);

  const changes = await h.call(at, 'list_recent_changes');
  assert.equal(changes.structuredContent.changes[0].change_id, ap.structuredContent.change_id);

  const undo = await h.call(at, 'undo_change', { change_id: ap.structuredContent.change_id });
  assert.ok(!undo.isError, JSON.stringify(undo));
  assert.deepEqual(h.state('u_one').routines[0].ex[0].weight, 55);
  assert.deepEqual(h.state('u_one').routines[0].ex[0].sets, 3);
  assert.deepEqual(h.state('u_one').habitLog, STATE_ONE.habitLog, 'undo leaves the habit log alone');
  const twice = await h.call(at, 'undo_change', { change_id: ap.structuredContent.change_id });
  assert.equal(twice.structuredContent.replayed, true);

  // Tokens in clear nowhere.
  const files = h.files() + h.log;
  for (const tok of [tokens.access_token, tokens.refresh_token]) assert.ok(!files.includes(tok), 'token leaked');
  assert.match(h.files(), /auth\.mcp\.connect/);
  assert.match(h.files(), /auth\.mcp\.write/);
});

test('a stale preview is refused, a destructive one needs the stronger confirmation, a workout logs once', async t => {
  const h = await startServer(t);
  const { tokens: { access_token: at } } = await connect(h);

  const pv = await h.call(at, 'preview_routine_changes', { operations: [{ op: 'update_exercise', routine_id: 'r1', exercise_id: '0025', sets: 5 }] });
  // The plan moves on a device in between.
  const pull = await (await h.fetch('/api/data', { headers: cookie('u_one') })).json();
  const edited = structuredClone(pull.state);
  edited.routines[0].ex[0].reps = 3;
  const put = await h.fetch('/api/data', { method: 'PUT', headers: { ...cookie('u_one'), 'Content-Type': 'application/json' }, body: JSON.stringify({ state: edited, baseRev: pull.rev }) });
  assert.equal(put.status, 200);
  const stale = await h.call(at, 'apply_routine_changes', { preview_id: pv.structuredContent.preview_id });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error, 'stale');
  assert.equal(h.state('u_one').routines[0].ex[0].sets, 3);

  // Removing needs apply_destructive_routine_changes and the phrase.
  const rm = await h.call(at, 'preview_routine_changes', { operations: [{ op: 'remove_exercise', routine_id: 'r1', exercise_id: '0289' }] });
  assert.equal(rm.structuredContent.tier, 'destructive');
  const phrase = rm.structuredContent.confirmation_phrase;
  const plain = await h.call(at, 'apply_routine_changes', { preview_id: rm.structuredContent.preview_id });
  assert.equal(plain.structuredContent.error, 'needs_confirmation');
  const wrong = await h.call(at, 'apply_destructive_routine_changes', { preview_id: rm.structuredContent.preview_id, confirmation: 'yes' });
  assert.equal(wrong.structuredContent.error, 'confirmation_mismatch');
  assert.equal(h.state('u_one').routines[0].ex.length, 2);
  const done = await h.call(at, 'apply_destructive_routine_changes', { preview_id: rm.structuredContent.preview_id, confirmation: phrase });
  assert.ok(!done.isError, JSON.stringify(done));
  assert.deepEqual(h.state('u_one').routines[0].ex.map(e => e.id), ['0025']);

  // A four-day program as one preview: routines created and scheduled together.
  const prog = await h.call(at, 'preview_routine_changes', { operations: [
    { op: 'create_routine', name: 'Upper A', exercises: [{ exercise_id: '0025', sets: 4, reps: 6, weight: 60 }], weekdays: [1] },
    { op: 'create_routine', name: 'Lower A', exercises: [{ exercise_id: '0043', sets: 4, reps: 6 }], weekdays: [2] },
    { op: 'create_routine', name: 'Upper B', exercises: [{ exercise_id: '0289', sets: 3, reps: 10 }], weekdays: [4] },
    { op: 'create_routine', name: 'Lower B', exercises: [{ exercise_id: '0043', sets: 3, reps: 10 }], weekdays: [5] }
  ] });
  assert.ok(!prog.isError, JSON.stringify(prog));
  assert.equal(prog.structuredContent.tier, 'ordinary');
  const progApplied = await h.call(at, 'apply_routine_changes', { preview_id: prog.structuredContent.preview_id });
  assert.ok(!progApplied.isError, JSON.stringify(progApplied));
  const S = h.state('u_one');
  assert.deepEqual(S.routines.map(r => r.name), ['Push Day', 'Legs', 'Upper A', 'Lower A', 'Upper B', 'Lower B']);
  assert.equal(S.routines[2].ex[0].weight, 60);
  assert.deepEqual(S.week[1], [S.routines[2].id]);

  // Logging a past workout: previewed, saved once, undone.
  const wl = await h.call(at, 'preview_workout_log', { date: '2026-10-10', duration_min: 50, routine_id: 'r1', exercises: [{ exercise_id: '0025', sets: [{ reps: 5, weight: 60 }, { reps: 5, weight: 60 }] }] });
  assert.ok(!wl.isError, JSON.stringify(wl));
  const logged = await h.call(at, 'log_workout', { preview_id: wl.structuredContent.preview_id });
  const relog = await h.call(at, 'log_workout', { preview_id: wl.structuredContent.preview_id });
  assert.equal(relog.structuredContent.replayed, true);
  const ws = h.state('u_one').workouts;
  assert.equal(ws.length, 2);
  assert.deepEqual(ws.map(w => w.d), ['2026-10-01', '2026-10-10']);
  assert.deepEqual(ws[1].entries[0].sets, [{ w: 60, r: 5, done: true }, { w: 60, r: 5, done: true }]);
  const future = await h.call(at, 'preview_workout_log', { date: '2999-01-01', duration_min: 50, exercises: [{ exercise_id: '0025', sets: [{ reps: 5 }] }] });
  assert.equal(future.isError, true);
  await h.call(at, 'undo_change', { change_id: logged.structuredContent.change_id });
  assert.equal(h.state('u_one').workouts.length, 1);

  // Undo is about what the change touched: the program (other routines, the week) does not stand
  // in the way of undoing the removal in Push, but a later edit of Push does, until it is undone.
  const later = await h.call(at, 'preview_routine_changes', { operations: [{ op: 'update_exercise', routine_id: 'r1', exercise_id: '0025', reps: 6 }] });
  const laterApplied = await h.call(at, 'apply_routine_changes', { preview_id: later.structuredContent.preview_id });
  const refused = await h.call(at, 'undo_change', { change_id: done.structuredContent.change_id });
  assert.equal(refused.structuredContent.error, 'stale');
  assert.ok(!(await h.call(at, 'undo_change', { change_id: laterApplied.structuredContent.change_id })).isError);
  assert.ok(!(await h.call(at, 'undo_change', { change_id: done.structuredContent.change_id })).isError);
  assert.deepEqual(h.state('u_one').routines[0].ex.map(e => e.id), ['0025', '0289']);
  assert.equal(h.state('u_one').routines.length, 6, 'the program stays');
});

test('invalid operations are refused by Gymly\'s own validation, with nothing saved', async t => {
  const h = await startServer(t);
  const { tokens: { access_token: at } } = await connect(h);
  const bad = await h.call(at, 'preview_routine_changes', { operations: [
    { op: 'update_exercise', routine_id: 'r1', exercise_id: '9999', sets: 4 },
    { op: 'add_exercise', routine_id: 'r1', exercise_id: '0025' },
    { op: 'update_exercise', routine_id: 'rz', exercise_id: '0025', sets: 4 }
  ] });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.issues.length, 3);
  // Schema limits are enforced before any handler runs.
  const huge = await h.call(at, 'preview_routine_changes', { operations: [{ op: 'update_exercise', routine_id: 'r1', exercise_id: '0025', sets: 400 }] });
  assert.equal(huge.isError, true);
  const unknownOp = await h.call(at, 'preview_routine_changes', { operations: [{ op: 'replace_document', state: {} }] });
  assert.equal(unknownOp.isError, true);
  // Object keys are not exercises (review 4).
  for (const bad of ['__proto__', 'constructor', 'toString']) {
    const wl = await h.call(at, 'preview_workout_log', { date: '2026-10-10', duration_min: 30, exercises: [{ exercise_id: bad, sets: [{ reps: 5, weight: 100 }] }] });
    assert.equal(wl.isError, true, bad);
  }
  assert.equal(h.state('u_one')._rev, 3);
});

test('isolation: a connection reads and writes its own profile only, and a read-only one cannot write', async t => {
  const h = await startServer(t);
  const one = await connect(h);
  const two = await connect(h, { uid: 'u_two' });
  const r1 = await h.call(one.tokens.access_token, 'list_routines');
  const r2 = await h.call(two.tokens.access_token, 'list_routines');
  assert.doesNotMatch(JSON.stringify(r1), /TWO-SECRET-ROUTINE/);
  assert.match(JSON.stringify(r2), /TWO-SECRET-ROUTINE/);
  // A preview made on one connection is unknown to another.
  const pv = await h.call(one.tokens.access_token, 'preview_routine_changes', { operations: [{ op: 'update_exercise', routine_id: 'r1', exercise_id: '0025', sets: 4 }] });
  const stolen = await h.call(two.tokens.access_token, 'apply_routine_changes', { preview_id: pv.structuredContent.preview_id });
  assert.equal(stolen.structuredContent.error, 'not_found');
  // Another profile's routine id is just not there.
  const cross = await h.call(two.tokens.access_token, 'get_routine', { routine_id: 'r1' });
  assert.doesNotMatch(JSON.stringify(cross), /Push Day/);

  const ro = await connect(h, { allowWrite: false });
  assert.equal(ro.tokens.scope, 'gymly:read');
  const denied = await h.call(ro.tokens.access_token, 'preview_routine_changes', { operations: [{ op: 'update_exercise', routine_id: 'r1', exercise_id: '0025', sets: 4 }] });
  assert.equal(denied.structuredContent.error, 'insufficient_scope');
  assert.match(denied._meta['mcp/www_authenticate'][0], /error="insufficient_scope"/);
  assert.equal(h.state('u_one')._rev, 3);
});

test('only listed profiles can authorize; a declined consent sends access_denied', async t => {
  const h = await startServer(t);
  const client = await register(h);
  const p = pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', resource: RESOURCE });
  const off = await h.fetch('/api/oauth/authorize?' + q, { headers: cookie('u_off') });
  assert.equal(off.status, 403);
  // Not signed in: the sign-in page, not a consent.
  const anon = await (await h.fetch('/api/oauth/authorize?' + q)).text();
  assert.match(anon, /Sign in with a passkey/);
  assert.doesNotMatch(anon, /request_id/);

  const { location } = await consent(h, client, { decision: 'deny' });
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('iss'), ORIGIN);
  assert.equal(location.searchParams.get('state'), 'st-1');
});

test('the authorize endpoint never redirects to an unregistered address and insists on PKCE S256', async t => {
  const h = await startServer(t);
  const client = await register(h);
  const base = { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' };
  const go = q => h.fetch('/api/oauth/authorize?' + new URLSearchParams(q), { headers: cookie('u_one') });
  const evil = await go({ ...base, redirect_uri: 'https://evil.example/cb' });
  assert.equal(evil.status, 400);
  assert.equal(evil.headers.get('location'), null);
  assert.equal((await go({ ...base, client_id: 'nope' })).status, 400);
  // Even for a registered client, errors before consent are shown, not redirected: registration
  // is open, so the redirect URI is still the requester's choice (no open redirect).
  const plain = await go({ ...base, code_challenge_method: 'plain' });
  assert.equal(plain.status, 400);
  assert.equal(plain.headers.get('location'), null);
  assert.match(await plain.text(), /S256/);
  const otherResource = await go({ ...base, resource: 'https://other.example/mcp' });
  assert.equal(otherResource.status, 400);
  assert.equal(otherResource.headers.get('location'), null);
  // The consent screen cannot be framed and carries its own CSP.
  const page = await go(base);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  // The decision is a browser form: a cross-site post of it is refused.
  const html = await page.text();
  const reqId = /name="request_id" value="([^"]+)"/.exec(html)[1];
  const forged = await h.form('/api/oauth/authorize', { request_id: reqId, decision: 'allow' }, { ...cookie('u_one'), 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(forged.status, 403);
  // Another signed-in profile cannot answer someone else's consent screen.
  const other = await h.form('/api/oauth/authorize', { request_id: reqId, decision: 'allow' }, { ...cookie('u_two'), 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(other.status, 400);
});

test('codes are single-use and PKCE-bound; refresh tokens rotate and a replay ends the connection', async t => {
  const h = await startServer(t);
  const client = await register(h);
  const { location, p } = await consent(h, client);
  const code = location.searchParams.get('code');
  const wrongVerifier = await h.form('/api/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: pkce().verifier });
  assert.equal(wrongVerifier.status, 400);
  // The failed attempt spent the code.
  const late = await h.form('/api/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: p.verifier });
  assert.equal((await late.json()).error, 'invalid_grant');

  const { tokens } = await connect(h, { client });
  const r1 = await h.form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(r1.status, 200);
  const t1 = await r1.json();
  assert.notEqual(t1.refresh_token, tokens.refresh_token);
  assert.equal((await h.rpc(t1.access_token, 'tools/list')).status, 200);
  // Within the grace a retry of the spent token is refused without ending anything...
  const retry = await h.form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(retry.status, 400);
  assert.equal((await h.rpc(t1.access_token, 'tools/list')).status, 200);
  // ...a refresh token presented by another client ends the connection outright.
  const thief = await register(h, { client_name: 'Thief' });
  const stolen = await h.form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: thief.client_id });
  assert.equal(stolen.status, 400);
  assert.equal((await h.rpc(t1.access_token, 'tools/list')).status, 401);
  assert.match(fs.readFileSync(path.join(h.dataDir, 'audit.log'), 'utf8'), /auth\.mcp\.reuse/);
});

test('revocation, Settings disconnect and sign-out-everywhere end a connection at once', async t => {
  const h = await startServer(t);
  const a = await connect(h);
  const rv = await h.form('/api/oauth/revoke', { token: a.tokens.refresh_token, client_id: a.client.client_id });
  assert.equal(rv.status, 200);
  assert.equal((await h.rpc(a.tokens.access_token, 'tools/list')).status, 401);

  const b = await connect(h);
  const list = await (await h.fetch('/api/account/mcp-connections', { headers: cookie('u_one') })).json();
  assert.equal(list.connections.length, 1);
  assert.equal(list.connections[0].client, 'Test Client');
  assert.ok(!JSON.stringify(list).includes(b.tokens.access_token));
  // Another profile cannot disconnect it.
  assert.equal((await h.fetch('/api/account/mcp-connections?id=' + list.connections[0].id, { method: 'DELETE', headers: cookie('u_two') })).status, 404);
  const del = await h.fetch('/api/account/mcp-connections?id=' + list.connections[0].id, { method: 'DELETE', headers: { ...cookie('u_one'), 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(del.status, 200);
  assert.equal((await h.rpc(b.tokens.access_token, 'tools/list')).status, 401);

  const c = await connect(h);
  const out = await h.fetch('/api/logout/all', { method: 'POST', headers: { ...cookie('u_one'), 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(out.status, 200);
  assert.equal((await h.rpc(c.tokens.access_token, 'tools/list')).status, 401);
  const refresh = await h.form('/api/oauth/token', { grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.client.client_id });
  assert.equal(refresh.status, 400);
  assert.equal(h.db().mcpGrants.length, 0);
});

test('transport limits: foreign Origin, oversized body, batches, malformed JSON', async t => {
  const h = await startServer(t);
  const { tokens: { access_token: at } } = await connect(h);
  assert.equal((await h.rpc(at, 'tools/list', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.rpc(at, 'tools/list', {}, { Origin: ORIGIN })).status, 200);
  const big = await h.fetch('/api/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(300 * 1024) } }) });
  assert.equal(big.status, 413);
  const batch = await h.fetch('/api/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]' });
  assert.equal(batch.status, 400);
  const junk = await h.fetch('/api/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{nope' });
  assert.equal(junk.status, 400);
  // The access token opens nothing but /api/mcp.
  assert.equal((await h.fetch('/api/data', { headers: { Authorization: 'Bearer ' + at } })).status, 401);
  assert.equal((await h.fetch('/api/mcp/v1/state', { headers: { Authorization: 'Bearer ' + at } })).status, 401);
});

test('a device with unsynced edits merges with an assistant\'s change: both survive, as between two devices', async t => {
  const { mergeStates, stampChange, stampRoutines } = await import('../../frontend/src/lib/sync-merge.js');
  const h = await startServer(t);
  const { tokens: { access_token: at } } = await connect(h);

  // The phone pulls, then edits offline: a weigh-in, and a rename of the Legs routine.
  const pulled = await (await h.fetch('/api/data', { headers: cookie('u_one') })).json();
  const prev = structuredClone(pulled.state);
  const local = structuredClone(pulled.state);
  local.bodyweight = [...local.bodyweight, { d: '2026-10-20', w: 79.6, t: Date.now() }];
  local.routines[1].name = 'Legs (phone)';
  local.routines = stampRoutines(prev.routines, local.routines, Date.now());
  local._ts = stampChange(prev, local, Date.now());

  // Meanwhile the assistant changes Push on the server.
  const pv = await h.call(at, 'preview_routine_changes', { operations: [{ op: 'update_exercise', routine_id: 'r1', exercise_id: '0025', sets: 4, weight: 60 }] });
  assert.ok(!(await h.call(at, 'apply_routine_changes', { preview_id: pv.structuredContent.preview_id })).isError);

  // The phone's push over the revision it read is a conflict, as with another device...
  const json = { ...cookie('u_one'), 'Content-Type': 'application/json' };
  const first = await h.fetch('/api/data', { method: 'PUT', headers: json, body: JSON.stringify({ state: local, baseRev: pulled.rev, stamped: true }) });
  assert.equal(first.status, 409);
  const conflict = await first.json();
  // ...it merges with the app's own merge and pushes again.
  const merged = mergeStates(local, conflict.state);
  const second = await h.fetch('/api/data', { method: 'PUT', headers: json, body: JSON.stringify({ state: merged, baseRev: conflict.rev, stamped: true }) });
  assert.equal(second.status, 200, await second.clone().text());

  const S = h.state('u_one');
  assert.deepEqual(S.routines[0].ex[0], { ...S.routines[0].ex[0], id: '0025', sets: 4, weight: 60 }, 'the assistant\'s change survived the merge');
  assert.equal(S.routines[1].name, 'Legs (phone)', 'the phone\'s edit survived too');
  assert.ok(S.bodyweight.some(b => b.d === '2026-10-20' && b.w === 79.6));
  // The assistant's undo takes back its own change and nothing of the phone's.
  const changes = await h.call(at, 'list_recent_changes');
  const undo = await h.call(at, 'undo_change', { change_id: changes.structuredContent.changes[0].change_id });
  assert.ok(!undo.isError, JSON.stringify(undo));
  const U = h.state('u_one');
  assert.deepEqual(U.routines[0].ex[0], { ...U.routines[0].ex[0], sets: 3, weight: 55 });
  assert.equal(U.routines[1].name, 'Legs (phone)');
  assert.ok(U.bodyweight.some(b => b.d === '2026-10-20'));
  // A phone edit to the routine the assistant changed, though, does block its undo.
  const p2 = await h.call(at, 'preview_routine_changes', { operations: [{ op: 'update_exercise', routine_id: 'r2', exercise_id: '0043', sets: 5 }] });
  const a2 = await h.call(at, 'apply_routine_changes', { preview_id: p2.structuredContent.preview_id });
  const pull2 = await (await h.fetch('/api/data', { headers: cookie('u_one') })).json();
  const edit = structuredClone(pull2.state);
  edit.routines[1].ex[0].reps = 7;
  edit.routines = stampRoutines(pull2.state.routines, edit.routines, Date.now());
  assert.equal((await h.fetch('/api/data', { method: 'PUT', headers: json, body: JSON.stringify({ state: edit, baseRev: pull2.rev, stamped: true }) })).status, 200);
  const blocked = await h.call(at, 'undo_change', { change_id: a2.structuredContent.change_id });
  assert.equal(blocked.structuredContent.error, 'stale');
});
