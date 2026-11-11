/* The Oura OAuth pieces on their own: configuration, PKCE, the authorize URL, the code and refresh
   exchanges against a fake that keeps Oura's single-use rules, error classes, revocation, and the
   encrypted token store. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ouraConfig, pkcePair, newState, authorizeUrl, exchangeCode, refreshTokens, revokeToken, parseTokenResponse, OuraError, DEFAULT_SCOPES } from '../oura/oauth.js';
import { createOuraStore, deriveKey } from '../oura/store.js';
import { fakeOura, CFG } from './oura-fake.mjs';

test('configuration: off without both credentials, redirect URI from ORIGIN, scopes filtered', () => {
  assert.equal(ouraConfig({}, { origin: 'https://gym.example' }), null);
  assert.equal(ouraConfig({ OURA_CLIENT_ID: 'x' }, { origin: 'https://gym.example' }), null);
  assert.equal(ouraConfig({ OURA_CLIENT_SECRET: 'y' }, { origin: 'https://gym.example' }), null);
  const c = ouraConfig({ OURA_CLIENT_ID: ' cid ', OURA_CLIENT_SECRET: 'csecret' }, { origin: 'https://gym.example/', version: '1.4.1' });
  assert.equal(c.clientId, 'cid');
  assert.equal(c.redirectUri, 'https://gym.example/api/integrations/oura/callback');
  assert.deepEqual(c.scopes, DEFAULT_SCOPES);
  assert.ok(!c.scopes.includes('email') && !c.scopes.includes('personal'), 'no email or personal scope by default');
  assert.match(c.userAgent, /^Gymly\/1\.4\.1 /);
  const o = ouraConfig({ OURA_CLIENT_ID: 'a', OURA_CLIENT_SECRET: 'b', OURA_SCOPES: 'daily, bogus workout', OURA_REDIRECT_URI: 'https://x.example/gym/api/integrations/oura/callback' }, { origin: 'https://x.example' });
  assert.deepEqual(o.scopes, ['daily', 'workout']);
  assert.equal(o.redirectUri, 'https://x.example/gym/api/integrations/oura/callback');
});

test('PKCE: a 43–128 character verifier and its S256 challenge; states are long and unique', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(pkcePair().verifier, verifier);
  const s = newState();
  assert.ok(s.length >= 40);
  assert.notEqual(newState(), s);
});

test('the authorize URL carries code flow, client, exact redirect, scopes, state and S256 challenge', () => {
  const u = new URL(authorizeUrl(CFG, { state: 'st', challenge: 'ch' }));
  assert.equal(u.origin + u.pathname, 'https://cloud.ouraring.com/oauth/authorize');
  const q = Object.fromEntries(u.searchParams);
  assert.deepEqual(q, {
    response_type: 'code', client_id: 'cid', redirect_uri: CFG.redirectUri,
    scope: 'daily heartrate workout spo2 heart_health', state: 'st', code_challenge: 'ch', code_challenge_method: 'S256',
  });
  assert.ok(!u.toString().includes('csecret'), 'the secret never goes to the browser');
});

test('code exchange: form body with verifier and redirect, tokens parsed; a code works once', async () => {
  const oura = fakeOura();
  const code = oura.issueCode('the-verifier');
  const t = await exchangeCode(CFG, { code, verifier: 'the-verifier' }, oura.fetch);
  assert.match(t.access, /^acc-/); assert.match(t.refresh, /^ref-/);
  assert.ok(t.exp > Date.now() + 86000000);
  assert.deepEqual(t.scope, CFG.scopes);
  const call = oura.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const body = Object.fromEntries(new URLSearchParams(call.body));
  assert.equal(body.grant_type, 'authorization_code');
  assert.equal(body.code_verifier, 'the-verifier');
  assert.equal(body.redirect_uri, CFG.redirectUri);
  await assert.rejects(exchangeCode(CFG, { code, verifier: 'the-verifier' }, oura.fetch), e => e instanceof OuraError && e.code === 'reauth');
});

test('a wrong verifier, a wrong client secret and a rate limit are told apart, and no message leaks a secret', async () => {
  const oura = fakeOura();
  await assert.rejects(exchangeCode(CFG, { code: oura.issueCode('v'), verifier: 'other' }, oura.fetch), e => e.code === 'reauth');
  await assert.rejects(exchangeCode({ ...CFG, clientSecret: 'wrong' }, { code: oura.issueCode('v'), verifier: 'v' }, oura.fetch), e => {
    assert.equal(e.code, 'config');
    assert.ok(!e.message.includes('wrong') && !e.message.includes('csecret'));
    return true;
  });
  const limited = async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
  await assert.rejects(refreshTokens(CFG, 'r', limited), e => e.code === 'rate' && e.retryAfter === 30);
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(refreshTokens(CFG, 'r', down), e => e.code === 'network');
});

test('refresh rotates: a new pair each time, and the old refresh token is dead', async () => {
  const oura = fakeOura();
  const first = await exchangeCode(CFG, { code: oura.issueCode('v'), verifier: 'v' }, oura.fetch);
  const second = await refreshTokens(CFG, first.refresh, oura.fetch);
  assert.notEqual(second.refresh, first.refresh);
  assert.notEqual(second.access, first.access);
  await assert.rejects(refreshTokens(CFG, first.refresh, oura.fetch), e => e.code === 'reauth');
});

test('a token answer without a pair is refused; a missing lifetime counts as already due', () => {
  assert.throws(() => parseTokenResponse({ access_token: 'a' }), OuraError);
  assert.equal(parseTokenResponse({ access_token: 'a', refresh_token: 'r' }, 1000).exp, 1000);
});

test('revoke: POST first, GET when the method is refused; false (not a throw) when Oura is down', async () => {
  const oura = fakeOura();
  const t = await exchangeCode(CFG, { code: oura.issueCode('v'), verifier: 'v' }, oura.fetch);
  assert.equal(await revokeToken(CFG, t.access, oura.fetch), true);
  assert.ok(oura.revoked.has(t.access));
  assert.deepEqual(oura.calls.slice(-2).map(c => c.method), ['POST', 'GET']);
  assert.equal(await revokeToken(CFG, 'x', async () => { throw new Error('down'); }), false);
  assert.equal(await revokeToken(CFG, '', oura.fetch), false);
});

test('the token store: encrypted at rest, 0600 in a 0700 folder, unreadable with another key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oura-store-'));
  try {
    const key = deriveKey('instance-secret', 'csecret');
    const store = createOuraStore({ dir: path.join(dir, 'oura'), key });
    store.put('u1', { tokens: { access: 'ACCESS-PLAIN', refresh: 'REFRESH-PLAIN', exp: 5 }, connectedAt: 1, scopes: ['daily'] });
    const file = path.join(dir, 'oura', 'u1.json');
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('ACCESS-PLAIN') && !text.includes('REFRESH-PLAIN'), 'no token in clear text');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'oura')).mode & 0o777, 0o700);
    assert.deepEqual(store.get('u1').tokens, { access: 'ACCESS-PLAIN', refresh: 'REFRESH-PLAIN', exp: 5 });
    // The data directory alone (its `secret` included) is not enough: the client secret is part of the key.
    assert.equal(createOuraStore({ dir: path.join(dir, 'oura'), key: deriveKey('instance-secret', 'other') }).get('u1'), null);
    // Without any key a leftover connection is still visible and removable.
    const keyless = createOuraStore({ dir: path.join(dir, 'oura') });
    assert.equal(keyless.get('u1'), null);
    assert.equal(keyless.meta('u1').connectedAt, 1);
    assert.throws(() => keyless.put('u1', { tokens: {} }));
    assert.throws(() => store.get('../db'), /bad profile id/);
    assert.equal(keyless.remove('u1'), true);
    assert.equal(store.get('u1'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
