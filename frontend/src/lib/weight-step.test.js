// The weight + and − buttons (lib/weight-step.js): exact steps that undo each other, a step of
// the exercise's own that wins over the plan's, kept per unit, synced, and never reaching back
// into progression or a logged set.
import { describe, expect, it } from 'vitest'
import * as Server from '../../../api/sync-stamps.js'
import { PULLEYS, onPlanGrid, ownStepFor, pulleyFor, stepBy, takesPulley, weightStepper, withExEquip } from './weight-step.js'
import { nextPrescription } from './progression.js'
import { convertStateUnit } from './units.js'
import { highestStamp, mergeStates, resetIdsOf, stampChange, STAMPED_MAPS } from './sync-merge.js'
import { EXIDX } from './exercises.js'

const ROW = '0292'       // dumbbell one arm bent-over row: back, so 5 kg by default
const LUNGE = '0336'     // dumbbell lunge: upper legs, 5 kg by default
const CURL = '0294'      // dumbbell biceps curl: 2.5 kg by default
const CABLE_ROW = '0861' // cable seated row
const LEG_EXT = '0585'   // lever leg extension
const RACK = [2, 4, 6, 8, 10, 12, 14]

const base = (over = {}) => ({
  unit: 'kg', week: {}, dayPlan: {}, workouts: [], routines: [], bodyweight: [], customEx: [], favEx: [],
  exWeights: {}, exNotes: {}, barWeights: {}, equipProfiles: [], gymCards: [], _ts: 0, ...over,
})
const taps = (v, step, dir, n) => { for (let i = 0; i < n; i++) v = stepBy(v, step, dir); return v }
const session = (d, id, w, reps) => ({
  id: 'w' + d, d, start: new Date(d + 'T10:00:00').getTime(),
  entries: [{ id, target: { sets: 2, reps: 8, mode: 'reps' }, sets: reps.map(r => ({ w, r, done: true })) }],
})

describe('one tap', () => {
  it('the exercises used here are what the test assumes', () => {
    expect([EXIDX[ROW].eq, EXIDX[ROW].bp]).toEqual(['dumbbell', 'back'])
    expect([EXIDX[LUNGE].eq, EXIDX[LUNGE].bp]).toEqual(['dumbbell', 'upper legs'])
    expect(EXIDX[CABLE_ROW].eq).toBe('cable')
    expect(EXIDX[LEG_EXT].eq).toBe('leverage machine')
  })

  it('walks 10 → 12.5 → 15 with a 2.5 kg step, and back', () => {
    expect(stepBy(10, 2.5, 1)).toBe(12.5)
    expect(stepBy(12.5, 2.5, 1)).toBe(15)
    expect(stepBy(15, 2.5, -1)).toBe(12.5)
    expect(stepBy(12.5, 2.5, -1)).toBe(10)
  })

  it('keeps a typed weight off the grid where it is: 11.5 + 2.5 is 14, and − is 11.5 again', () => {
    expect(stepBy(11.5, 2.5, 1)).toBe(14)
    expect(stepBy(14, 2.5, -1)).toBe(11.5)
    expect(stepBy(11.5, 2.5, -1)).toBe(9)
    expect(stepBy(9, 2.5, 1)).toBe(11.5)
  })

  it('is not pulled onto the grid by a near miss: 11.4 with a 0.5 step goes to 11.9 and back', () => {
    // the old stepper read anything within 0.1 of the grid as on it: 11.4 + 0.5 was 12, − was 11.5
    expect(stepBy(11.4, 0.5, 1)).toBe(11.9)
    expect(stepBy(11.9, 0.5, -1)).toBe(11.4)
    expect(stepBy(62.45, 0.25, 1)).toBe(62.7)
  })

  it('undoes itself exactly, however many taps, in every step', () => {
    for (const step of [0.1, 0.25, 0.5, 1, 1.25, 2, 2.5, 4.5, 5, 10]) {
      for (const start of [0, 7.3, 11.5, 20, 61.25, 100]) {
        const up = taps(start, step, 1, 200)
        expect(taps(up, step, -1, 200)).toBe(start)
      }
    }
  })

  it('adds up without drift: a hundred taps of 1.25 is 125, of 0.1 is 10', () => {
    expect(taps(0, 1.25, 1, 100)).toBe(125)
    expect(taps(0, 0.1, 1, 100)).toBe(10)
    expect(taps(0, 0.25, 1, 7)).toBe(1.75)
    expect(taps(20, 1.25, 1, 3)).toBe(23.75)
    expect(taps(20, 0.5, -1, 3)).toBe(18.5)
    expect(taps(10, 0.1, 1, 3)).toBe(10.3)       // not 10.299999999999999
  })

  it('on the plan\'s step, reads a tenth-rounded progression weight as the grid value it stands for', () => {
    // progression rounds a 1.25 grid to a tenth: 61.25 is prescribed as 61.3
    expect(onPlanGrid(61.3, 1.25)).toBe(61.25)
    expect(onPlanGrid(63.8, 1.25)).toBe(63.75)
    const plan = weightStepper(base(), { id: CURL, inc: 1.25 })
    expect(plan.source).toBe('plan')
    expect(plan.move(61.3, 1)).toBe(62.5)
    expect(plan.move(61.3, -1)).toBe(60)
    expect(plan.move(63.8, 1)).toBe(65)
    // a weight that is no rounding of the grid is kept as typed
    expect(onPlanGrid(61.4, 1.25)).toBe(61.4)
    expect(plan.move(61.4, 1)).toBe(62.65)
    expect(plan.move(11.5, 1)).toBe(12.75)
    // and nothing is read into a step of the exercise's own, nor into whole or half steps
    expect(stepBy(61.3, 1.25, 1)).toBe(62.55)
    expect(onPlanGrid(11.4, 0.5)).toBe(11.4)
    expect(onPlanGrid(7.3, 2.5)).toBe(7.3)
  })

  it('works the same in pounds', () => {
    expect(taps(45, 5, 1, 3)).toBe(60)
    expect(stepBy(47.5, 5, 1)).toBe(52.5)
    expect(stepBy(52.5, 5, -1)).toBe(47.5)
    expect(taps(135, 2.5, 1, 4)).toBe(145)
  })

  it('never goes below 0, and leaves the weight alone without a step', () => {
    expect(stepBy(1, 2.5, -1)).toBe(0)
    expect(stepBy(0, 2.5, -1)).toBe(0)
    expect(stepBy(0, 2.5, 1)).toBe(2.5)
    expect(stepBy('', 2.5, 1)).toBe(2.5)
    expect(stepBy(null, 2.5, 1)).toBe(2.5)
    expect(stepBy(10, 0, 1)).toBe(10)
    expect(stepBy(10, null, 1)).toBe(10)
  })
})

