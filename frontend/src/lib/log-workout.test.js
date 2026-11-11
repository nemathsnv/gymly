// The hosted MCP's workout log (ported from openGym #739): what an assistant's description of a
// session becomes in the history, and what it moves. Most cases are upstream's; the merges,
// cardio and machine level, routines, the profile's own clock and the undo are this app's.
import { describe, expect, it } from 'vitest'
import { buildLoggedWorkout, appendLoggedWorkout, resolveExercise, findDuplicate, removeLoggedWorkout } from './log-workout.js'
import { setLabel, workoutVolume, setsDone } from './history.js'
import { best1RM } from './onerm.js'
import { mergeStates, stampChange } from './sync-merge.js'
import { EXIDX } from './exercises.js'

// Pinned to an evening, local time, so "today" and "now" mean the same thing on every machine.
const NOW = new Date('2026-10-20T19:30:00').getTime()
const TODAY = '2026-10-20'
const clone = v => JSON.parse(JSON.stringify(v))
const profile = (over = {}) => ({ unit: 'kg', workouts: [], routines: [], customEx: [], exWeights: {}, deleted: {}, edited: {}, ...over })
const curls = (over = {}) => ({
  date: TODAY,
  exercises: [{ exercise: 'dumbbell curl', sets: [{ reps: 12, weight: 12 }, { reps: 12, weight: 12 }, { reps: 10, weight: 12 }] }],
  ...over,
})
const build = (S, input, now = NOW, opts = {}) => buildLoggedWorkout(S, input, { now, ...opts })
const bench = (d, w, prs = []) => ({
  id: 'w' + d, d, start: new Date(d + 'T18:00:00').getTime(), end: new Date(d + 'T19:00:00').getTime(),
  routineIds: [], routineId: null, name: 'Bench', prs,
  entries: [{ id: '0025', sets: [{ w, r: 5, done: true }], topW: w, target: null }],
})

describe('what the user said becomes the workout Finish would have saved', () => {
  it('"dumbbell curls, 12 kg, 12/12/10": three rows, the catalogue curl, the volume Finish stores', () => {
    const r = build(profile(), curls())
    expect(r.problems).toBeUndefined()
    const w = r.workout
    expect(w.d).toBe(TODAY)
    expect(w.end).toBe(NOW)
    expect(w.routineIds).toEqual([])
    expect(w.name).toBe('Freestyle')
    expect(w.entries).toHaveLength(1)
    expect(w.entries[0].id).toBe('0294')
    expect(w.entries[0].sets).toEqual([{ w: 12, r: 12, done: true }, { w: 12, r: 12, done: true }, { w: 12, r: 10, done: true }])
    expect(w.entries[0].topW).toBe(12)
    expect(w.vol).toBe(workoutVolume(w))
    expect(w.vol).toBe(12 * 34)
    expect(setsDone(w)).toBe(3)
    expect(r.resolved[0]).toMatchObject({ input: 'dumbbell curl', id: '0294', name: EXIDX['0294'].n, mode: 'reps' })
    // the Stats screen's estimate finds the session (History: views/history-logged.test.jsx)
    expect(best1RM(profile({ workouts: [w] }), '0294')).toMatchObject({ w: 12, r: 12, d: TODAY })
  })

  it('a name the catalogue spells twice is a question with both answers, not the first of them', () => {
    const r = build(profile(), { date: TODAY, exercises: [{ exercise: 'lever chest press', sets: [{ reps: 10, weight: 40 }] }] })
    expect(r.workout).toBeUndefined()
    expect(r.problems[0].field).toBe('exercises[0].exercise')
    expect(r.problems[0].problem).toMatch(/more than one exercise matches/)
    expect(r.problems[0].candidates.map(c => c.id)).toEqual(['0576', '0577'])
    expect(r.problems[0].candidates[0]).toMatchObject({ name: 'lever chest press', equipment: 'leverage machine' })
  })

  it('a name nothing is close to says so, and suggests rather than invents', () => {
    const r = build(profile(), { date: TODAY, exercises: [{ exercise: 'zercher frobnicate', sets: [{ reps: 5 }] }] })
    expect(r.problems[0].problem).toMatch(/^no exercise in the library matches/)
    const none = resolveExercise(profile(), 'qqqq')
    expect(none).toMatchObject({ candidates: [] })
    expect(none.problem).toMatch(/make it in the app first/)
  })

  it("the user's own exercise is found by id and by name, and two of the same name ask which", () => {
    const own = { id: 'c1', n: 'Grip Trainer', custom: true, bp: 'lower arms' }
    expect(resolveExercise(profile({ customEx: [own] }), 'grip trainer')).toMatchObject({ id: 'c1', custom: true })
    expect(resolveExercise(profile({ customEx: [own] }), 'c1')).toMatchObject({ id: 'c1', name: 'Grip Trainer' })
    const twice = profile({ customEx: [own, { ...own, id: 'c2' }] })
    expect(resolveExercise(twice, 'Grip Trainer').candidates.map(c => c.id)).toEqual(['c1', 'c2'])
  })

  it('a key every object has is no exercise', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const r = build(profile(), { date: TODAY, exercises: [{ exercise: name, sets: [{ reps: 8, weight: 20 }] }] })
      expect(r.workout, name).toBeUndefined()
    }
  })

  it('the same exercise named twice (by name and by id) is one entry to fix, not two', () => {
    const r = build(profile(), { date: TODAY, exercises: [{ exercise: 'bench press', sets: [{ reps: 5 }] }, { exercise: '0025', sets: [{ reps: 5 }] }] })
    expect(r.problems[0]).toMatchObject({ field: 'exercises[1].exercise' })
    expect(r.problems[0].problem).toMatch(/same exercise as "bench press"/)
  })
})

