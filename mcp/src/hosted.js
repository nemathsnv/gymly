/* What the hosted MCP endpoint (api/mcp-remote) runs of this package and of frontend/src/lib.

   The API image carries nothing outside api/, so scripts/build-mcp-hosted.mjs bundles this file
   into api/mcp-remote/read-tools.gen.js, with hosted-state.js standing in for state.js. The read
   tools are V1's own (tools.js), unchanged, so a question answered over stdio and over HTTPS gets
   the same numbers from the same code the app's screens use. Three read tools are added here
   (search_exercises, get_training_progress, get_schedule), and the write tools borrow a few labels
   and lookups through `helpers`; nothing in this file writes.

   The habit tools (HABIT_TOOLS, runHabitTool) are the one way any part of the habit log leaves the
   server, and only on a connection the owner granted gymly:habits:read (api/mcp-remote/tools.js).
   They are not V1 tools and never run through withState, which drops the log with the other
   private keys (private-keys.js) for every other tool. */
import { z } from 'zod'
import { TOOLS } from './tools.js'
import { getState } from './state.js'
import { withState } from './hosted-state.js'
import { exLine } from './labels.js'
import { modeOf, workoutVolume, setsDone, effectiveRoutineIds, isPerSide, cleanupSg } from '../../frontend/src/lib/history.js'
import { deleteRoutine } from '../../frontend/src/lib/routines.js'
import { uid } from '../../frontend/src/lib/format.js'
import { insertChronological } from '../../frontend/src/lib/backfill.js'
import { buildCompletedWorkout } from '../../frontend/src/lib/finish-workout.js'
import { allExercises, searchExercises, exOr, canonicalExId, isAssisted, isCardio, EXIDX, registerCustom } from '../../frontend/src/lib/exercises.js'
import { buildLoggedWorkout, appendLoggedWorkout, removeLoggedWorkout, findDuplicate } from '../../frontend/src/lib/log-workout.js'
import { e1rmSeries, best1RM, formulaOf } from '../../frontend/src/lib/onerm.js'
import { habitList, readEntry, isDay, isHabitId, addDays as addHabitDays, daysBetween } from '../../frontend/src/lib/habits.js'
import { scheduleDay, missedWorkouts, planReschedule, planAssignments, applyReschedule, planChanges, isIsoDate, weekEndOf } from '../../frontend/src/lib/reschedule.js'

