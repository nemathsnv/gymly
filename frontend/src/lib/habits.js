// Daily habits: a per-day log of the habits a profile tracks (Habits view, Home card). Alcohol is
// built in; any number of the user's own can be added, renamed, archived and brought back.
//
// Stored as one flat map in the profile, the way a day note is (lib/day-notes.js):
//
//   S.habitLog = {
//     'alcohol|2026-10-08': { s: 'free', note: 'Dinner with friends', tz: 'Europe/Lisbon', _ts },
//     'alcohol|2026-10-09': { s: 'drank', n: 3, tz: 'Europe/Lisbon', _ts },
//     'alcohol|2026-10-10': { _ts },    // taken back to "not logged"
//     'h1abc|def':          { name: 'Read', icon: 'note', color: 'blue', kind: 'do', at, _ts },
//     'h1abc|2026-10-10':   { s: 'good', _ts },
//     'alcohol|def':        { archived: true, _ts },   // only once the built-in one is edited
//   }
//
// The key is `habit|day`. A day is a calendar date string, 'YYYY-MM-DD', written once and read back
// as that string: it is never rebuilt from a timestamp, so a phone that lands in another time zone
// cannot move a logged day. What "today" is comes from the device's clock (todayISO), nothing else.
//
// A habit's definition is the entry under `habit|def`, in the same map, so it syncs, merges, backs
// up, resets and stays private exactly as its days do. That is also why it is not a key of its own
// in the profile: every app build since habits first shipped merges this map entry by entry, so
// one still running the alcohol-only build keeps the definitions and days it cannot show instead of
// writing its older copy over them. The alcohol log needs no migration: its keys are as they were,
// and Alcohol is a habit with no definition entry until it is edited (habitOf).
//
// Each entry carries the time it was last written (`_ts`), so two devices that logged different
// days keep both, and the same day keeps the later write (lib/sync-merge.js mergeStampedMap, via
// STAMPED_MAPS). Taking a day back to "not logged" is a stamped empty entry, not a deleted key: a
// delete would come straight back from the other device's copy on the next sync. A habit is never
// deleted either: archiving it is a flag on its definition, and every day stays.
//
// A day with no entry is NOT a good day. It is "not logged", and nothing here counts it as one: a
// streak is a run of days someone logged as good, and a missing day ends it. Future days cannot be
// written, and a stored entry dated after this device's today (another device was further east,
// or this one just flew west) is held back until its day arrives, not counted.
//
// What an entry's `s` holds: Alcohol's own words, 'free' and 'drank' (with `n`, the drinks, on a
// drank day); any other habit's 'good' and 'bad', whichever kind it is. A habit's kind ('do': Done
// / Not done, 'avoid': Avoided / Did it) only names the two answers, so changing it keeps every
// logged day's meaning: a good day stays good.
import { NOTE_MAX } from './history.js'
import { todayISO, localTZ } from './format.js'

/** The built-in habit: its words are the ones the alcohol-only log always stored. */
export const ALCOHOL = Object.freeze({ id: 'alcohol', builtin: true, kind: 'avoid', good: 'free', bad: 'drank', count: true, icon: 'heart', color: 'teal' })
/** What every other habit's entries hold. */
export const CUSTOM = Object.freeze({ builtin: false, good: 'good', bad: 'bad', count: false })

/** The two kinds of habit: one to do (Done / Not done), one to stay away from (Avoided / Did it). */
export const KINDS = Object.freeze(['do', 'avoid'])
/** The icons and colours a habit can take (components/Icon.jsx names, index.css colour tokens). */
export const HABIT_ICONS = Object.freeze(['heart', 'star', 'flame', 'bolt', 'target', 'trophy', 'moon', 'sun', 'sunrise',
  'figureRun', 'steps', 'stretch', 'bike', 'swim', 'dumbbell', 'note', 'lightbulb', 'clock', 'bell', 'shield', 'phoneScreen', 'sparkles'])
