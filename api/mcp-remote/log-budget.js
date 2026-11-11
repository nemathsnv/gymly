/* How many workouts assistants may log into one profile: 20 in any hour (openGym's limit for its
 * log_workout, beed2965e). Logging a week someone forgot is a handful; a client looping on the
 * tool is not, and each save is a full write of the profile that every device then pulls.
 *
 * A sliding hour per profile, kept in memory (a restart forgets it, as the other MCP windows do).
 * Only saves count: a preview, a refusal or a workout that was already logged is not one, so the
 * caller asks `wait` before the write and calls `spend` once it landed. This sits beside the
 * endpoint's general write budget (30 writes in 10 minutes, server.js MCP_WRITES), which plan
 * edits and undo count against too.
 *
 * `now` is injectable so the tests can walk the clock instead of sleeping. */
export const LOG_WORKOUT_LIMIT = 20;
export const LOG_WORKOUT_WINDOW_MS = 3600000;

export function createLogBudget({ max = LOG_WORKOUT_LIMIT, windowMs = LOG_WORKOUT_WINDOW_MS, maxKeys = 10000, now = Date.now } = {}) {
  const saves = new Map();
  const recent = key => {
    const t = now();
    const kept = (saves.get(key) || []).filter(at => t - at < windowMs);
    if (kept.length) saves.set(key, kept); else saves.delete(key);
    return kept;
  };
  return {
    /** Seconds until one more save fits, or 0 when it fits now. Counts nothing. */
    wait(key) {
      const kept = recent(key);
      if (kept.length < max) return 0;
      return Math.max(1, Math.ceil((kept[kept.length - max] + windowMs - now()) / 1000));
    },
    /** Records a save that landed. */
    spend(key) {
      const kept = recent(key);
      kept.push(now());
      saves.delete(key);
      saves.set(key, kept);
      // The profile quiet the longest makes room; only profiles allowed to connect ever get here.
      while (saves.size > maxKeys) saves.delete(saves.keys().next().value);
    },
    sweep() { for (const key of [...saves.keys()]) recent(key); },
    get size() { return saves.size; }
  };
}
