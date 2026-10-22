/* Applying a validated change list to a profile document, on the server.
 *
 * Hand-copied from CHANGE_APPLY in frontend/src/lib/coach.js (which cannot be imported here: it
 * pulls in the app's i18n and React), like queue.js and sync-stamps.js are, and pinned to it by
 * frontend/src/lib/mcp-apply-parity.test.js: the same change applied by the Coach in the app and
 * by an assistant through the hosted MCP endpoint leaves the same plan. Three differences, each
 * on purpose and each covered by that test:
 *
 *   - `weight` is a change type here and not in the Coach's list: the routine's own target
 *     weight, the field the routine editor sets and the progression engine starts from when the
 *     plan changed (progression.js "Plan changed, so starting from your new target").
 *   - `add-routine` takes the routine id the preview chose (`after.id`), so the changes listed
 *     after it in the same preview, and the undo record, can name the routine before it exists.
 *   - the app's helpers (`cleanupSg`, `deleteRoutine`, `canonicalExId`, `uid`) are passed in, not
 *     imported: here they come from the bundled app code (read-tools.gen.js), in the parity test
 *     from frontend/src/lib directly.
 *
 * Every function mutates `s`, a private copy of the document; a throw part-way leaves the caller
 * holding a copy it simply does not save, so an apply is all or nothing. */

export const POLICIES = ['off', 'linear', 'greyskull', 'double', 'triple', 'time'];

const findRoutine = (s, id) => (s.routines || []).find(r => r && r.id === id) || null;
const findEx = (r, id) => (r?.ex || []).find(e => e && e.id === id) || null;
function need(x) { if (!x) throw new Error('missing target'); return x; }

