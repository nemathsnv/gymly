/* mcp-remote/oauth.js on its own, with a clock the test moves: what expires when, what a replayed
   refresh token does after the grace, what a profile taken off MCP_OAUTH_USERS or signed out
   everywhere keeps (nothing), and which redirect URIs and client metadata documents pass. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createOAuth, validRedirectUri, redirectUriMatches, validMetadataUrl, cleanText, bearerChallenge,
  ACCESS_TTL_S, CODE_TTL_MS, REUSE_GRACE_MS, DCR_UNUSED_MS, MAX_GRANT_DAYS
} from '../mcp-remote/oauth.js';

const ISSUER = 'https://gym.example';
const RESOURCE = ISSUER + '/api/mcp';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

function setup({ docs = {} } = {}) {
  let t = 1_800_000_000_000;
  const db = { users: [{ id: 'u1', name: 'One', sv: 0 }, { id: 'u2', name: 'Two' }] };
  const allowed = new Set(['u1', 'u2']);
  let saves = 0;
  const fetched = [];
  const o = createOAuth({
    getDb: () => db, save: () => { saves++; },
    findUser: id => db.users.find(u => u.id === id) || null,
    allowed: u => allowed.has(u.id) && !u.disabled,
    sessionVersion: u => u.sv || 0,
    fetchMetadata: async url => { fetched.push(url); if (!(url in docs)) throw new Error('404'); return docs[url]; },
    config: { issuer: ISSUER, resource: RESOURCE },
    now: () => t
  });
  const pkce = () => { const v = crypto.randomBytes(32).toString('base64url'); return { v, c: crypto.createHash('sha256').update(v).digest('base64url') }; };
  const q = obj => new URLSearchParams(obj);
  async function code(clientId, { user = db.users[0], scope = 'gymly:read gymly:write', write = true, redirect = REDIRECT } = {}) {
    const p = pkce();
    const chk = await o.checkAuthorize(q({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: p.c, code_challenge_method: 'S256', scope, resource: RESOURCE, state: 's' }));
    assert.ok(chk.ok, JSON.stringify(chk));
    const id = o.openRequest(user, chk.client, chk.params);
    const d = o.decide(user, id, { allow: true, allowWrite: write });
    return { code: new URL(d.redirect).searchParams.get('code'), p, redirect: d.redirect };
  }
  async function connect(clientId, opts = {}) {
    const c = await code(clientId, opts);
    const r = await o.token(q({ grant_type: 'authorization_code', code: c.code, redirect_uri: opts.redirect || REDIRECT, client_id: clientId, code_verifier: c.p.v }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }
  return { o, db, allowed, fetched, tick: ms => { t += ms; }, code, connect, q, saves: () => saves };
}

const DOC_URL = 'https://chatgpt.com/oauth/client.json';
const DOC = { client_id: DOC_URL, client_name: 'ChatGPT', redirect_uris: [REDIRECT] };

test('a CIMD client (ChatGPT\'s shape) connects with PKCE alone, and the code carries iss', async () => {
  const s = setup({ docs: { [DOC_URL]: DOC } });
  const c = await s.code(DOC_URL);
  const u = new URL(c.redirect);
  assert.equal(u.origin + u.pathname, REDIRECT);
  assert.equal(u.searchParams.get('iss'), ISSUER);
  assert.equal(u.searchParams.get('state'), 's');
  const tok = await s.connect(DOC_URL);
  assert.equal(tok.token_type, 'Bearer');
  assert.equal(s.o.resolve(tok.access_token).user.id, 'u1');
  // The client is verified by its host, and a metadata document is fetched once, then cached.
  assert.equal(s.fetched.length, 1);
  assert.equal((await s.o.clientFor(DOC_URL)).verified, true);
});

test('metadata documents: must name themselves, list valid redirects and come from a plain https URL', async () => {
  const bad = {
    'https://a.example/c.json': { ...DOC, client_id: 'https://other.example/c.json' },
    'https://b.example/c.json': { client_id: 'https://b.example/c.json', client_name: 'X', redirect_uris: ['javascript:alert(1)'] },
    'https://c.example/c.json': { client_id: 'https://c.example/c.json', redirect_uris: [REDIRECT] }
  };
  const s = setup({ docs: bad });
  for (const url of Object.keys(bad)) assert.equal(await s.o.clientFor(url), null, url);
  for (const url of ['http://a.example/c.json', 'https://a.example/', 'https://10.0.0.1/c.json', 'https://[::1]/c.json', 'https://u:p@a.example/c.json', 'https://a.example:8443/c.json']) {
    assert.equal(validMetadataUrl(url), false, url);
  }
  // A failing document is not fetched again at once.
  const before = s.fetched.length;
  await s.o.clientFor('https://a.example/c.json');
  assert.equal(s.fetched.length, before);
  assert.equal(cleanText('Evil‮resU\u0000 name'), 'EvilresU name');
});

test('redirect URIs: https, loopback http on any port, app schemes; never javascript:, fragments or lookalikes', () => {
  for (const ok of ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:1234/cb', 'http://localhost/cb', 'com.example.app:/cb']) assert.ok(validRedirectUri(ok), ok);
  for (const no of ['javascript:alert(1)', 'data:text/html,x', 'http://example.com/cb', 'https://a.example/cb#x', 'https://u:p@a.example/cb', 'file:///etc/passwd', '']) assert.ok(!validRedirectUri(no), no);
  assert.ok(redirectUriMatches(['http://127.0.0.1:1/cb'], 'http://127.0.0.1:5555/cb'));
  assert.ok(!redirectUriMatches(['http://127.0.0.1:1/cb'], 'http://127.0.0.1:5555/other'));
  assert.ok(!redirectUriMatches(['https://claude.ai/cb'], 'https://claude.ai.evil.example/cb'));
  assert.ok(!redirectUriMatches(['https://claude.ai/cb'], 'https://claude.ai/cb/'));
});

test('dynamic registration: public and confidential clients, refused metadata, unused clients expire', async () => {
  const s = setup();
  const pub = s.o.register({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' });
  assert.equal(pub.status, 201);
  assert.equal(pub.body.client_secret, undefined);
  const conf = s.o.register({ client_name: 'Conf', redirect_uris: [REDIRECT] });
  assert.equal(conf.body.token_endpoint_auth_method, 'client_secret_basic');
  assert.match(conf.body.client_secret, /^gymly_ocs_/);
  assert.ok(!JSON.stringify(s.db.mcpClients).includes(conf.body.client_secret));
  assert.equal(s.o.register({ redirect_uris: ['http://evil.example/cb'] }).status, 400);
  assert.equal(s.o.register({ redirect_uris: [REDIRECT], grant_types: ['client_credentials'] }).status, 400);
  assert.equal(s.o.register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' }).status, 400);

  // A confidential client needs its secret, Basic or post.
  const c = await s.code(conf.body.client_id);
  const noSecret = await s.o.token(s.q({ grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, client_id: conf.body.client_id, code_verifier: c.p.v }));
  assert.equal(noSecret.status, 401);
  const c2 = await s.code(conf.body.client_id);
  const basic = 'Basic ' + Buffer.from(`${conf.body.client_id}:${conf.body.client_secret}`).toString('base64');
  const ok = await s.o.token(s.q({ grant_type: 'authorization_code', code: c2.code, redirect_uri: REDIRECT, code_verifier: c2.p.v }), basic);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  // Unused for a day, a registration is gone; a used one lives on.
  s.tick(DCR_UNUSED_MS + 1);
  assert.equal(await s.o.clientFor(pub.body.client_id), null);
  assert.ok(await s.o.clientFor(conf.body.client_id));
});

test('lifetimes: a code lasts five minutes, an access token an hour, a grant at most MAX_GRANT_DAYS', async () => {
  const s = setup();
  const cl = s.o.register({ client_name: 'C', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }).body;
  const c = await s.code(cl.client_id);
  s.tick(CODE_TTL_MS + 1);
  const late = await s.o.token(s.q({ grant_type: 'authorization_code', code: c.code, redirect_uri: REDIRECT, client_id: cl.client_id, code_verifier: c.p.v }));
  assert.equal(late.body.error, 'invalid_grant');

  const tok = await s.connect(cl.client_id);
  s.tick(ACCESS_TTL_S * 1000 - 1000);
  assert.ok(s.o.resolve(tok.access_token).user);
  s.tick(2000);
  assert.equal(s.o.resolve(tok.access_token).error, 'invalid_token');
  // Refreshing keeps it going, but never past the grant's own end.
  let rt = tok.refresh_token;
  for (let i = 0; i < MAX_GRANT_DAYS / 20; i++) {
    s.tick(20 * 86400000);
    const r = await s.o.token(s.q({ grant_type: 'refresh_token', refresh_token: rt, client_id: cl.client_id }));
    if (r.status !== 200) { assert.ok(i >= MAX_GRANT_DAYS / 20 - 1, `refused early at ${i}`); return; }
    rt = r.body.refresh_token;
  }
  s.tick(20 * 86400000);
  const end = await s.o.token(s.q({ grant_type: 'refresh_token', refresh_token: rt, client_id: cl.client_id }));
  assert.equal(end.status, 400);
});

test('refresh replay: within the grace a plain refusal, after it the whole connection ends', async () => {
  const s = setup();
  const cl = s.o.register({ client_name: 'C', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }).body;
  const tok = await s.connect(cl.client_id);
  const r1 = await s.o.token(s.q({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: cl.client_id }));
  assert.equal(r1.status, 200);
  const retry = await s.o.token(s.q({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: cl.client_id }));
  assert.equal(retry.status, 400);
  assert.ok(s.o.resolve(r1.body.access_token).user, 'the grace keeps the connection');
  s.tick(REUSE_GRACE_MS + 1);
  const replay = await s.o.token(s.q({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: cl.client_id }));
  assert.equal(replay.status, 400);
  assert.equal(replay.event.kind, 'reuse');
  assert.equal(s.o.resolve(r1.body.access_token).error, 'invalid_token');
  const newer = await s.o.token(s.q({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: cl.client_id }));
  assert.equal(newer.status, 400, 'the newer refresh token died with the connection');
  assert.equal(s.db.mcpGrants.length, 0);
});

test('a refresh cannot widen scopes; a read-only consent never yields write', async () => {
  const s = setup();
  const cl = s.o.register({ client_name: 'C', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }).body;
  const tok = await s.connect(cl.client_id, { write: false });
  assert.equal(tok.scope, 'gymly:read');
  const wider = await s.o.token(s.q({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: cl.client_id, scope: 'gymly:read gymly:write' }));
  assert.equal(wider.body.error, 'invalid_scope');
});

test('off the list, signed out everywhere, disabled or deleted: the connection is refused and cleared', async () => {
  for (const end of [
    s => s.allowed.delete('u1'),
    s => { s.db.users[0].sv = 1; },
    s => { s.db.users[0].disabled = true; },
    s => { s.db.users = s.db.users.filter(u => u.id !== 'u1'); }
  ]) {
    const s = setup();
    const cl = s.o.register({ client_name: 'C', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }).body;
    const tok = await s.connect(cl.client_id);
    end(s);
    assert.equal(s.o.resolve(tok.access_token).error, 'invalid_token');
    assert.equal(s.db.mcpGrants.length, 0);
    const r = await s.o.token(s.q({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: cl.client_id }));
    assert.equal(r.status, 400);
  }
  // Consent is refused outright for someone not on the list.
  const s = setup();
  s.allowed.clear();
  const cl = s.o.register({ client_name: 'C', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }).body;
  const p = crypto.randomBytes(32).toString('base64url');
  const chk = await s.o.checkAuthorize(s.q({ response_type: 'code', client_id: cl.client_id, redirect_uri: REDIRECT, code_challenge: crypto.createHash('sha256').update(p).digest('base64url'), code_challenge_method: 'S256' }));
  const id = s.o.openRequest(s.db.users[0], chk.client, chk.params);
  assert.equal(s.o.decide(s.db.users[0], id, { allow: true }).page, 'not_available');
});

test('a consent screen is answered once, by the person it was shown to; a sign-out between issues nothing', async () => {
  const s = setup();
  const cl = s.o.register({ client_name: 'C', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }).body;
  const p = crypto.randomBytes(32).toString('base64url');
  const chk = await s.o.checkAuthorize(s.q({ response_type: 'code', client_id: cl.client_id, redirect_uri: REDIRECT, code_challenge: crypto.createHash('sha256').update(p).digest('base64url'), code_challenge_method: 'S256' }));
  const id = s.o.openRequest(s.db.users[0], chk.client, chk.params);
  assert.equal(s.o.decide(s.db.users[1], id, { allow: true }).page, 'expired', 'another profile');
  const d = s.o.decide(s.db.users[0], id, { allow: true });
  assert.ok(d.redirect);
  assert.equal(s.o.decide(s.db.users[0], id, { allow: true }).page, 'expired', 'twice');
  // Signed out everywhere after consent, before the exchange: the code is worthless.
  s.db.users[0].sv = 5;
  const r = await s.o.token(s.q({ grant_type: 'authorization_code', code: new URL(d.redirect).searchParams.get('code'), redirect_uri: REDIRECT, client_id: cl.client_id, code_verifier: p }));
  assert.equal(r.body.error, 'invalid_grant');
});

test('revocation needs the owning client; tokens are stored only as hashes', async () => {
  const s = setup();
  const a = s.o.register({ client_name: 'A', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }).body;
  const b = s.o.register({ client_name: 'B', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }).body;
  const tok = await s.connect(a.client_id);
  const stored = JSON.stringify(s.db);
  for (const v of [tok.access_token, tok.refresh_token]) assert.ok(!stored.includes(v));
  const other = await s.o.revoke(s.q({ token: tok.access_token, client_id: b.client_id }));
  assert.equal(other.status, 200);
  assert.ok(s.o.resolve(tok.access_token).user, 'another client cannot revoke it');
  await s.o.revoke(s.q({ token: tok.access_token, client_id: a.client_id }));
  assert.equal(s.o.resolve(tok.access_token).error, 'invalid_token');
});

test('the challenge names the resource metadata and strips quotes from the description', () => {
  const c = bearerChallenge({ issuer: ISSUER, resource: RESOURCE }, 'invalid_token', 'say "hi"\\');
  assert.equal(c, `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp", scope="gymly:read gymly:write", error="invalid_token", error_description="say hi"`);
});