export const HABIT_COLORS = Object.freeze(['teal', 'green', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow'])
/** The longest name a habit takes, and the most habits of your own (archived ones included). */
export const NAME_MAX = 40
export const HABIT_MAX = 50

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

// A habit id: Alcohol's, or one made by newHabitId. Never holds '|', which ends the id in a key.
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
export const isHabitId = id => typeof id === 'string' && ID.test(id)
/** What `habit`'s entries hold (its good and bad words, whether a bad day takes a count), or null for no habit. */
export const rulesOf = habit => (habit === ALCOHOL.id ? ALCOHOL : isHabitId(habit) ? CUSTOM : null)

/** The key of a habit's definition: in the day's place, a word no day can be. */
export const DEF_DAY = 'def'
export const defKey = habit => habitKey(habit, DEF_DAY)

/** A fresh habit id: the time and a few random letters, so two devices never make the same one. */
export const newHabitId = (now = Date.now(), rand = Math.random) =>
  'h' + Math.max(0, Math.floor(Number(now) || 0)).toString(36) + Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0')

const cleanName = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '')
const logOf = S => (isMap(S?.habitLog) ? S.habitLog : {})

/**
 * Habit `habit` as the screens use it, or null when there is none: { id, builtin, name, icon,
 * color, kind, archived, at, good, bad, count }. Alcohol always exists; its `name` is null until
 * it is renamed (the screens say "Alcohol" in the app's language), and its kind cannot change.
 * Any other habit exists while its definition has a name; one without (a cleared definition) is
 * gone, though its days stay in the log. A value this build does not know (an icon a newer one
 * added) reads as the default; the stored definition keeps it.
 */
export function habitOf(S, habit) {
  const rules = rulesOf(habit)
  if (!rules) return null
  const raw = logOf(S)[defKey(habit)]
  const d = isMap(raw) ? raw : {}
  const icon = HABIT_ICONS.includes(d.icon) ? d.icon : null
  const color = HABIT_COLORS.includes(d.color) ? d.color : null
  const archived = d.archived === true
  if (rules === ALCOHOL) {
    return { ...ALCOHOL, name: cleanName(d.name) || null, icon: icon || ALCOHOL.icon, color: color || ALCOHOL.color, archived, at: 0 }
  }
  const name = cleanName(d.name)
  if (!name) return null
  return {
    id: habit, ...CUSTOM, name, icon: icon || 'star', color: color || 'teal',
    kind: KINDS.includes(d.kind) ? d.kind : 'do', archived, at: Number.isFinite(d.at) && d.at > 0 ? d.at : 0,
  }
}

/**
 * Every habit of the profile, Alcohol first and the others in the order they were made: the
 * active ones, or with `archived: true` the archived ones, or with `archived: null` all of them.
 */
export function habitList(S, { archived = false } = {}) {
  const ids = new Set([ALCOHOL.id])
  for (const k of Object.keys(logOf(S))) {
    const i = k.lastIndexOf('|')
    if (i > 0 && k.slice(i + 1) === DEF_DAY) ids.add(k.slice(0, i))
  }
  return [...ids].map(id => habitOf(S, id))
    .filter(h => h && (archived == null || h.archived === archived))
    .sort((a, b) => (a.builtin === b.builtin ? a.at - b.at || (a.id < b.id ? -1 : 1) : a.builtin ? -1 : 1))
}

/**
 * S.habitLog with `habit`'s definition changed by `patch`, stamped `now`: `name` (an empty one
 * takes Alcohol back to its own name, and is refused for any other habit), `icon`, `color`, `kind`
 * (not Alcohol's) and `archived`. What it leaves out, or holds a value it does not take, stays as
 * it was, and so does every field of the stored definition this build does not know. The days are
 * never touched. Returns the map as it was for a habit id that cannot be one.
 */
export function withHabit(map, habit, patch = {}, { now = Date.now() } = {}) {
  const base = isMap(map) ? map : {}
  const rules = rulesOf(habit)
  if (!rules) return base
  const cur = isMap(base[defKey(habit)]) ? base[defKey(habit)] : {}
  const next = { ...cur }
  if ('name' in patch) {
    const name = cleanName(patch.name)
    if (name) next.name = name
    else if (rules === ALCOHOL) delete next.name
    else return base
  }
  if (rules !== ALCOHOL && !cleanName(next.name)) return base
  if (HABIT_ICONS.includes(patch.icon)) next.icon = patch.icon
  if (HABIT_COLORS.includes(patch.color)) next.color = patch.color
  if (rules !== ALCOHOL && KINDS.includes(patch.kind)) next.kind = patch.kind
  if (rules !== ALCOHOL && !KINDS.includes(next.kind)) next.kind = 'do'
  if (patch.archived === true) next.archived = true
  else if (patch.archived === false) delete next.archived
  if (rules !== ALCOHOL && !(Number.isFinite(next.at) && next.at > 0)) next.at = Number(now) || 1
  next._ts = now
  return { ...base, [defKey(habit)]: next }
}

/**
 * S.habitLog with a new habit made from `fields` (name, icon, color, kind), and its id — or the map
 * as it was and a null id for a habit with no name, or once HABIT_MAX of your own exist.
 */
export function createHabit(map, fields = {}, { now = Date.now(), id = newHabitId(now) } = {}) {
  const base = isMap(map) ? map : {}
  const S = { habitLog: base }
  if (!isHabitId(id) || id === ALCOHOL.id || habitOf(S, id)) return { map: base, id: null }
  if (habitList(S, { archived: null }).filter(h => !h.builtin).length >= HABIT_MAX) return { map: base, id: null }
  const { name, icon, color, kind } = fields
  const next = withHabit(base, id, { name, icon, color, kind: KINDS.includes(kind) ? kind : 'do', archived: false }, { now })
  return next === base ? { map: base, id: null } : { map: next, id }
}

/** Whether `iso` can take an entry at all: a real date, from MIN_DAY to today, never later. */
export const canLog = (iso, today = todayISO()) => isDay(iso) && iso >= MIN_DAY && iso <= today

/**
 * A stored entry read back: { status, count, note, tz }, junk left out, or null for none or a
 * cleared one. `status` is the habit's `good` or `bad` word, or null (a note on an unlogged day).
 */
export function readEntry(habit, raw) {
  const h = rulesOf(habit)
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
 * for a habit that does not exist (no definition in `map`) and a day that cannot take an entry (a
 * future day, not a date).
 * An entry left with nothing is written as a cleared one, so the removal syncs.
 *
 * `tz` is the zone of the device that wrote the entry: for showing that a day was logged elsewhere,
 * never for deciding which day it is.
 */
export function withEntry(map, habit, iso, patch = {}, { now = Date.now(), today = todayISO(), tz = localTZ() } = {}) {
  const base = isMap(map) ? map : {}
  const h = rulesOf(habit)
  // Only a habit that exists takes a day (its definition is in this same map).
  if (!h || !canLog(iso, today) || !habitOf({ habitLog: base }, habit)) return base
  const raw = base[habitKey(habit, iso)]
  const cur = readEntry(habit, raw) || { status: null, count: null, note: '' }
  let status = 'status' in patch ? patch.status : cur.status
  if (status !== h.good && status !== h.bad) status = null
  // Drinks follow the status: a free day has none, and moving back to a drank day does not
  // resurrect a number from before.
  const keep = 'count' in patch ? patch.count : status === cur.status ? cur.count : null
  const count = h.count && status === h.bad && Number.isInteger(keep) && keep >= 1 && keep <= COUNT_MAX ? keep : null
  const note = ('note' in patch ? String(patch.note ?? '') : cur.note).trim().slice(0, NOTE_MAX)
  // Fields a newer build writes and this one does not know stay with the day.
  const entry = { ...(isMap(raw) ? Object.fromEntries(Object.entries(raw).filter(([k]) => !ENTRY_KEYS.has(k))) : {}), _ts: now }
  if (status) entry.s = status
  if (count) entry.n = count
  if (note) entry.note = note
  if (status || note) entry.tz = tz
  return { ...base, [habitKey(habit, iso)]: entry }
}

const ENTRY_KEYS = new Set(['s', 'n', 'note', 'tz', '_ts'])

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

/** Whether `status` is `h`'s good or bad answer: 'good', 'bad', or null for not logged. */
export const roleOf = (h, status) => (status == null || !h ? null : status === h.good ? 'good' : status === h.bad ? 'bad' : null)

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
 *            A bad day or a day nobody logged ends it. `since` is its first day.
 *   best     the longest such run in the whole log
 *   d30, d90 the last 30 / 90 days: free (good days), drank (bad days), unlogged, logged, and
 *            the drinks recorded (Alcohol only)
 *   prev30   the 30 days before d30
 *   trend    d30 against prev30 — { free, drank } as differences — or null while either window
 *            has fewer than TREND_MIN_LOGGED logged days: unlogged days are not good days, so
 *            a thin log does not get a direction
 *   ahead    logged days dated after this device's today
 */
export function habitStats(S, habit, today = todayISO()) {
  const h = rulesOf(habit) || CUSTOM
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
 * (free: good days, drank: bad days.) Blocks run back from today rather than along calendar weeks,
 * so the latest is never a partial one.
 */
export function weekly(S, habit, n = 12, today = todayISO()) {
  const h = rulesOf(habit) || CUSTOM
  const { days } = indexOf(S, habit, today)
  return Array.from({ length: n }, (_, i) => {
    const back = (n - 1 - i) * 7
    const w = windowOf(days, h, addDays(today, -back), 7, 0)
    return { from: addDays(today, -back - 6), to: addDays(today, -back), free: w.free, drank: w.drank, unlogged: w.unlogged }
  })
}

/**
 * The calendar the heatmap draws: the last `n` days laid out in weeks of 7, the first week padded
 * back to the week's first day and the last forward to its end; `role` is 'good', 'bad' or null.
 * Cells outside the range have
 * `out: true` (the padding before the first day); a day after today is `future`. `weekStart` is a getDay() index (1 Monday).
 */
export function calendarRows(S, habit, n, weekStart = 1, today = todayISO()) {
  const { days } = indexOf(S, habit, today)
  const h = rulesOf(habit) || CUSTOM
  const first = addDays(today, -(n - 1))
  const dow = iso => new Date(dayMs(iso)).getUTCDay()
  const lead = (dow(first) - weekStart + 7) % 7
  const total = Math.ceil((lead + n) / 7) * 7
  const cells = Array.from({ length: total }, (_, i) => {
    const iso = addDays(first, i - lead)
    const e = days.get(iso)
    return {
      iso, out: iso < first, future: iso > today, today: iso === today,
      status: e?.status ?? null, role: roleOf(h, e?.status), count: e?.count ?? null, hasNote: !!e?.note,
    }
  })
  const rows = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  return rows
}
