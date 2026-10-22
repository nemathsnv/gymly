// Daily habits: a per-day log, the alcohol-free calendar first (Habits view, Home card).
//
// Stored as one flat map in the profile, the way a day note is (lib/day-notes.js):
//
//   S.habitLog = {
//     'alcohol|2026-10-08': { s: 'free', note: 'Dinner with friends', tz: 'Europe/Lisbon', _ts },
//     'alcohol|2026-10-09': { s: 'drank', n: 3, tz: 'Europe/Lisbon', _ts },
//     'alcohol|2026-10-10': { _ts },    // taken back to "not logged"
//   }
//
// The key is `habit|day`. A day is a calendar date string, 'YYYY-MM-DD', written once and read back
// as that string: it is never rebuilt from a timestamp, so a phone that lands in another time zone
// cannot move a logged day. What "today" is comes from the device's clock (todayISO), nothing else.
//
// Each entry carries the time it was last written (`_ts`), so two devices that logged different
// days keep both, and the same day keeps the later write (lib/sync-merge.js mergeStampedMap, via
// STAMPED_MAPS). Taking a day back to "not logged" is a stamped empty entry, not a deleted key: a
// delete would come straight back from the other device's copy on the next sync.
//
// A day with no entry is NOT alcohol-free. It is "not logged", and nothing here counts it as a good
// day: a streak is a run of days someone said were free, and a missing day ends it. Future days
// cannot be written, and a stored entry dated after this device's today (another device was
// further east, or this one just flew west) is held back until its day arrives, not counted.
//
// Another habit is a new row in HABITS, not a new store: its `good` and `bad` words are what the
// entry's `s` holds, and `count` names the optional number on a `bad` day (drinks).
import { NOTE_MAX } from './history.js'
import { todayISO, localTZ } from './format.js'

export const HABITS = Object.freeze({
  alcohol: Object.freeze({ id: 'alcohol', good: 'free', bad: 'drank', count: true }),
})
export const HABIT_IDS = Object.freeze(Object.keys(HABITS))

/** Earliest day the log takes: nothing older is a real entry, and it bounds every walk below. */
export const MIN_DAY = '2000-01-01'
/** The most drinks one day records. */
export const COUNT_MAX = 99

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v)
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86400000

/** Whether `iso` is a real calendar date written 'YYYY-MM-DD' (2026-02-30 is not). */
export function isDay(iso) {
  const m = ISO.exec(typeof iso === 'string' ? iso : '')
  if (!m) return false
  const [y, mo, d] = [+m[1], +m[2], +m[3]]
  const at = new Date(Date.UTC(y, mo - 1, d))
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d
}

// Calendar arithmetic on the date string itself, in UTC, so a daylight-saving change or the
// device's zone can never add or drop an hour from a day.
const dayMs = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) }
const pad = (n, w = 2) => String(n).padStart(w, '0')
/** `iso` moved by `n` calendar days (negative = earlier). */
export function addDays(iso, n) {
  const at = new Date(dayMs(iso) + n * DAY_MS)
  return pad(at.getUTCFullYear(), 4) + '-' + pad(at.getUTCMonth() + 1) + '-' + pad(at.getUTCDate())
}
/** Whole days from `a` to `b` (positive when `b` is later). */
export const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / DAY_MS)

export const habitKey = (habit, iso) => habit + '|' + iso

/** Whether `iso` can take an entry at all: a real date, from MIN_DAY to today, never later. */
export const canLog = (iso, today = todayISO()) => isDay(iso) && iso >= MIN_DAY && iso <= today

/**
 * A stored entry read back: { status, count, note, tz }, junk left out, or null for none or a
 * cleared one. `status` is the habit's `good` or `bad` word, or null (a note on an unlogged day).
 */
export function readEntry(habit, raw) {
  const h = HABITS[habit]
  if (!h || !isMap(raw)) return null
  const status = raw.s === h.good || raw.s === h.bad ? raw.s : null
  const count = h.count && status === h.bad && Number.isInteger(raw.n) && raw.n >= 1 && raw.n <= COUNT_MAX ? raw.n : null
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, NOTE_MAX) : ''
  const tz = typeof raw.tz === 'string' && raw.tz.length <= 64 ? raw.tz : null
  return status || note ? { status, count, note, tz } : null
}

