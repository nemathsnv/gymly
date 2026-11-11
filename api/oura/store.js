/* Where a profile's Oura connection is kept: its tokens and a few facts about the connection,
 * one file per profile under DATA_DIR/oura/, mode 0600 in a 0700 directory.
 *
 * The tokens are encrypted at rest (AES-256-GCM; the Oura API Agreement §9(a)(ii) asks for that).
 * The key is derived from two secrets that live in different places: the instance's own `secret`
 * file in DATA_DIR and OURA_CLIENT_SECRET from the server's environment file. A copy of the data
 * directory alone, a backup of it included, therefore cannot be turned back into tokens.
 * Rotating the client secret makes stored tokens unreadable. The connection then reads as gone
 * and the person connects again, which is the right outcome for a rotated secret anyway.
 *
 * No Oura health data is ever written here or anywhere else on disk (sync.js keeps a
 * summary in memory only). What is stored is the minimum a connection needs: tokens, when it was made,
 * which scopes Oura reported as granted, when it last synced, the last sync error's code, and the
 * device's time zone name.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../durable.js';

const UID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function deriveKey(instanceSecret, clientSecret) {
  if (!instanceSecret || !clientSecret) throw new Error('oura store: both secrets are required');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(instanceSecret), 'utf8'),
    Buffer.from(String(clientSecret), 'utf8'), Buffer.from('gymly-oura-tokens-v1'), 32));
}

export function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function open(key, blob) {
  try {
    const buf = Buffer.from(String(blob), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {{dir: string, key: Buffer|null}} opts  dir is DATA_DIR/oura. Without a key (the
 *   integration is not configured) nothing can be read or written, but a connection left over
 *   from before can still be seen and deleted.
 */
export function createOuraStore({ dir, key = null }) {
  const file = uid => {
    if (!UID_RE.test(uid)) throw new Error('oura store: bad profile id');
    return path.join(dir, uid + '.json');
  };
  const ensureDir = () => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch { /* not ours to fix */ } };

  function readRaw(uid) {
    const f = file(uid);                 // a malformed id throws here, never reads a path
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  }

  return {
    /** { connectedAt, scopes, lastSync, tokens: {access, refresh, exp} } or null. A file whose
     *  tokens no longer decrypt (rotated client secret, damaged file) is no connection. */
    get(uid) {
      const raw = readRaw(uid);
      if (!key || !raw || !raw.tok) return null;
      const tokens = open(key, raw.tok);
      if (!tokens || !tokens.access || !tokens.refresh) return null;
      return { connectedAt: raw.connectedAt || null, scopes: raw.scopes || null, lastSync: raw.lastSync || null, tokens };
    },
    /** Facts only, without decrypting: what the status route shows. */
    meta(uid) {
      const raw = readRaw(uid);
      return raw && raw.tok ? { connectedAt: raw.connectedAt || null, scopes: raw.scopes || null, lastSync: raw.lastSync || null, lastError: raw.lastError || null } : null;
    },
    put(uid, { tokens, connectedAt, scopes, lastSync }) {
      if (!key) throw new Error('oura store: not configured');
      ensureDir();
      const rec = { v: 1, connectedAt: connectedAt || Date.now(), scopes: scopes || null, lastSync: lastSync || null, tok: seal(key, tokens) };
      atomicWrite(file(uid), JSON.stringify(rec), 0o600);
    },
    touch(uid, patch) {
      const raw = readRaw(uid);
      if (!raw) return;
      atomicWrite(file(uid), JSON.stringify({ ...raw, ...patch }), 0o600);
    },
    remove(uid) {
      const f = file(uid);
      try { fs.unlinkSync(f); return true; } catch { return false; }
    },
  };
}
