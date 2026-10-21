/* The bookkeeping behind MCP tokens (mcp-access.js): what is stored, what a lookup accepts, and
   what of a profile's document an MCP client is sent. The routes around it are in
   server-mcp.test.js, against a real server. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_TOKEN_PREFIX, MAX_MCP_TOKENS, MCP_TOKEN_MAX_DAYS, MCP_TOUCH_MS, MCP_WITHHELD,
  parseMcpTokenRequest, createMcpToken, findMcpToken, listMcpTokens, revokeMcpToken, dropMcpTokens,
  touchMcpToken, hashMcpToken, isMcpTokenShaped, mcpView
} from '../mcp-access.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 1);
const fresh = () => ({ users: [{ id: 'a' }, { id: 'b' }], mcpTokens: [] });

test('a token is 256 random bits behind a recognisable prefix, and only its hash is kept', () => {
  const db = fresh();
  const { token, record } = createMcpToken(db, 'a', { name: 'laptop', days: 30, sv: 2 }, T0);
  assert.ok(token.startsWith(MCP_TOKEN_PREFIX));
  assert.ok(isMcpTokenShaped(token));
  assert.equal(Buffer.from(token.slice(MCP_TOKEN_PREFIX.length), 'base64url').length, 32);
  assert.equal(record.h, hashMcpToken(token));
  assert.equal(record.scope, 'read');
  assert.equal(record.sv, 2);
  assert.equal(record.exp, T0 + 30 * DAY);
  assert.equal(record.hint, token.slice(-4));
  // Nothing stored anywhere is the token itself.
  assert.ok(!JSON.stringify(db).includes(token));
  assert.ok(!JSON.stringify(db).includes(token.slice(MCP_TOKEN_PREFIX.length)));
  // Two tokens never collide.
  const again = createMcpToken(db, 'a', { name: 'x', days: 1 }, T0);
  assert.notEqual(again.token, token);
  assert.notEqual(again.record.id, record.id);
});

test('a lookup finds the live token and nothing else', () => {
  const db = fresh();
  const { token, record } = createMcpToken(db, 'a', { name: 'n', days: 1 }, T0);
  assert.equal(findMcpToken(db, token, T0 + 1000), record);
  // wrong, malformed, empty, not a string, a prefix-only string, a session-shaped token
  const other = MCP_TOKEN_PREFIX + 'A'.repeat(43);
  for (const bad of [other, token.slice(0, -1), token + 'x', '', null, undefined, 42, {}, MCP_TOKEN_PREFIX, 'u1:9999999999999:0.mac', token.toUpperCase()]) {
    assert.equal(findMcpToken(db, bad, T0), null, String(bad));
  }
});

test('an expired token is refused and drops out of the list', () => {
  const db = fresh();
  const { token } = createMcpToken(db, 'a', { name: 'n', days: 1 }, T0);
  assert.ok(findMcpToken(db, token, T0 + DAY - 1));
  assert.equal(findMcpToken(db, token, T0 + DAY), null);
  assert.deepEqual(listMcpTokens(db, 'a', T0 + DAY), []);
  assert.equal(db.mcpTokens.length, 0);
});

test('a record with any scope but read is refused, whoever wrote it', () => {
  const db = fresh();
  const { token, record } = createMcpToken(db, 'a', { name: 'n', days: 1 }, T0);
  record.scope = 'write';
  assert.equal(findMcpToken(db, token, T0), null);
  delete record.scope;
  assert.equal(findMcpToken(db, token, T0), null);
});

test('the list shows names, dates and a hint, never a hash', () => {
  const db = fresh();
  createMcpToken(db, 'a', { name: 'one', days: 5 }, T0);
  createMcpToken(db, 'a', { name: 'two', days: 5 }, T0 + 1);
  createMcpToken(db, 'b', { name: 'theirs', days: 5 }, T0);
  const list = listMcpTokens(db, 'a', T0 + 2);
  assert.deepEqual(list.map(t => t.name), ['two', 'one']);
  for (const t of list) {
    assert.deepEqual(Object.keys(t).sort(), ['created', 'exp', 'hint', 'id', 'lastUsed', 'name', 'scope']);
    assert.equal(t.hint.length, 4);
  }
});

test('revoking: only the owner, only once', () => {
  const db = fresh();
  const { token, record } = createMcpToken(db, 'a', { name: 'n', days: 5 }, T0);
  assert.equal(revokeMcpToken(db, 'b', record.id, T0), null, 'another profile cannot revoke it');
  assert.ok(findMcpToken(db, token, T0));
  for (const bad of ['', null, undefined, 7, 'nope']) assert.equal(revokeMcpToken(db, 'a', bad, T0), null);
  assert.equal(revokeMcpToken(db, 'a', record.id, T0), record);
  assert.equal(findMcpToken(db, token, T0), null);
  assert.equal(revokeMcpToken(db, 'a', record.id, T0), null);
});

test('dropMcpTokens ends every token of one profile and no other', () => {
  const db = fresh();
  const a1 = createMcpToken(db, 'a', { name: 'n', days: 5 }, T0);
  const a2 = createMcpToken(db, 'a', { name: 'n', days: 5 }, T0);
  const b1 = createMcpToken(db, 'b', { name: 'n', days: 5 }, T0);
  assert.equal(dropMcpTokens(db, 'a'), true);
  assert.equal(dropMcpTokens(db, 'a'), false);
  assert.equal(findMcpToken(db, a1.token, T0), null);
  assert.equal(findMcpToken(db, a2.token, T0), null);
  assert.ok(findMcpToken(db, b1.token, T0));
});

test(`at most ${MAX_MCP_TOKENS} per profile; expired ones do not count`, () => {
  const db = fresh();
  for (let i = 0; i < MAX_MCP_TOKENS; i++) assert.ok(createMcpToken(db, 'a', { name: 'n', days: i === 0 ? 1 : 5 }, T0).token);
  assert.equal(createMcpToken(db, 'a', { name: 'n', days: 5 }, T0).code, 'mcp-token-limit');
  assert.ok(createMcpToken(db, 'b', { name: 'n', days: 5 }, T0).token, 'the limit is per profile');
  assert.ok(createMcpToken(db, 'a', { name: 'n', days: 5 }, T0 + DAY).token, 'the expired one made room');
});

test('lastUsed is noted at most every ten minutes', () => {
  const rec = { lastUsed: null };
  assert.equal(touchMcpToken(rec, T0), true);
  assert.equal(touchMcpToken(rec, T0 + MCP_TOUCH_MS - 1), false);
  assert.equal(rec.lastUsed, T0);
  assert.equal(touchMcpToken(rec, T0 + MCP_TOUCH_MS), true);
});

test('request parsing: defaults, trimming, and every refusal', () => {
  assert.deepEqual(parseMcpTokenRequest({}), { name: 'MCP client', days: 90 });
  assert.deepEqual(parseMcpTokenRequest(null), { name: 'MCP client', days: 90 });
  assert.deepEqual(parseMcpTokenRequest({ name: '  Claude Code \n', days: 7 }), { name: 'Claude Code', days: 7 });
  assert.deepEqual(parseMcpTokenRequest({ name: 'a'.repeat(60), days: MCP_TOKEN_MAX_DAYS }), { name: 'a'.repeat(60), days: MCP_TOKEN_MAX_DAYS });
  for (const name of [5, true, ['x'], { a: 1 }, 'a'.repeat(61)]) assert.equal(parseMcpTokenRequest({ name }).code, 'mcp-token-name', String(name));
  for (const days of [0, -1, 1.5, '30', MCP_TOKEN_MAX_DAYS + 1, NaN, Infinity, true]) assert.equal(parseMcpTokenRequest({ days }).code, 'mcp-token-days', String(days));
});

test('the MCP view keeps the training record and withholds what an assistant has no use for', () => {
  const S = {
    unit: 'kg', routines: [{ id: 'r1' }], workouts: [{ id: 'w1' }], bodyweight: [{ d: '2026-10-01', w: 80 }],
    gymCards: [{ id: 'c', code: '4006381333931', name: 'Gym' }], lastGymCardId: 'c',
    coach: { consent: { agreedAt: 'x' }, pending: { changes: [] } },
    reminder: { on: true, time: '07:00', tz: 'Europe/Lisbon' }, hints: { swipeSets: true },
    _rev: 4, _ts: 9, _wid: 'w', _wids: ['w'], _unstamped: { a: 1 }, _prior: { b: 2 }
  };
  const v = mcpView(S);
  for (const k of MCP_WITHHELD) assert.ok(!(k in v), k);
  assert.deepEqual(v.routines, S.routines);
  assert.deepEqual(v.workouts, S.workouts);
  assert.equal(v.unit, 'kg');
  assert.ok(!JSON.stringify(v).includes('4006381333931'));
  assert.ok(S.gymCards, 'the stored document is not touched');
  for (const bad of [null, undefined, [], 'x', 3]) assert.equal(mcpView(bad), null);
  // The list itself, so a change to it is a deliberate one.
  assert.deepEqual([...MCP_WITHHELD].sort(), ['_prior', '_unstamped', '_wid', '_wids', 'coach', 'gymCards', 'hints', 'lastGymCardId', 'reminder']);
});
