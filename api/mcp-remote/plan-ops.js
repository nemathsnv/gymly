/* What an assistant may change in a profile, and how a change is previewed, applied and undone.
 *
 * Pure: every function takes the profile document and returns a new one or a description; the
 * caller (tools.js) holds the previews, and server.js writes the document through the same commit
 * path PUT /api/data uses. Nothing here touches the disk.
 *
 * The boundary is the AI Coach's: an operation the assistant asks for is translated into the
 * Coach's closed list of change types and checked by the Coach's validator (validateReview in
 * coach/core/validate.js) against the plan as it stands. An operation that is not on the list
 * does not exist; there is no field-level patch and no "replace the document". One change type is
 * added on top, `weight` (plan-apply.js), and checked here.
 *
 * Operations are checked one after another, each against the plan as the ones before it leave it,
 * on a scratch copy. So "create a routine, then put it on Monday" or "add an exercise, then set its
 * weight" can be one preview, and what the preview shows is the plan the apply will produce. */
import { validateReview, CHANGE_TYPES as COACH_TYPES } from '../coach/core/validate.js';
import { canonicalPlan } from '../coach/core/payload.js';
import { hashPlan } from '../coach/core/plan-hash.js';
import { glyphStr } from '../coach/core/glyphs.js';
import { helpers } from './read-tools.gen.js';
import { createApplier, POLICIES } from './plan-apply.js';

export { POLICIES };
const { applyChanges } = createApplier(helpers);

export const MAX_OPS = 20;
export const MAX_CHANGES = 60;
// The Coach holds a plan to 7 routines; a profile can have more, and editing one of them must not
// be refused for it. Only adding routines is capped, at a number no real plan reaches.
export const MAX_ROUTINES = 30;
export const MAX_EX_PER_ROUTINE = 20;
// Beyond these a preview is "bulk" and needs the stronger confirmation (see tierOf).
export const BULK_CHANGES = 16;
export const BULK_ROUTINES = 3;
export const MAX_WEIGHT_KG = 1000;
const MAX_WEIGHT = unit => (unit === 'lb' ? 2205 : MAX_WEIGHT_KG);
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const cap = s => String(s || '').replace(/(^|\s)(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase());
// Names typed by the assistant reach the plan, the preview and the undo record: no control,
// bidi or line-separator characters, as mcp-access.js does for token names.
export const cleanName = v => String(v == null ? '' : v)
  .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, '').trim().slice(0, 40);

export const planHashOf = S => hashPlan(canonicalPlan(S || {}));

function scratchOf(S) {
  const s = { routines: clone(Array.isArray(S?.routines) ? S.routines.filter(isObj) : []), week: clone(isObj(S?.week) ? S.week : {}), dayPlan: clone(isObj(S?.dayPlan) ? S.dayPlan : {}), customEx: Array.isArray(S?.customEx) ? S.customEx : [], unit: S?.unit };
  for (const r of s.routines) if (!Array.isArray(r.ex)) r.ex = [];
  return s;
}
const routineOf = (s, id) => s.routines.find(r => r.id === id) || null;
const exNameOf = (id, s) => cap(helpers.exerciseName(id, s) || id);

/* ---------- operations → the Coach's change contract ---------- */

const why = 'Asked for by the user through an AI assistant (hosted MCP).';

// update_exercise's fields, each one scalar change of the Coach's list.
const FIELD_TYPES = [
  ['sets', 'sets'], ['reps', 'reps'], ['reps_min', 'repsMin'], ['reps_max', 'repsMax'],
  ['seconds', 'sec'], ['increment', 'inc'], ['progression', 'exercise-prog'], ['weight', 'weight']
];

function weightError(unit, w, where) {
  if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0 || w > MAX_WEIGHT(unit)) return `${where}: weight must be more than 0 and at most ${MAX_WEIGHT(unit)} ${unit}`;
  if (Math.round(w * 100) !== w * 100) return `${where}: weight has more than two decimals`;
  return null;
}

