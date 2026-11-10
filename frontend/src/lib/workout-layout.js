// The workout's layouts (Settings → Workout → Layout, and the workout's ⋯ → Layout for one
// session): 'cards' shows one exercise at a time with Prev/Next, 'list' stacks the whole session,
// 'compact' is that stack with only names and set rows.
//
// There used to be a fourth, 'focus': one set of one exercise at a time. It was its own logging
// UI beside the set rows every other layout shares, and it fell behind them: no Add set, no
// warm-up set, no copy, no way to edit a finished set without un-ticking it. A stepmill done as
// 5 min at level 5 then 5 min at level 8 could not be logged in it at all. It was removed, and a
// profile or a running session that still says 'focus' reads as cards: nothing stored is
// rewritten, and an older app on another device still finds the value it wrote.
export const WORKOUT_LAYOUTS = ['cards', 'list', 'compact']

/** The layout a stored value stands for: a known one as it is, anything else ('focus', a
 * profile written before layouts existed, junk) as cards. */
export const workoutLayoutOf = v => (WORKOUT_LAYOUTS.includes(v) ? v : 'cards')

/** The layout the running session shows: its own choice from the ⋯ menu, else the saved one. */
export const activeWorkoutLayout = S => workoutLayoutOf(S?.active?.workoutView || S?.workoutView)
