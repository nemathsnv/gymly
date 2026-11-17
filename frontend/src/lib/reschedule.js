// One-time workout rescheduling: a missed session moved forward, the days after it shifted to
// keep their order, all of it for those dates only. The recurring week (`S.week`) is never
// touched; every change is a per-date override in the existing `S.dayPlan` (a routine id or the
// `'rest'` sentinel, lib/history.js effectiveRoutineIds), so Home, the calendar, Start, the
// reminders and the MCP all show the moved session with no reader of their own. Once the dates
// pass, the weekly plan is back in charge by itself: nothing is left to undo.
//
// What happened to a missed day is remembered per date, the way a day note is (lib/day-notes.js):
//
//   S.missedDays = { '2026-11-16': { act: 'moved', to: '2026-11-17', _ts }, … }
//
//   moved   — its session was rescheduled (to `to`);
//   skipped — let go on purpose, nothing made up; excused like a day note (no missed-day nudge);
//   kept    — "Keep schedule": nothing changed, and Gymly stops asking about it.
//
// Each entry carries its own edit time (lib/sync-merge.js STAMPED_MAPS), so two devices that each
// answered a different day keep both. Taking an answer back is a stamped empty entry.
//
// THE SHIFT (planReschedule). Missed sessions go first, in date order, followed by every session
// planned from `from` to `until` (default: the end of `from`'s week). They are laid onto the
// training days of that span in order, so each session moves forward and keeps its place in the
// sequence. A rest day stays a rest day (`fillRest` lets catch-up sessions take it instead), and
// what no longer fits before the week turns over is listed in `dropped`, never silently lost:
// the approval screen names it. A day that already has a workout logged is never reassigned and
// counts as trained; a missed session already made up on a later day is not scheduled again.
//
// Nothing here runs on its own: Home asks (Reschedule / Skip / Keep schedule), the MCP previews
// and applies only on the user's say-so.
import { isoOf, todayISO, weekStartOf, weekDayOffset } from './format.js'
import { effectiveRoutineIds } from './history.js'
import { queueLiveOn } from './queue.js'
import { excusedOn } from './day-notes.js'
import { loadOfRoutine } from './muscles.js'
import { isCardio } from './exercises.js'

export const MISSED_ACTS = ['moved', 'skipped', 'kept']
/** How far back Home looks for a missed session. */
export const MISSED_LOOKBACK_DAYS = 7
/** More training days in a row than this earns a recovery warning. */
export const MAX_TRAINING_STREAK = 5
/** The longest span one reschedule may rewrite. */
export const MAX_SPAN_DAYS = 28

const ISO = /^\d{4}-\d{2}-\d{2}$/
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
export const isIsoDate = v => typeof v === 'string' && ISO.test(v) && isoOf(new Date(v + 'T12:00:00')) === v
/** `iso` moved by `n` calendar days (local noon, so no DST edge can move the day). */
export const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoOf(d) }
const weekdayOf = iso => new Date(iso + 'T12:00:00').getDay()
const routineIdsOf = w => (Array.isArray(w?.routineIds) ? w.routineIds : (w?.routineId ? [w.routineId] : []))
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

/* ---------- the per-day answers (S.missedDays) ---------- */

/** A stored answer read back: { act, to? }, or null for none, a cleared one or junk. */
export function readMissed(entry) {
  if (!isMap(entry) || !MISSED_ACTS.includes(entry.act)) return null
  return entry.act === 'moved' && isIsoDate(entry.to) ? { act: 'moved', to: entry.to } : { act: entry.act }
}

/** The answer given for `iso`, or null. */
export const missedAnswerOf = (S, iso) => readMissed(isMap(S?.missedDays) ? S.missedDays[iso] : null)

/** Skipped or moved: the day is accounted for, so the missed-day nudge leaves it alone. */
export const resolvedOff = (S, iso) => {
  const a = missedAnswerOf(S, iso)
  return !!a && (a.act === 'skipped' || a.act === 'moved')
}

/** S.missedDays with `iso` set to `answer` ({ act, to? }), stamped `now`; null clears it (stamped). */
export function withMissed(map, iso, answer, now = Date.now()) {
  const clean = readMissed(answer)
  const entry = clean ? { ...clean, _ts: now } : { _ts: now }
  return { ...(isMap(map) ? map : {}), [iso]: entry }
}

/** Records `act` ('skipped' | 'kept') for each date on the draft `s`. */
export function answerMissed(s, isos, act, now = Date.now()) {
  if (!MISSED_ACTS.includes(act)) return
  for (const iso of [].concat(isos)) if (isIsoDate(iso)) s.missedDays = withMissed(s.missedDays, iso, { act }, now)
}