describe('merged exercises (S.exMerged) are logged where their history went', () => {
  const merged = (over = {}) => profile({
    customEx: [{ id: 'c9', n: 'My Curl', custom: true, bp: 'upper arms', eq: 'custom' }],
    exMerged: {
      // a catalogue curl merged into the user's own
      '0294': { into: 'c9', _ts: 5 },
      // an imported custom bench, merged into the catalogue's and then removed
      cbench: { into: '0025', n: 'Bench Press (Barbell) FN', _ts: 6 },
    },
    ...over,
  })

  it('by the catalogue name, the catalogue id, or the old custom name and id', () => {
    expect(resolveExercise(merged(), 'dumbbell curl')).toMatchObject({ id: 'c9', name: 'My Curl', custom: true, merged_from: '0294' })
    expect(resolveExercise(merged(), '0294')).toMatchObject({ id: 'c9', merged_from: '0294' })
    expect(resolveExercise(merged(), 'Bench Press (Barbell) FN')).toMatchObject({ id: '0025', merged_from: 'cbench' })
    expect(resolveExercise(merged(), 'cbench')).toMatchObject({ id: '0025' })
    const w = build(merged(), curls()).workout
    expect(w.entries[0].id).toBe('c9')
  })

  it('an undone merge (into: null) is no merge', () => {
    const S = merged({ exMerged: { '0294': { into: null, _ts: 7 } } })
    expect(resolveExercise(S, 'dumbbell curl')).toMatchObject({ id: '0294' })
    expect(resolveExercise(S, 'dumbbell curl').merged_from).toBeUndefined()
  })

  it('candidates merged into the same exercise are offered once, under the name it has now', () => {
    const S = profile({ exMerged: { '0577': { into: '0576', _ts: 1 } } })
    expect(resolveExercise(S, 'lever chest press')).toMatchObject({ id: '0576' })
  })
})

