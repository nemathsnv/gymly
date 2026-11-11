/* Oura API v2 documents → the few numbers Gymly shows, per data type and per day.
 *
 * Data minimisation (Oura API Agreement §3(m), §4(c)): of each document only the fields on the
 * screen are kept. No 5-minute series, no sleep hypnograms, no movement or MET samples, no ring
 * ids. Heart-rate samples are reduced to a per-day min / average / max before they leave this
 * module. Pure: no I/O, no clock — the tests feed it fixtures shaped like the v2 spec (1.43).
 *
 * Two levels, so the sync (sync.js) can refresh one data type over a few days without touching
 * the rest:
 *   partials(type, docs, { tz })  → Map(day → that type's fields for the day), or for workouts
 *                                   Map(id → workout)
 *   assemble({ byType, workouts, status }, { from }) → { days, workouts, available }
 */

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = v => (num(v) == null ? null : Math.round(v));
const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Whether `tz` is an IANA zone this runtime knows. */
export function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
}

const dayFormats = new Map();
/** The calendar day (YYYY-MM-DD) an instant falls on in `tz` — daylight saving included. */
export function localDay(ms, tz = 'UTC') {
  const zone = validTz(tz) ? tz : 'UTC';
  let f = dayFormats.get(zone);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }); dayFormats.set(zone, f); }
  return f.format(new Date(ms));
}

