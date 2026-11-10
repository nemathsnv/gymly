# Workout view — cards / list / compact

The active workout screen (`frontend/src/views/Workout.jsx`) has three layouts, chosen by
`S.workoutView` (`'cards' | 'list' | 'compact'`, default `'cards'`, read through
`frontend/src/lib/workout-layout.js`). All three render the same `ExerciseBlock` set rows over
the same active session and completion pipeline.

| Value | What you see |
|---|---|
| `cards` | One unit at a time, `Prev` / `Next` + swipe. The original flow. |
| `list` | Every unit stacked and scrollable. Each non-current unit has a **Set current** chip in its header; completion still auto-advances the current marker, starts rest and can open the top-weight sheet. Blocks render with the `compact` `ExerciseBlock` prop (smaller). |
| `compact` | `list`, with each `ExerciseBlock` also rendered `dense`: no media, no tag chips (Cardio / per-side / target / equipment / **Best:**), no note lines, no "Last time …" recap, no bar-and-plates chip, no progression-guidance line, no "Make superset with previous/next". Just the name, the ⋯ menu and the set rows. |

### The removed `focus` layout

There used to be a fourth layout, `focus`: one set of one exercise at a time with large
steppers and a set pager (`FocusView.jsx`). It was its own logging UI beside `ExerciseBlock`
and fell behind it: it never rendered Add set, Add warm-up set, Copy set, the rest timer, Move
or Update routine (all handed to it in `blockProps`), kept its own copies of the drop / burst /
warm-up / failure edits that had drifted from the set rows' (no drop grid, warm-ups not moved to
the top, drop sets offered on cardio), made a finished set read-only until un-ticked, and hid
every set but one — so a stepmill done as two segments could not be logged in it. Cards
already shows one exercise at a time, so the layout was removed rather than given a second
copy of every set action.

A profile (`S.workoutView`) or a running session (`s.active.workoutView`) that still says
`'focus'` reads as `cards` (`workoutLayoutOf`). Nothing stored is rewritten: an older app on
another device still finds the value it wrote, and no workout data changes.

Everything `compact` hides is still on the ⋯ menu (note, details, history, bar weight,
progression settings) or is display-only.

Unknown / absent values read as `cards`, so a profile written before the setting existed is
unchanged.

Orthogonal to all three: **Settings → During a workout → Workout controls** (`S.wc`) decides
whether Move / Swap / Remove, the pair buttons, the drop/burst shortcuts and the `+/-`
steppers show inline. The lean default keeps them in each exercise's ⋯ menu; turning
`exerciseButtons` on adds a footer Move / Swap / Remove row that acts on the current unit
(and, in `list` / `compact`, the "…act on the exercise marked Current" hint).

## Where it is set

- **Saved default:** Settings → During a workout → **Workout view** (a 3-way `Segmented`).
- **Per session:** the workout header's **⋮** button opens a `menuSheet` with the three
  layouts; picking one writes `s.active.workoutView`.

`beginWorkout` / `beginBackfill` (`frontend/src/sheets.jsx`) snapshot `S.workoutView` onto
`s.active.workoutView` when the session is created (through `workoutLayoutOf`, so a saved
`'focus'` starts in cards), and the render prefers `A.workoutView || S.workoutView`. So the ⋮ menu re-lays-out the running session only, and
changing the saved default never disturbs a workout already in progress.

## Tests

- `frontend/src/lib/workout-layout.test.js` — the three layouts and the fallback to cards.
- `frontend/src/views/Workout.test.jsx` — `workout list view`, `workout compact view`,
  `the removed Focus layout`, and `workout view header menu` describe blocks.
- `frontend/src/views/Settings.workoutview.test.jsx` — the 3-way Segmented and a saved `'focus'`.
- `frontend/src/sheets.workoutview.test.jsx` — `beginWorkout` / backfill snapshot behaviour,
  including a saved `'focus'` starting in cards.