/** The entry for `habit` on `iso`, or null. Not limited to today: callers decide what a future day is. */
export const entryOf = (S, habit, iso) => readEntry(habit, isMap(S?.habitLog) ? S.habitLog[habitKey(habit, iso)] : null)

/** The status on `iso` (the habit's good or bad word), or null — also for any day after `today`. */
export function statusOn(S, habit, iso, today = todayISO()) {
  if (!isDay(iso) || iso > today) return null
  return entryOf(S, habit, iso)?.status ?? null
}

/**
 * S.habitLog with `patch` applied to `habit` on `iso`, stamped `now`. `patch` can hold `status`
 * (the good or bad word, or null for "not logged"), `count` (drinks, kept only on the bad status)
 * and `note` (empty takes it away); what it leaves out stays as it was. Returns the map as it was
 * for a habit that does not exist and a day that cannot take an entry (a future day, not a date).
 * An entry left with nothing is written as a cleared one, so the removal syncs.
 *
 * `tz` is the zone of the device that wrote the entry: for showing that a day was logged elsewhere,
 * never for deciding which day it is.
 */
export function withEntry(map, habit, iso, patch = {}, { now = Date.now(), today = todayISO(), tz = localTZ() } = {}) {
  const base = isMap(map) ? map : {}
  const h = HABITS[habit]
  if (!h || !canLog(iso, today)) return base
  const cur = readEntry(habit, base[habitKey(habit, iso)]) || { status: null, count: null, note: '' }
  let status = 'status' in patch ? patch.status : cur.status
  if (status !== h.good && status !== h.bad) status = null
  // Drinks follow the status: a free day has none, and moving back to a drank day does not
  // resurrect a number from before.
  const keep = 'count' in patch ? patch.count : status === cur.status ? cur.count : null
  const count = h.count && status === h.bad && Number.isInteger(keep) && keep >= 1 && keep <= COUNT_MAX ? keep : null
  const note = ('note' in patch ? String(patch.note ?? '') : cur.note).trim().slice(0, NOTE_MAX)
  const entry = { _ts: now }
  if (status) entry.s = status
  if (count) entry.n = count
  if (note) entry.note = note
  if (status || note) entry.tz = tz
  return { ...base, [habitKey(habit, iso)]: entry }
}

// Every readable entry of `habit` dated today or earlier, by day; `ahead` counts the logged days
// dated after today (see the top of this file).
function indexOf(S, habit, today) {
  const log = isMap(S?.habitLog) ? S.habitLog : {}
  const prefix = habit + '|'
  const days = new Map()
  let ahead = 0
  for (const [key, raw] of Object.entries(log)) {
    if (!key.startsWith(prefix)) continue
    const iso = key.slice(prefix.length)
    if (!isDay(iso) || iso < MIN_DAY) continue
    const e = readEntry(habit, raw)
    if (!e) continue
    if (iso > today) { if (e.status) ahead++; continue }
    days.set(iso, e)
  }
  return { days, ahead }
}

/** The last `n` days ending on `today`, oldest first: [{ iso, status }]. A day nobody logged is null. */
export function lastDays(S, habit, n, today = todayISO()) {
  const { days } = indexOf(S, habit, today)
  return Array.from({ length: n }, (_, i) => {
    const iso = addDays(today, i - (n - 1))
    return { iso, status: days.get(iso)?.status ?? null }
  })
}

function windowOf(days, h, today, n, back) {
  const w = { free: 0, drank: 0, unlogged: 0, logged: 0, days: n, drinks: 0, drinkDays: 0 }
  for (let i = 0; i < n; i++) {
    const e = days.get(addDays(today, -(back + i)))
    if (e?.status === h.good) w.free++
    else if (e?.status === h.bad) {
      w.drank++
      if (e.count) { w.drinks += e.count; w.drinkDays++ }
    } else w.unlogged++
  }
  w.logged = w.free + w.drank
  return w
}