describe('the numbers', () => {
  it('pounds into a kilo profile and kilos into a pound one, to the hundredth', () => {
    expect(build(profile(), curls({ unit: 'lb', exercises: [{ exercise: '0294', sets: [{ reps: 10, weight: 45 }] }] })).workout.entries[0].sets[0].w).toBe(20.41)
    expect(build(profile({ unit: 'lb' }), curls({ unit: 'kg', exercises: [{ exercise: '0294', sets: [{ reps: 10, weight: 20 }] }] })).workout.entries[0].sets[0].w).toBe(44.09)
    expect(build(profile({ unit: 'lb' }), curls({ exercises: [{ exercise: '0294', sets: [{ reps: 10, weight: 25 }] }] })).workout.entries[0].sets[0].w).toBe(25)
  })

  it('a warm-up is logged as one and stays out of the top weight and the volume', () => {
    const w = build(profile(), { date: TODAY, exercises: [{ exercise: '0025', sets: [{ reps: 5, weight: 120, warmup: true }, { reps: 5, weight: 100 }] }] }).workout
    expect(w.entries[0].sets[0]).toMatchObject({ phase: 'warmup' })
    expect(w.entries[0].topW).toBe(100)
    expect(w.vol).toBe(500)
  })

  it('a timed hold keeps its mode on the entry, so it reads back as 1:00 and not as 0 reps', () => {
    const w = build(profile(), { date: TODAY, exercises: [{ exercise: '0025', sets: [{ seconds: 60 }] }] }).workout
    const e = w.entries[0]
    expect(e.sets[0]).toEqual({ sec: 60, w: 0, done: true })
    expect(e.target.mode).toBe('time')
    expect(setLabel(e.id, e.sets[0], { ...e.target, id: e.id })).toBe('1:00')
  })

  it("a dumbbell exercise logged 'each' keeps that meaning, and its volume counts both bells", () => {
    const S = profile({ dbLoad: { '0289': { mode: 'each', _ts: 1 } } })
    const w = build(S, { date: TODAY, exercises: [{ exercise: '0289', sets: [{ reps: 10, weight: 20 }] }] }).workout
    expect(w.entries[0].target.dbLoad).toBe('each')
    expect(w.vol).toBe(400)
    expect(build(profile(), { date: TODAY, exercises: [{ exercise: '0289', sets: [{ reps: 10, weight: 20 }] }] }).workout.vol).toBe(200)
  })

  it('failure, RIR and RPE ride on the row; both scales at once, or effort on a hold, are refused', () => {
    const w = build(profile(), { date: TODAY, exercises: [{ exercise: '0025', sets: [{ reps: 5, weight: 100, rir: 2 }, { reps: 4, weight: 100, failure: true, rpe: 10 }] }] }).workout
    expect(w.entries[0].sets).toEqual([{ w: 100, r: 5, done: true, rir: 2 }, { w: 100, r: 4, done: true, failure: true, rpe: 10 }])
    expect(build(profile(), { date: TODAY, exercises: [{ exercise: '0025', sets: [{ reps: 5, rir: 2, rpe: 8 }] }] }).problems).toBeDefined()
    expect(build(profile(), { date: TODAY, exercises: [{ exercise: '0025', sets: [{ seconds: 30, rpe: 8 }] }] }).problems).toBeDefined()
    expect(build(profile(), { date: TODAY, exercises: [{ exercise: '0025', sets: [{ reps: 5, rpe: 3 }] }] }).problems).toBeDefined()
  })

  it('a set with nothing measured, a mix of reps and seconds, half a rep, no sets or a negative weight is refused, all at once', () => {
    const r = build(profile(), {
      date: TODAY,
      exercises: [
        { exercise: '0025', sets: [{}] },
        { exercise: '0289', sets: [{ reps: 5 }, { seconds: 30 }] },
        { exercise: '0043', sets: [{ reps: 2.5 }] },
        { exercise: '0294', sets: [] },
        { exercise: '0091', sets: [{ reps: 5, weight: -5 }] },
        { exercise: '0031', sets: [{ reps: 5, weight: 1200 }] },
      ],
    })
    expect(r.workout).toBeUndefined()
    expect(r.problems.map(p => p.field)).toEqual(['exercises[0].sets[0]', 'exercises[1].sets', 'exercises[2].sets[0]', 'exercises[3].sets', 'exercises[4].sets[0]', 'exercises[5].sets[0]'])
  })

  it('dates: not tomorrow, not 2026-02-30, not a start later than now', () => {
    expect(build(profile(), curls({ date: '2026-10-21' })).problems[0].field).toBe('date')
    expect(build(profile(), curls({ date: '2026-02-30' })).problems[0].field).toBe('date')
    expect(build(profile(), curls({ start: '21:00' })).problems[0].field).toBe('start')
    expect(build(profile(), curls({ start: '9am' })).problems[0].field).toBe('start')
  })

  it('times: today ends now; a given start and length are kept; the past gets the backfill 18:00 and hour', () => {
    const today = build(profile(), curls({ durationMin: 45 })).workout
    expect([today.start, today.end]).toEqual([NOW - 45 * 60000, NOW])
    const untimed = build(profile(), curls()).workout
    expect(untimed.end - untimed.start).toBe(60 * 60000)
    const given = build(profile(), curls({ start: '17:10', durationMin: 50 })).workout
    expect(given.start).toBe(new Date('2026-10-20T17:10:00').getTime())
    expect(given.end - given.start).toBe(50 * 60000)
    const past = build(profile(), curls({ date: '2026-10-18' }))
    expect(past.past).toBe(true)
    expect(past.workout.start).toBe(new Date('2026-10-18T18:00:00').getTime())
    expect(past.workout.end - past.workout.start).toBe(60 * 60000)
  })

  it("the profile's own calendar and clock decide, not the server's", () => {
    // 23:30 in UTC is already tomorrow in Tokyo: the date the user means is accepted there.
    const now = Date.parse('2026-10-20T23:30:00Z')
    const tokyo = (iso, hhmm) => Date.parse(`${iso}T${hhmm}:00+09:00`)
    const r = build(profile(), curls({ date: '2026-10-21', start: '07:00', durationMin: 30 }), now, { today: '2026-10-21', at: tokyo })
    expect(r.problems).toBeUndefined()
    expect(r.workout.start).toBe(Date.parse('2026-10-20T22:00:00Z'))
    expect(build(profile(), curls({ date: '2026-10-22' }), now, { today: '2026-10-21', at: tokyo }).problems[0].field).toBe('date')
  })

  it('a session that would end later than now is refused, today or from yesterday', () => {
    expect(build(profile(), curls({ start: '19:00', durationMin: 120 })).problems[0].field).toBe('durationMin')
    expect(build(profile(), curls({ date: '2026-10-19', start: '23:00', durationMin: 24 * 60 })).problems[0].field).toBe('durationMin')
  })

  it('"just did" after a session logged in the app is filed after it, at least five minutes long', () => {
    const app = { ...bench(TODAY, 100), id: 'w-app', start: new Date(`${TODAY}T18:00:00`).getTime(), end: new Date(`${TODAY}T19:29:00`).getTime() }
    const S = profile({ workouts: [app] })
    const built = build(S, curls())
    expect(built.workout.end - built.workout.start).toBe(5 * 60000)
    const r = appendLoggedWorkout(S, built, { now: NOW })
    expect(S.workouts.map(w => w.id)).toEqual(['w-app', r.workout.id])
  })
})