// The calendar date where the profile's owner is. The reminder's time zone is the one the app
// records; without it the server's own clock decides, which is what V1's tools always did.
export function todayFor(S, now = new Date()) {
  const tz = S?.reminder?.tz
  if (typeof tz === 'string' && tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
    } catch { /* an unknown zone falls through to the server's */ }
  }
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
}
const addDays = (iso, n) => {
  const d = new Date(iso + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const mondayOf = iso => {
  const d = new Date(iso + 'T12:00:00Z')
  return addDays(iso, -((d.getUTCDay() + 6) % 7))
}
const round1 = v => Math.round(v * 10) / 10
const customOf = (id, S) => (S.customEx || []).find(ex => ex && ex.id === id)
// The catalogue index is a plain object: `__proto__` or `toString` must not read as exercises.
const inCatalogue = id => typeof id === 'string' && Object.hasOwn(EXIDX, id)
const exerciseOf = (id, S) => customOf(id, S) || (inCatalogue(id) ? EXIDX[id] : { id, n: 'Unknown exercise', missing: true })

const noState = () => ({ error: 'no synced state yet: sign in at least once from a device so Gymly can save this profile', unit: 'kg' })

// The profile's own exercises indexed for the duration of one call, as the app has them: a
// custom one-arm dumbbell press counts one bell, a custom assisted machine folds towards less
// help, a custom cardio exercise reads as cardio. One process serves every profile, so the index
// is put back before the call returns (everything inside is synchronous).
function withCustomsIndexed(S, run) {
  registerCustom(Array.isArray(S?.customEx) ? S.customEx.filter(x => x && x.id) : [])
  try { return run() } finally { registerCustom([]) }
}

/** search_exercises — names to ids, which every write needs. */
export const searchExercisesTool = {
  name: 'search_exercises',
  description: 'Find exercises by name in the Gymly library (5,000+ built-ins) and the user\'s own custom exercises. Returns ids to use in routine changes. Always resolve an exercise name to an id with this tool before proposing a change that adds or swaps an exercise; never guess an id. `in_routines` names the routines that already contain it.',
  schema: {
    query: z.string().trim().min(2).max(80).describe('Exercise name or words from it, e.g. "incline dumbbell press".'),
    limit: z.number().int().min(1).max(25).optional().describe('Max results, default 10.')
  },
  handler: ({ query, limit }) => {
    const S = getState() || {}
    const list = allExercises({ customEx: Array.isArray(S.customEx) ? S.customEx.filter(x => x && x.id) : [] })
    const routines = Array.isArray(S.routines) ? S.routines : []
    const hits = searchExercises(list, query).slice(0, limit || 10)
    return {
      query,
      results: hits.map(ex => ({
        id: ex.id,
        name: ex.n,
        body_part: ex.bp || null,
        equipment: ex.eq || null,
        custom: !!customOf(ex.id, S),
        default_mode: isCardio(ex.id) ? 'cardio' : 'reps',
        in_routines: routines.filter(r => (r.ex || []).some(e => e && e.id === ex.id)).map(r => ({ id: r.id, name: r.name }))
      }))
    }
  }
}

/** get_training_progress — the trend over a block of weeks, for "am I progressing?". */
export const trainingProgress = {
  name: 'get_training_progress',
  description: 'Summarise training progress over the last N weeks: sessions, completed sets and volume per week; estimated 1RM trend (first, latest and best in the window, plus the all-time best) for chosen exercises or, by default, the five most-trained lifts; and the body-weight change. Weeks start on Monday. Estimates use the formula the user picked in Settings.',
  schema: {
    weeks: z.number().int().min(1).max(52).optional().describe('How many weeks back from today, default 8.'),
    exercise_ids: z.array(z.string().min(1).max(64)).max(10).optional().describe('Exercise ids to report the 1RM trend for (from list_routines, get_workout or search_exercises).')
  },
  handler: ({ weeks, exercise_ids }) => {
    const S = getState()
    if (!S) return noState()
    const n = weeks || 8
    const today = todayFor(S)
    const from = addDays(mondayOf(today), -7 * (n - 1))
    const workouts = (S.workouts || []).filter(w => w && typeof w.d === 'string' && w.d >= from && w.d <= today)
    const byWeek = new Map()
    for (let i = 0; i < n; i++) byWeek.set(addDays(from, 7 * i), { week_of: addDays(from, 7 * i), sessions: 0, sets_done: 0, volume: 0 })
    for (const w of workouts) {
      const b = byWeek.get(mondayOf(w.d))
      if (!b) continue
      b.sessions++
      b.sets_done += setsDone(w)
      b.volume += workoutVolume(w)
    }
    // Default lifts: the reps-mode exercises in the most sessions of the window.
    let ids = exercise_ids && exercise_ids.length ? [...new Set(exercise_ids)] : null
    if (!ids) {
      const count = new Map()
      for (const w of workouts) {
        for (const e of (w.entries || [])) {
          if (!e || !e.id || isAssisted(e.id) || modeOf({ ...(e.target || {}), id: e.id }) !== 'reps') continue
          if (!(e.sets || []).some(s => s && s.done)) continue
          count.set(e.id, (count.get(e.id) || 0) + 1)
        }
      }
      ids = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id)
    }
    const formula = formulaOf(S)
    const lifts = ids.map(id => {
      const ex = exerciseOf(id, S)
      const series = e1rmSeries(S, id, formula).filter(p => p.d >= from && p.d <= today)
      const best = series.reduce((m, p) => (!m || p.y > m.y ? p : m), null)
      const first = series[0] || null, last = series[series.length - 1] || null
      const allTime = best1RM(S, id, formula)
      return {
        id, name: ex.n,
        sessions_with_estimate: series.length,
        first: first ? { date: first.d, est: first.y, w: first.w, r: first.r } : null,
        latest: last ? { date: last.d, est: last.y, w: last.w, r: last.r } : null,
        best_in_window: best ? { date: best.d, est: best.y, w: best.w, r: best.r } : null,
        change: first && last ? round1(last.y - first.y) : null,
        change_pct: first && last && first.y > 0 ? round1((last.y - first.y) / first.y * 100) : null,
        all_time_best: allTime ? { date: allTime.d, est: allTime.est, w: allTime.w, r: allTime.r } : null
      }
    })
    const bw = (S.bodyweight || []).filter(b => b && b.d >= from && b.d <= today && Number(b.w) > 0)
      .sort((a, b) => (a.d || '').localeCompare(b.d || ''))
    return {
      unit: S.unit || 'kg',
      from, to: today, weeks: n, formula,
      totals: { sessions: workouts.length, sets_done: [...byWeek.values()].reduce((a, b) => a + b.sets_done, 0), volume: [...byWeek.values()].reduce((a, b) => a + b.volume, 0) },
      per_week: [...byWeek.values()],
      lifts,
      bodyweight: bw.length ? {
        first: { date: bw[0].d, weight: bw[0].w },
        latest: { date: bw[bw.length - 1].d, weight: bw[bw.length - 1].w },
        change: round1(bw[bw.length - 1].w - bw[0].w),
        goal: S.targetW || null
      } : null
    }
  }
}

/** get_schedule — date by date: what is planned, what the recurring week alone says, what was done. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const scheduleDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine(isIsoDate, { message: 'not a calendar date' })
export const SCHEDULE_MAX_DAYS = 62
export const scheduleTool = {
  name: 'get_schedule',
  description: 'The user\'s schedule date by date, in their own time zone: for each date the routines planned (`planned`), what the recurring weekly plan alone would give (`weekly`), a one-time `override` when the date differs from the weekly plan, the workouts logged that day, and a `status`: done, missed (planned, gone by, nothing logged), moved (a missed session that was rescheduled; `answer.to` says where), skipped, kept (the user chose to keep the schedule as it was), excused (a day note), rest, today or planned. `missed` lists the missed sessions Gymly would ask the user about now. Defaults to the last 7 days and the next 14. Use preview_schedule_changes to move sessions on specific dates; never change the weekly plan for a one-off.',
  schema: {
    from: scheduleDate().optional().describe('First date, YYYY-MM-DD. Default 7 days ago.'),
    to: scheduleDate().optional().describe(`Last date, YYYY-MM-DD. Default 13 days from today; at most ${SCHEDULE_MAX_DAYS} days in all.`)
  },
  handler: ({ from, to }) => {
    const S = getState()
    if (!S) return noState()
    const today = todayFor(S)
    const f = from || addDays(today, -7)
    const t = to || addDays(today, 13)
    if (t < f) return { error: 'to is before from' }
    if (addDays(f, SCHEDULE_MAX_DAYS - 1) < t) return { error: `at most ${SCHEDULE_MAX_DAYS} days at once` }
    const routines = Array.isArray(S.routines) ? S.routines : []
    const named = ids => ids.map(id => ({ id, name: routines.find(r => r && r.id === id)?.name || null }))
    const days = []
    for (let iso = f; iso <= t; iso = addDays(iso, 1)) {
      const d = scheduleDay(S, iso, today)
      days.push({
        date: iso, weekday_name: DAY_NAMES[new Date(iso + 'T12:00:00Z').getUTCDay()], status: d.status,
        planned: named(d.planned), weekly: named(d.weekly), override: d.override,
        logged: d.logged.map(w => ({ workout_id: w.id, name: w.name, routine_ids: w.routine_ids })),
        ...(d.answer ? { answer: d.answer } : {})
      })
    }
    return {
      today,
      week_ends_on: weekEndOf(S, today),
      days,
      missed: missedWorkouts(S, today).map(m => ({ date: m.iso, routines: named(m.ids) }))
    }
  }
}

export const READ_TOOLS = [...TOOLS, searchExercisesTool, trainingProgress, scheduleTool]

/** One read tool's answer for one profile. Throws for an unknown name. */
export function runReadTool(name, args, S, user) {
  const tool = READ_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error('unknown read tool ' + name)
  return withState(S, user, () => tool.handler(args || {}))
}

/* Lookups the write side (api/mcp-remote/plan-ops.js) needs from the app's own code: what an
   exercise is called, how a prescription reads, which routines a date holds. All pure. */
export const helpers = {
  todayFor,
  addDays,
  canonicalExId,
  cleanupSg,
  deleteRoutine,
  uid,
  insertChronological,
  buildCompletedWorkout,
  exerciseName: (id, S) => {
    const ex = exerciseOf(id, S || {})
    return ex && !ex.missing ? ex.n : null
  },
  isKnownExercise: (id, S) => !!customOf(id, S || {}) || inCatalogue(id),
  isCardio: id => isCardio(id),
  isPerSide: cfg => isPerSide(cfg),
  prescription: (cfg, unit) => exLine(cfg, unit),
  routineIdsOn: (S, iso) => withState(S, { id: '', name: '' }, () => effectiveRoutineIds(getState(), iso, todayFor(S))),
  workoutVolume: w => workoutVolume(w),
  setsDone: w => setsDone(w),
  // log_workout (frontend/src/lib/log-workout.js, ported from openGym #739): the workout a
  // description stands for, filing it the way Finish does, and taking it back out.
  buildLoggedWorkout: (S, input, opts) => withCustomsIndexed(S, () => buildLoggedWorkout(S || {}, input, opts)),
  appendLoggedWorkout: (S, built, opts) => withCustomsIndexed(S, () => appendLoggedWorkout(S, built, opts)),
  removeLoggedWorkout: (S, undo) => removeLoggedWorkout(S, undo),
  findDuplicate: (S, w) => findDuplicate(S || {}, w),
  // One-time rescheduling (frontend/src/lib/reschedule.js): the shift and explicit dates, both
  // planned in the profile's own time zone, and the write that applies them.
  planReschedule: (S, opts) => withCustomsIndexed(S, () => planReschedule(S || {}, { ...opts, today: todayFor(S || {}) })),
  planAssignments: (S, list, opts) => withCustomsIndexed(S, () => planAssignments(S || {}, list, { ...opts, today: todayFor(S || {}) })),
  applyReschedule: (s, p, now) => applyReschedule(s, p, now),
  planChanges: p => planChanges(p),
  scheduleDay: (S, iso) => scheduleDay(S || {}, iso, todayFor(S || {}))
}

/* ---------- habits: gymly:habits:read only ----------

   The owner's consent covers habit names, kinds, whether one is archived, and each day's answer and
   count; never a day's note (a private text), the device's time zone, the sync stamps, or anything
   else of the profile. So these tools do not hand the log on: they read it through
   frontend/src/lib/habits.js and copy out the fields named below, one by one. A field the app adds
   to a habit or a day later is left out until it is added here on purpose. */

/** The longest range get_habit_log answers, and the one it answers without `from`/`to`. */
export const HABIT_LOG_MAX_DAYS = 92
export const HABIT_LOG_DEFAULT_DAYS = 14

const habitLogOf = S => (S && typeof S.habitLog === 'object' && S.habitLog && !Array.isArray(S.habitLog) ? S.habitLog : {})

// "Today" for the habit log: the profile's date (todayFor), and without a reminder zone the zone of
// the device that last wrote a day, so a log kept east of the server is not a day behind. The zone
// only picks the date; it is never part of an answer.
function habitToday(S, now) {
  if (typeof S?.reminder?.tz === 'string' && S.reminder.tz) return todayFor(S, now)
  let tz = null, ts = -Infinity
  for (const raw of Object.values(habitLogOf(S))) {
    if (raw && typeof raw.tz === 'string' && raw.tz.length <= 64 && Number(raw._ts) > ts) { tz = raw.tz; ts = Number(raw._ts) }
  }
  return todayFor(tz ? { reminder: { tz } } : {}, now)
}

// One habit as an assistant is told it: an explicit list of fields.
function habitView(h) {
  return {
    id: h.id,
    name: h.name || (h.builtin ? 'Alcohol' : ''),
    builtin: !!h.builtin,
    kind: h.kind,
    archived: !!h.archived,
    answers: { good: h.good, bad: h.bad },
    counts: !!h.count,
    icon: h.icon,
    color: h.color,
    created: h.at > 0 ? new Date(h.at).toISOString().slice(0, 10) : null
  }
}

const listHabitsTool = {
  name: 'list_habits',
  description: 'List the habits the user tracks in Gymly\'s daily habit log: the built-in one and their own, each with its id (for get_habit_log), name, kind ("do": a habit to build, "avoid": one to stay away from), whether it is archived, its two answers (the status words get_habit_log reports for a good and a bad day) and whether a bad day carries a count. Notes the user wrote are never shared.',
  schema: {
    include_archived: z.boolean().optional().describe('Include archived habits too (default true).')
  },
  handler: (S, { include_archived }) => {
    const habits = habitList(S, { archived: include_archived === false ? false : null }).map(habitView)
    return { habits, count: habits.length }
  }
}

const habitDay = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine(isDay, { message: 'not a calendar date' })

const habitLogTool = {
  name: 'get_habit_log',
  description: `Read the user's daily habit log for a range of days: one entry per habit and day that was logged, with the status (the habit's good or bad answer, as list_habits gives them) and, where the habit counts, the count. A day with no entry was not logged: never treat it as a good day. Default the ${HABIT_LOG_DEFAULT_DAYS} days ending today; at most ${HABIT_LOG_MAX_DAYS} days per call. Notes the user wrote on a day are never shared.`,
  schema: {
    from: habitDay().optional().describe(`First day, YYYY-MM-DD. Default ${HABIT_LOG_DEFAULT_DAYS - 1} days before \`to\`.`),
    to: habitDay().optional().describe('Last day, YYYY-MM-DD. Default today (the profile\'s date).'),
    habit_id: z.string().trim().min(1).max(40).optional().describe('Only this habit (an id from list_habits).')
  },
  handler: (S, { from, to, habit_id }, now) => {
    const today = habitToday(S, now)
    const end = to || (from ? (() => { const d = addHabitDays(from, HABIT_LOG_DEFAULT_DAYS - 1); return d < today ? d : today })() : today)
    const start = from || addHabitDays(end, -(HABIT_LOG_DEFAULT_DAYS - 1))
    if (start > end) return { error: 'invalid_range', message: '`from` is after `to`' }
    const span = daysBetween(start, end) + 1
    if (span > HABIT_LOG_MAX_DAYS) return { error: 'invalid_range', message: `at most ${HABIT_LOG_MAX_DAYS} days per call; this range has ${span}` }
    const habits = habitList(S, { archived: null })
    if (habit_id != null && !(isHabitId(habit_id) && habits.some(h => h.id === habit_id))) return { error: 'not_found', message: 'no habit with that id; list_habits gives the ids' }
    const log = habitLogOf(S)
    const entries = []
    for (const h of habits) {
      if (habit_id != null && h.id !== habit_id) continue
      for (let i = 0; i < span; i++) {
        const date = addHabitDays(start, i)
        const key = h.id + '|' + date
        if (!Object.hasOwn(log, key)) continue
        const e = readEntry(h.id, log[key])
        // A day with only a note has no status: nothing an assistant may be told about it.
        if (!e || !e.status) continue
        entries.push({ habit_id: h.id, date, status: e.status, result: e.status === h.good ? 'good' : 'bad', count: h.count ? e.count : null })
      }
    }
    entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    return {
      from: start, to: end, days: span, today,
      habits: habits.filter(h => habit_id == null || h.id === habit_id).map(h => ({ id: h.id, name: h.name || (h.builtin ? 'Alcohol' : ''), archived: !!h.archived })),
      entries,
      about_missing_days: 'A day without an entry was not logged. It is not a good day.'
    }
  }
}

export const HABIT_TOOLS = [listHabitsTool, habitLogTool]

/** One habit tool's answer for one profile (S may be null for a profile never synced). Throws for an unknown name. */
export function runHabitTool(name, args, S, now = new Date()) {
  const tool = HABIT_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error('unknown habit tool ' + name)
  return tool.handler(S || {}, args || {}, now)
}