/** One operation as the change list it stands for, checked against the scratch plan `s`. */
function changesFor(op, s, i) {
  const where = `operations[${i}] (${op.op})`;
  const t = (type, target, after) => ({ id: `c${i}-${type}`, type, target, after, why });
  const T = (extra = {}) => ({ routineId: op.routine_id, exId: op.exercise_id, ...extra });
  switch (op.op) {
    case 'update_exercise': {
      const out = FIELD_TYPES.filter(([k]) => op[k] !== undefined).map(([k, type]) => t(type, T(), op[k]));
      if (op.minutes !== undefined || op.speed !== undefined) {
        out.push(t('cardio', T(), { ...(op.minutes !== undefined ? { min: op.minutes } : {}), ...(op.speed !== undefined ? { speed: op.speed } : {}) }));
      }
      if (!out.length) return { error: `${where}: name at least one field to change` };
      return { changes: out };
    }
    case 'add_exercise':
      return {
        changes: [t('add-exercise', T(), {
          id: op.exercise_id, sets: op.sets, reps: op.reps, sec: op.seconds, repsMin: op.reps_min, repsMax: op.reps_max,
          mode: op.mode || (helpers.isCardio(op.exercise_id) ? 'cardio' : 'reps'), prog: op.progression,
          ...(op.per_side ? { side: true } : {}), ...(op.position !== undefined ? { position: op.position } : {})
        })],
        // add-exercise keeps no load and no cardio target; they follow as their own changes.
        follow: [
          ...(op.weight !== undefined ? [{ op: 'update_exercise', routine_id: op.routine_id, exercise_id: op.exercise_id, weight: op.weight }] : []),
          ...(op.minutes !== undefined || op.speed !== undefined ? [{ op: 'update_exercise', routine_id: op.routine_id, exercise_id: op.exercise_id, minutes: op.minutes, speed: op.speed }] : [])
        ]
      };
    case 'swap_exercise':
      return { changes: [t('swap-exercise', T(), { id: op.new_exercise_id, sets: op.sets, reps: op.reps, weight: op.weight })] };
    case 'remove_exercise':
      return { changes: [t('remove-exercise', T(), null)] };
    case 'reorder_exercises':
      return { changes: [t('reorder', { routineId: op.routine_id }, op.exercise_ids)] };
    case 'link_superset':
      return { changes: [t('superset', T(), { link: true, with: op.with_exercise_id })] };
    case 'unlink_superset':
      return { changes: [t('superset', T(), { link: false })] };
    case 'rename_routine':
      return { changes: [t('rename-routine', { routineId: op.routine_id }, cleanName(op.name))] };
    case 'set_routine_progression':
      return { changes: [t('routine-prog', { routineId: op.routine_id }, op.progression)] };
    case 'schedule_day':
      return { changes: [t('week', { weekday: op.weekday }, op.routine_id == null ? 'rest' : op.routine_id)] };
    case 'remove_routine':
      return { changes: [t('remove-routine', { routineId: op.routine_id }, null)] };
    case 'create_routine': {
      const rid = op._rid;
      const exercises = op.exercises || [];
      const follow = [];
      exercises.forEach(e => {
        const f = {};
        if (e.weight !== undefined) f.weight = e.weight;
        if (e.reps_min !== undefined) f.reps_min = e.reps_min;
        if (e.minutes !== undefined) f.minutes = e.minutes;
        if (e.speed !== undefined) f.speed = e.speed;
        if (e.increment !== undefined) f.increment = e.increment;
        if (e.progression !== undefined) f.progression = e.progression;
        if (Object.keys(f).length) follow.push({ op: 'update_exercise', routine_id: rid, exercise_id: e.exercise_id, ...f });
      });
      for (const d of [...new Set(op.weekdays || [])]) follow.push({ op: 'schedule_day', weekday: d, routine_id: rid });
      return {
        changes: [{
          ...t('add-routine', {}, {
            name: cleanName(op.name), emoji: op.icon, prog: op.progression,
            ex: exercises.map(e => ({
              id: e.exercise_id, sets: e.sets, reps: e.reps, sec: e.seconds, repsMax: e.reps_max,
              mode: e.mode || (helpers.isCardio(e.exercise_id) ? 'cardio' : 'reps'), ...(e.per_side ? { side: true } : {})
            }))
          }),
          _rid: rid
        }],
        follow
      };
    }
    default:
      return { error: `${where}: unknown operation` };
  }
}