/** Fewest logged days each of two windows needs before they are compared as a trend. */
export const TREND_MIN_LOGGED = 7

/**
 * What the Habits view shows for `habit` as of `today`:
 *   current  the verified streak: consecutive days each logged as the good status, ending today —
 *            or yesterday while today is still unlogged (`pending`: not broken, not yet extended).
 *            A drank day or a day nobody logged ends it. `since` is its first day.
 *   best     the longest such run in the whole log
 *   d30, d90 the last 30 / 90 days: free, drank, unlogged, logged, and the drinks recorded
 *   prev30   the 30 days before d30
 *   trend    d30 against prev30 — { free, drank } as differences — or null while either window
 *            has fewer than TREND_MIN_LOGGED logged days: unlogged days are not good days, so
 *            a thin log does not get a direction
 *   ahead    logged days dated after this device's today
 */
export function habitStats(S, habit, today = todayISO()) {
  const h = HABITS[habit]
  const { days, ahead } = indexOf(S, habit, today)
  const good = iso => days.get(iso)?.status === h.good

  // Today unlogged leaves the streak standing on yesterday: not broken yet, not extended either.
  const todayStatus = days.get(today)?.status ?? null
  const pending = todayStatus === null
  let cursor = todayStatus === h.good ? today : pending ? addDays(today, -1) : null
  let current = 0, since = null
  while (cursor && cursor >= MIN_DAY && good(cursor)) { current++; since = cursor; cursor = addDays(cursor, -1) }

  let best = 0, run = 0, prev = null
  for (const iso of [...days.keys()].filter(good).sort()) {
    run = prev && daysBetween(prev, iso) === 1 ? run + 1 : 1
    if (run > best) best = run
    prev = iso
  }

  const d30 = windowOf(days, h, today, 30, 0)
  const prev30 = windowOf(days, h, today, 30, 30)
  const d90 = windowOf(days, h, today, 90, 0)
  const trend = d30.logged >= TREND_MIN_LOGGED && prev30.logged >= TREND_MIN_LOGGED
    ? { free: d30.free - prev30.free, drank: d30.drank - prev30.drank }
    : null
  return { current, since, pending, best, d30, prev30, d90, trend, ahead }
}

/**
 * `n` consecutive 7-day blocks ending today, oldest first: [{ from, to, free, drank, unlogged }].
 * Blocks run back from today rather than along calendar weeks, so the latest is never a partial one.
 */
export function weekly(S, habit, n = 12, today = todayISO()) {
  const h = HABITS[habit]
  const { days } = indexOf(S, habit, today)
  return Array.from({ length: n }, (_, i) => {
    const back = (n - 1 - i) * 7
    const w = windowOf(days, h, addDays(today, -back), 7, 0)
    return { from: addDays(today, -back - 6), to: addDays(today, -back), free: w.free, drank: w.drank, unlogged: w.unlogged }
  })
}

/**
 * The calendar the heatmap draws: the last `n` days laid out in weeks of 7, the first week padded
 * back to the week's first day and the last forward to its end. Cells outside the range have
 * `out: true` (the padding before the first day); a day after today is `future`. `weekStart` is a getDay() index (1 Monday).
 */
export function calendarRows(S, habit, n, weekStart = 1, today = todayISO()) {
  const { days } = indexOf(S, habit, today)
  const first = addDays(today, -(n - 1))
  const dow = iso => new Date(dayMs(iso)).getUTCDay()
  const lead = (dow(first) - weekStart + 7) % 7
  const total = Math.ceil((lead + n) / 7) * 7
  const cells = Array.from({ length: total }, (_, i) => {
    const iso = addDays(first, i - lead)
    const e = days.get(iso)
    return {
      iso, out: iso < first, future: iso > today, today: iso === today,
      status: e?.status ?? null, count: e?.count ?? null, hasNote: !!e?.note,
    }
  })
  const rows = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  return rows
}
