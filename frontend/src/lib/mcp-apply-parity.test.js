/* The hosted MCP endpoint applies routine changes on the server (api/mcp-remote/plan-apply.js), with
 * a hand copy of the Coach's CHANGE_APPLY: the API image carries none of frontend/. This pins the
 * copy to the original: every change type the Coach knows, applied by applyChangeSet here and by
 * the server's applier, leaves the same routines and the same week. The server's applier is given
 * this file's own helpers, so what is compared is the apply logic itself.
 *
 * Two differences are by design and checked as such: `weight` exists only on the server (the
 * routine's target weight, which the routine editor sets), and the server's add-routine takes the
 * id its preview chose.
 */
import { describe, it, expect } from 'vitest'
import { applyChangeSet, CHANGE_TYPES } from './coach.js'
import { cleanupSg } from './history.js'
import { deleteRoutine } from './routines.js'
import { canonicalExId } from './exercises.js'
import { uid } from './format.js'
import { createApplier } from '../../../api/mcp-remote/plan-apply.js'

const srv = createApplier({ cleanupSg, deleteRoutine, canonicalExId, uid })

const base = () => ({
  routines: [
    { id: 'r1', name: 'Push', emoji: 'barbell', ex: [
      { id: '0025', sets: 3, reps: 5, weight: 60, side: true, bodyweight: false },
      { id: '0289', sets: 3, reps: 10 },
      { id: '0151', sets: 2, reps: 12, sg: 'aa' },
      { id: '0188', sets: 2, reps: 12, sg: 'aa' }
    ] },
    { id: 'r2', name: 'Legs', ex: [{ id: '0043', sets: 3, reps: 5 }] }
  ],
  week: { 1: ['r1'], 3: ['r2', 'r1'] },
  dayPlan: { '2099-01-05': 'r2', '2099-01-06': 'r1' },
  workouts: []
})

const T = (routineId, exId, extra = {}) => ({ routineId, exId, ...extra })
const CASES = [
  { type: 'sets', target: T('r1', '0025'), after: 5 },
  { type: 'reps', target: T('r1', '0025'), after: 8 },
  { type: 'repsMin', target: T('r1', '0289'), after: 8 },
  { type: 'repsMax', target: T('r1', '0289'), after: 15 },
  { type: 'sec', target: T('r1', '0289'), after: 45 },
  { type: 'cardio', target: T('r1', '0289'), after: { min: 25, speed: 9 } },
  { type: 'inc', target: T('r1', '0025'), after: 2.5 },
  { type: 'exercise-prog', target: T('r1', '0025'), after: 'double' },
  { type: 'routine-prog', target: { routineId: 'r1' }, after: 'linear' },
  { type: 'rename-routine', target: { routineId: 'r1' }, after: 'Push A' },
  { type: 'add-exercise', target: T('r1'), after: { id: '0047', sets: 4, mode: 'reps', reps: 6, weight: 40, prog: 'linear', repsMin: 4, repsMax: 8, setsMax: 5, position: 1 } },
  { type: 'add-exercise', target: T('r1'), after: { id: '0047', mode: 'time', sec: 30, side: true, bodyweight: true } },
  { type: 'add-exercise', target: T('r2'), after: { id: '0047', mode: 'cardio' } },
  { type: 'remove-exercise', target: T('r1', '0151') },
  { type: 'swap-exercise', target: T('r1', '0025'), after: { id: '0047', reps: 6, weight: 70 } },
  { type: 'swap-exercise', target: T('r1', '0289'), after: { id: '0047' } },
  { type: 'reorder', target: { routineId: 'r1' }, after: ['0289', '0025', '0151', '0188'] },
  { type: 'superset', target: T('r1', '0151'), after: { link: false } },
  { type: 'superset', target: T('r1', '0025'), after: { link: true, with: '0289' } },
  { type: 'remove-routine', target: { routineId: 'r2' } },
  { type: 'week', target: { weekday: 1 }, after: 'r2' },
  { type: 'week', target: { weekday: 3 }, after: 'rest' },
  { type: 'week', target: { weekday: 5 }, after: null }
]

// Superset tags are random on both sides; what has to agree is which exercises share one.
const shape = s => JSON.parse(JSON.stringify({ routines: s.routines, week: s.week, dayPlan: s.dayPlan }, (k, v) => (k === 'sg' && v ? 'SG' : v)))

describe('server apply ≡ the Coach\'s apply', () => {
  it('covers every change type the Coach has, plus weight', () => {
    // add-routine has its own case below (the id differs by design).
    const covered = new Set([...CASES.map(c => c.type), 'add-routine'])
    for (const t of CHANGE_TYPES) expect(covered.has(t), t).toBe(true)
    expect(srv.CHANGE_TYPES.sort()).toEqual([...CHANGE_TYPES, 'weight'].sort())
  })

  for (const [i, c] of CASES.entries()) {
    it(`${c.type} #${i}`, () => {
      const change = { id: 'c' + i, why: 'x', ...c }
      const ui = base()
      applyChangeSet(ui, { id: 'p', changes: [change] }, ['c' + i])
      const server = srv.applyChanges(base(), [change])
      expect(shape(server)).toEqual(shape(ui))
    })
  }

  it('add-routine: the same routine, under the id the preview chose', () => {
    const after = { name: 'Upper', emoji: 'arm', prog: 'double', ex: [{ id: '0025', sets: 4, mode: 'reps', reps: 8, repsMax: 12, setsMax: 5, side: true }, { id: '0047', mode: 'time', sec: 40 }] }
    const ui = base()
    applyChangeSet(ui, { id: 'p', changes: [{ id: 'c', type: 'add-routine', target: {}, after, why: 'x' }] }, ['c'])
    const server = srv.applyChanges(base(), [{ id: 'c', type: 'add-routine', target: {}, after: { ...after, id: 'chosen' } }])
    const added = ui.routines[2]
    expect(server.routines[2]).toEqual({ ...added, id: 'chosen' })
  })

  it('weight sets the routine\'s target weight, which the Coach cannot change', () => {
    const s = srv.applyChanges(base(), [{ type: 'weight', target: T('r1', '0289'), after: 42.5 }])
    expect(s.routines[0].ex[1]).toEqual({ id: '0289', sets: 3, reps: 10, weight: 42.5 })
  })

  it('a change that cannot apply throws, so the caller saves nothing', () => {
    expect(() => srv.applyChanges(base(), [{ type: 'sets', target: T('r1', 'missing'), after: 3 }])).toThrow()
    expect(() => srv.applyChanges(base(), [{ type: 'reorder', target: { routineId: 'r1' }, after: ['0025', '0025', '0151', '0188'] }])).toThrow()
  })
})
