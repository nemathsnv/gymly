# Daily habits

A separate section from workouts: Home card → **Habits** (`/habits`), a list of every habit with
today's check-in, and one screen per habit (`/habits/:id`). **Alcohol** is built in; any number of
the user's own can be added (**Add habit**), renamed, re-coloured, archived and brought back.

## What it records

One status per habit per day, set in one tap. Each habit is one of two kinds:

| kind | good | bad | stored `s` |
|---|---|---|---|
| Alcohol (built in) | No alcohol | Drank alcohol | `free` / `drank` |
| to build (`do`) | Done | Not done | `good` / `bad` |
| to avoid (`avoid`) | Avoided | Did it | `good` / `bad` |

…and **Not logged** (no status) for all. Alcohol's bad day can carry a drink count; any day of any
habit a private note. Past days can be corrected; future days cannot be written.

A habit's kind only names its two answers, so changing it (offered for your own habits, not for
Alcohol) keeps what every logged day meant: a good day stays good.

**Never assume.** A day nobody logged is *not logged*, not a good day. The current streak is a run
of days someone logged as good, ending today — or yesterday while today is still unlogged ("log
today to keep it going"). A bad day or a gap ends it. The 30-day trend needs at least a week
logged in each of the two compared windows; below that it shows no direction at all.

## Data model

`S.habitLog` — one flat map in the profile document. Days are keyed `habit|YYYY-MM-DD`, a habit's
definition `habit|def`:

```js
{
  'alcohol|2026-10-08': { s: 'free', note?: 'text', tz: 'Europe/Lisbon', _ts },
  'alcohol|2026-10-09': { s: 'drank', n: 3, tz: 'Europe/Lisbon', _ts },
  'alcohol|2026-10-10': { _ts },                       // taken back to "not logged"
  'alcohol|def':        { name?: 'Wine', archived?: true, icon?, color?, _ts },  // only once edited
  'h1k2x9a0f3|def':     { name: 'Read', kind: 'do', icon: 'note', color: 'blue', at, archived?: true, _ts },
  'h1k2x9a0f3|2026-10-10': { s: 'good', note?: 'Chapter 3', tz, _ts },
}
```

Plus `S.habitsOn` (default on): hides the Home card and the routes; the log stays.

- **Ids** are stable: `alcohol`, or `h` + the creation time in base 36 + four random letters
  (`newHabitId`), so two devices never make the same one. An id never holds `|`.
- **A habit exists** while its definition has a name (Alcohol always does). A habit is never
  deleted: archiving is a flag on its definition, and every day stays. A definition cleared by a
  backup that replaced the profile (below) takes the habit off the list; its days stay in the log.
- **At most** `HABIT_MAX` (50) habits of your own, archived ones included; names up to 40 characters.
- **Unknown fields** a newer build may add to a definition or a day are kept by every write of
  this one (`withHabit`, `withEntry`).

The helpers (`frontend/src/lib/habits.js`) are pure and tested beside it (`habits.test.js`,
`habits.custom.test.js`, `habits.compat.test.js`).

### Why definitions live in the log, and the migration

Definitions could have been a new key of their own in the profile. They are not, on purpose: every
build since habits first shipped (6358351c) merges `habitLog` entry by entry
(`STAMPED_MAPS`). A device still running the alcohol-only build therefore keeps every definition
and every day of another habit it cannot show, instead of writing its older copy over a new key it
would treat as an ordinary setting. The same goes for privacy, backup and reset: the definitions
get every guarantee the days already had.

The alcohol-only log needs **no migration**: its keys are exactly what this build reads, and
Alcohol is a habit with no definition entry until it is edited. Reading a profile writes nothing,
so it is safe to repeat and nothing is stamped or synced just by opening the app. Tested against
a profile in exactly the shape production wrote (`habits.custom.test.js`), and against a frozen
copy of the production module (`lib/compat/habits-6358351c.js`, `habits.compat.test.js`).

### Time zones

The day is a calendar-date string written once and read back as that string. It is never rebuilt
from a timestamp, so changing zone cannot move a logged day. Date arithmetic is done on the string
in UTC, so daylight-saving changes neither add nor drop a day. "Today" is the device's local date
(`todayISO`). `tz` is only the zone of the device that last wrote the entry; the day sheet shows it
when it differs from the device's current zone.

A screen that logs "today" reads it through `useToday()` (`lib/use-today.js`), which re-checks the
clock every 30 s, on return to the foreground and on focus: a page left open past midnight, or
carried into another zone, says the new date and writes to it.

Flying west can leave this device's today *behind* an entry another device already wrote. Such an
entry is kept, not counted or drawn, and the habit's screen says so; it counts when its day arrives.
Flying east and skipping a day leaves a gap, which breaks the streak: the log never fills it in.

## Sync, backup, reset

`habitLog` is one of the stamped maps (`STAMPED_MAPS` in `frontend/src/lib/sync-merge.js` and
`api/sync-stamps.js`), the same mechanism as `dayNotes`: each entry carries its own `_ts`, so two
devices keep both of two different days or habits, the same day keeps the later write, and "Not
logged" is a stamped empty entry rather than a delete (a delete would return from the other
device's copy). A habit's definition is one entry: a rename on one device and an archive on another,
both offline, settle on the later of the two as a whole (the same on both devices); days logged
meanwhile on either are separate entries and are all kept. A device that edited after seeing the
other's write always wins, even if its clock runs behind.

**The server's guard** (`keepHabitLog` in `api/sync-stamps.js`, run on every `PUT /api/data`): what
the stored log holds stays unless the writer sent a later version of that entry. The app never
removes a key, so nothing a device meant is lost; but an app from before habits (to which the log
is an ordinary setting, kept whole by its merge), an API script that leaves the log out, or any
writer with an older copy can no longer take days or habits away or set them back. When the guard
keeps or sets back anything, the document goes in one revision further (as for any put-back), so
that writer's next push is a conflict and its merge starts from the copy with the log. A reset
(`resetAt` moving forward) is the one exception: it starts the log over.

- **Backup / export**: the log is part of `S`, so the JSON/zip backup holds every habit and day.
- **Import**: restores them. A backup that *replaces* the profile clears (stamped empty entries,
  `stampReplace`) every habit day and definition the replaced copies held and the backup lacks, so
  neither the server's guard nor another device's merge brings them back. "Merge them in" keeps both.
- **Reset everything** wipes the log, definitions included (named in `resetIds`).
- **Sign-in** after using the app signed out counts a habit made meanwhile (even with no day logged)
  among what it asks about adding (`localExtras`).
- **Another account** on the same device neither inherits nor pushes the previous account's habits
  (the store's owner checks; `useStore.habits.test.jsx`).

## Privacy

The log — names and definitions included — lives only in the signed-in user's own
`state-<uid>.json`, behind the session cookie, like the rest of the profile. It is **not** exposed
anywhere else:

- the read-only MCP token view (`MCP_WITHHELD` in `api/mcp-access.js`, `WITHHELD` in
  `mcp/src/remote.js`) leaves it out;
- the local-mode and hosted MCP states drop it on load (`mcp/src/private-keys.js`), so no tool can
  return it by accident; hosted writes and undo leave it untouched;
- the Coach builds its payload from an explicit list of categories, none of which is habits
  (`api/test/payload.test.js`).

Opening habit data to an assistant needs its own design and consent (what it may read, whether it
may write, how it is shown in the connection screen). It is deliberately not part of this feature.

## Known limits

- An app build from before this one shows Alcohol only, under its built-in name, and does not hide
  it when archived here; it keeps every other habit and day intact (above).
- Two offline edits of the *same* habit's definition keep the later one whole (a rename on one
  device and a colour change on another: the later wins both).
- No reminders, no reordering of habits, no deleting a habit (archive instead).