describe('cardio and the stepmill (this app logs both)', () => {
  it('a run is minutes and speed; reps on it are a question', () => {
    const w = build(profile(), { date: TODAY, exercises: [{ exercise: '0685', sets: [{ minutes: 25, speed: 10 }] }] }).workout
    expect(w.entries[0].sets).toEqual([{ min: 25, speed: 10, done: true }])
    expect(build(profile(), { date: TODAY, exercises: [{ exercise: '0685', sets: [{ reps: 10 }] }] }).problems[0].problem).toMatch(/is cardio: give minutes/)
  })

  it('a stepmill takes its machine level, not a speed', () => {
    const r = build(profile(), { date: TODAY, exercises: [{ exercise: 'stepmill', sets: [{ minutes: 15, level: 8 }] }] })
    expect(r.workout.entries[0]).toMatchObject({ id: '2311', sets: [{ min: 15, speed: 0, level: 8, done: true }] })
    expect(r.resolved[0].levelled).toBe(true)
    expect(build(profile(), { date: TODAY, exercises: [{ exercise: '2311', sets: [{ minutes: 15, speed: 5 }] }] }).problems[0].problem).toMatch(/level, not a speed/)
    expect(build(profile(), { date: TODAY, exercises: [{ exercise: '0685', sets: [{ minutes: 15, level: 5 }] }] }).problems[0].problem).toMatch(/stepmill or stair climber only/)
    expect(build(profile(), { date: TODAY, exercises: [{ exercise: '2311', sets: [{ minutes: 15, level: 99 }] }] }).problems).toBeDefined()
  })
})

describe('a session that followed a routine', () => {
  it('carries the routine, its name and each slot, so the next session reads it back', () => {
    const S = profile({ routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 5, weight: 60, sg: 'g1' }] }] })
    const w = build(S, { date: TODAY, routineId: 'r1', exercises: [{ exercise: 'bench press', sets: [{ reps: 5, weight: 60 }] }] }).workout
    expect(w.name).toBe('Push')
    expect(w.routineIds).toEqual(['r1'])
    expect(w.entries[0]).toMatchObject({ rid: 'r1', target: { id: '0025', sets: 3, reps: 5, weight: 60 } })
    expect(w.entries[0].target.sg).toBeUndefined()
    expect(build(S, { date: TODAY, routineId: 'nope', exercises: [{ exercise: '0025', sets: [{ reps: 5 }] }] }).problems[0].field).toBe('routineId')
  })
})

