/* Personal access tokens for an MCP client (mcp/, "remote" mode).
 *
 * A session cookie or a paired phone's bearer token is the whole account: it writes the training
 * history, adds passkeys, changes the password. An LLM client needs none of that to answer "what
 * did I bench last week", and it keeps whatever it is given in a config file on somebody's laptop
 * for months. So it gets its own credential, narrower on every axis:
 *
 *   - one scope, `read`, honoured by the /api/mcp/v1/* routes and by nothing else — sessionOf()
 *     never accepts one, so it cannot reach /api/data, the account routes or the admin ones;
 *   - one profile: the token names its owner, and no route takes a user id from the caller;
 *   - `gymly_mcp_` + 32 random bytes (base64url), stored only as a SHA-256 — like a device link,
 *     a copy of db.json holds nothing that works, and a random secret needs no slow hash;
 *   - an expiry (90 days unless asked otherwise, 365 at most), at most MAX_MCP_TOKENS per
 *     profile, revocable one by one from Settings, and all gone with "sign out everywhere",
 *     a disable or a delete;
 *   - shown once, at creation. The list shows a name, dates and the last four characters.
 *
 * Phase 2 (writes) adds a second scope rather than widening this one: see docs/dev/MCP_WRITES.md.
 *
 * Pure bookkeeping on `db.mcpTokens`; the routes, the throttle and the audit are server.js's. */
import crypto from 'node:crypto';

export const MCP_TOKEN_PREFIX = 'gymly_mcp_';
export const MAX_MCP_TOKENS = 10;
export const MCP_TOKEN_DAYS = 90;
export const MCP_TOKEN_MAX_DAYS = 365;
export const MCP_NAME_MAX = 60;
// The only scope that exists. A record carrying anything else is refused by findMcpToken, so a
// db.json edited by hand (or written by a later version and then rolled back) cannot hand a read
// route's caller more than it asked for.
export const MCP_SCOPES = Object.freeze(['read']);
// lastUsed is written at most this often per token: every tool call reads, and a db.json save per
// read would be a disk write an MCP client asks for as fast as it likes.
export const MCP_TOUCH_MS = 10 * 60 * 1000;

const DAY = 86400000;
// 32 bytes as unpadded base64url is 43 characters.
const TOKEN_RE = /^gymly_mcp_[A-Za-z0-9_-]{43}$/;

export const isMcpTokenShaped = v => typeof v === 'string' && TOKEN_RE.test(v);
export const hashMcpToken = token => crypto.createHash('sha256').update('gymly-mcp:' + token).digest('hex');

function prune(db, now) {
  db.mcpTokens = (Array.isArray(db.mcpTokens) ? db.mcpTokens : [])
    .filter(t => t && typeof t.h === 'string' && typeof t.userId === 'string' && t.exp > now);
}

// A request's `name` and `days`, checked. → { name, days } or { error, code }.
export function parseMcpTokenRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  let name = b.name === undefined || b.name === null ? '' : b.name;
  if (typeof name !== 'string') return { error: 'name must be text', code: 'mcp-token-name' };
  // Control characters (C0, DEL, C1), bidi overrides and isolates, and line/paragraph separators
  // would reach the Settings list and the admin activity log as typed — a name that reorders how
  // an audit row reads is a spoof even where nothing executes.
  name = name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, '').trim();
  if (name.length > MCP_NAME_MAX) return { error: `name is longer than ${MCP_NAME_MAX} characters`, code: 'mcp-token-name' };
  let days = b.days === undefined || b.days === null ? MCP_TOKEN_DAYS : b.days;
  if (!Number.isInteger(days) || days < 1 || days > MCP_TOKEN_MAX_DAYS) {
    return { error: `days must be a whole number from 1 to ${MCP_TOKEN_MAX_DAYS}`, code: 'mcp-token-days' };
  }
  return { name: name || 'MCP client', days };
}

// What a list shows: never the hash.
export const mcpTokenView = t => ({
  id: t.id, name: t.name, scope: t.scope, created: t.created, exp: t.exp,
  lastUsed: t.lastUsed || null, hint: t.hint
});

export function listMcpTokens(db, userId, now = Date.now()) {
  prune(db, now);
  return db.mcpTokens.filter(t => t.userId === userId).sort((a, b) => b.created - a.created).map(mcpTokenView);
}

