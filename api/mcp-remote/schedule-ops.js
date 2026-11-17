/* One-time schedule changes an assistant may make: moving a missed session forward, assigning a
 * routine (or rest) to specific dates, and answering a missed day (skipped / kept).
 *
 * Pure, like plan-ops.js: the caller (tools.js) holds the previews and commits through the same
 * path PUT /api/data uses. The planning is the app's own (frontend/src/lib/reschedule.js, through
 * read-tools.gen.js `helpers`), so what an assistant previews is what the Home screen's Reschedule
 * would do. Only per-date overrides (`S.dayPlan`) and the missed-day answers (`S.missedDays`) are
 * written: never the weekly plan, a routine or a logged workout, and never a date before today or
 * one that already has a workout logged.
 *
 * Staleness is scoped to the dates a change touches: their override, their missed-day answer and
 * the workouts logged on them. A workout logged on one of those dates since the preview, or the
 * day changed on a device, makes the apply refuse; changes to other dates do not. */
import { helpers } from './read-tools.gen.js';
import { StaleError } from './plan-ops.js';

export const MAX_SCHEDULE_DATES = 28;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const dayLabel = iso => `${WEEKDAY[new Date(iso + 'T12:00:00Z').getUTCDay()]} ${iso}`;

/** What a change to `dates` depends on, as a string to compare. */
export function scheduleKey(S, dates) {
  const plan = isObj(S?.dayPlan) ? S.dayPlan : {};
  const missed = isObj(S?.missedDays) ? S.missedDays : {};
  const workouts = Array.isArray(S?.workouts) ? S.workouts.filter(w => w && typeof w === 'object') : [];
  return JSON.stringify(dates.map(iso => {
    const m = missed[iso];
    return [
      iso,
      Object.hasOwn(plan, iso) ? plan[iso] : null,
      isObj(m) && m.act ? [m.act, m.to || null] : null,
      workouts.filter(w => w.d === iso).map(w => w.id ?? w.start ?? null)
    ];
  }));
}

/**
 * Validates and plans a schedule change. `input` is one of
 *   { reschedule_missed: { missed_dates?, from?, until?, use_rest_days? } }
 *   { assignments: [{ date, routine_id | 'rest' | null }], answers?: [{ date, act }] }
 *   { answers: [{ date, act: 'skipped' | 'kept' }] }
 * Returns { ok, errors } or { ok: true, nochange } or the preview the apply takes.
 */
export function previewSchedule(S, input) {
  const doc = S || {};
  const routines = Array.isArray(doc.routines) ? doc.routines : [];
  const nameOf = id => routines.find(r => r && r.id === id)?.name || id;
  const label = ids => (ids.length ? ids.map(nameOf).join(' + ') : 'Rest');
  let p;
  if (input.reschedule_missed) {
    const r = input.reschedule_missed;
    if (input.assignments) return { ok: false, errors: ['give reschedule_missed or assignments, not both'] };
    p = helpers.planReschedule(doc, { missed: r.missed_dates, from: r.from, until: r.until, fillRest: r.use_rest_days === true });
  } else {
    p = helpers.planAssignments(doc, input.assignments || [], { answers: input.answers || [] });
  }
  if (!p.ok) return { ok: false, errors: p.errors };
  if (!helpers.planChanges(p)) return { ok: true, nochange: true, warnings: p.warnings.map(w => w.message) };
  const dates = [...new Set([...p.days.map(d => d.date), ...Object.keys(p.writes), ...Object.keys(p.resolutions)])].sort();
  if (dates.length > MAX_SCHEDULE_DATES) return { ok: false, errors: [`at most ${MAX_SCHEDULE_DATES} dates in one change`] };
  const lines = [];
  for (const d of p.days) {
    if (!(d.date in p.writes)) continue;
    lines.push(`${dayLabel(d.date)}: ${label(d.before)} → ${label(d.after)}${d.moved_from ? ` (from ${d.moved_from})` : ''}`);
  }
  for (const [iso, r] of Object.entries(p.resolutions).sort()) {
    const was = label(helpers.scheduleDay(doc, iso).planned);
    lines.push(r.act === 'moved' ? `${dayLabel(iso)}: missed ${was}, rescheduled to ${r.to}`
      : r.act === 'skipped' ? `${dayLabel(iso)}: missed ${was}, skipped (not made up)`
        : `${dayLabel(iso)}: missed ${was}, schedule kept as it is`);
  }
  return {
    ok: true,
    writes: p.writes, resolutions: p.resolutions, dates,
    baseKey: scheduleKey(doc, dates),
    lines,
    days: p.days.map(d => ({ date: d.date, before: d.before.map(nameOf), after: (d.fixed ? d.before : d.after).map(nameOf), changed: d.date in p.writes, ...(d.fixed ? { already_trained: true } : {}), ...(d.moved_from ? { moved_from: d.moved_from } : {}) })),
    not_made_up: (p.dropped || []).map(d => ({ routine: nameOf(d.routine_id), planned_on: d.planned_on, missed: d.missed })),
    already_done: (p.alreadyDone || []).map(a => ({ routine: nameOf(a.routine_id), missed_on: a.missed_on, done_on: a.done_on })),
    warnings: p.warnings.map(w => w.message),
    weekly_plan_resumes: p.until ? helpers.addDays(p.until, 1) : null
  };
}

/** The document with a schedule preview applied, and what an undo needs. Throws StaleError. */
export function applySchedule(S, preview, now = Date.now()) {
  if (scheduleKey(S, preview.dates) !== preview.baseKey) {
    throw new StaleError('a date this preview changes was edited or trained since (in the app, on another device or by another assistant); preview the change again');
  }
  const next = clone(S || {});
  const plan = isObj(S?.dayPlan) ? S.dayPlan : {};
  const missed = isObj(S?.missedDays) ? S.missedDays : {};
  const before = { dayPlan: {}, missedDays: {} };
  for (const iso of preview.dates) {
    before.dayPlan[iso] = Object.hasOwn(plan, iso) ? plan[iso] : null;
    before.missedDays[iso] = Object.hasOwn(missed, iso) ? clone(missed[iso]) : null;
  }
  helpers.applyReschedule(next, { ok: true, writes: preview.writes, resolutions: preview.resolutions }, now);
  return { next, undo: { dates: preview.dates, before }, afterKey: scheduleKey(next, preview.dates) };
}

/** The document with a schedule change taken back, or a StaleError when its dates moved on since. */
export function undoSchedule(S, record, now = Date.now()) {
  const { dates, before } = record.undo;
  if (scheduleKey(S, dates) !== record.afterKey) {
    throw new StaleError('a date this change touched has been edited or trained since, so undoing it would also throw that away; change those dates in the app instead');
  }
  const next = clone(S || {});
  if (!isObj(next.dayPlan)) next.dayPlan = {};
  if (!isObj(next.missedDays)) next.missedDays = {};
  for (const iso of dates) {
    const v = before.dayPlan[iso];
    if (v == null) delete next.dayPlan[iso];
    else next.dayPlan[iso] = v;
    // Each answer carries its own edit time (sync-merge.js STAMPED_MAPS): the restored one, or a
    // cleared entry, is stamped now so a device holding the newer answer takes the undo.
    const m = before.missedDays[iso];
    if (isObj(m)) next.missedDays[iso] = { ...m, _ts: now };
    else if (Object.hasOwn(next.missedDays, iso)) next.missedDays[iso] = { _ts: now };
  }
  return next;
}
