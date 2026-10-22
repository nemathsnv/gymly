/* mcp-remote/plan-ops.js: how an assistant's operations become a preview a person can read, which
   ones need the stronger confirmation, what the Coach's validator refuses, and that apply and undo
   are exact inverses — including the reschedules a removed routine takes with it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  previewPlan, applyPlan, undoPlan, previewWorkout, applyWorkout, undoWorkout, zonedEpoch, cleanName,
  StaleError, planHashOf, BULK_CHANGES, MAX_OPS
} from '../mcp-remote/plan-ops.js';

const S0 = () => ({
  unit: 'kg',
  routines: [
    { id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 55 }, { id: '0289', sets: 3, reps: 10 }] },
    { id: 'r2', name: 'Legs', ex: [{ id: '0043', sets: 3, reps: 5 }] }
  ],
  week: { 1: ['r1'], 3: ['r2'] },
  dayPlan: { '2099-03-02': 'r2', '2099-03-03': 'rest' },
  workouts: [{ id: 'w1', d: '2026-10-01', start: 10, name: 'Push', entries: [] }]
});
let n = 0;
const ids = () => 'new' + (++n);

test('an ordinary edit previews as one before → after line and applies exactly', () => {
  const S = S0();
  const p = previewPlan(S, [{ op: 'update_exercise', routine_id: 'r1', exercise_id: '0025', sets: 4, reps: 8, weight: 60 }]);
  assert.equal(p.ok, true);
  assert.equal(p.tier, 'ordinary');
  assert.deepEqual(p.lines, ['“Push” · Barbell Bench Press: 3 × 5 · 55 kg → 4 × 8 · 60 kg']);
  assert.deepEqual(p.changes.map(c => c.type), ['sets', 'reps', 'weight']);
  const { next, afterHash } = applyPlan(S, p);
  assert.deepEqual(next.routines[0].ex[0], { id: '0025', sets: 4, reps: 8, weight: 60 });
  assert.equal(afterHash, p.afterHash, 'the preview showed the plan the apply produced');
  assert.deepEqual(S, S0(), 'the input is never mutated');
});

test('a replaced exercise is a swap (ordinary); a removal is destructive; many changes are bulk', () => {
  const swap = previewPlan(S0(), [{ op: 'swap_exercise', routine_id: 'r1', exercise_id: '0289', new_exercise_id: '0151' }]);
  assert.equal(swap.tier, 'ordinary');
  assert.match(swap.lines[0], /replace Dumbbell Bench Press \(3 × 10\) with Cable Bench Press/);
  const rm = previewPlan(S0(), [{ op: 'remove_exercise', routine_id: 'r1', exercise_id: '0289' }]);
  assert.equal(rm.tier, 'destructive');
  assert.equal(rm.removals.length, 1);
  const rr = previewPlan(S0(), [{ op: 'remove_routine', routine_id: 'r2' }]);
  assert.equal(rr.tier, 'destructive');
  assert.match(rr.removals[0], /its logged workouts stay in history/);
  // Four existing routines touched at once is bulk, however small each edit.
  const S = S0();
  S.routines.push({ id: 'r3', name: 'Arms', ex: [{ id: '0025', sets: 3, reps: 5 }] }, { id: 'r4', name: 'Core', ex: [{ id: '0025', sets: 3, reps: 5 }] });
  const bulk = previewPlan(S, ['r1', 'r2', 'r3', 'r4'].map(r => ({ op: 'rename_routine', routine_id: r, name: r + ' renamed' })));
  assert.equal(bulk.tier, 'bulk');
  assert.equal(BULK_CHANGES, 16);
});

test('operations build on each other: create a routine, schedule it, set a weight on what it added', () => {
  const p = previewPlan(S0(), [
    { op: 'create_routine', name: 'Pull', exercises: [{ exercise_id: '0027', sets: 3, reps: 8, weight: 50 }], weekdays: [2, 5] },
    { op: 'add_exercise', routine_id: 'r1', exercise_id: '0047', sets: 3, reps: 12, weight: 20 }
  ], { newId: ids });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  const { next } = applyPlan(S0(), p);
  const pull = next.routines.find(r => r.name === 'Pull');
  assert.deepEqual(pull.ex[0], { id: '0027', sets: 3, mode: 'reps', reps: 8, weight: 50 });
  assert.deepEqual(next.week[2], [pull.id]);
  assert.deepEqual(next.week[5], [pull.id]);
  assert.equal(next.routines[0].ex[2].weight, 20);
  assert.ok(p.lines.some(l => /Tuesdays: rest → “Pull”/.test(l)));
  assert.ok(p.schedule.find(x => x.routine_name === 'Pull').next_dates.length >= 2);
});

test('the Coach\'s validator speaks: unknown ids, duplicates, odd per-side reps, inverted ranges', () => {
  const p = previewPlan(S0(), [
    { op: 'update_exercise', routine_id: 'r1', exercise_id: '9999', sets: 4 },
    { op: 'add_exercise', routine_id: 'r1', exercise_id: '0025' },
    { op: 'add_exercise', routine_id: 'r1', exercise_id: 'not-an-exercise' },
    { op: 'add_exercise', routine_id: 'r2', exercise_id: '0047', reps: 9, per_side: true },
    { op: 'update_exercise', routine_id: 'nope', exercise_id: '0025', sets: 4 },
    { op: 'reorder_exercises', routine_id: 'r1', exercise_ids: ['0025', '0025'] },
    { op: 'schedule_day', weekday: 2, routine_id: 'ghost' }
  ]);
  assert.equal(p.ok, false);
  assert.equal(p.errors.length, 7, p.errors.join('\n'));
  assert.match(p.errors.join('\n'), /even number/);
});

test('weights: positive, within the unit\'s bound, two decimals, never on cardio', () => {
  const bad = w => previewPlan(S0(), [{ op: 'update_exercise', routine_id: 'r1', exercise_id: '0025', weight: w }]);
  for (const w of [0, -5, 1000.5, 60.123]) assert.equal(bad(w).ok, false, String(w));
  assert.equal(bad(1000).ok, true);
  const lb = { ...S0(), unit: 'lb' };
  assert.equal(previewPlan(lb, [{ op: 'update_exercise', routine_id: 'r1', exercise_id: '0025', weight: 2000 }]).ok, true);
  const cardio = { ...S0(), routines: [{ id: 'c', name: 'Run', ex: [{ id: '0685', mode: 'cardio', sets: 1, min: 20 }] }] };
  const r = previewPlan(cardio, [{ op: 'update_exercise', routine_id: 'c', exercise_id: '0685', weight: 10 }]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /cardio/);
});

test('a profile with more routines than the Coach allows can still be edited', () => {
  const S = S0();
  for (let i = 0; i < 9; i++) S.routines.push({ id: 'x' + i, name: 'Extra ' + i, ex: [{ id: '0025', sets: 3, reps: 5 }] });
  const p = previewPlan(S, [{ op: 'update_exercise', routine_id: 'x3', exercise_id: '0025', sets: 4 }]);
  assert.equal(p.ok, true, JSON.stringify(p.errors));
});

test('limits and no-ops', () => {
  assert.equal(previewPlan(S0(), []).ok, false);
  assert.equal(previewPlan(S0(), Array(MAX_OPS + 1).fill({ op: 'update_exercise', routine_id: 'r1', exercise_id: '0025', sets: 4 })).ok, false);
  const same = previewPlan(S0(), [{ op: 'update_exercise', routine_id: 'r1', exercise_id: '0025', sets: 3, weight: 55 }]);
  assert.equal(same.ok, true);
  assert.equal(same.nochange, true);
  assert.equal(cleanName(' Push‮\u0000 Day  '), 'Push Day');
});

test('apply refuses a moved plan; undo is exact and refuses once the plan moved on', () => {
  const S = S0();
  const p = previewPlan(S, [{ op: 'remove_routine', routine_id: 'r2' }]);
  const moved = S0();
  moved.routines[0].ex[0].reps = 6;
  assert.throws(() => applyPlan(moved, p), StaleError);

  const { next, undo, afterHash } = applyPlan(S, p);
  assert.equal(next.dayPlan['2099-03-02'], undefined, 'its reschedule went with it');
  assert.deepEqual(next.week, { 1: ['r1'] });
  const back = undoPlan(next, { undo, afterHash });
  assert.deepEqual(back.routines, S.routines);
  assert.deepEqual(back.week, S.week);
  assert.deepEqual(back.dayPlan, S.dayPlan);
  assert.equal(planHashOf(back), planHashOf(S));
  const later = structuredClone(next);
  later.routines[0].name = 'Push renamed';
  assert.throws(() => undoPlan(later, { undo, afterHash }), StaleError);
});

test('logging a workout: validated, filed in date order, added once, undone by id', () => {
  const now = Date.parse('2026-10-22T20:00:00Z');
  const S = { ...S0(), reminder: { tz: 'Europe/Berlin' } };
  const input = { date: '2026-10-20', start_time: '07:30', duration_min: 45, routine_id: 'r1',
    exercises: [{ exercise_id: '0025', sets: [{ reps: 5, weight: 60 }, { reps: 5, weight: 62.5, rir: 1 }] }, { exercise_id: '0685', sets: [{ minutes: 10, speed: 9 }] }] };
  const p = previewWorkout(S, input, { now, newId: () => 'wnew' });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.equal(p.workout.start, Date.parse('2026-10-20T05:30:00Z'), '07:30 in Berlin (CEST)');
  assert.equal(p.workout.end - p.workout.start, 45 * 60000);
  assert.deepEqual(p.workout.entries[0].sets, [{ w: 60, r: 5, done: true }, { w: 62.5, r: 5, done: true, rir: 1 }]);
  assert.deepEqual(p.workout.entries[1].sets, [{ min: 10, speed: 9, done: true }]);
  assert.equal(p.workout.entries[0].rid, 'r1');
  assert.equal(p.workout.name, 'Push');
  const { next } = applyWorkout(S, p);
  assert.deepEqual(next.workouts.map(w => w.id), ['w1', 'wnew']);
  assert.equal(applyWorkout(next, p).already, true);
  assert.deepEqual(undoWorkout(next, { workoutId: 'wnew' }).next.workouts.map(w => w.id), ['w1']);
  assert.equal(undoWorkout(S, { workoutId: 'wnew' }).gone, true);

  const bad = previewWorkout(S, { ...input, date: '2026-10-23', exercises: [{ exercise_id: 'zzz', sets: [{ reps: 5 }] }, { exercise_id: '0025', sets: [{ weight: 50 }] }] }, { now });
  assert.equal(bad.ok, false);
  // In the future (twice: the date, and so the end), an unknown exercise, a set with no reps.
  assert.equal(bad.errors.length, 4, bad.errors.join('\n'));
  const dup = previewWorkout(S, { ...input, exercises: [{ exercise_id: '0025', sets: [{ reps: 5 }] }, { exercise_id: '0025', sets: [{ reps: 5 }] }] }, { now });
  assert.match(dup.errors[0], /listed twice/);
  const sameDay = previewWorkout(S, { ...input, date: '2026-10-01' }, { now });
  assert.match(sameDay.warnings[0], /already logged on 2026-10-01/);
});

test('zonedEpoch lands on the wall-clock time on both sides of a DST change', () => {
  assert.equal(zonedEpoch('2026-03-29', '12:00', 'Europe/Berlin'), Date.parse('2026-03-29T10:00:00Z'));
  assert.equal(zonedEpoch('2026-03-28', '12:00', 'Europe/Berlin'), Date.parse('2026-03-28T11:00:00Z'));
  assert.equal(zonedEpoch('2026-11-01', '09:00', 'America/New_York'), Date.parse('2026-11-01T14:00:00Z'));
});
