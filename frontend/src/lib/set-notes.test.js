import { describe, expect, test } from 'vitest'
import { setNoteOf, withSetNote, setNotesOf, SET_NOTE_MAX } from './set-notes.js'
import { buildCompletedWorkout } from './finish-workout.js'

describe('a note on one set', () => {
  test('is kept trimmed and short, and a blank one is no note', () => {
    expect(withSetNote({ w: 80, r: 8 }, '  grip slipped \n')).toEqual({ w: 80, r: 8, note: 'grip slipped' })
    expect(withSetNote({ w: 80, r: 8, note: 'x' }, '  ')).toEqual({ w: 80, r: 8 })
    expect(withSetNote({}, 'a'.repeat(300)).note).toHaveLength(SET_NOTE_MAX)
    expect(withSetNote({}, 'two\nlines').note).toBe('two lines')
    expect(setNoteOf({ note: ' easy ' })).toBe('easy')
    expect(setNoteOf({})).toBe('')
    expect(setNoteOf(null)).toBe('')
    expect(setNoteOf({ note: 42 })).toBe('')
  })

  test('stays with its set when the workout is saved', () => {
    const active = { id: 'a', d: '2026-10-09', start: 1, name: 'Push', entries: [{ id: '0025', target: { mode: 'reps' }, sets: [
      { w: 80, r: 8, done: true }, { w: 80, r: 7, done: true, note: 'grip slipped', weightOrigin: 'manual' },
    ] }] }
    const w = buildCompletedWorkout(active, { end: 2 })
    expect(w.entries[0].sets.map(s => s.note)).toEqual([undefined, 'grip slipped'])
  })
})

describe('setNotesOf: the notes History lists under an exercise', () => {
  test('numbered like the workout numbers its rows, warm-ups apart', () => {
    const e = { sets: [
      { w: 40, r: 5, done: true, phase: 'warmup', note: 'stiff' },
      { w: 80, r: 8, done: true },
      { w: 80, r: 7, done: true, note: ' grip slipped ' },
      { w: 80, r: 6, done: false, note: 'not done, not shown' },
    ] }
    expect(setNotesOf(e)).toEqual([
      { i: 0, warm: true, n: 1, note: 'stiff' },
      { i: 2, warm: false, n: 2, note: 'grip slipped' },
    ])
  })
  test('a timed per-side pair is one set number', () => {
    const e = { sets: [
      { sec: 30, side: 'L', done: true }, { sec: 30, side: 'R', done: true },
      { sec: 30, side: 'L', done: true, note: 'left hip' }, { sec: 30, side: 'R', done: true },
    ] }
    expect(setNotesOf(e).map(x => x.n)).toEqual([2])
  })
  test('nothing for an entry without notes', () => {
    expect(setNotesOf({ sets: [{ w: 1, r: 1, done: true }] })).toEqual([])
    expect(setNotesOf(null)).toEqual([])
  })
})