// → { token, record } or { error, code }. The token is returned once and never stored.
// `sv` is the profile's session version when the token was made: server.js refuses a token whose
// sv is no longer the profile's, so every path that ends the account's sessions (sign out
// everywhere, a new password, an admin reset) ends its MCP tokens too, including any added later.
export function createMcpToken(db, userId, { name, days, sv = 0 }, now = Date.now()) {
  prune(db, now);
  if (db.mcpTokens.filter(t => t.userId === userId).length >= MAX_MCP_TOKENS) {
    return { error: `a profile can have at most ${MAX_MCP_TOKENS} MCP tokens; revoke one first`, code: 'mcp-token-limit' };
  }
  const token = MCP_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const record = {
    id: crypto.randomBytes(8).toString('hex'),
    h: hashMcpToken(token),
    userId, name, scope: 'read', sv,
    created: now, exp: now + days * DAY, lastUsed: null,
    hint: token.slice(-4)
  };
  db.mcpTokens.push(record);
  return { token, record };
}

// The live record a presented token belongs to, or null — wrong, revoked, expired and malformed
// all look the same from outside. Compared in constant time against every stored hash.
export function findMcpToken(db, token, now = Date.now()) {
  prune(db, now);
  if (!isMcpTokenShaped(token)) return null;
  const h = Buffer.from(hashMcpToken(token), 'hex');
  let hit = null;
  for (const t of db.mcpTokens) {
    const stored = Buffer.from(t.h, 'hex');
    if (stored.length === h.length && crypto.timingSafeEqual(stored, h)) hit = t;
  }
  if (!hit || !MCP_SCOPES.includes(hit.scope)) return null;
  return hit;
}

// Notes a use. Says whether the record changed, so the caller saves only then.
export function touchMcpToken(rec, now = Date.now()) {
  if (rec.lastUsed && now - rec.lastUsed < MCP_TOUCH_MS) return false;
  rec.lastUsed = now;
  return true;
}

// Revokes one of this profile's tokens. Another profile's id is "not found", same as a wrong one.
export function revokeMcpToken(db, userId, id, now = Date.now()) {
  prune(db, now);
  const rec = typeof id === 'string' && id ? db.mcpTokens.find(t => t.id === id && t.userId === userId) : null;
  if (!rec) return null;
  db.mcpTokens = db.mcpTokens.filter(t => t !== rec);
  return rec;
}

// Every token of a profile, for the moments its sessions end. Says whether anything went.
export function dropMcpTokens(db, userId) {
  const before = (db.mcpTokens || []).length;
  db.mcpTokens = (db.mcpTokens || []).filter(t => t && t.userId !== userId);
  return db.mcpTokens.length !== before;
}

/* What an MCP client is sent of a profile's document.
 *
 * The training record and the settings the training helpers read (units, progression, plates,
 * week start …) go; what an assistant has no use for and a transcript should not carry stays home:
 *   gymCards / lastGymCardId — gym membership cards, i.e. barcodes and member numbers;
 *   coach   — the AI Coach's consent record, profile and pending proposals;
 *   reminder, hints — device-facing switches, nothing about training;
 *   habitLog — the daily habit log (alcohol-free days, drink counts, private notes): health data
 *     the owner kept for themselves. Not training data, and not opened to an assistant until that
 *     is designed and consented to on its own (docs/dev/HABITS.md);
 *   _unstamped, _prior, _wids, _wid — the server's own sync notes (sync-stamps.js, PUT /api/data).
 * A denylist rather than an allowlist on purpose: the shared helpers (frontend/src/lib) read
 * settings all over the document, and a field the app adds later must not silently break the
 * numbers the MCP tools compute. Anything secret-shaped that is ever added to the document has to
 * be added here too — api/test/mcp-access.test.js names this list. */
export const MCP_WITHHELD = Object.freeze(['gymCards', 'lastGymCardId', 'coach', 'reminder', 'hints', 'habitLog', '_unstamped', '_prior', '_wids', '_wid']);

export function mcpView(S) {
  if (!S || typeof S !== 'object' || Array.isArray(S)) return null;
  const out = {};
  for (const [k, v] of Object.entries(S)) if (!MCP_WITHHELD.includes(k)) out[k] = v;
  return out;
}