// The plan the Coach's validator is shown: the routines the changes name (so its own 7-routine
// cap, meant for a whole created plan, does not refuse an edit to a profile that has more).
function planFor(s, changes) {
  const ids = new Set();
  for (const c of changes) {
    if (c.target?.routineId) ids.add(c.target.routineId);
    if (c.type === 'week' && typeof c.after === 'string') ids.add(c.after);
  }
  return { routines: s.routines.filter(r => ids.has(r.id)), week: s.week };
}

function checkWeight(c, s) {
  const r = routineOf(s, c.target?.routineId);
  if (!r) return `routine "${c.target?.routineId}" is not one of the profile's routines`;
  const e = (r.ex || []).find(x => x.id === c.target?.exId);
  if (!e) return `exercise "${c.target?.exId}" is not in routine "${r.name}"`;
  if ((e.mode || (helpers.isCardio(e.id) ? 'cardio' : 'reps')) === 'cardio') return `"${exNameOf(e.id, s)}" is cardio and has no weight`;
  const bad = weightError(s.unit || 'kg', c.after, `weight for "${exNameOf(e.id, s)}"`);
  if (bad) return bad;
  return null;
}

/* ---------- preview ---------- */

/**
 * → { ok:true, changes, lines, tier, ... } | { ok:false, errors }.
 * `ops` is the tool's validated input; `newId` names routines the preview creates.
 */