/** day ± n calendar days, on the date itself (no clock, no zone). */
export function addDays(day, n) {
  const t = Date.parse(day + 'T12:00:00Z') + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** The one main sleep of a day: a long_sleep if there is one, else the longest period. Naps and
 *  'deleted' periods never stand for the night. */
function mainSleep(periods) {
  const usable = periods.filter(p => p && p.type !== 'deleted');
  const long = usable.filter(p => p.type === 'long_sleep');
  const pool = long.length ? long : usable;
  return pool.reduce((best, p) => (!best || (num(p.total_sleep_duration) || 0) > (num(best.total_sleep_duration) || 0) ? p : best), null);
}

/** heart-rate rows (UTC timestamps) → Map(day → {min, avg, max, n}) on the person's own days. */
export function heartRateByDay(rows, tz = 'UTC') {
  const acc = new Map();
  for (const r of rows || []) {
    const bpm = num(r?.bpm);
    const t = Date.parse(r?.timestamp);
    if (bpm == null || bpm <= 0 || !Number.isFinite(t)) continue;
    const day = localDay(t, tz);
    const a = acc.get(day) || { min: Infinity, max: -Infinity, sum: 0, n: 0 };
    a.min = Math.min(a.min, bpm); a.max = Math.max(a.max, bpm); a.sum += bpm; a.n++;
    acc.set(day, a);
  }
  return new Map([...acc].map(([d, a]) => [d, { min: a.min, avg: Math.round(a.sum / a.n), max: a.max, n: a.n }]));
}

export function summarizeWorkout(w) {
  if (!w || typeof w.id !== 'string' || !isDay(w.day)) return null;
  const start = Date.parse(w.start_datetime), end = Date.parse(w.end_datetime);
  return {
    id: w.id,
    day: w.day,
    activity: typeof w.activity === 'string' ? w.activity.slice(0, 60) : 'workout',
    label: typeof w.label === 'string' && w.label ? w.label.slice(0, 80) : null,
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null,
    calories: int(w.calories),
    distance: int(w.distance),
    intensity: ['easy', 'moderate', 'hard'].includes(w.intensity) ? w.intensity : null,
    source: typeof w.source === 'string' ? w.source.slice(0, 40) : null,
  };
}

/* One reducer per data type: a document → the fields kept for its day. A day whose document
   carries nothing usable keeps no entry, so "no reading" is never shown as a zero. */
const DAILY = {
  daily_readiness: r => ({
    readiness: { score: int(r.score), temperatureDeviation: num(r.temperature_deviation), hrvBalance: int(r.contributors?.hrv_balance), restingHeartRate: int(r.contributors?.resting_heart_rate) },
  }),
  daily_sleep: s => ({ sleepScore: int(s.score) }),
  daily_activity: a => ({ activity: { score: int(a.score), steps: int(a.steps), activeCalories: int(a.active_calories) } }),
  daily_stress: s => ({
    stress: { stressHighSec: int(s.stress_high), recoveryHighSec: int(s.recovery_high), summary: ['restored', 'normal', 'stressful'].includes(s.day_summary) ? s.day_summary : null },
  }),
  daily_spo2: s => ({ spo2: { average: num(s.spo2_percentage?.average), breathingDisturbanceIndex: int(s.breathing_disturbance_index) } }),
  daily_cardiovascular_age: c => ({ vascularAge: int(c.vascular_age) }),
  vO2_max: v => ({ vo2Max: int(v.vo2_max) }),
};
const hasValue = o => Object.values(o).some(v => (v && typeof v === 'object' ? hasValue(v) : v != null));

/**
 * One data type's documents → Map(day → fields) (Map(id → workout) for 'workout'). Days are
 * Oura's own `day` (the person's local date, as Oura assigns it); heart-rate samples are put on
 * days in `tz`, the zone the person's device reports.
 */
export function partials(type, docs, { tz = 'UTC' } = {}) {
  const list = Array.isArray(docs) ? docs : [];
  if (type === 'heartrate') return heartRateByDay(list, tz);
  if (type === 'workout') {
    const out = new Map();
    for (const w of list) { const s = summarizeWorkout(w); if (s) out.set(s.id, s); }
    return out;
  }
  if (type === 'sleep') {
    const byDay = new Map();
    for (const p of list) if (p && isDay(p.day)) byDay.set(p.day, [...(byDay.get(p.day) || []), p]);
    const out = new Map();
    for (const [d, ps] of byDay) {
      const s = mainSleep(ps);
      if (!s) continue;
      const v = { totalSec: int(s.total_sleep_duration), efficiency: int(s.efficiency), averageHrv: int(s.average_hrv), lowestHeartRate: int(s.lowest_heart_rate), averageHeartRate: int(s.average_heart_rate) };
      if (hasValue(v)) out.set(d, { sleep: v });
    }
    return out;
  }
  const reduce = DAILY[type];
  const out = new Map();
  if (!reduce) return out;
  for (const doc of list) {
    if (!doc || !isDay(doc.day)) continue;
    const v = reduce(doc);
    if (hasValue(v)) out.set(doc.day, v);
  }
  return out;
}

const STATUS = { ok: 'ok', forbidden: 'not-shared', rate: 'rate-limited' };
export const statusOf = v => (Array.isArray(v) ? 'ok' : STATUS[v?.error] || 'error');

/**
 * What is held → what the screen gets: one row per day from `from` on (newest first), the
 * workouts in that range (newest first), and per data type whether Oura shared it.
 */
export function assemble({ byType = {}, workouts = new Map(), status = {} } = {}, { from = '0000-00-00' } = {}) {
  const days = new Map();
  for (const [type, m] of Object.entries(byType)) {
    for (const [d, v] of m) {
      if (d < from) continue;
      const row = days.get(d) || { day: d };
      if (type === 'heartrate') row.heartRate = v;
      else if (type === 'sleep') row.sleep = { ...(row.sleep || {}), ...v.sleep };
      else if (type === 'daily_sleep') row.sleep = { ...(row.sleep || {}), score: v.sleepScore };
      else if (type === 'daily_cardiovascular_age' || type === 'vO2_max') row.cardio = { ...(row.cardio || {}), ...v };
      else Object.assign(row, v);
      days.set(d, row);
    }
  }
  return {
    days: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)),
    workouts: [...workouts.values()].filter(w => w.day >= from).sort((a, b) => (b.start || 0) - (a.start || 0)),
    available: { ...status },
  };
}

/** One-shot: raw documents per type → the screen's shape (tests, and a sync that holds nothing). */
export function summarize(raw, { tz = 'UTC' } = {}) {
  const byType = {}, status = {};
  let workouts = new Map();
  for (const [type, v] of Object.entries(raw || {})) {
    status[type] = statusOf(v);
    if (type === 'workout') workouts = partials('workout', Array.isArray(v) ? v : [], { tz });
    else byType[type] = partials(type, Array.isArray(v) ? v : [], { tz });
  }
  return assemble({ byType, workouts, status });
}
