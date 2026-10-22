/* What the hosted MCP endpoint (api/mcp-remote) runs of this package and of frontend/src/lib.

   The API image carries nothing outside api/, so scripts/build-mcp-hosted.mjs bundles this file
   into api/mcp-remote/read-tools.gen.js, with hosted-state.js standing in for state.js. The read
   tools are V1's own (tools.js), unchanged, so a question answered over stdio and over HTTPS gets
   the same numbers from the same code the app's screens use. Two read tools are added here, and
   the write tools borrow a few labels and lookups through `helpers`; nothing in this file writes. */
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
import { allExercises, searchExercises, exOr, canonicalExId, isAssisted, isCardio, EXIDX } from '../../frontend/src/lib/exercises.js'
import { e1rmSeries, best1RM, formulaOf } from '../../frontend/src/lib/onerm.js'

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

const noState = () => ({ error: 'no synced state yet — sign in at least once from a device so Gymly can save this profile', unit: 'kg' })

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

export const READ_TOOLS = [...TOOLS, searchExercisesTool, trainingProgress]

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
  setsDone: w => setsDone(w)
}