export function previewPlan(S, ops, { newId = helpers.uid } = {}) {
  const errors = [];
  if (!Array.isArray(ops) || !ops.length) return { ok: false, errors: ['operations must list at least one operation'] };
  if (ops.length > MAX_OPS) return { ok: false, errors: [`at most ${MAX_OPS} operations in one preview — split the request`] };
  const s = scratchOf(S);
  const unit = S?.unit === 'lb' ? 'lb' : 'kg';
  s.unit = unit;
  const customIds = s.customEx.filter(isObj).map(c => c.id).filter(Boolean);
  const applied = [];
  const notes = [];
  const queue = ops.map((op, i) => ({ op: op.op === 'create_routine' ? { ...op, _rid: newId() } : op, i }));
  while (queue.length) {
    const { op, i } = queue.shift();
    const res = changesFor(op, s, i);
    if (res.error) { errors.push(res.error); continue; }
    if (res.follow?.length) queue.unshift(...res.follow.map(f => ({ op: f, i })));
    const weights = res.changes.filter(c => c.type === 'weight');
    const coach = res.changes.filter(c => c.type !== 'weight');
    let ok = [];
    if (coach.length) {
      const v = validateReview({ changes: coach }, planFor(s, coach), { customIds });
      if (!v.ok) { errors.push(...v.errors.map(e => `operations[${i}] (${op.op}): ${e}`)); continue; }
      if (v.nochange) { notes.push(`operations[${i}] (${op.op}) changes nothing: the plan already says that`); }
      else {
        ok = v.proposal.changes.map(c => {
          const orig = coach.find(x => x.id === c.id || c.id.startsWith(x.id));
          return c.type === 'add-routine' ? { ...c, after: { ...c.after, id: orig?._rid } } : c;
        });
      }
    }
    let bad = false;
    for (const c of weights) {
      const err = checkWeight(c, s);
      if (err) { errors.push(`operations[${i}] (${op.op}): ${err}`); bad = true; continue; }
      const cur = (routineOf(s, c.target.routineId).ex || []).find(x => x.id === c.target.exId)?.weight ?? null;
      if (cur === c.after) notes.push(`operations[${i}]: the weight is already ${c.after} ${unit}`);
      else ok.push({ ...c, before: cur, routineName: routineOf(s, c.target.routineId).name });
    }
    if (bad) continue;
    try { applyChanges(s, ok); } catch (e) { errors.push(`operations[${i}] (${op.op}) cannot be applied: ${e.message}`); continue; }
    applied.push(...ok);
  }
  if (applied.length > MAX_CHANGES) errors.push(`this comes to ${applied.length} changes, more than the ${MAX_CHANGES} one preview may hold — split the request`);
  if (s.routines.length > Math.max(MAX_ROUTINES, (S?.routines || []).length)) errors.push(`the plan would hold ${s.routines.length} routines, more than ${MAX_ROUTINES}`);
  for (const r of s.routines) {
    const before = (S?.routines || []).find(x => x && x.id === r.id);
    if (r.ex.length > MAX_EX_PER_ROUTINE && r.ex.length > (before?.ex?.length || 0)) errors.push(`routine "${r.name}" would hold ${r.ex.length} exercises, more than ${MAX_EX_PER_ROUTINE}`);
  }
  if (errors.length) return { ok: false, errors, notes };
  if (!applied.length) return { ok: true, nochange: true, notes };
  const diff = diffPlans(S, s, unit);
  return {
    ok: true,
    changes: applied,
    lines: diff.lines,
    removals: diff.removals,
    routines_touched: diff.touched,
    tier: tierOf(applied, diff),
    schedule: scheduleOf(S, s, diff.touchedIds),
    notes,
    baseHash: planHashOf(S),
    afterHash: planHashOf(s)
  };
}

