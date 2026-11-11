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

/* ---------- what a change is about, and whether it moved ----------
   A preview is checked against, and an undo restores, only what its changes touch: the routines
   they name (or create, or schedule) and, when one reschedules or removes a routine, the week.
   Two previews about different routines therefore do not invalidate each other, while any edit
   to a routine a preview is about — in the app, on another device, by another assistant — makes
   it stale. The comparison is the whole routine as stored (name, icon, every exercise field, notes,
   set types), not the Coach's plan fingerprint, which leaves some of those out; only the sync
   stamps (`_ts`, `_f`, `_u`), which the commit adds, are ignored. */
const STAMP_KEYS = new Set(['_ts', '_f', '_u']);
const bare = v => JSON.stringify(v, (k, x) => (STAMP_KEYS.has(k) ? undefined : x));
const weekOf = S => {
  const w = {};
  for (let d = 0; d < 7; d++) { const ids = [].concat(isObj(S?.week) ? S.week[d] ?? [] : []); if (ids.length) w[d] = ids; }
  return w;
};
export function scopeOf(changes) {
  const ids = new Set();
  let week = false;
  for (const c of changes) {
    if (c.target?.routineId) ids.add(c.target.routineId);
    if (c.type === 'add-routine' && c.after?.id) ids.add(c.after.id);
    if (c.type === 'week') { week = true; if (typeof c.after === 'string' && c.after !== 'rest') ids.add(c.after); }
    if (c.type === 'remove-routine') week = true;
  }
  return { ids: [...ids].sort(), week };
}
export function scopeKey(S, scope) {
  const rs = Array.isArray(S?.routines) ? S.routines : [];
  return bare({ r: scope.ids.map(id => rs.find(r => r && r.id === id) || null), w: scope.week ? weekOf(S) : null });
}

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
  if (ops.length > MAX_OPS) return { ok: false, errors: [`at most ${MAX_OPS} operations in one preview; split the request`] };
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
  if (applied.length > MAX_CHANGES) errors.push(`this comes to ${applied.length} changes, more than the ${MAX_CHANGES} one preview may hold; split the request`);
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
    scope: scopeOf(applied),
    baseKey: scopeKey(S, scopeOf(applied))
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
        lines.push(`“${r.name}”: replace ${exNameOf(was.id, s)} (${pres(was)}) with ${exNameOf(e.id, s)}: ${pres(e)}`);
        continue;
      }
      if (!prev) { touched.add(r.id); lines.push(`“${r.name}”: add ${exNameOf(e.id, s)}: ${pres(e)}`); continue; }
      const a = pres(prev), b = pres(e);
      const same = JSON.stringify(prev) === JSON.stringify(e);
      if (!same) {
        touched.add(r.id);
        const what = a !== b ? `${a} → ${b}` : describeFieldChange(prev, e, unit);
        lines.push(`“${r.name}” · ${exNameOf(e.id, s)}: ${what}`);
      }
    }
    const kept = nIds.filter(id => oIds.includes(id));
    if (kept.join() !== oIds.filter(id => nIds.includes(id)).join()) { touched.add(r.id); lines.push(`“${r.name}”: new exercise order: ${r.ex.map(e => exNameOf(e.id, s)).join(', ')}`); }
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
  const scope = preview.scope;
  if (scopeKey(S, scope) !== preview.baseKey) {
    throw new StaleError('what this preview changes was edited since (in the app, on another device or by another assistant); preview the change again');
  }
  const next = clone(S || {});
  const dayBefore = clone(isObj(next.dayPlan) ? next.dayPlan : {});
  applyChanges(next, preview.changes);
  const dayPlanDropped = {};
  for (const [iso, v] of Object.entries(dayBefore)) if (!(iso in next.dayPlan)) dayPlanDropped[iso] = v;
  const rs = Array.isArray(S?.routines) ? S.routines : [];
  const before = {};
  for (const id of scope.ids) {
    const index = rs.findIndex(r => r && r.id === id);
    before[id] = index < 0 ? null : { index, routine: clone(rs[index]) };
  }
  return {
    next,
    undo: { scope, before, ...(scope.week ? { week: clone(isObj(S?.week) ? S.week : {}) } : {}), dayPlanDropped },
    afterKey: scopeKey(next, scope)
  };
}

