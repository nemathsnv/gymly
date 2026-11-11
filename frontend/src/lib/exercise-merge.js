// Merge one exercise into another (#656, ported from openGym): an import from FitNotes or Strong
// left "Bench Press (Barbell)" as a custom exercise next to the catalogue's barbell bench press,
// and the history belongs on the catalogue one.
//
// Everything that names the exercise moves to the target:
//   - every logged entry (with its sets, notes, set media and a stepmill's machine level, which
//     live on the sets), in every saved workout, and the workout's records list; each workout
//     touched is stamped as edited, so a sync keeps this version
//   - routine slots, with everything the slot carries (sets, rest, warm-ups, progression,
//     superset group)
//   - the kept working weight (the better of the two), the standing note (both, joined), the
//     favourite star, and the per-exercise settings the target has none of yet: bar weight, plate
//     loading, what a dumbbell weight means, and the weight +/− step and pulley (lib/weight-step.js)
//   - Structural Balance's role overrides that picked it
// Then the source goes: a custom exercise is removed (its photo or video, and its link, move to
// the target when the target is your own exercise and has none). A catalogue exercise cannot be
// removed, so it is hidden instead (lib/exercises.js allExercises leaves it out), and searching
// for its name finds the target (lib/exercises.js keeps the names merged into an exercise).
//
// `S.exMerged` records each merge, `{ [sourceId]: { into, n?, _ts } }` (`n`: a custom source's
// name, for that search), stamped per key like the other settings maps (sync-merge.js
// STAMPED_MAPS). It is how the merge stays a merge on every copy: a workout another device logged
// against the source before it heard of the merge is moved over when the two copies meet
// (sync-merge.js mergeStates → applyExerciseMerges), and the MCP bridge reads it the same way
// (mcp/src/state.js, mcp/src/hosted-state.js). Undo clears the record (`into: null`, stamped) and
// puts everything back as it was.
//
// Not here, because this app has none of them: upstream's programme targets, routine backups
// (`subs`), editable aliases and per-exercise weight units.
import { betterWeight, isCustomEx, EXIDX, mergedTarget } from './exercises.js'
import { exerciseMuscleSnapshot } from './muscles.js'
import { NOTE_MAX } from './history.js'

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
const list = v => (Array.isArray(v) ? v : [])
const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

// Per-exercise settings maps: the target keeps its own, the source's moves only where it has none.
// barWeights holds plain numbers; the other three carry their own stamp (sync-merge.js STAMPED_MAPS).
const MOVE_MAPS = ['barWeights', 'loadKind', 'dbLoad', 'exEquip']
// What an Undo puts back whole.
const RESTORE = ['routines', 'customEx', 'exWeights', 'exNotes', 'favEx', 'balanceOverrides', ...MOVE_MAPS]

/** Where `id` went, following merges of merges; `id` itself when it was never merged. */
export const mergedInto = (S, id) => mergedTarget(S?.exMerged, id)

/** The ids merged away (catalogue exercises among them are hidden from the lists), or null. */
export function mergedAway(S) {
  const m = isMap(S?.exMerged) ? S.exMerged : null
  if (!m) return null
  const out = new Set()
  for (const [k, v] of Object.entries(m)) if (v && v.into) out.add(k)
  return out.size ? out : null
}

const exOf = (S, id) => list(S?.customEx).find(c => c?.id === id) || EXIDX[id] || null
const entryHas = (w, id) => list(w?.entries).some(e => e?.id === id)
const routineHas = (r, id) => list(r?.ex).some(c => c?.id === id)
const workoutKey = w => (w?.id != null ? w.id : `${w?.d}|${w?.start}`)

/**
 * What a merge of `fromId` into `toId` would move, for the confirm sheet: counts of workouts,
 * logged sets and routines, and whether a note comes along.
 */
export function mergePreview(S, fromId, toId) {
  const workouts = list(S?.workouts).filter(w => entryHas(w, fromId))
  const sets = workouts.reduce((n, w) => n + list(w.entries).filter(e => e?.id === fromId)
    .reduce((m, e) => m + list(e.sets).filter(s => s?.done).length, 0), 0)
  return {
    workouts: workouts.length,
    sets,
    routines: list(S?.routines).filter(r => routineHas(r, fromId)).length,
    note: !!(S?.exNotes?.[fromId] || '').trim(),
    custom: list(S?.customEx).some(c => c?.id === fromId),
    same: fromId === toId,
  }
}