describe('the step an exercise steps by', () => {
  const S = (over = {}) => base({ unit: 'kg', ...over })

  it('without a step of its own: the plan\'s increment, or the default for the exercise, as before', () => {
    expect(weightStepper(S(), { id: ROW })).toMatchObject({ step: 5, source: 'plan' })
    expect(weightStepper(S(), { id: CURL })).toMatchObject({ step: 2.5, source: 'plan' })
    expect(weightStepper(S(), { id: ROW, inc: 2 })).toMatchObject({ step: 2, source: 'plan' })
    expect(weightStepper(S(), { id: ROW }).move(10, 1)).toBe(15)
  })

  it('a dumbbell row given 2.5 kg goes 10 → 12.5 → 15', () => {
    const st = S({ exEquip: withExEquip(S(), ROW, { step: 2.5 }, 1) })
    const s = weightStepper(st, { id: ROW })
    expect(s).toMatchObject({ step: 2.5, source: 'exercise' })
    expect(s.move(s.move(10, 1), 1)).toBe(15)
    expect(s.move(10, 1)).toBe(12.5)
  })

  it('wins over the plan\'s progression step and over the dumbbells you own', () => {
    const st = S({ exEquip: withExEquip(S(), CURL, { step: 1 }, 1), dumbbells: { kg: { weights: RACK, _ts: 1 } } })
    expect(weightStepper(st, { id: CURL, inc: 2.5 })).toMatchObject({ step: 1, source: 'exercise' })
    expect(weightStepper(st, { id: CURL }).move(10, 1)).toBe(11)
    // the rack still walks a dumbbell exercise without a step of its own
    const lunge = weightStepper(st, { id: LUNGE })
    expect(lunge.source).toBe('dumbbells')
    expect(lunge.move(10, 1)).toBe(12)
    expect(lunge.move(11, 1)).toBe(12)
  })

  it('is per exercise: changing one leaves the next one as it was', () => {
    let st = S()
    st = { ...st, exEquip: withExEquip(st, CABLE_ROW, { step: 5 }, 1) }
    st = { ...st, exEquip: withExEquip(st, LEG_EXT, { step: 2.5 }, 2) }
    st = { ...st, exEquip: withExEquip(st, ROW, { step: 1.25 }, 3) }
    expect(weightStepper(st, { id: CABLE_ROW }).move(40, 1)).toBe(45)
    expect(weightStepper(st, { id: LEG_EXT }).move(40, 1)).toBe(42.5)
    expect(weightStepper(st, { id: ROW }).move(40, 1)).toBe(41.25)
    expect(weightStepper(st, { id: LUNGE }).move(40, 1)).toBe(45)  // untouched: still its default
    st = { ...st, exEquip: withExEquip(st, LEG_EXT, { step: 5 }, 4) }
    expect(weightStepper(st, { id: LEG_EXT }).move(40, 1)).toBe(45)
    expect(weightStepper(st, { id: CABLE_ROW }).move(40, 1)).toBe(45)
    expect(weightStepper(st, { id: ROW }).move(40, 1)).toBe(41.25)
  })

  it('is kept per unit, never converted, and a unit switch leaves it where it was', () => {
    const kg = S({ exEquip: withExEquip(S(), ROW, { step: 2.5 }, 1) })
    expect(ownStepFor(kg, ROW)).toBe(2.5)
    const lb = convertStateUnit(kg, 'lb')
    expect(lb.exEquip).toEqual(kg.exEquip)
    expect(ownStepFor(lb, ROW)).toBeNull()             // no pound step said yet: the default
    expect(weightStepper(lb, { id: ROW }).step).toBe(10)
    const both = { ...lb, exEquip: withExEquip(lb, ROW, { step: 5 }, 2) }
    expect(both.exEquip[ROW].step).toEqual({ kg: 2.5, lb: 5 })
    expect(ownStepFor(convertStateUnit(both, 'kg'), ROW)).toBe(2.5)
  })

  it('clearing goes back to the plan\'s step, for this unit only, and keeps the pulley', () => {
    let st = S({ exEquip: withExEquip(S(), CABLE_ROW, { step: 5, pulley: '2:1' }, 1) })
    st = { ...st, exEquip: withExEquip({ ...st, unit: 'lb' }, CABLE_ROW, { step: 10 }, 2) }
    st = { ...st, exEquip: withExEquip(st, CABLE_ROW, { step: null }, 3) }
    expect(st.exEquip[CABLE_ROW]).toEqual({ step: { lb: 10 }, pulley: '2:1', _ts: 3 })
    expect(weightStepper(st, { id: CABLE_ROW }).source).toBe('plan')
    expect(pulleyFor(st, CABLE_ROW)).toBe('2:1')
  })

  it('takes only a real step: nothing, zero, negatives and junk are no step', () => {
    for (const bad of [0, -2.5, 'x', NaN, Infinity, 0.001]) {
      expect(ownStepFor(S({ exEquip: withExEquip(S(), ROW, { step: bad }, 1) }), ROW)).toBeNull()
    }
    expect(ownStepFor(S({ exEquip: { [ROW]: { step: { kg: '2.5' }, _ts: 1 } } }), ROW)).toBe(2.5)
    expect(ownStepFor(S({ exEquip: { [ROW]: 'junk' } }), ROW)).toBeNull()
    expect(ownStepFor(S({ exEquip: null }), ROW)).toBeNull()
  })
})

