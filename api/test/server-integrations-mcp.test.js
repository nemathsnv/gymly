/* A workout an assistant logs through the hosted MCP endpoint (api/mcp-remote) reaches the
 * profile's webhook like one a device syncs: both are written by commitState, which is where
 * the events are read off. The webhook is set up before the server starts, a day old, so the
 * workout (which the MCP tool only ever logs in the past) is newer than it. */
// net-guard.js reads ALLOWED_PRIVATE_IPS when it loads: the receiver is on 127.0.0.1.
process.env.ALLOWED_PRIVATE_IPS = '127.0.0.1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const { createIntegrations } = await import('../integrations/index.js');
const { verifySignature } = await import('../integrations/crypto.js');

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:8080';
const RESOURCE = ORIGIN + '/api/mcp';
const REDIRECT = 'http://127.0.0.1:53682/callback';
const mint = uid => { const p = `${uid}:${Date.now() + 86400000}:0`; return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); };
const cookie = uid => ({ Cookie: `gymsid=${mint(uid)}` });
const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

test('a workout logged by an assistant over the hosted MCP endpoint is delivered once', async t => {
  // The receiver.
  const got = [];
  const rx = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { got.push({ headers: req.headers, body: b }); res.writeHead(204).end(); }); });
  await new Promise(r => rx.listen(0, '127.0.0.1', r));
  t.after(() => rx.close());

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-int-mcp-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: 'u_one', name: 'One', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }));
  fs.writeFileSync(path.join(dataDir, 'state-u_one.json'), JSON.stringify({
    unit: 'kg', _rev: 1, _wid: 'wid-1', reminder: { tz: 'UTC' },
    routines: [{ id: 'r1', name: 'Push Day', ex: [{ id: '0025', sets: 3, reps: 5, weight: 55 }] }], workouts: [],
  }));
  const env = { INTEGRATIONS: 'webhook', INTEGRATIONS_ALLOW_LAN: '1' };
  const seed = createIntegrations({ dataDir, secret: SECRET, env, now: () => Date.now() - 86400000 });
  const { reveal } = seed.connect('u_one', 'webhook', { url: `http://127.0.0.1:${rx.address().port}/hook`, events: ['workout.finished'] });
  seed.stop();

  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', MCP_OAUTH_USERS: 'u_one', ...env }
  });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  t.after(() => child.kill('SIGKILL'));
  const api = `http://127.0.0.1:${await boundPort(child, () => log)}`;
  const f = (p, opts = {}) => fetch(api + p, { redirect: 'manual', ...opts });
  const form = (p, fields, headers = {}) => f(p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });

  // Connect an assistant: register, consent with write access, code for a token.
  const client = await (await f('/api/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Test', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) })).json();
  const p = pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', state: 's', scope: 'gymly:read gymly:write', resource: RESOURCE });
  const html = await (await f('/api/oauth/authorize?' + q, { headers: cookie('u_one') })).text();
  const reqId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(reqId, html.slice(0, 300));
  const back = await form('/api/oauth/authorize', { request_id: reqId, decision: 'allow', allow_write: '1' }, { ...cookie('u_one'), 'Sec-Fetch-Site': 'same-origin' });
  const code = new URL(back.headers.get('location')).searchParams.get('code');
  const tok = await (await form('/api/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: p.verifier, resource: RESOURCE })).json();
  assert.ok(tok.access_token, JSON.stringify(tok));
  let id = 0;
  const call = async (name, args) => {
    const r = await f('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', Authorization: 'Bearer ' + tok.access_token },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
    });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.ok(!body.result.isError, JSON.stringify(body.result));
    return body.result;
  };

  // A session that ended twenty minutes ago, logged after the fact.
  const start = new Date(Date.now() - 50 * 60000);
  const hhmm = start.toISOString().slice(11, 16);
  const pv = await call('preview_workout_log', { date: start.toISOString().slice(0, 10), start_time: hhmm, duration_min: 30, routine_id: 'r1', exercises: [{ exercise_id: '0025', sets: [{ reps: 5, weight: 60 }] }] });
  await call('log_workout', { preview_id: pv.structuredContent.preview_id });
  await call('log_workout', { preview_id: pv.structuredContent.preview_id });   // replayed: no second workout

  for (let i = 0; i < 50 && got.length < 1; i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(got.length, 1, log);
  assert.equal(got[0].headers['x-opengym-event'], 'workout.finished');
  assert.equal(verifySignature(reveal.secret, got[0].body, got[0].headers['x-opengym-signature']), true);
  const w = JSON.parse(got[0].body).data.workout;
  assert.equal(w.exercises[0].name, 'barbell bench press');
  assert.equal(w.durationMin, 30);
});