export function createApplier({ cleanupSg, deleteRoutine, canonicalExId, uid }) {
  const findExIn = (s, c) => findEx(findRoutine(s, c.target.routineId), c.target.exId);
  const APPLY = {
    'add-exercise': (s, c) => {
      const r = need(findRoutine(s, c.target.routineId));
      const a = c.after || {};
      const e = { id: canonicalExId(a.id), sets: a.sets || 3, mode: a.mode || 'reps' };
      if (e.mode === 'cardio') { e.min = a.min || 20; e.speed = a.speed || 8; }
      else if (e.mode === 'time') e.sec = a.sec || 45;
      else e.reps = a.reps || 10;
      if (a.weight > 0) e.weight = a.weight;
      if (POLICIES.includes(a.prog)) e.prog = a.prog;
      if (Number.isInteger(a.repsMin)) e.repsMin = a.repsMin;
      if (Number.isInteger(a.repsMax)) e.repsMax = a.repsMax;
      if (Number.isInteger(a.setsMax)) e.setsMax = a.setsMax;
      if (a.bodyweight != null) e.bodyweight = !!a.bodyweight;
      if (a.side) e.side = true;
      const at = Number.isInteger(a.position) ? Math.min(a.position, r.ex.length) : r.ex.length;
      r.ex.splice(at, 0, e);
      cleanupSg(r.ex);
    },
    'remove-exercise': (s, c) => {
      const r = need(findRoutine(s, c.target.routineId));
      r.ex = r.ex.filter(e => e.id !== c.target.exId);
      cleanupSg(r.ex);
    },
    'swap-exercise': (s, c) => {
      const r = need(findRoutine(s, c.target.routineId));
      const i = r.ex.findIndex(e => e.id === c.target.exId);
      if (i < 0) throw new Error('missing exercise');
      const old = r.ex[i], a = c.after || {};
      const { bodyweight, side, ...keep } = old;
      r.ex[i] = { ...keep, id: canonicalExId(a.id), ...(a.sets ? { sets: a.sets } : {}), ...(a.reps ? { reps: a.reps } : {}), ...(a.weight > 0 ? { weight: a.weight } : {}) };
    },
    sets: (s, c) => { need(findExIn(s, c)).sets = c.after; },
    reps: (s, c) => { need(findExIn(s, c)).reps = c.after; },
    repsMin: (s, c) => { need(findExIn(s, c)).repsMin = c.after; },
    repsMax: (s, c) => { need(findExIn(s, c)).repsMax = c.after; },
    sec: (s, c) => { need(findExIn(s, c)).sec = c.after; },
    cardio: (s, c) => {
      const e = need(findExIn(s, c));
      if (c.after?.min != null) e.min = c.after.min;
      if (c.after?.speed != null) e.speed = c.after.speed;
    },
    inc: (s, c) => { need(findExIn(s, c)).inc = c.after; },
    weight: (s, c) => { need(findExIn(s, c)).weight = c.after; },
    'exercise-prog': (s, c) => { need(findExIn(s, c)).prog = c.after; },
    'routine-prog': (s, c) => { need(findRoutine(s, c.target.routineId)).prog = c.after; },
    reorder: (s, c) => {
      const r = need(findRoutine(s, c.target.routineId));
      const by = new Map(r.ex.map(e => [e.id, e]));
      const next = c.after.map(id => by.get(id)).filter(Boolean);
      if (next.length !== r.ex.length || new Set(next).size !== r.ex.length) throw new Error('incomplete reorder');
      r.ex = next;
      cleanupSg(r.ex);
    },
    superset: (s, c) => {
      const r = need(findRoutine(s, c.target.routineId));
      const i = r.ex.findIndex(e => e.id === c.target.exId);
      if (i < 0) throw new Error('missing exercise');
      if (!c.after?.link) { delete r.ex[i].sg; cleanupSg(r.ex); return; }
      if (c.after.with === c.target.exId) throw new Error('superset with itself');
      const j = r.ex.findIndex(e => e.id === c.after.with);
      if (j < 0) throw new Error('missing partner');
      const [partner] = r.ex.splice(j, 1);
      const at = r.ex.findIndex(e => e.id === c.target.exId);
      r.ex.splice(at + 1, 0, partner);
      const tag = uid().slice(0, 6);
      r.ex[at].sg = tag;
      r.ex[at + 1].sg = tag;
    },
    'add-routine': (s, c) => {
      const a = c.after;
      s.routines.push({
        id: a.id || uid(), name: a.name, emoji: a.emoji || '🏋️',
        ...(POLICIES.includes(a.prog) ? { prog: a.prog } : {}),
        ex: a.ex.map(e => ({
          id: canonicalExId(e.id), sets: e.sets || 3, mode: e.mode || 'reps',
          ...(e.mode === 'time' ? { sec: e.sec || 45 } : { reps: e.reps || 10 }),
          ...(Number.isInteger(e.repsMax) ? { repsMax: e.repsMax } : {}),
          ...(Number.isInteger(e.setsMax) ? { setsMax: e.setsMax } : {}),
          ...(e.bodyweight != null ? { bodyweight: !!e.bodyweight } : {}),
          ...(e.side ? { side: true } : {})
        }))
      });
    },
    'remove-routine': (s, c) => { deleteRoutine(s, c.target.routineId); },
    'rename-routine': (s, c) => { need(findRoutine(s, c.target.routineId)).name = c.after; },
    week: (s, c) => {
      const d = c.target.weekday;
      if (c.after == null || c.after === 'rest') delete s.week[d];
      else s.week[d] = [c.after];
    }
  };

  /** Applies `changes` in order to `s`. Throws on the first one that cannot be applied. */
  function applyChanges(s, changes) {
    if (!Array.isArray(s.routines)) s.routines = [];
    if (!s.week || typeof s.week !== 'object' || Array.isArray(s.week)) s.week = {};
    if (!s.dayPlan || typeof s.dayPlan !== 'object' || Array.isArray(s.dayPlan)) s.dayPlan = {};
    for (const c of changes) {
      const fn = APPLY[c.type];
      if (!fn) throw new Error('unknown change type ' + c.type);
      fn(s, c);
    }
    return s;
  }
  return { applyChanges, CHANGE_TYPES: Object.keys(APPLY) };
}
