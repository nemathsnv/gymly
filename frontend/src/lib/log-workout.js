// A session described rather than tapped through ("dumbbell curls, 12 kg, 12/12/10") turned into
// the workout the app would have saved had it been logged on the phone. Ported from openGym
// (#739, commits 47d81fe78 and beed2965e) for this app's hosted MCP endpoint
// (api/mcp-remote/plan-ops.js, preview_workout_log and log_workout), which hands it a structured
// description an assistant read out of what the user said. Kept here, pure and beside its test,
// because it decides what lands in the history and what weight comes next.
//
// It follows the finish sheet (sheets.jsx doFinishWorkout) step for step, not the CSV importer:
// one session someone just did is the app's own kind of workout, so a session logged for today
// gets its PR badges and moves the confirmed weights the way Finish does, and one logged into the
// past is a backfill: badges held against the history around it (rebuildPrHistory), confirmed
// weights left alone. A common name resolves the way an import resolves it, to the catalogue's
// default variant ("shoulder press" is the barbell one), and the answer says which; what it does
// not do is pick between names the catalogue spells alike or invent an exercise: those come back
// as a problem with candidates, to put to the user instead of a workout filed under the wrong lift.
//
// Where this differs from upstream, because this app differs:
//   - an exercise merged into another (S.exMerged, lib/exercise-merge.js) resolves to the one it
//     went into, by its id or by the name it had, so nothing is logged under a merged-away entry;
//   - cardio is logged (minutes, speed), and a stepmill or stair climber takes its machine level
//     instead of a speed (lib/machine-level.js);
//   - a session can name the routine it followed, and its entries then carry that routine's slot;
//   - no custom exercise is created from here: a name nothing matches is a question, and the user
//     makes the exercise in the app (one write path for the library, the app's);
//   - the time of day is the profile's, not the process's: the caller passes `today` and `at`;
//   - the document is not stamped as a device's own save (`_ts`): the server commits it as a
//     writer that does not stamp (api/server.js commitState), and stamps what changed.
import { EXIDX, canonicalExId, betterWeight, beatsWeight, mergedTarget } from './exercises.js'
import { exerciseCandidates, importId } from './import-csv.js'
import { bestWeightFor, bestWeightForEntry, workoutVolume, EFFORT, modeOf } from './history.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { withMeaning, entryDbLoad } from './dumbbells.js'
import { isWarmupRow } from './workout-model.js'
import { insertChronological } from './backfill.js'
import { rebuildPrHistory } from './workout-date.js'
import { stampWorkout } from './sync-merge.js'
import { exerciseMuscleSnapshot } from './muscles.js'
import { levelFits, clampLevel, LEVEL_MAX } from './machine-level.js'

const LB_TO_KG = 0.45359237
// The hosted endpoint's bounds (api/mcp-remote/tools.js and plan-ops.js MAX_WEIGHT_KG).
export const LOG_LIMITS = {
  maxKg: 1000, maxReps: 200, maxSec: 3600, maxMin: 600, maxSpeed: 60,
  maxSets: 20, maxExercises: 20, maxDurationMin: 24 * 60, maxBodyweightKg: 700,
}

