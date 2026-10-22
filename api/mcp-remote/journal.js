/* The record of what assistants changed in a profile, kept beside its document as
 * DATA_DIR/mcp-journal-<uid>.json: one entry per applied preview, with what an undo needs (the
 * plan before the change, or the id of the workout it logged) and a summary a person can read.
 * It is the per-profile audit trail of the hosted MCP endpoint and the source of undo_change;
 * the server-wide audit.log gets one line per write, with counts and no content.
 *
 * Written with the same durable write as the state files (durable.js), before the change itself
 * is saved: a crash between the two leaves an entry whose change never landed, which undo then
 * refuses (the plan does not match what it recorded), never a change with no way back. */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../durable.js';

export const JOURNAL_KEEP = 25;

export function createJournal(dir) {
  const file = uid => path.join(dir, 'mcp-journal-' + String(uid).replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
  function load(uid) {
    try {
      const v = JSON.parse(fs.readFileSync(file(uid), 'utf8'));
      return Array.isArray(v?.entries) ? v.entries : [];
    } catch { return []; }
  }
  function save(uid, entries) {
    atomicWrite(file(uid), JSON.stringify({ v: 1, entries: entries.slice(-JOURNAL_KEEP) }), 0o600);
  }
  return {
    list: load,
    find: (uid, id) => load(uid).find(e => e.id === id) || null,
    append(uid, entry) { save(uid, [...load(uid), entry]); },
    update(uid, id, patch) {
      const all = load(uid);
      const e = all.find(x => x.id === id);
      if (!e) return null;
      Object.assign(e, patch);
      save(uid, all);
      return e;
    },
    remove(uid) { try { fs.unlinkSync(file(uid)); } catch { /* none */ } }
  };
}
