/* MCP tokens end to end, real server.js in a child: making one with a session, reading the owner's
   data with it, and every way it must not work — another profile's data, a session route, an
   admin route, after revocation, after "sign out everywhere", after a disable. And that the token
   itself is written nowhere: not db.json, not the audit log, not the server's output. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { hashMcpToken } from '../mcp-access.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}
const cookie = (uid, sv) => ({ Cookie: `gymsid=${mintSession(uid, sv)}` });
const bearer = tok => ({ Authorization: `Bearer ${tok}` });

const now = new Date().toISOString();
const USERS = [
  { id: 'u_one', name: 'One', created: now, email: 'one@example.test', pw: { h: 'scrypt$secret-hash', set: now } },
  { id: 'u_two', name: 'Two', created: now },
  { id: 'u_admin', name: 'Boss', created: now, admin: true },
  { id: 'u_fresh', name: 'Fresh', created: now },
  { id: 'u_broken', name: 'Broken', created: now }
];
const STATE_ONE = {
  unit: 'kg', _rev: 3, _wid: 'wid-3', _ts: 1,
  routines: [{ id: 'r1', name: 'Push Day', ex: [{ id: '0025', sets: 3, reps: 8, weight: 60 }] }],
  workouts: [{ id: 'w1', d: '2026-10-01', name: 'Push Day', entries: [{ id: '0025', sets: [{ w: 60, r: 8, done: true }] }] }],
  bodyweight: [{ d: '2026-10-01', w: 80.4 }],
  gymCards: [{ id: 'card1', name: 'My gym', code: 'MEMBER-998877' }], lastGymCardId: 'card1',
  coach: { consent: { agreedAt: now, version: 1 }, pending: { summary: 'COACH-PRIVATE' } },
  reminder: { on: true, time: '07:00', tz: 'Europe/Lisbon' }, hints: { swipeSets: true },
  _unstamped: { x: 1 }, _prior: { y: 2 }, _wids: ['wid-1', 'wid-2']
};
const STATE_TWO = { unit: 'lb', routines: [{ id: 'r2', name: 'TWO-SECRET-ROUTINE' }], workouts: [], _rev: 1 };

async function startServer(t, editDb = () => {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-mcp-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const db = { users: structuredClone(USERS), creds: [], subs: [], invites: [] };
  editDb(db);
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(db));
  fs.writeFileSync(path.join(dataDir, 'state-u_one.json'), JSON.stringify(STATE_ONE));
  fs.writeFileSync(path.join(dataDir, 'state-u_two.json'), JSON.stringify(STATE_TWO));
  fs.writeFileSync(path.join(dataDir, 'state-u_broken.json'), '{"routines": [');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', AUDIT_LOG: '1' }
  });
  const h = { api: '', log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  h.req = (method, p, headers = {}, body) => fetch(h.api + p, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  h.mint = async (uid, body = { name: 'Claude Code' }, sv = 0) => {
    const r = await h.req('POST', '/api/account/mcp-tokens', cookie(uid, sv), body);
    assert.equal(r.status, 201, await r.clone().text());
    return r.json();
  };
  h.state = (tok, extra = {}) => h.req('GET', '/api/mcp/v1/state', { ...bearer(tok), ...extra });
  h.files = () => ['db.json', 'db.json.bak', 'audit.log'].map(f => { try { return fs.readFileSync(path.join(dataDir, f), 'utf8'); } catch { return ''; } }).join('\n');
  return h;
}

test('a session makes a token; the token reads its owner\'s data and only that', async t => {
  const h = await startServer(t);

  // No session, no token.
  assert.equal((await h.req('POST', '/api/account/mcp-tokens', {}, {})).status, 401);
  assert.equal((await h.req('GET', '/api/account/mcp-tokens')).status, 401);

  const made = await h.mint('u_one', { name: 'Claude Code', days: 30 });
  assert.match(made.token, /^gymly_mcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(made.scope, 'read');
  assert.equal(made.name, 'Claude Code');
  assert.equal(made.hint, made.token.slice(-4));
  assert.ok(Math.abs(made.exp - made.created - 30 * 86400000) < 1000);

  // The list never carries the token or its hash.
  const list = await (await h.req('GET', '/api/account/mcp-tokens', cookie('u_one'))).json();
  assert.equal(list.max, 10);
  assert.equal(list.tokens.length, 1);
  assert.ok(!JSON.stringify(list).includes(made.token));
  assert.ok(!('h' in list.tokens[0]));
  // Another profile sees none of them.
  assert.deepEqual((await (await h.req('GET', '/api/account/mcp-tokens', cookie('u_two'))).json()).tokens, []);

  const r = await h.state(made.token);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.json();
  assert.deepEqual(body.user, { id: 'u_one', name: 'One', created: now });
  assert.equal(body.scope, 'read');
  assert.equal(body.rev, 3);
  assert.deepEqual(body.state.routines, STATE_ONE.routines);
  assert.deepEqual(body.state.workouts, STATE_ONE.workouts);
  assert.deepEqual(body.state.bodyweight, STATE_ONE.bodyweight);
  for (const k of ['gymCards', 'lastGymCardId', 'coach', 'reminder', 'hints', '_unstamped', '_prior', '_wids', '_wid']) assert.ok(!(k in body.state), k);
  const text = JSON.stringify(body);
  for (const leak of ['MEMBER-998877', 'COACH-PRIVATE', 'one@example.test', 'scrypt', 'TWO-SECRET-ROUTINE', 'u_two', 'Europe/Lisbon']) {
    assert.ok(!text.includes(leak), `response leaks ${leak}`);
  }

  // No parameter picks another profile.
  for (const q of ['?uid=u_two', '?user=u_two', '?id=u_two']) {
    const other = await (await h.req('GET', '/api/mcp/v1/state' + q, bearer(made.token))).json();
    assert.equal(other.user.id, 'u_one', q);
  }

  // Conditional read: unchanged answers 304 with no body.
  const etag = r.headers.get('etag');
  assert.ok(etag);
  const again = await h.state(made.token, { 'If-None-Match': etag });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), '');
  assert.equal((await h.state(made.token, { 'If-None-Match': '"m1-2-x"' })).status, 200);
  // Behind the bundled nginx the tag reaches the client weak (gzip), and comes back that way.
  assert.equal((await h.state(made.token, { 'If-None-Match': 'W/' + etag })).status, 304);
  assert.equal((await h.state(made.token, { 'If-None-Match': `"other", W/${etag}` })).status, 304);
  assert.equal((await h.state(made.token, { 'If-None-Match': 'W/"m1-2-x"' })).status, 200);
  // A conditional request is still a request: a wrong token gets 401, never 304.
  assert.equal((await h.state('gymly_mcp_' + 'B'.repeat(43), { 'If-None-Match': '*' })).status, 401);

  // A profile with no document yet: an honest null, not someone else's.
  const freshTok = (await h.mint('u_fresh')).token;
  const fresh = await (await h.state(freshTok)).json();
  assert.equal(fresh.state, null);
  assert.equal(fresh.user.id, 'u_fresh');
  // A document that cannot be read: 503, not an empty profile.
  const brokenTok = (await h.mint('u_broken')).token;
  assert.equal((await h.state(brokenTok)).status, 503);

  // The token is written nowhere: only its hash is in db.json, the audit log names it by name.
  const files = h.files();
  for (const tok of [made.token, freshTok, brokenTok]) {
    assert.ok(!files.includes(tok), 'a token reached the data directory');
    assert.ok(!files.includes(tok.slice('gymly_mcp_'.length)));
    assert.ok(!h.log.includes(tok), 'a token reached the server log');
  }
  const db = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8'));
  assert.equal(db.mcpTokens.length, 3);
  assert.match(db.mcpTokens[0].h, /^[0-9a-f]{64}$/);
  assert.match(fs.readFileSync(path.join(h.dataDir, 'audit.log'), 'utf8'), /"ev":"auth\.mcp\.create".*"msg":"Claude Code"/);
});

test('an MCP token opens the MCP route and nothing else; nothing else opens the MCP route', async t => {
  const h = await startServer(t);
  const { token } = await h.mint('u_one');
  const adminTok = (await h.mint('u_admin')).token;

  // Not a session anywhere: reading, writing, the account, minting more tokens, the admin routes.
  const refusals = [
    ['GET', '/api/data'], ['GET', '/api/data/rev'], ['GET', '/api/me'],
    ['PUT', '/api/data', { state: { unit: 'kg', routines: [], workouts: [] } }],
    ['GET', '/api/account/mcp-tokens'], ['POST', '/api/account/mcp-tokens', {}],
    ['POST', '/api/logout/all', {}], ['POST', '/api/pair/create', {}],
    ['GET', '/api/account/passkeys']
  ];
  for (const [m, p, b] of refusals) {
    const r = await h.req(m, p, bearer(token), b);
    assert.equal(r.status, 401, `${m} ${p} took an MCP token`);
  }
  // An admin's MCP token carries no admin rights.
  for (const p of ['/api/admin/users', '/api/admin/audit', '/api/admin/user?id=u_two']) {
    assert.equal((await h.req('GET', p, bearer(adminTok))).status, 401, p);
  }
  // The data on disk did not move.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'state-u_one.json'), 'utf8')).routines, STATE_ONE.routines);

  // The MCP route takes nothing but an MCP token in the Authorization header.
  const refused = async (headers, p = '/api/mcp/v1/state') => {
    const r = await h.req('GET', p, headers);
    assert.equal(r.status, 401, JSON.stringify(headers) + ' ' + p);
    assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="gymly-mcp"');
    assert.deepEqual(await r.json(), { error: 'the MCP token is missing, wrong, expired or revoked', code: 'mcp-token-invalid' });
  };
  await refused({});
  await refused(cookie('u_one'));                                   // a browser session
  await refused(bearer(mintSession('u_one')));                      // a paired phone's session token
  await refused(bearer('gymly_mcp_' + 'A'.repeat(43)));             // well-formed, never issued
  await refused(bearer(token.slice(0, -1)));                        // truncated
  await refused(bearer(token + 'A'));                               // extended
  await refused({ Authorization: token });                          // no scheme
  await refused({ Authorization: 'Basic ' + Buffer.from('x:' + token).toString('base64') });
  await refused({}, '/api/mcp/v1/state?token=' + token);           // never from the query string
  await refused({}, '/api/mcp/v1/state?access_token=' + token);
  assert.equal((await h.req('GET', '/api/mcp/v1/other', bearer(token))).status, 404);
  // The token itself does not show up in a refusal's audit row or the log.
  assert.ok(!h.files().includes(token) && !h.log.includes(token));
  assert.match(fs.readFileSync(path.join(h.dataDir, 'audit.log'), 'utf8'), /"ev":"auth\.mcp\.fail".*"msg":"token-invalid"/);
});

test('bad requests to make a token are refused with a reason, and there is a ceiling', async t => {
  const h = await startServer(t);
  for (const body of [{ name: 5 }, { name: 'x'.repeat(61) }, { days: 0 }, { days: 366 }, { days: 1.5 }, { days: '30' }]) {
    const r = await h.req('POST', '/api/account/mcp-tokens', cookie('u_two'), body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match((await r.json()).code, /^mcp-token-(name|days)$/);
  }
  // Not JSON at all.
  const junk = await fetch(h.api + '/api/account/mcp-tokens', { method: 'POST', headers: { ...cookie('u_two'), 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(junk.status, 400);
  assert.equal((await (await h.req('GET', '/api/account/mcp-tokens', cookie('u_two'))).json()).tokens.length, 0, 'nothing was made');

  for (let i = 0; i < 10; i++) await h.mint('u_two', { name: 'n' + i });
  const over = await h.req('POST', '/api/account/mcp-tokens', cookie('u_two'), { name: 'eleventh' });
  assert.equal(over.status, 409);
  assert.equal((await over.json()).code, 'mcp-token-limit');
});

test('a token stops working when revoked, on "sign out everywhere", and on a disable', async t => {
  const h = await startServer(t);

  // Revoke: only its owner can, and it is dead on the next request.
  const a = await h.mint('u_one', { name: 'a' });
  const b = await h.mint('u_one', { name: 'b' });
  assert.equal((await h.req('DELETE', '/api/account/mcp-tokens?id=' + a.id, cookie('u_two'))).status, 404, 'not another profile');
  assert.equal((await h.req('DELETE', '/api/account/mcp-tokens?id=' + a.id)).status, 401, 'not without a session');
  assert.equal((await h.req('DELETE', '/api/account/mcp-tokens?id=' + a.id, bearer(b.token))).status, 401, 'not with an MCP token');
  assert.equal((await h.state(a.token)).status, 200);
  const del = await h.req('DELETE', '/api/account/mcp-tokens?id=' + a.id, cookie('u_one'));
  assert.equal(del.status, 200);
  assert.deepEqual((await del.json()).tokens.map(x => x.name), ['b']);
  assert.equal((await h.state(a.token)).status, 401);
  assert.equal((await h.req('DELETE', '/api/account/mcp-tokens?id=' + a.id, cookie('u_one'))).status, 404, 'only once');
  assert.equal((await h.req('DELETE', '/api/account/mcp-tokens', cookie('u_one'))).status, 404, 'no id');
  assert.equal((await h.state(b.token)).status, 200, 'the other one is untouched');

  // "Sign out everywhere" ends every token of the profile, and a new session's token works.
  const two = await h.mint('u_two');
  assert.equal((await h.req('POST', '/api/logout/all', cookie('u_one'), {})).status, 200);
  assert.equal((await h.state(b.token)).status, 401);
  assert.equal((await h.state(two.token)).status, 200, 'another profile is untouched');
  const after = await h.mint('u_one', { name: 'after' }, 1);
  assert.equal((await h.state(after.token)).status, 200);

  // Disable: refused at once, and lifting the disable does not bring it back.
  const dis = await h.req('POST', '/api/admin/user/disable', cookie('u_admin'), { id: 'u_two', disabled: true });
  assert.equal(dis.status, 200);
  assert.equal((await h.state(two.token)).status, 401);
  await h.req('POST', '/api/admin/user/disable', cookie('u_admin'), { id: 'u_two', disabled: false });
  assert.equal((await h.state(two.token)).status, 401);

  // Delete: gone with the profile.
  const del2 = await h.req('POST', '/api/admin/user/delete', cookie('u_admin'), { id: 'u_one' });
  assert.equal(del2.status, 200);
  assert.equal((await h.state(after.token)).status, 401);
  const db = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8'));
  assert.deepEqual(db.mcpTokens, []);

  const audit = fs.readFileSync(path.join(h.dataDir, 'audit.log'), 'utf8');
  assert.match(audit, /"ev":"auth\.mcp\.revoke".*"msg":"a"/);
});

// A request that starts before "sign out everywhere" and finishes its body after it must not come
// back with a token: the sign-out has already dropped the profile's tokens and moved its session
// version, and a token minted at the end would be stamped with the new version and live on.
function slowCreate(h, uid) {
  const body = JSON.stringify({ name: 'slow' });
  let finish;
  const done = new Promise((resolve, reject) => {
    const req = http.request(h.api + '/api/account/mcp-tokens', {
      method: 'POST', headers: { ...cookie(uid), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let t = ''; res.on('data', d => t += d); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
    req.on('error', reject);
    req.write(body.slice(0, 5));
    finish = () => req.end(body.slice(5));
  });
  return { done, finish: () => finish() };
}

test('a token request still in flight when the account signs out everywhere, or is disabled, gets no token', async t => {
  const h = await startServer(t);
  const slow = slowCreate(h, 'u_one');
  await new Promise(r => setTimeout(r, 100));          // the server is now waiting on the body
  assert.equal((await h.req('POST', '/api/logout/all', cookie('u_one'), {})).status, 200);
  slow.finish();
  const r = await slow.done;
  assert.equal(r.status, 401, r.text);
  assert.ok(!r.text.includes('gymly_mcp_'));
  const db = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'db.json'), 'utf8'));
  assert.deepEqual(db.mcpTokens || [], []);

  const slow2 = slowCreate(h, 'u_two');
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await h.req('POST', '/api/admin/user/disable', cookie('u_admin'), { id: 'u_two', disabled: true })).status, 200);
  slow2.finish();
  assert.equal((await slow2.done).status, 401);
});

test('making and revoking tokens is rate-limited per address', async t => {
  const h = await startServer(t);
  let last;
  for (let i = 0; i < 61; i++) last = await h.req('POST', '/api/account/mcp-tokens', cookie('u_two'), { name: 'n' + i });
  assert.equal(last.status, 429);
  assert.ok(+last.headers.get('retry-after') > 0);
  assert.equal((await h.req('DELETE', '/api/account/mcp-tokens?id=x', cookie('u_two'))).status, 429, 'the same budget');
});

test('a surviving record is still refused: older session version, disabled profile, missing profile', async t => {
  // Every path that bumps a profile's session version also drops its tokens; this is the second
  // line behind that. Seeded straight into db.json, since no route leaves such a record behind.
  const stale = 'gymly_mcp_' + crypto.randomBytes(32).toString('base64url');
  const live = 'gymly_mcp_' + crypto.randomBytes(32).toString('base64url');
  const rec = (tok, sv, id) => ({ id, h: hashMcpToken(tok), userId: 'u_sv', name: id, scope: 'read', sv, created: Date.now(), exp: Date.now() + 86400000, lastUsed: null, hint: tok.slice(-4) });
  const locked = 'gymly_mcp_' + crypto.randomBytes(32).toString('base64url');
  const orphan = 'gymly_mcp_' + crypto.randomBytes(32).toString('base64url');
  const h = await startServer(t, db => {
    db.users.push({ id: 'u_sv', name: 'Versioned', created: now, sv: 1 });
    db.users.push({ id: 'u_locked', name: 'Locked', created: now, disabled: true });
    db.mcpTokens = [
      rec(stale, 0, 'stale'), rec(live, 1, 'live'),
      { ...rec(locked, 0, 'locked'), userId: 'u_locked' },   // a disabled profile's
      { ...rec(orphan, 0, 'orphan'), userId: 'u_gone' }      // a profile that is not there
    ];
  });
  assert.equal((await h.state(stale)).status, 401);
  // …and it is neither listed as live nor holding one of the ten slots.
  const listed = await (await h.req('GET', '/api/account/mcp-tokens', cookie('u_sv', 1))).json();
  assert.deepEqual(listed.tokens.map(x => x.id), ['live']);
  assert.equal((await h.state(locked)).status, 401);
  assert.equal((await h.state(orphan)).status, 401);
  assert.equal((await h.state(live)).status, 200);
});