/** The document with a plan change taken back, or a StaleError when what it touched moved on since. */
export function undoPlan(S, record) {
  const { scope, before } = record.undo;
  if (scopeKey(S, scope) !== record.afterKey) {
    throw new StaleError('what this change touched has been edited since, so undoing it would also throw away those later edits; undo the later changes first, or make the edit again by hand');
  }
  const next = clone(S || {});
  if (!Array.isArray(next.routines)) next.routines = [];
  for (const id of scope.ids) {
    const at = next.routines.findIndex(r => r && r.id === id);
    const was = before[id];
    if (!was) { if (at >= 0) next.routines.splice(at, 1); continue; }
    if (at >= 0) next.routines[at] = clone(was.routine);
    else next.routines.splice(Math.min(was.index, next.routines.length), 0, clone(was.routine));
  }
  if (scope.week) next.week = clone(record.undo.week);
  if (!isObj(next.dayPlan)) next.dayPlan = {};
  // Reschedules the change dropped come back, unless the day has been planned anew since.
  for (const [iso, v] of Object.entries(record.undo.dayPlanDropped || {})) if (!(iso in next.dayPlan)) next.dayPlan[iso] = v;
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

// The tool's snake_case input as the description frontend/src/lib/log-workout.js reads.
// `exercise_id` is the name this tool's input had before names were accepted; it is an exercise
// reference like any other.
const describedAs = input => ({
  date: input.date,
  start: input.start_time,
  durationMin: input.duration_min,
  name: input.name,
  note: input.note,
  unit: input.unit,
  routineId: input.routine_id,
  bodyweight: input.bodyweight,
  exercises: (input.exercises || []).map(e => ({
    exercise: e.exercise ?? e.exercise_id,
    note: e.note,
    sets: (e.sets || []).map(s => ({
      reps: s.reps, seconds: s.seconds, minutes: s.minutes, speed: s.speed, level: s.level,
      weight: s.weight, warmup: s.warmup, failure: s.failure, rir: s.rir, rpe: s.rpe
    }))
  }))
});

// One problem the way the assistant has to put it to the user: where, what, and the choices.
const problemLine = p => {
  const what = p.exercise != null ? `${p.field} "${p.exercise}"` : p.field;
  const choices = (p.candidates || []).map(c => `${c.id} ${cap(c.name)}${c.equipment ? ` (${c.equipment})` : ''}`);
  return `${what}: ${p.problem}${choices.length ? `. Candidates: ${choices.join('; ')}` : ''}`;
};

const setLine = (x, unit) => {
  const tail = [x.phase === 'warmup' ? 'warm-up' : '', x.failure ? 'to failure' : '', x.rir != null ? `RIR ${x.rir}` : '', x.rpe != null ? `RPE ${x.rpe}` : ''].filter(Boolean).join(', ');
  const main = x.min != null
    ? `${x.min} min${x.level ? ` at level ${x.level}` : x.speed ? ` at ${x.speed} km/h` : ''}`
    : x.sec != null ? `${x.sec}s${x.w ? ` @ ${x.w} ${unit}` : ''}`
      : `${x.r}${x.w ? ` × ${x.w} ${unit}` : ' reps'}`;
  return tail ? `${main} (${tail})` : main;
};

/**
 * What the workout an assistant describes would be, against the profile as it stands: the
 * workout, a line per exercise, and what each name was taken to mean. Nothing is saved.
 *
 * → { ok: true, workout, past, lines, resolved, warnings, prs, unit, volume, sets_done, duplicate }
 * | { ok: false, problems, errors }. `duplicate` is the workout already in the history this one
 * repeats (`same_request`: the same description; else the same sets on the same day).
 */
export function previewWorkout(S, input, { now = Date.now() } = {}) {
  const S0 = S || {};
  const tz = S0.reminder?.tz || null;
  const today = helpers.todayFor(S0, new Date(now));
  const described = describedAs({ ...input, date: input.date || today });
  const built = helpers.buildLoggedWorkout(S0, described, { now, today, at: (iso, hhmm) => zonedEpoch(iso, hhmm, tz) });
  if (built.problems) return { ok: false, problems: built.problems, errors: built.problems.map(problemLine) };
  const { workout } = built;
  const unit = built.unit;
  const warnings = [];
  const notes = [];
  for (const r of built.resolved) {
    const was = String(r.input ?? '').trim();
    if (r.merged_from) notes.push(`"${was}" was merged into ${cap(r.name)} in the app, so it is logged there`);
    else if (was && was !== r.id && was.toLowerCase() !== String(r.name).toLowerCase()) notes.push(`"${was}" was taken as ${cap(r.name)} (${r.id}); if the user meant another variant, ask and pass its id`);
    if (r.weightMeans) notes.push(`${cap(r.name)}: the weight is ${r.weightMeans === 'each' ? 'per dumbbell' : 'both dumbbells together'}, as this profile logs it`);
  }
  const dup = helpers.findDuplicate(S0, workout);
  const same = (Array.isArray(S0.workouts) ? S0.workouts : []).filter(w => w && w.d === workout.d && (!dup || w.id !== dup.workout.id));
  if (same.length) warnings.push(`${same.length} other workout(s) already logged on ${workout.d} (${same.map(w => w.name || 'workout').join(', ')}); this adds another, it does not replace them`);
  // The badges it would get if nothing else is logged before it is saved (they are worked out
  // again when it is saved).
  const trial = clone(S0);
  const filed = dup ? null : helpers.appendLoggedWorkout(trial, built, { now });
  const prs = filed?.added ? (filed.workout.prs || []).map(id => cap(exNameOf(id, S0))) : [];
  const lines = workout.entries.map(en => `${cap(exNameOf(en.id, S0))}: ${en.sets.map(x => setLine(x, unit)).join(', ')}`);
  return {
    ok: true, workout, past: built.past, lines, resolved: built.resolved, warnings, notes, prs, unit,
    volume: helpers.workoutVolume(workout), sets_done: helpers.setsDone(workout),
    duplicate: dup ? { workout_id: dup.workout.id, date: dup.workout.d, name: dup.workout.name || null, same_request: dup.sameRequest } : null
  };
}

/**
 * File a previewed workout into the profile as it is now. → { next, filed } to commit, or
 * { duplicate } when the history already has it (nothing to write). Throws StaleError when the
 * profile switched kg and lb since the preview: its weights were read in the other unit.
 */
export function applyWorkout(S, preview, { now = Date.now() } = {}) {
  const cur = S || {};
  if ((cur.unit === 'lb' ? 'lb' : 'kg') !== preview.unit) throw new StaleError('the profile switched between kg and lb since this preview, so its weights would be read wrongly; preview the workout again');
  const next = clone(cur);
  const filed = helpers.appendLoggedWorkout(next, { workout: preview.workout, past: preview.past }, { now, allowDuplicate: preview.allowDuplicate === true });
  if (!filed.added) return { duplicate: { workout_id: filed.workout.id, date: filed.workout.d, same_request: filed.sameRequest } };
  return { next, filed, prs: (filed.workout.prs || []).map(id => exNameOf(id, next)) };
}

/** Take a logged workout back out: { next } to commit, or { gone: true }. */
export function undoWorkout(S, record) {
  // A journal entry from before undo carried what logging changed has only the workout's id.
  const r = helpers.removeLoggedWorkout(S || {}, record.undo || { workoutId: record.workoutId });
  return r.gone ? { next: null, gone: true } : { next: r.next };
}

export { COACH_TYPES };