describe('the pulley', () => {
  it('is a label from a short list, offered on cables and machines', () => {
    expect(PULLEYS).toEqual(['1:1', '2:1', '4:1'])
    expect(takesPulley(CABLE_ROW)).toBe(true)
    expect(takesPulley(LEG_EXT)).toBe(true)
    expect(takesPulley(ROW)).toBe(false)
    const st = base({ exEquip: withExEquip(base(), CABLE_ROW, { pulley: '3:7' }, 1) })
    expect(pulleyFor(st, CABLE_ROW)).toBeNull()
  })

  it('changes no number: the step and every logged weight stay what the stack shows', () => {
    const plain = base({ workouts: [session('2026-10-01', CABLE_ROW, 50, [8, 8])] })
    const rigged = { ...plain, exEquip: withExEquip(plain, CABLE_ROW, { pulley: '2:1' }, 1) }
    expect(weightStepper(rigged, { id: CABLE_ROW }).move(50, 1)).toBe(weightStepper(plain, { id: CABLE_ROW }).move(50, 1))
    expect(rigged.workouts).toEqual(plain.workouts)
    expect(nextPrescription(rigged, { id: CABLE_ROW, sets: 2, reps: 8, mode: 'reps' }, null))
      .toEqual(nextPrescription(plain, { id: CABLE_ROW, sets: 2, reps: 8, mode: 'reps' }, null))
  })
})