describe('the same call twice is one workout', () => {
  it('the id comes from the description, not the clock: a retry minutes later names the same workout', () => {
    const a = build(profile(), curls()).workout
    const b = build(profile(), curls(), NOW + 7 * 60000).workout
    expect(a.end).not.toBe(b.end)
    expect(b.id).toBe(a.id)
    // and the exercise as resolved, so a name and its id are the same request
    expect(build(profile(), curls({ exercises: [{ ...curls().exercises[0], exercise: '0294' }] })).workout.id).toBe(a.id)
  })

  it('a retry after the first write landed adds nothing', () => {
    const S = profile()
    expect(appendLoggedWorkout(S, build(S, curls()), { now: NOW }).added).toBe(true)
    const again = appendLoggedWorkout(S, build(S, curls(), NOW + 60000), { now: NOW + 60000 })
    expect(again).toMatchObject({ added: false, reason: 'duplicate', sameRequest: true })
    expect(S.workouts).toHaveLength(1)
  })

  it('the same sets reworded (another note) are a duplicate too, unless the caller says it is a second session', () => {
    const S = profile()
    appendLoggedWorkout(S, build(S, curls()), { now: NOW })
    const reworded = build(S, curls({ note: 'felt strong' }))
    expect(findDuplicate(S, reworded.workout)).toMatchObject({ sameRequest: false })
    expect(appendLoggedWorkout(S, reworded, { now: NOW }).added).toBe(false)
    expect(appendLoggedWorkout(S, reworded, { now: NOW, allowDuplicate: true }).added).toBe(true)
    expect(new Set(S.workouts.map(w => w.id)).size).toBe(2)
    // and allowed once, a retry of it is still caught by its id
    expect(appendLoggedWorkout(S, reworded, { now: NOW, allowDuplicate: true }).added).toBe(false)
  })
})