/** Why a merge cannot happen, as an English key for t(), or null when it can. */
export function mergeBlocked(S, fromId, toId) {
  if (!fromId || !toId || fromId === toId) return 'Pick a different exercise.'
  // Nothing goes into an exercise that was itself merged away (into the source or anywhere).
  if (mergedInto(S, toId) !== toId) return 'Pick a different exercise.'
  if (!exOf(S, toId)) return 'Pick a different exercise.'
  if (list(S?.active?.entries).some(e => e?.id === fromId)) return 'Finish your current workout first'
  return null
}

// The entry's history snapshot follows the target: a custom target's own muscles and name, none
// for a catalogue one (the catalogue answers for it).
function retarget(e, toId, toEx) {
  e.id = toId
  if (toEx && isCustomEx(toEx)) {
    const snap = exerciseMuscleSnapshot(toEx)
    if (Object.keys(snap).length) e.muscleSnapshot = snap; else delete e.muscleSnapshot
    if (toEx.n) e.n = toEx.n
  } else {
    delete e.muscleSnapshot
    delete e.n
  }
}

/**
 * Every place in `S` that still names `fromId`, moved to `toId`. With `stamp`, each workout it
 * changes is stamped as edited at `now` (an edit made here, which a sync must keep; the same as
 * sync-merge.js stampWorkout, written out to keep the two modules from importing each other);
 * without, it is a merged copy being brought in line (applyExerciseMerges). Returns the keys of
 * the workouts it changed. Mutates `S`.
 */
function redirect(S, fromId, toId, { stamp = false, now = Date.now() } = {}) {
  const toEx = exOf(S, toId)
  const changed = []
  for (const w of list(S.workouts)) {
    if (!entryHas(w, fromId)) continue
    for (const e of list(w.entries)) if (e?.id === fromId) retarget(e, toId, toEx)
    if (Array.isArray(w.prs) && w.prs.includes(fromId)) w.prs = [...new Set(w.prs.map(id => (id === fromId ? toId : id)))]
    if (stamp) w._ts = now
    changed.push(workoutKey(w))
  }
  for (const r of list(S.routines)) {
    if (!routineHas(r, fromId)) continue
    r.ex = list(r.ex).map(c => (c && c.id === fromId ? { ...c, id: toId } : c))
  }
  return changed
}

/**
 * Merges `fromId` into `toId` in `S` (a store draft) at `now`. Returns `{ undo }`: what Undo needs
 * to put it all back (the touched workouts as they were, and the fields replaced whole). Throws
 * with mergeBlocked's reason when it cannot happen.
 */