describe('what it leaves alone', () => {
  it('progression keeps its own increment: the next weight is the same with or without a step', () => {
    const plain = base({ workouts: [session('2026-10-01', ROW, 20, [8, 8])] })
    const stepped = { ...plain, exEquip: withExEquip(plain, ROW, { step: 2.5 }, 1) }
    const cfg = { id: ROW, sets: 2, reps: 8, mode: 'reps' }
    const a = nextPrescription(plain, cfg, null)
    expect(a.weight).toBe(25)
    expect(nextPrescription(stepped, cfg, null)).toEqual(a)
  })

  it('setting or clearing a step writes S.exEquip only: no logged set, routine or plan changes', () => {
    const st = base({
      workouts: [session('2026-10-01', ROW, 11.5, [8, 8]), session('2026-10-03', ROW, 12.5, [8, 7])],
      routines: [{ id: 'r1', name: 'A', ex: [{ id: ROW, sets: 2, reps: 8, weight: 12.5, inc: 5 }] }],
    })
    const before = JSON.parse(JSON.stringify(st))
    const after = { ...st, exEquip: withExEquip(st, ROW, { step: 2.5, pulley: null }, 1) }
    const cleared = { ...after, exEquip: withExEquip(after, ROW, { step: null }, 2) }
    for (const s of [after, cleared]) {
      expect(s.workouts).toEqual(before.workouts)
      expect(s.routines).toEqual(before.routines)
    }
    expect(st).toEqual(before)                 // and the state it was given is not mutated
  })
})

describe('syncing two devices', () => {
  const at = (step, ts, pulley = null) => ({ [ROW]: { step: { kg: step }, pulley, _ts: ts } })

  it('exEquip is a stamped map in the app and in the server\'s copy of the rules', () => {
    expect(STAMPED_MAPS).toContain('exEquip')
    expect(Server.STAMPED_MAPS).toEqual(STAMPED_MAPS)
  })

  it('keeps each exercise as it was set last, on whichever device', () => {
    const phone = base({ _ts: 100, exEquip: { ...at(2.5, 90), [CABLE_ROW]: { step: { kg: 5 }, pulley: '2:1', _ts: 10 } } })
    const desk = base({ _ts: 200, exEquip: at(5, 20) })
    const m = mergeStates(phone, desk)
    expect(ownStepFor(m, ROW)).toBe(2.5)
    expect(ownStepFor(m, CABLE_ROW)).toBe(5)
    expect(pulleyFor(m, CABLE_ROW)).toBe('2:1')
    expect(mergeStates(desk, phone).exEquip).toEqual(m.exEquip)
  })

  it('a step cleared on one device is not brought back by the other', () => {
    const cleared = base({ _ts: 100, exEquip: { [ROW]: { step: {}, pulley: null, _ts: 80 } } })
    const stale = base({ _ts: 300, exEquip: at(2.5, 40) })
    expect(ownStepFor(mergeStates(cleared, stale), ROW)).toBeNull()
    expect(ownStepFor(mergeStates(stale, cleared), ROW)).toBeNull()
  })

  it('a copy from before the setting existed loses none of it', () => {
    const mine = base({ _ts: 100, exEquip: at(2.5, 90) })
    const old = base({ _ts: 300 })
    expect(mergeStates(mine, old).exEquip).toEqual(mine.exEquip)
    expect(mergeStates(old, mine).exEquip).toEqual(mine.exEquip)
  })

  it('an edit made on a device whose clock runs behind still wins over what it had seen', () => {
    const server = base({ _ts: 1000, exEquip: at(5, 900) })
    const mine = JSON.parse(JSON.stringify(server))
    mine.exEquip = withExEquip(mine, ROW, { step: 2.5 }, 5)
    mine._ts = stampChange(server, mine, 5)
    expect(mine.exEquip[ROW]._ts).toBeGreaterThan(900)
    expect(ownStepFor(mergeStates(mine, server), ROW)).toBe(2.5)
    expect(ownStepFor(mergeStates(server, mine), ROW)).toBe(2.5)
  })

  it('counts toward the stamps a copy carries, and "reset everything" names it', () => {
    expect(highestStamp(base({ _ts: 1, exEquip: at(2.5, 777) }))).toBe(777)
    expect(Server.highestStamp(base({ _ts: 1, exEquip: at(2.5, 777) }))).toBe(777)
    expect(resetIdsOf(base({ _ts: 1000, exEquip: at(2.5, 900) })).exEquip).toEqual([ROW])
  })
})