describe('filed the way Finish files it, and taken back exactly', () => {
  it('today: a heavier top set than history is a PR and becomes the confirmed weight; undo puts it back', () => {
    const S = profile({ workouts: [bench('2026-10-13', 100, ['0025'])], exWeights: { '0025': { w: 100, d: '2026-10-13' } } })
    const before = clone(S)
    const r = appendLoggedWorkout(S, build(S, { date: TODAY, exercises: [{ exercise: '0025', sets: [{ reps: 3, weight: 105 }] }] }), { now: NOW })
    expect(r.workout.prs).toEqual(['0025'])
    expect(S.exWeights['0025']).toEqual({ w: 105, d: TODAY })
    expect(r.workout._ts).toBeUndefined()
    expect(r.undo.exWeights).toEqual({ '0025': { before: { w: 100, d: '2026-10-13' }, after: { w: 105, d: TODAY } } })
    const { next } = removeLoggedWorkout(S, r.undo)
    expect(next).toEqual(before)
    expect(removeLoggedWorkout(next, r.undo)).toEqual({ gone: true })
  })

  it('undo leaves a confirmed weight moved again since', () => {
    const S = profile()
    const r = appendLoggedWorkout(S, build(S, { date: TODAY, exercises: [{ exercise: '0025', sets: [{ reps: 3, weight: 105 }] }] }), { now: NOW })
    S.exWeights['0025'] = { w: 110, d: TODAY }
    expect(removeLoggedWorkout(S, r.undo).next.exWeights['0025']).toEqual({ w: 110, d: TODAY })
  })

  it('today, assisted: less help is the better set, and a warm-up with more help moves nothing', () => {
    const S = profile({ exWeights: { 1432: { w: 25, d: '2026-10-13' } } })
    appendLoggedWorkout(S, build(S, { date: TODAY, exercises: [{ exercise: '1432', sets: [{ reps: 8, weight: 35, warmup: true }, { reps: 8, weight: 20 }, { reps: 8, weight: 22.5 }] }] }), { now: NOW })
    expect(S.exWeights['1432']).toEqual({ w: 20, d: TODAY })
  })

  it('into the past: confirmed weights stay; badges are held against the history around it; undo gives the later badge back', () => {
    const later = bench('2026-10-15', 100, ['0025'])
    const S = profile({ workouts: [later], exWeights: { '0025': { w: 100, d: '2026-10-15' } } })
    const before = clone(S)
    const r = appendLoggedWorkout(S, build(S, { date: '2026-10-10', exercises: [{ exercise: '0025', sets: [{ reps: 3, weight: 110 }] }] }), { now: NOW })
    expect(S.exWeights['0025']).toEqual({ w: 100, d: '2026-10-15' })
    expect(S.workouts.map(w => w.d)).toEqual(['2026-10-10', '2026-10-15'])
    expect(r.workout.prs).toEqual(['0025'])
    expect(r.workout._ts).toBe(NOW)
    expect(S.workouts[1].prs).toEqual([])
    expect(r.undo.prs).toEqual({ 'w2026-10-15': { before: ['0025'], after: [] } })
    expect(removeLoggedWorkout(S, r.undo).next).toEqual(before)
  })

  it("this morning's session logged after tonight's takes tonight's badge away, as a backfill does", () => {
    const evening = { ...bench(TODAY, 100, ['0025']), start: new Date(`${TODAY}T18:00:00`).getTime(), end: new Date(`${TODAY}T19:00:00`).getTime() }
    const S = profile({ workouts: [evening], exWeights: { '0025': { w: 100, d: TODAY } } })
    const r = appendLoggedWorkout(S, build(S, { date: TODAY, start: '10:00', durationMin: 60, exercises: [{ exercise: '0025', sets: [{ reps: 3, weight: 110 }] }] }), { now: NOW })
    expect(S.workouts.map(w => w.id)).toEqual([r.workout.id, evening.id])
    expect(r.workout.prs).toEqual(['0025'])
    expect(S.workouts[1].prs).toEqual([])
  })

  it("a custom exercise's muscles ride on the entry, so a device deleting it unseen leaves the sets their credit", () => {
    const own = { id: 'c1', n: 'Landmine press thing', custom: true, eq: 'custom', bp: 'chest', tg: '', desc: '' }
    const w = build(profile({ customEx: [own] }), { date: TODAY, exercises: [{ exercise: 'c1', sets: [{ reps: 8, weight: 20 }] }] }).workout
    expect(w.entries[0].muscleSnapshot).toBeTruthy()
    expect(build(profile(), { date: TODAY, exercises: [{ exercise: '0025', sets: [{ reps: 5 }] }] }).workout.entries[0].muscleSnapshot).toBeUndefined()
  })
})

describe('what a device does with it on its next sync', () => {
  it("a phone with its own unsent change keeps the logged workout, and the phone's change", () => {
    const old = bench('2026-10-13', 100)
    const server0 = profile({ workouts: [old], routines: [{ id: 'r1', name: 'Push', ex: [], _ts: 1 }], _ts: 1 })
    // the hosted MCP's write: the server's document plus the workout
    const server1 = clone(server0)
    appendLoggedWorkout(server1, build(server1, curls()), { now: NOW })
    // the phone, offline since server0: renamed a routine and deleted last week's session
    const phone = clone(server0)
    phone.routines[0].name = 'Push day'
    phone.workouts = []
    phone._ts = stampChange(server0, phone, NOW - 60000)
    const merged = mergeStates(phone, server1)
    expect(merged.routines[0].name).toBe('Push day')
    expect(merged.workouts.map(w => w.entries[0].id)).toEqual(['0294'])
    // and the other way round: the phone's copy taken as the newer one keeps it as well
    expect(mergeStates(server1, phone).workouts.map(w => w.entries[0].id)).toEqual(['0294'])
  })

  it('a backfill the server logged survives a phone that never saw it, with its badges', () => {
    const later = bench('2026-10-15', 100, ['0025'])
    const server0 = profile({ workouts: [later], _ts: 1 })
    const server1 = clone(server0)
    const r = appendLoggedWorkout(server1, build(server1, { date: '2026-10-10', exercises: [{ exercise: '0025', sets: [{ reps: 3, weight: 110 }] }] }), { now: NOW })
    const merged = mergeStates(clone(server0), server1)
    expect(merged.workouts.map(w => w.id)).toEqual([r.workout.id, later.id])
    expect(merged.workouts[0].prs).toEqual(['0025'])
  })
})