export function mergeExercise(S, fromId, toId, { now = Date.now() } = {}) {
  const blocked = mergeBlocked(S, fromId, toId)
  if (blocked) throw new Error(blocked)
  const fromEx = exOf(S, fromId)
  const custom = list(S.customEx).some(c => c?.id === fromId)
  const before = {}
  for (const f of RESTORE) before[f] = clone(S[f])
  before.workouts = clone(list(S.workouts).filter(w => entryHas(w, fromId)))

  redirect(S, fromId, toId, { stamp: true, now })

  // The kept working weight: the better of the two (lighter on an assistance machine).
  if (isMap(S.exWeights) && S.exWeights[fromId]) {
    const ew = { ...S.exWeights }
    const a = Number(ew[fromId]?.w) || 0, b = Number(ew[toId]?.w) || 0
    if (!b || (a && a !== b && betterWeight(toId, a, b) === a)) ew[toId] = { ...ew[fromId] }
    delete ew[fromId]
    S.exWeights = ew
  }
  // The standing note: both, the target's first.
  if (isMap(S.exNotes) && fromId in S.exNotes) {
    const notes = { ...S.exNotes }
    const joined = [notes[toId], notes[fromId]].map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
    if (joined.length) notes[toId] = [...new Set(joined)].join('\n').slice(0, NOTE_MAX)
    delete notes[fromId]
    S.exNotes = notes
  }
  // The favourite star moves with it.
  if (Array.isArray(S.favEx) && S.favEx.includes(fromId)) S.favEx = [...new Set(S.favEx.map(id => (id === fromId ? toId : id)))]
  // Per-exercise settings: the target keeps its own.
  for (const f of MOVE_MAPS) {
    if (!isMap(S[f]) || !(fromId in S[f])) continue
    const m = { ...S[f] }
    if (!(toId in m) && m[fromId] != null) m[toId] = isMap(m[fromId]) && m[fromId]._ts != null ? { ...m[fromId], _ts: now } : m[fromId]
    delete m[fromId]
    S[f] = m
  }
  if (isMap(S.balanceOverrides)) {
    let touched = false
    const m = {}
    for (const [k, v] of Object.entries(S.balanceOverrides)) {
      if (isMap(v) && v.id === fromId) { m[k] = { ...v, id: toId, _ts: now }; touched = true } else m[k] = v
    }
    if (touched) S.balanceOverrides = m
  }
  // The source itself: a custom exercise goes (its picture and link to an own target that has none).
  if (custom) {
    const src = S.customEx.find(c => c?.id === fromId)
    S.customEx = S.customEx.filter(c => c?.id !== fromId).map(c => {
      if (c?.id !== toId) return c
      const next = { ...c }
      if (src?.media && !c.media) next.media = src.media
      if (src?.url && !c.url) next.url = src.url
      return next
    })
  }
  const rec = { into: toId, _ts: now }
  if (custom && typeof fromEx?.n === 'string' && fromEx.n.trim()) rec.n = fromEx.n.trim()
  S.exMerged = { ...(isMap(S.exMerged) ? S.exMerged : {}), [fromId]: rec }
  return { undo: { fromId, toId, before } }
}

/**
 * Puts a merge back (its Undo): the workouts it touched as they were (stamped again, so a sync
 * keeps them), every field it replaced, and its record cleared with a stamp of its own.
 */
export function undoMerge(S, undo, { now = Date.now() } = {}) {
  if (!undo?.before) return
  const { before, fromId } = undo
  for (const f of RESTORE) {
    if (before[f] === undefined) delete S[f]
    else S[f] = clone(before[f])
  }
  // A stamped setting put back is a change of its own: it has to win a sync like the merge did.
  for (const f of ['loadKind', 'dbLoad', 'exEquip', 'balanceOverrides']) {
    if (!isMap(S[f])) continue
    for (const [k, v] of Object.entries(S[f])) if (isMap(v) && v._ts != null && (k === fromId || k === undo.toId || v.id === fromId)) S[f][k] = { ...v, _ts: now }
  }
  const back = new Map(list(before.workouts).map(w => [workoutKey(w), w]))
  S.workouts = list(S.workouts).map(w => {
    const old = back.get(workoutKey(w))
    if (!old) return w
    const restored = clone(old)
    restored._ts = now
    return restored
  })
  S.exMerged = { ...(isMap(S.exMerged) ? S.exMerged : {}), [fromId]: { into: null, _ts: now } }
}

/**
 * Brings a copy in line with the merges it records: anything that still names a merged-away
 * exercise (a workout another device logged before it heard of the merge, a routine from an
 * older backup) is moved to where that exercise went. Nothing is stamped: this is the same merge,
 * met again. Returns how many workouts it moved. Mutates `S`.
 */
export function applyExerciseMerges(S) {
  const away = mergedAway(S)
  if (!away) return 0
  let n = 0
  for (const fromId of away) {
    const toId = mergedInto(S, fromId)
    if (!toId || toId === fromId) continue
    n += redirect(S, fromId, toId).length
    if (list(S.customEx).some(c => c?.id === fromId)) S.customEx = S.customEx.filter(c => c?.id !== fromId)
  }
  return n
}

/**
 * `S` as a reader should see it (the MCP bridge): the same document when it records no merge,
 * otherwise a copy brought in line by applyExerciseMerges. Never mutates `S`.
 */
export function withExerciseMerges(S) {
  if (!S || typeof S !== 'object' || !mergedAway(S)) return S
  const out = clone(S)
  try { applyExerciseMerges(out) } catch { return S }
  return out
}