/* ---------- reading the plan ---------- */

// A profile as these helpers need it: an older or partial document must not throw.
const norm = S => ({
  ...S,
  routines: Array.isArray(S?.routines) ? S.routines.filter(r => r && r.id) : [],
  workouts: Array.isArray(S?.workouts) ? S.workouts.filter(Boolean) : [],
  week: isMap(S?.week) ? S.week : {},
  dayPlan: isMap(S?.dayPlan) ? S.dayPlan : {},
  missedDays: isMap(S?.missedDays) ? S.missedDays : {},
})

const workoutsOn = (S, iso) => S.workouts.filter(w => w.d === iso)
const hasExercises = (S, id) => (S.routines.find(r => r.id === id)?.ex || []).length > 0
/** The routines `iso` holds now, overrides included (what Home and Start show). */
const plannedOn = (S, iso, today) => effectiveRoutineIds(S, iso, today)
/** The routines the recurring week gives `iso`, its one-time override left out. */
export function weeklyOn(state, iso, today = todayISO()) {
  const S = norm(state)
  const { [iso]: _drop, ...rest } = S.dayPlan
  return effectiveRoutineIds({ ...S, dayPlan: rest }, iso, today)
}

/**
 * The scheduled sessions that went by without a workout, oldest first: [{ iso, ids }].
 *
 * Looks back `lookback` days, but never past the last day a workout was logged: once you have
 * trained again, the day before is history (still movable from its day sheet). A day is left out
 * when it has a note (lib/day-notes.js), already has an answer (moved, skipped, kept), or belongs
 * to a floating coach week or rotation (lib/queue.js), which carries an undone session forward
 * on its own. A routine with no exercises is no session (nextTrainingDay's rule).
 */
export function missedWorkouts(state, today = todayISO(), { lookback = MISSED_LOOKBACK_DAYS } = {}) {
  const S = norm(state)
  const last = S.workouts.reduce((m, w) => (typeof w.d === 'string' && w.d < today && w.d > m ? w.d : m), '')
  const out = []
  for (let i = lookback; i >= 1; i--) {
    const iso = addDays(today, -i)
    if (iso <= last || workoutsOn(S, iso).length) continue
    if (excusedOn(S, iso) || missedAnswerOf(S, iso)) continue
    if (queueLiveOn(S, iso, iso)) continue
    const ids = effectiveRoutineIds(S, iso, iso).filter(id => hasExercises(S, id))
    if (ids.length) out.push({ iso, ids })
  }
  return out
}

/** The last day of the week `iso` falls in, by the profile's first weekday. */
export const weekEndOf = (S, iso) => addDays(iso, 6 - weekDayOffset(weekdayOf(iso), weekStartOf(S)))

/* ---------- recovery checks ---------- */

// Muscles that take daily work fine (core, grip) or are not a muscle at all (a cardio entry):
// training them on consecutive days is no recovery concern, so they never raise a warning.
const RECOVER_FAST = new Set(['abs', 'obliques', 'forearm', 'cardiovascular system'])

// The muscles a routine mostly trains: those carrying at least half of its heaviest load. A
// routine that is mostly cardio counts as conditioning, not strength, and loads nothing here.
function focusOf(S, id) {
  const r = S.routines.find(x => x.id === id)
  const ex = r?.ex || []
  if (!ex.length || ex.filter(c => isCardio(c.id)).length * 2 >= ex.length) return []
  const load = loadOfRoutine(r)
  delete load['cardiovascular system']
  // Measured against the routine's whole load, core included, so a core circuit's incidental
  // leg or shoulder work does not read as its focus once the abs are set aside.
  const top = Math.max(0, ...Object.values(load))
  return top > 0 ? Object.keys(load).filter(m => load[m] >= top / 2 && !RECOVER_FAST.has(m)).sort() : []
}

/**
 * Warnings for a planned stretch of days: [{ date, ids }] in date order, plus what was trained on
 * the days just before it. `streak` — more than MAX_TRAINING_STREAK training days in a row;
 * `muscles` — two strength sessions on consecutive days that mostly train the same muscles.
 */
