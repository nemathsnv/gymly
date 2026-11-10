import { describe, expect, it } from 'vitest'
import { WORKOUT_LAYOUTS, activeWorkoutLayout, workoutLayoutOf } from './workout-layout.js'

describe('workout layouts', () => {
  it('offers cards, list and compact, and no focus', () => {
    expect(WORKOUT_LAYOUTS).toEqual(['cards', 'list', 'compact'])
  })

  it('keeps a known layout and reads the removed focus layout as cards', () => {
    for (const v of WORKOUT_LAYOUTS) expect(workoutLayoutOf(v)).toBe(v)
    expect(workoutLayoutOf('focus')).toBe('cards')
    expect(workoutLayoutOf(undefined)).toBe('cards')
    expect(workoutLayoutOf('')).toBe('cards')
    expect(workoutLayoutOf('grid')).toBe('cards')
  })

  it('prefers the running session’s own layout, and a session saved in focus shows cards', () => {
    expect(activeWorkoutLayout({ workoutView: 'list', active: { workoutView: 'compact' } })).toBe('compact')
    expect(activeWorkoutLayout({ workoutView: 'list', active: {} })).toBe('list')
    expect(activeWorkoutLayout({ workoutView: 'list', active: { workoutView: 'focus' } })).toBe('cards')
    expect(activeWorkoutLayout({ workoutView: 'focus' })).toBe('cards')
    expect(activeWorkoutLayout(null)).toBe('cards')
  })
})
