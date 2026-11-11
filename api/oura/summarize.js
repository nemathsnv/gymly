/* Oura API v2 documents → the few numbers the recovery overview shows, one row per day.
 *
 * Data minimisation (Oura API Agreement §3(m), §4(c)): of each document only the fields on the
 * screen are kept. No 5-minute series, no sleep hypnograms, no movement or MET samples, no ring
 * ids. Heart-rate samples are reduced to a per-day min / average / max before they leave this
 * function. Pure: no I/O, no clock — the tests feed it fixtures shaped like the v2 spec (1.43).
 */

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = v => (num(v) == null ? null : Math.round(v));
const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The one main sleep of a day: a long_sleep if there is one, else the longest period. Naps and
 *  'deleted' periods never stand for the night. */
function mainSleep(periods) {
  const usable = periods.filter(p => p && p.type !== 'deleted');
  const long = usable.filter(p => p.type === 'long_sleep');
  const pool = long.length ? long : usable;
  return pool.reduce((best, p) => (!best || (num(p.total_sleep_duration) || 0) > (num(best.total_sleep_duration) || 0) ? p : best), null);
}

/** heart-rate rows (UTC timestamps) → { 'YYYY-MM-DD': {min, avg, max, n} } by the given offset. */
export function heartRateByDay(rows, tzOffsetMin = 0) {
  const acc = new Map();
  for (const r of rows || []) {
    const bpm = num(r?.bpm);
    const t = Date.parse(r?.timestamp);
    if (bpm == null || !Number.isFinite(t)) continue;
    const day = new Date(t + tzOffsetMin * 60000).toISOString().slice(0, 10);
    const a = acc.get(day) || { min: Infinity, max: -Infinity, sum: 0, n: 0 };
    a.min = Math.min(a.min, bpm); a.max = Math.max(a.max, bpm); a.sum += bpm; a.n++;
    acc.set(day, a);
  }
  return Object.fromEntries([...acc].map(([d, a]) => [d, { min: a.min, avg: Math.round(a.sum / a.n), max: a.max, n: a.n }]));
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

/**
 * @param {Record<string, any[]|{error:string}>} raw   per data type, the documents or an error
 *   marker: daily_readiness, sleep, daily_sleep, daily_activity, daily_stress, daily_spo2,
 *   daily_cardiovascular_age, vO2_max, workout, heartrate
 * @param {{tzOffsetMin?: number}} opts   offset used to give heart-rate samples a local day
 * @returns {{days: object[], workouts: object[], available: Record<string,string>}}
 */
export function summarize(raw, { tzOffsetMin = 0 } = {}) {
  const available = {};
  const docs = {};
  for (const [type, v] of Object.entries(raw || {})) {
    if (Array.isArray(v)) { available[type] = 'ok'; docs[type] = v; }
    else { available[type] = v?.error === 'forbidden' ? 'not-shared' : v?.error === 'rate' ? 'rate-limited' : 'error'; docs[type] = []; }
  }
  const days = new Map();
  const day = d => {
    if (!days.has(d)) days.set(d, { day: d });
    return days.get(d);
  };
  const each = (type, fn) => { for (const doc of docs[type] || []) if (doc && isDay(doc.day)) fn(day(doc.day), doc); };

  each('daily_readiness', (row, r) => {
    row.readiness = {
      score: int(r.score),
      temperatureDeviation: num(r.temperature_deviation),
      hrvBalance: int(r.contributors?.hrv_balance),
      restingHeartRate: int(r.contributors?.resting_heart_rate),
    };
  });
  each('daily_sleep', (row, s) => { row.sleep = { ...(row.sleep || {}), score: int(s.score) }; });
  // The detailed sleep periods: duration, efficiency, HRV and heart rate of the main sleep.
  const periods = new Map();
  each('sleep', (_row, p) => { periods.set(p.day, [...(periods.get(p.day) || []), p]); });
  for (const [d, ps] of periods) {
    const s = mainSleep(ps);
    if (!s) continue;
    day(d).sleep = {
      ...(day(d).sleep || {}),
      totalSec: int(s.total_sleep_duration),
      efficiency: int(s.efficiency),
      averageHrv: int(s.average_hrv),
      lowestHeartRate: int(s.lowest_heart_rate),
      averageHeartRate: int(s.average_heart_rate),
    };
  }
  each('daily_activity', (row, a) => {
    row.activity = { score: int(a.score), steps: int(a.steps), activeCalories: int(a.active_calories) };
  });
  each('daily_stress', (row, s) => {
    row.stress = {
      stressHighSec: int(s.stress_high),
      recoveryHighSec: int(s.recovery_high),
      summary: ['restored', 'normal', 'stressful'].includes(s.day_summary) ? s.day_summary : null,
    };
  });
  each('daily_spo2', (row, s) => {
    row.spo2 = { average: num(s.spo2_percentage?.average), breathingDisturbanceIndex: int(s.breathing_disturbance_index) };
  });
  each('daily_cardiovascular_age', (row, c) => { row.cardio = { ...(row.cardio || {}), vascularAge: int(c.vascular_age) }; });
  each('vO2_max', (row, v) => { row.cardio = { ...(row.cardio || {}), vo2Max: int(v.vo2_max) }; });

  for (const [d, hr] of Object.entries(heartRateByDay(docs.heartrate, tzOffsetMin))) day(d).heartRate = hr;

  const seen = new Set();
  const workouts = [];
  for (const w of docs.workout || []) {
    const s = summarizeWorkout(w);
    if (!s || seen.has(s.id)) continue;      // the same document twice (pagination overlap) is one workout
    seen.add(s.id);
    workouts.push(s);
  }
  workouts.sort((a, b) => (b.start || 0) - (a.start || 0));

  return {
    days: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)),
    workouts,
    available,
  };
}