export function recoveryWarnings(state, days) {
  const S = norm(state)
  if (!days.length) return []
  const out = []
  const nameOf = id => S.routines.find(r => r.id === id)?.name || id
  // Days trained right before the stretch, so the run and the overlap see them.
  const lead = []
  for (let i = 1; i <= MAX_TRAINING_STREAK + 1; i++) {
    const iso = addDays(days[0].date, -i)
    const ids = [...new Set(workoutsOn(S, iso).flatMap(routineIdsOf))]
    const trained = workoutsOn(S, iso).length > 0
    lead.unshift({ date: iso, ids, trained })
    if (!trained) break
  }
  const all = [...lead, ...days.map(d => ({ ...d, trained: d.trained ?? d.ids.length > 0 }))]
  let run = 0, runStart = null, flagged = false
  for (let i = 0; i < all.length; i++) {
    const d = all[i]
    if (d.trained) { run++; if (run === 1) runStart = d.date } else { run = 0; flagged = false }
    if (run > MAX_TRAINING_STREAK && !flagged && i >= lead.length) {
      out.push({ type: 'streak', date: d.date, from: runStart, days: run, message: `${run} training days in a row from ${runStart} to ${d.date}; consider keeping a rest day.` })
      flagged = true
    }
    if (i === 0 || i < lead.length) continue
    const prev = all[i - 1]
    const a = prev.ids.flatMap(id => focusOf(S, id)), b = d.ids.flatMap(id => focusOf(S, id))
    const shared = [...new Set(a.filter(m => b.includes(m)))].sort()
    if (shared.length) {
      out.push({
        type: 'muscles', date: d.date, after: prev.date, muscles: shared,
        message: `${prev.ids.map(nameOf).join(' + ')} (${prev.date}) and ${d.ids.map(nameOf).join(' + ')} (${d.date}) both mostly train ${shared.join(', ')} on back-to-back days.`
      })
    }
  }
  return out
}

/* ---------- planning ---------- */

// The dayPlan write that makes `iso` hold `desired` ([] = rest): undefined when it already does,
// null to drop an override the weekly plan now matches, else the id or 'rest'.
function writeFor(S, iso, desired, today) {
  const current = plannedOn(S, iso, today)
  if (sameIds(current, desired)) return undefined
  if (sameIds(weeklyOn(S, iso, today), desired)) return S.dayPlan[iso] !== undefined ? null : undefined
  return desired[0] ?? 'rest'
}

const plan = fields => ({
  ok: true, errors: [], days: [], writes: {}, resolutions: {}, dropped: [], alreadyDone: [], warnings: [], ...fields,
})

/**
 * The shift for missed sessions: what each day from `from` to `until` would hold, the dayPlan
 * writes that make it so and the answers it records for the missed days. Saves nothing.
 *
 *   missed   — the missed dates (default: missedWorkouts(S, today))
 *   from     — the first day to rewrite (default today, or tomorrow when today is already trained);
 *              never before today
 *   until    — the last (default the end of `from`'s week)
 *   fillRest — let catch-up sessions take rest days instead of keeping them
 */