/** What the apply will change, as lines a person reads, worked out from the two plans. */
export function diffPlans(S, s, unit) {
  const lines = [], removals = [];
  const touched = new Set();
  const nameOfR = (plan, id) => routineOf(plan, id)?.name || id;
  const oldPlan = scratchOf(S);
  const pres = e => helpers.prescription(e, unit);
  for (const r of s.routines) {
    const o = routineOf(oldPlan, r.id);
    if (!o) {
      touched.add(r.id);
      lines.push(`New routine “${r.name}”: ${r.ex.map(e => `${exNameOf(e.id, s)} ${pres(e)}`).join('; ')}`);
      continue;
    }
    if (o.name !== r.name) { touched.add(r.id); lines.push(`Rename routine “${o.name}” → “${r.name}”`); }
    if ((o.prog || null) !== (r.prog || null)) { touched.add(r.id); lines.push(`“${r.name}”: progression ${o.prog || 'default'} → ${r.prog || 'default'}`); }
    const oIds = o.ex.map(e => e.id), nIds = r.ex.map(e => e.id);
    // An exercise gone from a slot that a new one now holds was replaced (swap-exercise), which
    // keeps the slot's prescription and is not a removal.
    const replaced = new Map();
    o.ex.forEach((e, i) => {
      const inSlot = r.ex[i];
      if (!nIds.includes(e.id) && inSlot && !oIds.includes(inSlot.id) && !replaced.has(inSlot.id)) replaced.set(inSlot.id, e);
    });
    const replacing = new Set([...replaced.values()].map(e => e.id));
    for (const e of o.ex) {
      if (!nIds.includes(e.id) && !replacing.has(e.id)) {
        touched.add(r.id);
        const line = `“${r.name}”: remove ${exNameOf(e.id, s)} (${pres(e)})`;
        lines.push(line);
        removals.push(line);
      }
    }
    for (const e of r.ex) {
      const prev = o.ex.find(x => x.id === e.id);
      if (!prev && replaced.has(e.id)) {
        const was = replaced.get(e.id);
        touched.add(r.id);
        lines.push(`“${r.name}”: replace ${exNameOf(was.id, s)} (${pres(was)}) with ${exNameOf(e.id, s)} — ${pres(e)}`);
        continue;
      }
      if (!prev) { touched.add(r.id); lines.push(`“${r.name}”: add ${exNameOf(e.id, s)} — ${pres(e)}`); continue; }
      const a = pres(prev), b = pres(e);
      const same = JSON.stringify(prev) === JSON.stringify(e);
      if (!same) {
        touched.add(r.id);
        const what = a !== b ? `${a} → ${b}` : describeFieldChange(prev, e, unit);
        lines.push(`“${r.name}” · ${exNameOf(e.id, s)}: ${what}`);
      }
    }
    const kept = nIds.filter(id => oIds.includes(id));
    if (kept.join() !== oIds.filter(id => nIds.includes(id)).join()) { touched.add(r.id); lines.push(`“${r.name}”: new exercise order — ${r.ex.map(e => exNameOf(e.id, s)).join(', ')}`); }
  }
  for (const o of oldPlan.routines) {
    if (!routineOf(s, o.id)) {
      touched.add(o.id);
      const line = `Remove routine “${o.name}” (${o.ex.length} exercises; its logged workouts stay in history)`;
      lines.push(line);
      removals.push(line);
    }
  }
  for (let d = 0; d < 7; d++) {
    const a = [].concat(oldPlan.week[d] || []), b = [].concat(s.week[d] || []);
    if (a.join('+') !== b.join('+')) {
      const show = (plan, ids) => (ids.length ? ids.map(id => `“${nameOfR(plan, id)}”`).join(' + ') : 'rest');
      lines.push(`${WEEKDAY[d]}s: ${show(oldPlan, a)} → ${show(s, b)}`);
    }
  }
  return { lines, removals, touched: [...touched].map(id => ({ id, name: nameOfR(s, id) === id ? nameOfR(oldPlan, id) : nameOfR(s, id) })), touchedIds: [...touched] };
}

function describeFieldChange(a, b, unit) {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'id' || JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    const label = { sg: 'superset', inc: 'increment', prog: 'progression', repsMin: 'reps min', repsMax: 'reps max', sec: 'seconds' }[k] || k;
    const v = x => (x === undefined || x === null || x === '' ? 'none' : k === 'sg' ? 'linked' : k === 'inc' || k === 'weight' ? `${x} ${unit}` : String(x));
    out.push(`${label} ${v(a[k])} → ${v(b[k])}`);
  }
  return out.join(', ') || 'updated';
}

// Destructive: something is removed from the plan. Bulk: many changes, or many existing routines.
export function tierOf(changes, diff) {
  if (changes.some(c => c.type === 'remove-exercise' || c.type === 'remove-routine')) return 'destructive';
  const existing = new Set(changes.filter(c => c.type !== 'add-routine' && c.target?.routineId).map(c => c.target.routineId));
  if (changes.length > BULK_CHANGES || existing.size > BULK_ROUTINES) return 'bulk';
  return diff.removals.length ? 'destructive' : 'ordinary';
}

// When the touched routines come up next, so "change tomorrow's bench press" can be checked
// against what the change really edits: the routine, every session of it from now on.
function scheduleOf(S, s, ids) {
  if (!ids.length) return [];
  const today = helpers.todayFor(S || {});
  const out = new Map(ids.map(id => [id, []]));
  const after = { ...(S || {}), routines: s.routines, week: s.week, dayPlan: s.dayPlan, workouts: S?.workouts || [] };
  for (let i = 0; i < 14; i++) {
    const iso = helpers.addDays(today, i);
    for (const id of helpers.routineIdsOn(after, iso)) if (out.has(id)) out.get(id).push(iso);
  }
  return [...out.entries()].map(([id, dates]) => ({ routine_id: id, routine_name: routineOf(s, id)?.name || null, next_dates: dates.slice(0, 4) }));
}

