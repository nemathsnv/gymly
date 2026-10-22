/* The server's guard on the habit log (sync-stamps.js keepHabitLog, run by stampPut for every
   writer): what the stored copy holds stays unless the writer sent a later version of it, so an
   app that does not merge the log entry by entry (one from before habits) or a script that leaves
   it out cannot take days or habits away or set them back. A reset is the one exception. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepHabitLog, stampPut } from '../sync-stamps.js';

const clone = v => JSON.parse(JSON.stringify(v));
const NOW = 1_800_000_000_000;
const LOG = () => ({
  'alcohol|2026-10-20': { s: 'free', _ts: NOW - 100 },
  'hread|def': { name: 'Read', kind: 'do', at: NOW - 90, _ts: NOW - 90 },
  'hread|2026-10-20': { s: 'good', _ts: NOW - 80 },
});
const doc = (habitLog, extra = {}) => ({ _ts: NOW - 50, _rev: 4, unit: 'kg', routines: [], workouts: [], habitLog, ...extra });

test('keeps what the writer left out, and the later of two versions of an entry', () => {
  const cur = doc(LOG());
  const next = doc({ 'alcohol|2026-10-20': { s: 'drank', _ts: NOW - 200 }, 'alcohol|2026-10-21': { s: 'free', _ts: NOW } });
  assert.equal(keepHabitLog(cur, next), true);
  assert.deepEqual(next.habitLog, { ...LOG(), 'alcohol|2026-10-21': { s: 'free', _ts: NOW } });
});

test('the writer\'s version wins when it is later, or on a tie', () => {
  const cur = doc(LOG());
  const later = { ...LOG(), 'hread|def': { name: 'Read more', kind: 'do', at: NOW - 90, _ts: NOW - 10 } };
  const next = doc(clone(later));
  assert.equal(keepHabitLog(cur, next), false);
  assert.deepEqual(next.habitLog, later);
  const tie = doc({ ...LOG(), 'hread|2026-10-20': { s: 'bad', _ts: NOW - 80 } });
  keepHabitLog(cur, tie);
  assert.equal(tie.habitLog['hread|2026-10-20'].s, 'bad');
});

test('a missing or broken log in the write is the stored one', () => {
  for (const habitLog of [undefined, null, 'x', [1]]) {
    const next = doc(habitLog);
    assert.equal(keepHabitLog(doc(LOG()), next), true);
    assert.deepEqual(next.habitLog, LOG());
  }
  // nothing stored: nothing to keep
  const n = doc({ a: 1 });
  assert.equal(keepHabitLog(doc(undefined), n), false);
  assert.deepEqual(n.habitLog, { a: 1 });
});

test('stampPut runs it for every writer, and reports it, but not across a reset', () => {
  for (const stamped of [true, false]) {
    const report = {};
    const next = stampPut(doc(LOG()), doc({}), { overRead: true, stamped, now: NOW, report });
    assert.deepEqual(next.habitLog, LOG(), `stamped: ${stamped}`);
    assert.equal(report.changed, true);
  }
  const reset = stampPut(doc(LOG(), { resetAt: NOW - 500 }), doc({}, { resetAt: NOW }), { overRead: true, stamped: true, now: NOW });
  assert.deepEqual(reset.habitLog, {});
});

test('an up-to-date app\'s write passes through untouched and unreported', () => {
  const report = {};
  const mine = { ...LOG(), 'hread|2026-10-21': { s: 'good', _ts: NOW } };
  const next = stampPut(doc(LOG()), doc(clone(mine)), { overRead: true, stamped: true, now: NOW, report });
  assert.deepEqual(next.habitLog, mine);
  assert.equal(report.changed, undefined);
});