// The least a "just did" squeezed in after today's last session lasts.
const MIN_ROOM_MS = 5 * 60000
const ISO = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const localIso = t => {
  const d = new Date(t)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
const localAt = (iso, hhmm) => new Date(`${iso}T${hhmm}:00`).getTime()
const realDate = iso => {
  const d = new Date(iso + 'T12:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso
}
const nameKey = n => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim()
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const list = v => (Array.isArray(v) ? v : [])
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
const inCatalogue = id => typeof id === 'string' && Object.hasOwn(EXIDX, id)
const customsOf = S => list(S?.customEx).filter(c => c && typeof c.id === 'string' && c.id)

/** The exercise record behind an id: the profile's own first, then the catalogue. */
export const exerciseOf = (S, id) => customsOf(S).find(c => c.id === id) || (inCatalogue(id) ? EXIDX[id] : null)

// Enough to tell candidates apart when the user is asked: the catalogue spells some names twice.
const candidateOf = (S, id) => {
  const ex = exerciseOf(S, id)
  return { id, name: ex?.n || id, equipment: ex?.eq || null, body_part: ex?.bp || null, ...(customsOf(S).some(c => c.id === id) ? { custom: true } : {}) }
}

// Where an exercise went, following merges of merges; itself when it was never merged.
const followMerge = (S, id) => mergedTarget(S?.exMerged, id)

/**
 * The exercise a reference names, as { id, name, custom?, merged_from? } or
 * { problem, candidates? }.
 *
 * In order: one of the profile's own exercises by id; a catalogue id (a drawing alias filed under
 * its canonical id, as the importer does); an id merged into another; one of the profile's own by
 * name, or the name a merged-away exercise had; else a catalogue name that means exactly one
 * entry. Whatever it lands on is followed through S.exMerged, so a lift merged into another is
 * logged where its history now lives. Anything else is a problem with the candidates to choose from.
 */
export function resolveExercise(S, ref) {
  const text = String(ref ?? '').trim()
  if (!text) return { problem: 'no exercise named' }
  const customs = customsOf(S)
  const merges = isMap(S?.exMerged) ? S.exMerged : {}
  const land = (id, from) => {
    const to = followMerge(S, id)
    const ex = exerciseOf(S, to)
    if (!ex) return { problem: `"${text}" was merged into an exercise this profile no longer has; pick another`, candidates: [] }
    return {
      id: to, name: ex.n,
      ...(customs.some(c => c.id === to) ? { custom: true } : {}),
      ...(to !== from ? { merged_from: from } : {}),
    }
  }
  if (customs.some(c => c.id === text)) return land(text, text)
  // Own keys only: `constructor` or `__proto__` is on every object and names no exercise.
  if (inCatalogue(text)) {
    const canon = canonicalExId(text)
    if (inCatalogue(canon)) return land(canon, canon)
  }
  if (Object.hasOwn(merges, text) && merges[text]?.into) return land(text, text)
  const named = customs.filter(c => nameKey(c.n) === nameKey(text))
  if (named.length === 1) return land(named[0].id, named[0].id)
  if (named.length > 1) {
    return { problem: 'several of your own exercises have this name; pass one id', candidates: named.map(c => candidateOf(S, c.id)) }
  }
  // A custom exercise merged away is gone from customEx; its record keeps the name it had.
  const gone = Object.keys(merges).filter(k => merges[k]?.into && typeof merges[k].n === 'string' && nameKey(merges[k].n) === nameKey(text))
  if (gone.length) {
    const to = [...new Set(gone.map(k => followMerge(S, k)))]
    if (to.length === 1) return land(gone[0], gone[0])
  }
  const { id, candidates, kind } = exerciseCandidates(text)
  if (id && inCatalogue(id)) return land(id, id)
  // Candidates merged into the same exercise are one candidate, under the name it has now.
  const seen = new Set()
  const offered = []
  for (const c of candidates || []) {
    const to = followMerge(S, c)
    if (seen.has(to) || !exerciseOf(S, to)) continue
    seen.add(to)
    offered.push(candidateOf(S, to))
  }
  if (offered.length === 1 && kind !== 'none') return land(offered[0].id, candidates[0])
  return {
    problem: kind === 'none' || !offered.length
      ? 'no exercise in the library matches' + (offered.length ? '; these only share a word with it' : '; make it in the app first, or pass an id from search_exercises')
      : 'more than one exercise matches; ask the user which and pass its id',
    candidates: offered,
  }
}

// One described set as the row the app stores, or a reason it cannot be one. `mode` is the
// exercise's: reps, seconds and minutes are different exercises' worth of meaning, never one row.
function rowOf(set, mode, { toProfile, levelled }) {
  const weight = set.weight == null ? 0 : num(set.weight)
  if (weight == null || weight < 0) return { problem: 'weight must be a number of 0 or more' }
  if (toProfile.toKg(weight) > LOG_LIMITS.maxKg) return { problem: `weight over ${LOG_LIMITS.maxKg} kg` }
  if (mode === 'cardio') {
    if (set.weight != null || set.reps != null || set.seconds != null) return { problem: 'a cardio set takes minutes (and speed or level), not weight, reps or seconds' }
    if (set.warmup === true || set.failure === true || set.rir != null || set.rpe != null) return { problem: 'warm-up, failure and effort are logged on lifting sets only' }
    const min = num(set.minutes)
    if (!(min > 0 && min <= LOG_LIMITS.maxMin)) return { problem: `minutes must be more than 0 and at most ${LOG_LIMITS.maxMin}` }
    const row = { min, speed: 0, done: true }
    if (set.speed != null) {
      const speed = num(set.speed)
      if (speed == null || speed < 0 || speed > LOG_LIMITS.maxSpeed) return { problem: `speed must be 0 to ${LOG_LIMITS.maxSpeed} km/h` }
      if (levelled && speed > 0) return { problem: 'this machine is set by a level, not a speed: give level' }
      row.speed = speed
    }
    if (set.level != null) {
      if (!levelled) return { problem: 'a machine level is for a stepmill or stair climber only' }
      const level = clampLevel(set.level)
      if (level == null || num(set.level) !== level) return { problem: `level must be a whole number 1 to ${LEVEL_MAX}` }
      row.level = level
    }
    return { row }
  }
  if (set.minutes != null || set.speed != null || set.level != null) return { problem: 'minutes, speed and level are for cardio exercises; a hold takes seconds' }
  const row = mode === 'time'
    ? { sec: Math.round(num(set.seconds)), w: toProfile.convert(weight), done: true }
    : { w: toProfile.convert(weight), r: num(set.reps), done: true }
  if (set.warmup === true) row.phase = 'warmup'
  if (set.failure === true) {
    if (set.warmup === true) return { problem: 'a warm-up set is not taken to failure' }
    row.failure = true
  }
  if (set.rir != null || set.rpe != null) {
    if (mode === 'time') return { problem: 'effort (RIR/RPE) is logged on rep sets only' }
    if (set.rir != null && set.rpe != null) return { problem: 'give RIR or RPE, not both' }
    const kind = set.rir != null ? 'rir' : 'rpe'
    const v = num(set[kind]), e = EFFORT[kind]
    if (v == null || v < e.min || v > e.max) return { problem: `${e.hd} must be between ${e.min} and ${e.max}` }
    row[kind] = v
  }
  return { row }
}

/**
 * Build the workout a description stands for, against profile `S`, without touching it.
 *
 * `input`: { date: 'YYYY-MM-DD', start?: 'HH:MM', durationMin?, name?, note?, unit?: 'kg'|'lb',
 *   routineId?, bodyweight?,
 *   exercises: [{ exercise, note?,
 *     sets: [{ reps? | seconds? | minutes?, weight?, speed?, level?, warmup?, failure?, rir? | rpe? }] }] }
 *
 * Options: `now` (epoch), `today` (the profile's calendar date, default the process's) and
 * `at(iso, 'HH:MM')` (the epoch of a wall-clock time on a date where the profile's owner is,
 * default the process's zone).
 *
 * Returns { workout, past, resolved } or { problems }: every problem in the whole description at
 * once, so one round trip to the user settles them all.
 */
export function buildLoggedWorkout(S0, input, { now = Date.now(), today, at = localAt } = {}) {
  const S = S0 || {}
  const problems = []
  const day = today || localIso(now)
  const date = input?.date
  if (typeof date !== 'string' || !ISO.test(date) || !realDate(date)) {
    problems.push({ field: 'date', problem: 'must be a real YYYY-MM-DD date' })
  } else if (date > day) problems.push({ field: 'date', problem: `is in the future (today is ${day} for this profile)` })
  else if (date < '2000-01-01') problems.push({ field: 'date', problem: 'is before 2000' })
  if (input?.start != null && !HHMM.test(String(input.start))) problems.push({ field: 'start', problem: 'must be HH:MM (24 h)' })
  const dur = input?.durationMin
  if (dur != null && !(num(dur) > 0 && dur <= LOG_LIMITS.maxDurationMin)) problems.push({ field: 'durationMin', problem: `must be 1 to ${LOG_LIMITS.maxDurationMin} minutes` })
  const profileUnit = S.unit === 'lb' ? 'lb' : 'kg'
  const unit = input?.unit == null ? profileUnit : input.unit
  if (unit !== 'kg' && unit !== 'lb') problems.push({ field: 'unit', problem: "must be 'kg' or 'lb'" })
  const toProfile = {
    toKg: w => (unit === 'lb' ? w * LB_TO_KG : w),
    // Converted only when the description is in the other unit, to the hundredth: 45 lb is
    // 20.41 kg, which reads back as 45 again.
    convert: w => (unit === profileUnit ? w : Math.round((unit === 'lb' ? w * LB_TO_KG : w / LB_TO_KG) * 100) / 100),
  }
  const routines = list(S.routines).filter(isMap)
  const routine = input?.routineId != null ? routines.find(r => r.id === input.routineId) || null : null
  if (input?.routineId != null && !routine) problems.push({ field: 'routineId', problem: 'is not one of the profile\'s routines' })
  let bw = null
  if (input?.bodyweight != null) {
    const b = num(input.bodyweight)
    if (!(b > 0) || toProfile.toKg(b) > LOG_LIMITS.maxBodyweightKg) problems.push({ field: 'bodyweight', problem: 'must be a body weight above 0' })
    else bw = toProfile.convert(b)
  }
  const exercises = list(input?.exercises)
  if (!exercises.length) problems.push({ field: 'exercises', problem: 'at least one exercise' })
  if (exercises.length > LOG_LIMITS.maxExercises) problems.push({ field: 'exercises', problem: `at most ${LOG_LIMITS.maxExercises}` })

  const resolved = []
  const entries = []
  exercises.slice(0, LOG_LIMITS.maxExercises).forEach((ex, i) => {
    const at_ = `exercises[${i}]`
    const hit = resolveExercise(S, ex?.exercise)
    if (hit.problem) {
      problems.push({ field: at_ + '.exercise', exercise: ex?.exercise ?? null, problem: hit.problem, ...(hit.candidates ? { candidates: hit.candidates } : {}) })
      return
    }
    const twice = resolved.find(r => r.id === hit.id)
    if (twice) {
      problems.push({ field: at_ + '.exercise', exercise: ex.exercise, problem: `is the same exercise as "${twice.input}" (${hit.name}); put all its sets in one entry` })
      return
    }
    const sets = list(ex.sets)
    if (!sets.length || sets.length > LOG_LIMITS.maxSets) {
      problems.push({ field: at_ + '.sets', problem: `1 to ${LOG_LIMITS.maxSets} sets` })
      return
    }
    const record = exerciseOf(S, hit.id)
    const cardioEx = modeOf({ id: hit.id }) === 'cardio' || record?.bp === 'cardio'
    const timed = sets.some(s => s?.seconds != null), counted = sets.some(s => s?.reps != null)
    const metered = sets.some(s => s?.minutes != null || s?.speed != null || s?.level != null)
    if ([timed, counted, metered].filter(Boolean).length > 1) {
      problems.push({ field: at_ + '.sets', problem: 'every set is reps, or every set is seconds, or every set is minutes, not a mix' })
      return
    }
    const mode = metered || (cardioEx && !timed && !counted) ? 'cardio' : timed ? 'time' : 'reps'
    if (cardioEx && mode !== 'cardio') {
      problems.push({ field: at_ + '.sets', problem: `${hit.name} is cardio: give minutes (and speed, or level on a stepmill) for each set` })
      return
    }
    const levelled = mode === 'cardio' && levelFits(record)
    const rows = []
    sets.forEach((s, j) => {
      const where = `${at_}.sets[${j}]`
      if (mode !== 'cardio') {
        const v = mode === 'time' ? num(s?.seconds) : num(s?.reps)
        const ok = mode === 'time'
          ? v != null && v >= 1 && v <= LOG_LIMITS.maxSec
          : Number.isInteger(v) && v >= 1 && v <= LOG_LIMITS.maxReps
        if (!ok) {
          problems.push({ field: where, problem: mode === 'time' ? `seconds must be 1 to ${LOG_LIMITS.maxSec}` : `reps must be a whole number 1 to ${LOG_LIMITS.maxReps}` })
          return
        }
      }
      const { row, problem } = rowOf(s || {}, mode, { toProfile, levelled })
      if (problem) problems.push({ field: where, problem })
      else rows.push(row)
    })
    // The routine's slot when the session followed one (what the next session reads back), else
    // a freestyle entry's config. Either way the meaning of a dumbbell weight is stamped the way
    // a freestyle entry gets it, the exercise's own default, so "20 each" stays 20 each.
    const planned = routine ? list(routine.ex).find(x => x && x.id === hit.id) : null
    let cfg
    if (planned) {
      const { sg, ...slot } = planned
      cfg = modeOf(slot) === mode ? slot : { ...slot, mode }
    } else cfg = mode === modeOf({ id: hit.id }) ? { id: hit.id } : { id: hit.id, mode }
    const target = mode === 'cardio' || cfg.dbLoad ? cfg : withMeaning(S, cfg, hit.id)
    const note = String(ex.note ?? '').trim().slice(0, 500)
    entries.push({ id: hit.id, sets: rows, target, ...(routine ? { rid: routine.id } : {}), ...(note ? { note } : {}) })
    resolved.push({
      input: ex.exercise, id: hit.id, name: hit.name, mode,
      ...(hit.custom ? { custom: true } : {}),
      ...(hit.merged_from ? { merged_from: hit.merged_from } : {}),
      ...(target.dbLoad ? { weightMeans: target.dbLoad } : {}),
      ...(levelled ? { levelled: true } : {}),
    })
  })
  if (problems.length) return { problems }

  const past = date < day
  const midnight = at(date, '00:00')
  // A length nobody gave is the backfill's hour (backfill.js), as when a session is logged in the
  // app. Into the past without a start: the backfill's 18:00. Today without one it is "just did":
  // it ended now. A length the caller gave is kept as given; the hour that stands in for a missing
  // one is only as long as fits after today's last session (and after midnight), so a "just did"
  // lands after the session just logged in the app rather than overlapping it.
  let start, end
  if (input.start != null) {
    start = at(date, input.start)
    end = start + (dur ?? 60) * 60000
    if (dur == null && !past) end = Math.max(start, Math.min(end, now))
  } else if (past) {
    start = at(date, '18:00')
    end = start + (dur ?? 60) * 60000
  } else {
    end = now
    if (dur != null) {
      start = end - dur * 60000
      if (start < midnight) return { problems: [{ field: 'durationMin', problem: 'a session that long ending now began yesterday: give the date and start it began on' }] }
    } else {
      const lastEnd = Math.max(0, ...list(S.workouts).filter(w => w?.d === date).map(w => Number(w.end) || Number(w.start) || 0))
      start = Math.max(end - 60 * 60000, lastEnd, midnight)
      // Too little room after it (a session on file that ended moments ago, or ends after now
      // because another device's clock is ahead) would make a session of seconds, read back as
      // "0 min": the floor instead, overlapping the last minutes of the one before as the app's
      // backfill allows.
      if (end - start < MIN_ROOM_MS) start = Math.max(end - MIN_ROOM_MS, midnight)
    }
  }
  if (start > now) return { problems: [{ field: 'start', problem: 'is later than now' }] }
  // As the app's own backfill refuses one (sheets.jsx endsInFuture): a finished session that has
  // not finished yet would count its whole length into the stats now.
  if (end > now) return { problems: [{ field: 'durationMin', problem: 'the session would end later than now: give an earlier start or a shorter length' }] }

  const name = String(input.name ?? '').trim().slice(0, 40) || routine?.name || 'Freestyle'
  const note = String(input.note ?? '').trim().slice(0, 500)
  // The id is the description's, not the clock's: the same call made again (its answer lost to a
  // timeout, a client retrying, a second preview of the same thing) names the same workout, and
  // appendLoggedWorkout keeps one. Only what the caller sent goes in, never the start filled in
  // from `now` or a converted weight; the exercise as it was resolved, so "bench" and "0025" are
  // the same request.
  const id = importId('mw', JSON.stringify([
    date, input.start ?? null, dur ?? null, input.name ?? null, input.note ?? null, input.unit ?? null,
    input.routineId ?? null, input.bodyweight ?? null,
    exercises.map((ex, i) => [resolved[i].id, ex.note ?? null,
      list(ex.sets).map(s => [s.reps ?? null, s.seconds ?? null, s.minutes ?? null, s.speed ?? null, s.level ?? null,
        s.weight ?? null, s.warmup === true, s.failure === true, s.rir ?? null, s.rpe ?? null])]),
  ]))
  // A custom exercise's muscles go with the entry, as Finish writes them: a device that deletes
  // the exercise without ever having seen this workout would otherwise leave its sets crediting
  // no muscle at all.
  const customs = customsOf(S)
  const workout = buildCompletedWorkout(
    { id, d: date, start, name, bw, routineIds: routine ? [routine.id] : [], note, entries },
    { end, prs: [], snapshotFor: e => { const c = customs.find(x => x.id === e.id); return c ? exerciseMuscleSnapshot(c) : null } },
  )
  // finish-workout's whitelist keeps `target`, which a timed hold and a dumbbell meaning need to
  // read back; volume as Finish stores it (warm-ups out, "each" counted per bell).
  workout.vol = workoutVolume(workout)
  return { workout, past, resolved, unit: profileUnit }
}

const sameEntries = (a, b) =>
  JSON.stringify(list(a).map(e => [e?.id, e?.sets])) === JSON.stringify(list(b).map(e => [e?.id, e?.sets]))

/**
 * The workout already in `S` this one repeats: the same request (its id) first, else the same day
 * with the same sets. `sameRequest` tells the two apart: a repeated request is never filed again,
 * the same sets are when the caller says it was a second session.
 */
export function findDuplicate(S, workout) {
  const all = list(S?.workouts).filter(Boolean)
  const own = all.find(w => w.id === workout.id)
  if (own) return { workout: own, sameRequest: true }
  const same = all.find(w => w.d === workout.d && sameEntries(w.entries, workout.entries))
  return same ? { workout: same, sameRequest: false } : null
}

/**
 * File a built workout into `S` (mutated): the workout in day order and, as Finish does, its PR
 * badges and confirmed weights for a session logged today, or for one logged into the past its
 * badges against the history around it and no confirmed weight moved. `allowDuplicate` files a
 * session identical to one already there (two real 3×10s on one day).
 *
 * Returns { added: true, workout, undo } or { added: false, reason: 'duplicate', workout,
 * sameRequest }. `undo` is what removeLoggedWorkout needs to take it back exactly: the confirmed
 * weights it moved and the badges of other sessions it changed, each before and after.
 */
export function appendLoggedWorkout(S, built, { now = Date.now(), allowDuplicate = false } = {}) {
  const dup = findDuplicate(S, built.workout)
  // A second session with the same sets has its own id already (its start or name differs, and
  // both are in the id), so a retry of it is caught by that id like any other.
  if (dup && (dup.sameRequest || !allowDuplicate)) return { added: false, reason: 'duplicate', workout: dup.workout, sameRequest: dup.sameRequest }
  const w = JSON.parse(JSON.stringify(built.workout))
  S.workouts = list(S.workouts).filter(Boolean)
  const prsBefore = new Map(S.workouts.filter(x => x.id != null).map(x => [x.id, list(x.prs).slice()]))
  const weightsBefore = isMap(S.exWeights) ? JSON.parse(JSON.stringify(S.exWeights)) : {}
  // Filed before a session already logged (an earlier day, or this morning when tonight's is
  // already in), it is a backfill: a badge it leads with, and one it falsifies on a later session
  // taken away, which the live-finish rule below would leave standing.
  const later = S.workouts.some(x => x.d > w.d || (x.d === w.d && (Number(x.start) || 0) > w.start))
  if (built.past || later) {
    // Its start and end are in the past; the stamp says when it was logged, which is what a merge
    // after a reset elsewhere asks of it (sync-merge.js sinceReset).
    stampWorkout(w, now)
    const touched = [...new Set(w.entries.map(e => e.id))]
    S.workouts = rebuildPrHistory(insertChronological(S.workouts, w), touched, w)
  } else {
    const H = { ...S, workouts: S.workouts.filter(x => Array.isArray(x.entries)) }
    w.prs = []
    w.entries.forEach(e => {
      const loads = e.sets.filter(s => s.done && !isWarmupRow(s)).map(s => s.w).filter(x => x > 0)
      const mx = loads.length ? loads.reduce((a, b) => betterWeight(e.id, a, b)) : 0
      // Held against history read the way this session logged a dumbbell weight (lib/dumbbells.js).
      if (beatsWeight(e.id, mx, bestWeightFor(H, e.id, entryDbLoad(e)))) w.prs.push(e.id)
    })
    S.exWeights = isMap(S.exWeights) ? S.exWeights : {}
    w.entries.forEach(e => {
      const mx = bestWeightForEntry(e)
      if (mx > 0 && beatsWeight(e.id, mx, (S.exWeights[e.id] || {}).w || 0)) S.exWeights[e.id] = { w: mx, d: w.d }
    })
    S.workouts = insertChronological(S.workouts, w)
  }
  const exWeights = {}
  for (const k of new Set([...Object.keys(weightsBefore), ...Object.keys(isMap(S.exWeights) ? S.exWeights : {})])) {
    const a = weightsBefore[k] ?? null, b = S.exWeights?.[k] ?? null
    if (JSON.stringify(a) !== JSON.stringify(b)) exWeights[k] = { before: a, after: b }
  }
  const prs = {}
  for (const x of S.workouts) {
    if (x.id == null || x.id === w.id || !prsBefore.has(x.id)) continue
    const a = prsBefore.get(x.id), b = list(x.prs)
    if (JSON.stringify(a) !== JSON.stringify(b)) prs[x.id] = { before: a, after: b.slice() }
  }
  return { added: true, workout: S.workouts.find(x => x.id === w.id) || w, undo: { workoutId: w.id, exWeights, prs } }
}

/**
 * Take a logged workout back out of `S` (a copy is returned; `S` is left alone): the workout, and
 * what logging it changed, for as long as that is still what logging it left. A confirmed weight
 * moved again since (a heavier session after it), or a badge changed since, stays as it is now.
 * Returns { next } or { gone: true } when the workout is no longer there.
 */
export function removeLoggedWorkout(S, undo) {
  const all = list(S?.workouts)
  if (!all.some(w => w && w.id === undo.workoutId)) return { gone: true }
  const next = JSON.parse(JSON.stringify(S))
  next.workouts = next.workouts.filter(w => !(w && w.id === undo.workoutId))
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  for (const [k, { before, after }] of Object.entries(undo.exWeights || {})) {
    if (!isMap(next.exWeights) || !same(next.exWeights[k], after)) continue
    if (before == null) delete next.exWeights[k]
    else next.exWeights[k] = before
  }
  for (const [id, { before, after }] of Object.entries(undo.prs || {})) {
    const w = next.workouts.find(x => x && x.id === id)
    if (w && same(list(w.prs), after)) w.prs = before
  }
  return { next }
}