/* ---------- apply and undo ---------- */

export class StaleError extends Error {
  constructor(message) { super(message); this.code = 'stale'; }
}

/** The document after `preview` is applied, with what an undo needs. Throws StaleError. */
export function applyPlan(S, preview) {
  if (planHashOf(S) !== preview.baseHash) {
    throw new StaleError('the plan changed since this preview (edited in the app, on another device or by another assistant) — preview the change again');
  }
  const next = clone(S || {});
  const dayBefore = clone(isObj(next.dayPlan) ? next.dayPlan : {});
  applyChanges(next, preview.changes);
  const dayPlanDropped = {};
  for (const [iso, v] of Object.entries(dayBefore)) if (!(iso in next.dayPlan)) dayPlanDropped[iso] = v;
  return {
    next,
    undo: { routines: clone(S?.routines || []), week: clone(isObj(S?.week) ? S.week : {}), dayPlanDropped },
    afterHash: planHashOf(next)
  };
}

/** The document with a plan change taken back, or a StaleError when the plan moved on since. */
export function undoPlan(S, record) {
  if (planHashOf(S) !== record.afterHash) {
    throw new StaleError('the plan has changed since this change was applied, so undoing it would also throw away those later edits — undo the later changes first, or make the edit again by hand');
  }
  const next = clone(S || {});
  next.routines = clone(record.undo.routines);
  next.week = clone(record.undo.week);
  next.dayPlan = { ...(isObj(next.dayPlan) ? next.dayPlan : {}), ...(record.undo.dayPlanDropped || {}) };
  return next;
}

/* ---------- logging a workout ---------- */

export const MAX_LOG_ENTRIES = 20;
export const MAX_LOG_SETS = 20;

// Epoch of a wall-clock time on a date in a time zone, without a library: guess UTC, then correct
// by the zone's offset at that instant (twice, for a guess that landed across a DST change).
export function zonedEpoch(iso, hhmm, tz) {
  const [y, mo, d] = iso.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  if (!tz) return new Date(y, mo - 1, d, h, mi).getTime();
  let t = want;
  for (let k = 0; k < 2; k++) {
    let parts;
    try {
      parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
        .formatToParts(new Date(t)).map(p => [p.type, p.value]));
    } catch { return new Date(y, mo - 1, d, h, mi).getTime(); }
    const seen = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    t += want - seen;
  }
  return t;
}

