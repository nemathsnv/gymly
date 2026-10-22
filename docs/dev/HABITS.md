# Daily habits (alcohol-free calendar)

A separate section from workouts: Home card → **Habits** (`/habits`). One habit exists today,
`alcohol`; the data model leaves room for more without building a habit manager.

## What it records

One status per day, set in one tap: **No alcohol** (`free`), **Drank alcohol** (`drank`), **Not
logged** (no status). A `drank` day can also carry a drink count, and any day a private note. Past
days can be edited; future days cannot be written.

**Never assume.** A day nobody logged is *not logged*, not alcohol-free. The current streak is a run
of days someone marked `free`, ending today — or yesterday while today is still unlogged ("log
today to keep it going"). A drank day or a gap ends it. The 30-day trend needs at least a week
logged in each of the two compared windows; below that it shows no direction at all.

## Data model

`S.habitLog` — one flat map in the profile document, keyed `habit|YYYY-MM-DD`:

```js
{
  'alcohol|2026-10-08': { s: 'free', note?: 'text', tz: 'Europe/Lisbon', _ts },
  'alcohol|2026-10-09': { s: 'drank', n: 3, tz: 'Europe/Lisbon', _ts },
  'alcohol|2026-10-10': { _ts },          // taken back to "not logged"
}
```

Plus `S.habitsOn` (default on): hides the Home card and the route; the log stays.

A new habit is a row in `HABITS` (`frontend/src/lib/habits.js`) with its own good/bad words.
Everything else — storage, sync, backup, reset, privacy — is shared.

The helpers (`habits.js`) are pure and tested beside it (`habits.test.js`).

### Time zones

The day is a calendar-date string written once and read back as that string. It is never rebuilt
from a timestamp, so changing zone cannot move a logged day. Date arithmetic is done on the string
in UTC, so daylight-saving changes neither add nor drop a day. "Today" is the device's local date
(`todayISO`). `tz` is only the zone of the device that last wrote the entry; the day sheet shows it
when it differs from the device's current zone.

Flying west can leave this device's today *behind* an entry another device already wrote. Such an
entry is kept, not counted or drawn, and the Habits screen says so; it counts when its day arrives.
Flying east and skipping a day leaves a gap, which breaks the streak: the log never fills it in.

## Sync, backup, reset

`habitLog` is one of the stamped maps (`STAMPED_MAPS` in `frontend/src/lib/sync-merge.js` and
`api/sync-stamps.js`), the same mechanism as `dayNotes`: each entry carries its own `_ts`, so two
devices that logged different days keep both, the same day keeps the later write, and "Not logged"
is a stamped empty entry rather than a delete (a delete would return from the other device's copy).
It rides in `PUT /api/data` with the profile, is included in the JSON/zip backup (it is part of
`S`), is restored by an import, and is wiped by "Reset everything" (named in `resetIds`).

## Privacy

The log lives only in the signed-in user's own `state-<uid>.json`, behind the session cookie, like
the rest of the profile. It is **not** exposed anywhere else:

- the read-only MCP token view (`MCP_WITHHELD` in `api/mcp-access.js`, `WITHHELD` in
  `mcp/src/remote.js`) leaves it out;
- the local-mode and hosted MCP states drop it on load (`mcp/src/private-keys.js`), so no tool can
  return it by accident; hosted writes and undo leave it untouched;
- the Coach builds its payload from an explicit list of categories, none of which is habits.

Opening habit data to an assistant needs its own design and consent (what it may read, whether it
may write, how it is shown in the connection screen). It is deliberately not part of this feature.

## Not done

Reminders for the daily check-in, other habits, and a habit-management screen.
