/* A stand-in for Oura's OAuth and v2 API, as an injectable fetch. It keeps the rules the real one
 * documents and the integration has to respect: codes and refresh tokens are single-use, every
 * request needs a User-Agent, a scope that was not granted answers 403, and a revoked token is
 * dead. Each instance records what it was asked, for the assertions.
 */
const DAY = 86400000;
export const day = (offset = 0, from = Date.now()) => new Date(from + offset * DAY).toISOString().slice(0, 10);

export function fixtures(today = Date.now()) {
  const d0 = day(0, today), d1 = day(-1, today);
  return {
    daily_readiness: [
      { id: 'r0', day: d0, score: 82, temperature_deviation: -0.1, timestamp: d0 + 'T00:00:00+01:00', contributors: { hrv_balance: 77, resting_heart_rate: 90 } },
      { id: 'r1', day: d1, score: 64, temperature_deviation: 0.3, timestamp: d1 + 'T00:00:00+01:00', contributors: { hrv_balance: 55, resting_heart_rate: 70 } },
    ],
    daily_sleep: [{ id: 's0', day: d0, score: 85, timestamp: d0 + 'T00:00:00+01:00', contributors: {} }],
    sleep: [
      { id: 'p-nap', day: d0, type: 'late_nap', total_sleep_duration: 1200, average_hrv: 20, lowest_heart_rate: 60, average_heart_rate: 66, efficiency: 70, bedtime_end: d0 + 'T15:00:00+01:00', sleep_phase_5_min: '4444', heart_rate: { items: [60, 61] } },
      { id: 'p-main', day: d0, type: 'long_sleep', total_sleep_duration: 27000, average_hrv: 48, lowest_heart_rate: 47, average_heart_rate: 53.4, efficiency: 91, bedtime_end: d0 + 'T07:10:00+01:00', sleep_phase_5_min: '4422113', heart_rate: { items: [50, 49] } },
    ],
    daily_activity: [{ id: 'a0', day: d0, score: 76, steps: 9120, active_calories: 410, met: { items: [1, 2, 3] }, class_5_min: '000111' }],
    daily_stress: [{ id: 'st0', day: d0, stress_high: 3600, recovery_high: 5400, day_summary: 'normal' }],
    daily_spo2: [{ id: 'o0', day: d0, spo2_percentage: { average: 97.2 }, breathing_disturbance_index: 3 }],
    daily_cardiovascular_age: [{ id: 'c0', day: d0, vascular_age: 31, pulse_wave_velocity: 6.1 }],
    vO2_max: [{ id: 'v0', day: d0, vo2_max: 47, timestamp: d0 + 'T08:00:00+01:00' }],
    workout: [
      { id: 'w-run', day: d1, activity: 'running', calories: 412.6, distance: 6020.4, intensity: 'hard', label: null, source: 'autodetected', start_datetime: d1 + 'T18:00:00+01:00', end_datetime: d1 + 'T18:41:00+01:00' },
      { id: 'w-str', day: d0, activity: 'strength_training', calories: 230, distance: null, intensity: 'moderate', label: 'Gym', source: 'confirmed', start_datetime: d0 + 'T17:05:00+01:00', end_datetime: d0 + 'T18:02:00+01:00' },
    ],
    heartrate: [
      { bpm: 52, source: 'rest', timestamp: d0 + 'T06:00:00+00:00' },
      { bpm: 140, source: 'workout', timestamp: d0 + 'T16:30:00+00:00' },
      { bpm: 70, source: 'awake', timestamp: d0 + 'T20:00:00+00:00' },
    ],
  };
}

export function fakeOura({ granted = ['daily', 'heartrate', 'workout', 'spo2', 'heart_health'], ttl = 86400, data = fixtures(), pageSize = 1 } = {}) {
  const scopeOf = { daily_readiness: 'daily', daily_sleep: 'daily', sleep: 'daily', daily_activity: 'daily', daily_stress: 'daily', daily_spo2: 'spo2', daily_cardiovascular_age: 'heart_health', vO2_max: 'heart_health', workout: 'workout', heartrate: 'heartrate' };
  const f = {
    calls: [], codes: new Map(), refresh: new Set(), access: new Set(), revoked: new Set(), n: 0, refreshes: 0,
    issueCode(verifier) { const c = 'code-' + (++f.n); f.codes.set(c, verifier); return c; },
    expireAccess() { f.access.clear(); },
  };
  const tokens = () => {
    const a = 'acc-' + (++f.n), r = 'ref-' + (++f.n);
    f.access.add(a); f.refresh.add(r);
    return { token_type: 'bearer', access_token: a, refresh_token: r, expires_in: ttl, scope: granted.join(' ') };
  };
  const reply = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  f.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const headers = init.headers || {};
    f.calls.push({ url: u.toString(), method: init.method || 'GET', headers, body: init.body || null });
    if (!headers['User-Agent']) return reply(403, { detail: 'User-Agent required' });
    if (u.pathname === '/oauth/token') {
      const p = new URLSearchParams(init.body);
      if (p.get('client_id') !== 'cid' || p.get('client_secret') !== 'csecret') return reply(401, { error: 'invalid_client' });
      if (p.get('grant_type') === 'authorization_code') {
        const v = f.codes.get(p.get('code'));
        f.codes.delete(p.get('code'));                        // single use
        if (!v) return reply(400, { error: 'invalid_grant' });
        const challengeOk = p.get('code_verifier') === v;
        if (!challengeOk) return reply(400, { error: 'invalid_grant' });
        return reply(200, tokens());
      }
      if (p.get('grant_type') === 'refresh_token') {
        f.refreshes++;
        const r = p.get('refresh_token');
        if (!f.refresh.has(r)) return reply(400, { error: 'invalid_grant' });
        f.refresh.delete(r);                                  // single use
        return reply(200, tokens());
      }
      return reply(400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname === '/oauth/revoke') {
      const a = u.searchParams.get('access_token');
      if (init.method !== 'GET') return reply(405, null);
      f.revoked.add(a); f.access.delete(a);
      return reply(200, {});
    }
    const m = /^\/v2\/usercollection\/(\w+)$/.exec(u.pathname);
    if (m) {
      const tok = (headers.Authorization || '').replace(/^Bearer /, '');
      if (!f.access.has(tok)) return reply(401, { detail: 'invalid token' });
      const type = m[1];
      if (!granted.includes(scopeOf[type])) return reply(403, { detail: 'missing scope' });
      const all = data[type] || [];
      const start = +(u.searchParams.get('next_token') || 0);
      const page = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? String(start + pageSize) : null;
      return reply(200, { data: page, next_token: next });
    }
    return reply(404, { detail: 'not found' });
  };
  return f;
}

export const CFG = { clientId: 'cid', clientSecret: 'csecret', scopes: ['daily', 'heartrate', 'workout', 'spo2', 'heart_health'], redirectUri: 'https://gym.example/api/integrations/oura/callback', userAgent: 'Gymly/test (+https://gym.example)' };