/** → { ok, workout, lines, warnings } | { ok:false, errors }. */
export function previewWorkout(S, input, { newId = helpers.uid, now = Date.now() } = {}) {
  const errors = [], warnings = [];
  const S0 = S || {};
  const unit = S0.unit === 'lb' ? 'lb' : 'kg';
  const today = helpers.todayFor(S0, new Date(now));
  if (input.date > today) errors.push(`date ${input.date} is in the future (today is ${today} for this profile)`);
  if (input.date < '2000-01-01') errors.push('date is before 2000');
  const routines = Array.isArray(S0.routines) ? S0.routines.filter(isObj) : [];
  const routine = input.routine_id ? routines.find(r => r.id === input.routine_id) : null;
  if (input.routine_id && !routine) errors.push(`routine "${input.routine_id}" is not one of the profile's routines`);
  const tz = S0.reminder?.tz || null;
  const start = zonedEpoch(input.date, input.start_time || '18:00', tz);
  const end = start + input.duration_min * 60000;
  if (end > now) errors.push('the workout would end in the future — use an earlier start time');
  const entries = [];
  input.exercises.forEach((e, i) => {
    const where = `exercises[${i}]`;
    if (!helpers.isKnownExercise(e.exercise_id, S0)) { errors.push(`${where}: "${e.exercise_id}" is not an exercise in the library or the profile's own — resolve it with search_exercises`); return; }
    const planned = routine ? (routine.ex || []).find(x => x.id === e.exercise_id) : null;
    const mode = e.sets.some(x => x.minutes != null || x.speed != null) ? 'cardio' : e.sets.some(x => x.seconds != null) ? 'time' : 'reps';
    const sets = [];
    e.sets.forEach((x, j) => {
      const at = `${where}.sets[${j}]`;
      if (x.weight != null) { const bad = weightError(unit, x.weight === 0 ? 0.01 : x.weight, at); if (bad) { errors.push(bad); return; } }
      if (mode === 'cardio') {
        if (!(x.minutes > 0)) { errors.push(`${at}: cardio sets need minutes`); return; }
        sets.push({ min: x.minutes, speed: x.speed || 0, done: true });
      } else if (mode === 'time') {
        if (!(x.seconds > 0)) { errors.push(`${at}: timed sets need seconds`); return; }
        sets.push({ sec: x.seconds, w: x.weight || 0, done: true });
      } else {
        if (!(x.reps >= 0)) { errors.push(`${at}: sets need reps`); return; }
        sets.push({ w: x.weight || 0, r: x.reps, done: true, ...(x.rir != null ? { rir: x.rir } : {}) });
      }
    });
    if (entries.some(en => en.id === e.exercise_id)) { errors.push(`${where}: "${e.exercise_id}" is listed twice — put all its sets in one entry`); return; }
    const target = planned ? { ...planned } : { id: e.exercise_id, sets: sets.length, mode, ...(mode === 'reps' ? { reps: sets[0]?.r || 0 } : mode === 'time' ? { sec: sets[0]?.sec || 0 } : { min: sets[0]?.min || 0 }) };
    delete target.sg;
    entries.push({ id: e.exercise_id, sets, target, ...(routine ? { rid: routine.id } : {}), ...(e.note ? { note: String(e.note).slice(0, 500) } : {}) });
  });
  if (errors.length) return { ok: false, errors };
  const same = (S0.workouts || []).filter(w => w && w.d === input.date);
  if (same.length) warnings.push(`${same.length} workout(s) already logged on ${input.date} (${same.map(w => w.name || 'workout').join(', ')}); this adds another, it does not replace them`);
  const workout = helpers.buildCompletedWorkout({
    id: newId(), d: input.date, start,
    routineIds: routine ? [routine.id] : [],
    name: cleanName(input.name) || routine?.name || 'Freestyle',
    bw: input.bodyweight || null,
    entries,
    note: input.note ? String(input.note).slice(0, 500) : ''
  }, { end, prs: [] });
  const lines = workout.entries.map(en => `${exNameOf(en.id, S0)}: ${en.sets.map(x => (x.min != null ? `${x.min} min` : x.sec != null ? `${x.sec}s${x.w ? ` @ ${x.w} ${unit}` : ''}` : `${x.r}${x.w ? ` × ${x.w} ${unit}` : ' reps'}`)).join(', ')}`);
  return { ok: true, workout, lines, warnings, volume: helpers.workoutVolume(workout), sets_done: helpers.setsDone(workout), unit };
}

export function applyWorkout(S, preview) {
  const next = clone(S || {});
  const list = Array.isArray(next.workouts) ? next.workouts : [];
  if (list.some(w => w && w.id === preview.workout.id)) return { next: null, already: true };
  next.workouts = helpers.insertChronological(list, clone(preview.workout));
  return { next };
}

export function undoWorkout(S, record) {
  const list = Array.isArray(S?.workouts) ? S.workouts : [];
  if (!list.some(w => w && w.id === record.workoutId)) return { next: null, gone: true };
  const next = clone(S);
  next.workouts = list.filter(w => !(w && w.id === record.workoutId));
  return { next };
}

export { COACH_TYPES };