export function planReschedule(state, { missed, from, until, fillRest = false, today = todayISO() } = {}) {
  const S = norm(state)
  const errors = []
  const nameOf = id => S.routines.find(r => r.id === id)?.name || id
  const dates = missed == null ? missedWorkouts(S, today).map(m => m.iso) : [...new Set([].concat(missed))].sort()
  if (from == null) from = workoutsOn(S, today).length ? addDays(today, 1) : today
  if (!isIsoDate(from)) return plan({ ok: false, errors: ['from is not a date (YYYY-MM-DD)'] })
  if (from < today) errors.push(`cannot reschedule into the past (${from} is before today, ${today})`)
  if (until == null) until = weekEndOf(S, from)
  if (!isIsoDate(until)) return plan({ ok: false, errors: ['until is not a date (YYYY-MM-DD)'] })
  if (until < from) errors.push(`until (${until}) is before from (${from})`)
  if (addDays(from, MAX_SPAN_DAYS - 1) < until) errors.push(`at most ${MAX_SPAN_DAYS} days can be rescheduled at once`)
  if (!dates.length) errors.push('there is no missed workout to reschedule')

  // The sessions to place first: each missed day's, unless it was made up since.
  const queue = [], alreadyDone = [], missedOut = []
  for (const iso of dates) {
    if (!isIsoDate(iso)) { errors.push(`${iso} is not a date (YYYY-MM-DD)`); continue }
    if (iso >= from) { errors.push(`${iso} is not before ${from}: only a day already gone by can be rescheduled forward`); continue }
    if (workoutsOn(S, iso).length) { errors.push(`${iso} already has a workout logged; completed days are never rescheduled`); continue }
    const ids = effectiveRoutineIds(S, iso, iso).filter(id => hasExercises(S, id))
    if (!ids.length) { errors.push(`nothing was planned on ${iso}`); continue }
    if (ids.length > 1) { errors.push(`${iso} combines ${ids.map(nameOf).join(' + ')}; a one-time reschedule moves one routine per day, so pick the day's routine in the app`); continue }
    missedOut.push({ iso, ids })
    const doneOn = S.workouts.find(w => w.d > iso && w.d < from && routineIdsOf(w).includes(ids[0]))
    if (doneOn) alreadyDone.push({ routine_id: ids[0], missed_on: iso, done_on: doneOn.d })
    else queue.push({ id: ids[0], from: iso, missed: true })
  }
  if (errors.length) return plan({ ok: false, errors, from, until, missed: missedOut })

  const days = [], writes = {}, resolutions = {}
  for (let iso = from; iso <= until; iso = addDays(iso, 1)) {
    const before = plannedOn(S, iso, today)
    const logged = workoutsOn(S, iso)
    if (logged.length) {
      // Trained already: kept as it is, and whatever it trained is no longer owed. The day's own
      // planned session still is, unless that workout was it: it joins the shift like any other.
      const did = new Set(logged.flatMap(routineIdsOf))
      for (const id of before) queue.push({ id, from: iso })
      for (const id of did) {
        const at = queue.findIndex(q => q.id === id)
        if (at < 0) continue
        if (queue[at].missed) alreadyDone.push({ routine_id: id, missed_on: queue[at].from, done_on: iso })
        queue.splice(at, 1)
      }
      days.push({ date: iso, before, after: before, ids: [...did], trained: true, fixed: true, moved_from: null })
      continue
    }
    if (before.length > 1) return plan({ ok: false, errors: [`${iso} combines ${before.map(nameOf).join(' + ')}; shorten the span with until, or change that day in the app`], from, until, missed: missedOut })
    if (before.length) queue.push({ id: before[0], from: iso })
    const take = before.length || (fillRest && queue.some(q => q.missed)) ? queue.shift() : null
    const after = take ? [take.id] : []
    const w = writeFor(S, iso, after, today)
    if (w !== undefined) writes[iso] = w
    if (take?.missed) resolutions[take.from] = { act: 'moved', to: iso }
    days.push({ date: iso, before, after, ids: after, fixed: false, moved_from: take && take.from !== iso ? take.from : null })
  }
  const dropped = queue.map(q => ({ routine_id: q.id, planned_on: q.from, missed: !!q.missed }))
  const warnings = recoveryWarnings(S, days)
  for (const d of dropped) {
    warnings.push({ type: 'dropped', date: d.planned_on, routine_id: d.routine_id, message: d.missed
      ? `${nameOf(d.routine_id)} (missed ${d.planned_on}) does not fit before ${until}; it stays missed.`
      : `${nameOf(d.routine_id)} (planned ${d.planned_on}) no longer fits before ${until} and is not made up; the regular week resumes after.` })
  }
  return plan({ from, until, fillRest: !!fillRest, missed: missedOut, days, writes, resolutions, dropped, alreadyDone, warnings })
}

/**
 * Explicit one-time assignments: [{ date, routine_id }], routine_id a routine's id, 'rest', or
 * null for "back to the weekly plan". `answers` records what became of past missed days
 * ({ date, act }). Only today and later can be assigned, never a day that already has a workout
 * logged; a date named twice is refused. Missed days whose routine the assignments place on a
 * day that would not otherwise have it are recorded as moved there, unless `answers` says
 * otherwise. Saves nothing.
 */
export function planAssignments(state, assignments, { answers = [], today = todayISO() } = {}) {
  const S = norm(state)
  const errors = []
  const nameOf = id => S.routines.find(r => r.id === id)?.name || id
  const seen = new Set(), list = []
  for (const a of [].concat(assignments || [])) {
    const iso = a?.date
    if (!isIsoDate(iso)) { errors.push(`${iso} is not a date (YYYY-MM-DD)`); continue }
    if (seen.has(iso)) { errors.push(`${iso} is assigned twice`); continue }
    seen.add(iso)
    if (iso < today) { errors.push(`${iso} is in the past; only today (${today}) and later can be assigned`); continue }
    if (workoutsOn(S, iso).length) { errors.push(`${iso} already has a workout logged; completed days are never reassigned`); continue }
    const v = a.routine_id
    if (v != null && v !== 'rest' && !S.routines.some(r => r.id === v)) { errors.push(`${iso}: no routine with id ${v}`); continue }
    list.push({ iso, desired: v == null ? weeklyOn(S, iso, today) : v === 'rest' ? [] : [v] })
  }
  const answerFor = new Map()
  for (const a of [].concat(answers || [])) {
    if (!isIsoDate(a?.date) || !MISSED_ACTS.includes(a?.act) || a.act === 'moved') { errors.push(`answers: ${a?.date} needs act "skipped" or "kept"`); continue }
    if (a.date >= today) { errors.push(`answers: ${a.date} has not gone by yet`); continue }
    answerFor.set(a.date, a.act)
  }
  if (!list.length && !answerFor.size && !errors.length) errors.push('nothing to change')
  if (errors.length) return plan({ ok: false, errors })
  list.sort((x, y) => (x.iso < y.iso ? -1 : 1))

  const days = [], writes = {}
  for (const { iso, desired } of list) {
    const before = plannedOn(S, iso, today)
    const w = writeFor(S, iso, desired, today)
    if (w !== undefined) writes[iso] = w
    days.push({ date: iso, before, after: desired, ids: desired, fixed: false, moved_from: null })
  }
  // Missed days whose session the assignments now place somewhere it was not: moved there.
  const resolutions = {}
  const placed = days.filter(d => d.after.length && !sameIds(d.after, weeklyOn(S, d.date, today)))
  for (const m of [...missedWorkouts(S, today)].reverse()) {
    if (answerFor.has(m.iso)) continue
    const at = placed.find(d => d.after[0] === m.ids[0] && !Object.values(resolutions).some(r => r.to === d.date))
    if (at) { resolutions[m.iso] = { act: 'moved', to: at.date }; at.moved_from = m.iso }
  }
  for (const [iso, act] of answerFor) resolutions[iso] = { act }

  // What the dates held and no longer hold anywhere among them: shown, so nothing goes unnoticed.
  const beforeAll = days.flatMap(d => d.before), afterAll = days.flatMap(d => d.after)
  const warnings = recoveryWarnings(S, days.map(d => ({ date: d.date, ids: d.after })))
  for (const id of new Set(beforeAll)) {
    const lost = beforeAll.filter(x => x === id).length - afterAll.filter(x => x === id).length
    if (lost > 0) warnings.push({ type: 'dropped', routine_id: id, message: `${nameOf(id)} is planned ${lost} time(s) fewer on these dates than before.` })
  }
  for (const id of new Set(afterAll)) {
    const n = afterAll.filter(x => x === id).length
    if (n > 1 && n > beforeAll.filter(x => x === id).length) warnings.push({ type: 'duplicate', routine_id: id, message: `${nameOf(id)} is assigned ${n} times on these dates.` })
  }
  return plan({ days, writes, resolutions, warnings })
}

/** Writes a plan's dayPlan changes and missed-day answers onto the draft `s`. */
export function applyReschedule(s, p, now = Date.now()) {
  if (!p?.ok) return s
  if (!isMap(s.dayPlan)) s.dayPlan = {}
  for (const [iso, v] of Object.entries(p.writes || {})) {
    if (v == null) delete s.dayPlan[iso]
    else s.dayPlan[iso] = v
  }
  for (const [iso, r] of Object.entries(p.resolutions || {})) s.missedDays = withMissed(s.missedDays, iso, r, now)
  return s
}

/** Whether a plan changes anything at all. */
export const planChanges = p => !!p?.ok && (Object.keys(p.writes || {}).length > 0 || Object.keys(p.resolutions || {}).length > 0)

/**
 * A day of the schedule as an assistant or the calendar reads it: what is planned, what the
 * recurring week alone would plan, what was logged, and what that adds up to.
 * status: done | missed | skipped | moved | kept | excused | rest | today | planned
 */
export function scheduleDay(state, iso, today = todayISO()) {
  const S = norm(state)
  const planned = plannedOn(S, iso, iso < today ? iso : today)
  const weekly = weeklyOn(S, iso, iso < today ? iso : today)
  const logged = workoutsOn(S, iso)
  const answer = missedAnswerOf(S, iso)
  let status
  if (logged.length) status = 'done'
  else if (iso < today) status = answer ? answer.act : excusedOn(S, iso) ? 'excused' : planned.length ? 'missed' : 'rest'
  else status = !planned.length ? 'rest' : iso === today ? 'today' : 'planned'
  return {
    date: iso, planned, weekly,
    override: S.dayPlan[iso] !== undefined && !sameIds(planned, weekly) ? S.dayPlan[iso] : null,
    logged: logged.map(w => ({ id: w.id ?? null, name: w.name || null, routine_ids: routineIdsOf(w) })),
    status, ...(answer ? { answer } : {}),
  }
}
